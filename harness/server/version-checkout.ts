/**
 * Playing a round's version (rounds.ts) from its commit, and keeping the game machine's copy in
 * step with whichever checkout plays: a git worktree under `.versions/` with this checkout's
 * private and runtime files linked in, that version's host on a spare port, and the game
 * machine's reader and helper files copied over and the reader rebuilt when they differ.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gameHost, quote } from "./device.js";
import type { Round } from "./rounds.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** This checkout's files a worktree shares: credentials, runtime state and the private guide images. */
const SHARED = [".env", "harness/runtime", ".internal"];

/** The game machine's part of the repository: its helpers and the reader built there. */
export const GAME_MACHINE_PATHSPEC = ["tools/ubuntu", "src", "CMakeLists.txt", "cmake", ":(exclude,glob)**/test_*.py"];

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function worktreeDir(round: Round, base = root) {
  return path.join(base, ".versions", `${round.version}-${round.commit.slice(0, 7)}`);
}

/** Runs `command` in `cwd`, its output to `log` line by line; resolves with the exit code. */
function run(command: string, args: string[], cwd: string, log: (line: string) => void, env = process.env) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let rest = "";
    const out = (d: Buffer) => {
      rest += d;
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) log(line);
    };
    child.stdout.on("data", out);
    child.stderr.on("data", out);
    child.on("error", reject);
    child.on("close", (code) => {
      if (rest.trim()) log(rest);
      resolve(code ?? 1);
    });
  });
}

/**
 * The round's worktree, made on first use: checked out at the round's commit, with this checkout's
 * shared files linked in and its dependencies installed.
 */
export async function prepareWorktree(round: Round, log: (line: string) => void) {
  const dir = worktreeDir(round);
  if (!existsSync(dir)) {
    mkdirSync(path.dirname(dir), { recursive: true });
    log(`Making a worktree for ${round.version} at ${round.commit.slice(0, 7)}: ${path.relative(root, dir)}`);
    git(root, ["worktree", "add", "--detach", dir, round.commit]);
  }
  const head = git(dir, ["rev-parse", "HEAD"]);
  if (head !== git(root, ["rev-parse", round.commit]))
    throw new Error(`${path.relative(root, dir)} is at ${head.slice(0, 7)}, not ${round.commit.slice(0, 7)}; remove it (git worktree remove) and run again.`);
  for (const name of SHARED) {
    const target = path.join(root, name);
    const link = path.join(dir, name);
    if (!existsSync(target)) continue;
    if (!existsSync(link) && !isLink(link)) symlinkSync(target, link);
  }
  if (!existsSync(path.join(dir, "node_modules"))) {
    log(`Installing ${round.version}'s dependencies (npm ci)`);
    const code = await run("npm", ["ci", "--no-audit", "--no-fund"], dir, log);
    if (code !== 0) throw new Error(`npm ci failed in ${path.relative(root, dir)} (exit ${code}).`);
  }
  return dir;
}

function isLink(file: string) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Starts the worktree's host on `port`, its output in `host.log` there, and waits until it answers
 * with the round's version.
 */
export async function startHost(dir: string, port: string, round: Round, log: (line: string) => void) {
  const out = openSync(path.join(dir, "host.log"), "a");
  const child = spawn(process.execPath, [path.join(dir, "node_modules/tsx/dist/cli.mjs"), "harness/server/index.ts"], {
    cwd: dir, env: { ...process.env, PORT: port }, stdio: ["ignore", out, out],
  });
  const stop = () => stopHost(child);
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`The ${round.version} host exited (code ${child.exitCode}); see ${path.join(dir, "host.log")}.`);
    const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.json() as Promise<any>).catch(() => null);
    if (state) {
      const version = state.benchmark?.version;
      if (version !== round.version) {
        await stop();
        throw new Error(`The worktree's host reports benchmark ${version ?? "unversioned"}, not ${round.version}.`);
      }
      log(`${round.version} host up on port ${port}`);
      return child;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await stop();
  throw new Error(`The ${round.version} host did not answer on port ${port} within 2 minutes; see ${path.join(dir, "host.log")}.`);
}

export function stopHost(child: ChildProcess) {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 10_000).unref();
  });
}

/** The game machine's files in a checkout, with their SHA-256 (the hash the game machine's sha256sum gives). */
export function gameMachineFiles(dir: string) {
  const files = git(dir, ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...GAME_MACHINE_PATHSPEC])
    .split("\n").filter((f, i, all) => f && all.indexOf(f) === i && existsSync(path.join(dir, f))).sort();
  return new Map(files.map((file) => [file, createHash("sha256").update(readFileSync(path.join(dir, file))).digest("hex")]));
}

function ssh(command: string, input?: Buffer) {
  const { host } = gameHost();
  return new Promise<{ code: number; out: string }>((resolve, reject) => {
    const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, command]);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** The checkout's game-machine files whose copy on the game machine is missing or different. */
export async function gameMachineDifferences(dir: string) {
  const local = gameMachineFiles(dir);
  const { root: remoteRoot } = gameHost();
  const files = [...local.keys()];
  const { out } = await ssh(`cd ${quote(remoteRoot)} && sha256sum -- ${files.map(quote).join(" ")} 2>/dev/null; true`);
  const remote = new Map(out.split("\n").filter((line) => /^[0-9a-f]{64}  /.test(line)).map((line) => [line.slice(66), line.slice(0, 64)] as const));
  return files.filter((file) => remote.get(file) !== local.get(file));
}

/**
 * Copies the checkout's game-machine files that differ to the game machine and, when the reader's
 * sources are among them, rebuilds the Windows programs the game runs (build/ubuntu-windows).
 * Returns the files copied.
 */
export async function syncGameMachine(dir: string, log: (line: string) => void) {
  const differ = await gameMachineDifferences(dir);
  if (!differ.length) return differ;
  log(`Game machine: copying ${differ.length} file(s) from ${path.relative(root, dir) || "this checkout"}: ${differ.slice(0, 6).join(", ")}${differ.length > 6 ? ", …" : ""}`);
  const tar = spawnSync("tar", ["-C", dir, "-cf", "-", ...differ], { maxBuffer: 256 * 1024 * 1024 });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr.toString().trim()}`);
  const { root: remoteRoot } = gameHost();
  const copied = await ssh(`mkdir -p ${quote(remoteRoot)} && tar -C ${quote(remoteRoot)} -xf -`, tar.stdout);
  if (copied.code !== 0) throw new Error(`Copying to the game machine failed: ${copied.out.trim().slice(-300)}`);
  if (differ.some((file) => !file.startsWith("tools/ubuntu/"))) {
    log("Game machine: rebuilding the reader (build/ubuntu-windows)");
    const r = quote(remoteRoot);
    const built = await ssh(`cd ${r} && mkdir -p build && cmake -S . -B build/ubuntu-windows -G Ninja -DCMAKE_TOOLCHAIN_FILE=cmake/windows-mingw.cmake -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON > build/sync-build.log 2>&1 && cmake --build build/ubuntu-windows --parallel 2 >> build/sync-build.log 2>&1; s=$?; tail -5 build/sync-build.log; exit $s`);
    if (built.code !== 0) throw new Error(`Rebuilding the reader failed: ${built.out.trim().slice(-500)}`);
  }
  const left = await gameMachineDifferences(dir);
  if (left.length) throw new Error(`The game machine still differs after copying: ${left.join(", ")}`);
  return differ;
}
