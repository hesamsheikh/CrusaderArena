import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { quote } from "./device.js";
import { freePort, gameMachineFiles, READER_STAMP, readerDigest, readerSources, syncGameMachine, worktreeDir, type GameShell } from "./version-checkout.js";

process.env.GAME_SSH_HOST = "game-machine";
process.env.GAME_REMOTE_ROOT = "/home/player/CrusaderBench";

/**
 * A game machine for syncGameMachine: its copy's SHA-256 per file, the reader sources its programs
 * were built from (READER_STAMP; null for none) and the commands it was sent. A copy brings every
 * file in line with `local`; a build records the digest it was given unless `buildFails`.
 */
function gameMachine(files: Map<string, string>, stamp: string | null, local: Map<string, string>, buildFails = false) {
  const machine = { files: new Map(files), stamp, commands: [] as string[] };
  const shell: GameShell = async (command) => {
    machine.commands.push(command);
    if (command.includes("sha256sum")) return { code: 0, out: [...machine.files].map(([file, hash]) => `${hash}  ${file}`).join("\n") };
    if (command.includes("tar -C")) {
      for (const [file, hash] of local) machine.files.set(file, hash);
      return { code: 0, out: "" };
    }
    if (command.startsWith("cat ")) return { code: 0, out: machine.stamp ?? "" };
    if (command.includes("cmake --build")) {
      machine.stamp = buildFails ? null : /echo ([0-9a-f]{64}) >/.exec(command)![1];
      return buildFails ? { code: 1, out: "ninja: build stopped: subcommand failed." } : { code: 0, out: "ninja: no work to do." };
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  return { machine, shell };
}

const builds = (commands: string[]) => commands.filter((c) => c.includes("cmake --build"));

test("a round's worktree is named by its version and commit", () => {
  assert.equal(worktreeDir({ version: "1.5.1", fingerprint: "e5d9", commit: "fe9754670075909d", since: "2026-10-11" }, "/repo"),
    "/repo/.versions/1.5.1-fe97546");
});

test("the game machine's files are its helpers and the reader's sources, without their tests", () => {
  const files = [...gameMachineFiles(".").keys()];
  assert.ok(files.includes("CMakeLists.txt"));
  assert.ok(files.some((f) => f.startsWith("src/windows/")));
  assert.ok(files.some((f) => f.startsWith("tools/ubuntu/") && f.endsWith(".py")));
  assert.ok(!files.some((f) => /(^|\/)test_[^/]*\.py$/.test(f)), "the Python tests stay out");
  assert.ok(files.every((f) => /^(tools\/ubuntu|src|cmake)\//.test(f) || f === "CMakeLists.txt"));
  assert.ok([...gameMachineFiles(".").values()].every((h) => /^[0-9a-f]{64}$/.test(h)));
});

test("the round's host skips a port another program already listens on", async () => {
  const taken = net.createServer();
  await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", () => resolve()));
  const port = (taken.address() as net.AddressInfo).port;
  try {
    const found = await freePort(port);
    assert.notEqual(found, port);
    assert.ok(found > port && found < port + 20);
  } finally {
    await new Promise<void>((resolve) => taken.close(() => resolve()));
  }
});

test("the game machine's reader is rebuilt when its programs were built from other sources, though no file differs", async () => {
  // 2026-10-13: a round on 1.5.0 rebuilt the probe from 1.5.0's sources; 1.6.3's copied back kept
  // older times, Ninja had nothing to do, and the 1.6.3 games ran 1.5.0's probe.
  const local = gameMachineFiles(".");
  const { machine, shell } = gameMachine(local, "0".repeat(64), local);
  const lines: string[] = [];
  assert.deepEqual(await syncGameMachine(".", (line) => lines.push(line), shell), []);
  const [build] = builds(machine.commands);
  assert.ok(build, "rebuilt");
  assert.match(lines.join("\n"), /rebuilding the reader .*built from other sources/);
  // Every reader source is touched before the build, whatever its time; the helpers are not.
  for (const file of readerSources(local)) assert.ok(build.includes(` ${quote(file)}`), file);
  assert.ok(!build.includes("tools/ubuntu/"));
  // The record goes before the build and comes back only after a whole one.
  assert.ok(build.indexOf(`rm -f ${READER_STAMP}`) < build.indexOf("touch -c"));
  assert.ok(build.indexOf("touch -c") < build.indexOf("cmake -S"));
  assert.ok(build.endsWith(`[ $s -eq 0 ] && echo ${readerDigest(local)} > ${READER_STAMP}; exit $s`));
  assert.equal(machine.stamp, readerDigest(local));

  machine.commands.length = 0;
  assert.deepEqual(await syncGameMachine(".", () => {}, shell), []);
  assert.deepEqual(builds(machine.commands), [], "built from these sources: left alone");
});

test("a helper that differs is copied without a rebuild; a reader source that differs is copied and rebuilt", async () => {
  const local = gameMachineFiles(".");
  const helper = [...local.keys()].find((file) => file.startsWith("tools/ubuntu/"))!;
  const source = readerSources(local).find((file) => file.startsWith("src/"))!;

  const one = gameMachine(new Map(local).set(helper, "1".repeat(64)), readerDigest(local), local);
  assert.deepEqual(await syncGameMachine(".", () => {}, one.shell), [helper]);
  assert.deepEqual(builds(one.machine.commands), []);

  // The game machine holds another version's source, and programs built from it.
  const other = new Map(local).set(source, "1".repeat(64));
  const two = gameMachine(other, readerDigest(other), local);
  const lines: string[] = [];
  assert.deepEqual(await syncGameMachine(".", (line) => lines.push(line), two.shell), [source]);
  assert.equal(builds(two.machine.commands).length, 1);
  assert.equal(two.machine.stamp, readerDigest(local));
  assert.match(lines.join("\n"), /rebuilding the reader \(build\/ubuntu-windows\)$/m);
});

test("a failed rebuild of the game machine's reader stops the sync and leaves no record of its sources", async () => {
  const local = gameMachineFiles(".");
  const { machine, shell } = gameMachine(local, "0".repeat(64), local, true);
  await assert.rejects(syncGameMachine(".", () => {}, shell), /Rebuilding the reader failed: ninja: build stopped/);
  assert.equal(machine.stamp, null, "the next sync builds again");
  const lines: string[] = [];
  await assert.rejects(syncGameMachine(".", (line) => lines.push(line), shell));
  assert.match(lines.join("\n"), /rebuilding the reader .*: no record of the sources its programs were built from/);
});

test("the reader's digest covers its sources' paths and contents, not the helpers", () => {
  const local = gameMachineFiles(".");
  const helper = [...local.keys()].find((file) => file.startsWith("tools/ubuntu/"))!;
  const [source] = readerSources(local);
  assert.equal(readerDigest(new Map(local).set(helper, "1".repeat(64))), readerDigest(local));
  assert.notEqual(readerDigest(new Map(local).set(source, "1".repeat(64))), readerDigest(local));
  assert.ok(readerSources(local).includes("CMakeLists.txt"));
  assert.ok(readerSources(local).every((file) => !file.startsWith("tools/ubuntu/")));
});
