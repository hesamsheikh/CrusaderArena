import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LAUNCHER_SERVICE_PREFIX, LAUNCHER_SERVICE_VARIABLE, withLauncherService } from "./steam-launcher.js";
import { ROUND_PRELOAD } from "./version-checkout.js";

const READER = "python3 '/game/CrusaderBench/tools/ubuntu/run-proton.py' 'watch' '--interval-ms' '100'";

test("the prefix goes before run-proton.py's remote command only, once", () => {
  const args = ["-T", "-o", "BatchMode=yes", "host", READER];
  const changed = withLauncherService(args);
  assert.deepEqual(changed.slice(0, -1), args.slice(0, -1));
  assert.equal(changed.at(-1), LAUNCHER_SERVICE_PREFIX + READER);
  assert.deepEqual(withLauncherService(changed), changed);
  const other = ["-T", "host", "python3 '/game/CrusaderBench/tools/ubuntu/game-session.py' status"];
  assert.deepEqual(withLauncherService(other), other);
});

test("the prefix exports nothing when no game runs, and leaves the command's exit status", () => {
  const run = spawnSync("sh", ["-c", `${LAUNCHER_SERVICE_PREFIX}echo "[\${${LAUNCHER_SERVICE_VARIABLE}-unset}]"; exit 3`], {
    encoding: "utf8", env: { PATH: process.env.PATH },
  });
  assert.equal(run.stdout.trim(), "[unset]");
  assert.equal(run.status, 3);
});

test("the preload gives an earlier round's host the prefix on its ssh calls to run-proton.py", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "round-preload-"));
  writeFileSync(path.join(dir, "ssh"), `#!/bin/sh\nfor last; do :; done\nprintf '%s\\n' "$last"\n`);
  chmodSync(path.join(dir, "ssh"), 0o755);
  writeFileSync(path.join(dir, "host.mjs"), `
    import { spawn } from "node:child_process";
    const run = (args) => new Promise((resolve) => { let out = ""; const c = spawn("ssh", args); c.stdout.on("data", (d) => (out += d)); c.on("close", () => resolve(out.trim())); });
    console.log(JSON.stringify([await run(["-T", "host", ${JSON.stringify(READER)}]), await run(["-T", "host", "true"])]));`);
  const run = spawnSync(process.execPath, ["--import", "tsx", "--import", ROUND_PRELOAD, path.join(dir, "host.mjs")], {
    encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), [LAUNCHER_SERVICE_PREFIX + READER, "true"]);
});
