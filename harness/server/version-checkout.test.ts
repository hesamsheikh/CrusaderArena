import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { freePort, gameMachineFiles, worktreeDir } from "./version-checkout.js";

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
