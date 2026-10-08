import test from "node:test";
import assert from "node:assert/strict";
import { GameDevice, readerIntervalMs } from "./device.js";

test("capture failure disconnects control and reports failure to the run owner", async () => {
  const failures: string[] = [];
  const device = new GameDevice(
    () => {},
    (message) => failures.push(message),
  );
  device.connected = true;
  // Exercise the actual serial capture/error lifecycle without starting SSH.
  Object.assign(device, {
    rpc: async () => {
      throw new Error("Game no longer exists");
    },
  });
  await assert.rejects(device.capture(), /no longer exists/);
  assert.equal(device.connected, false);
  assert.equal(device.latest, null);
  assert.deepEqual(failures, [
    "Game capture failed; reconnect before continuing.",
  ]);
});

test("memory guard becomes active on start and stops the session when it terminates the game", () => {
  const failures: string[] = [];
  const device = new GameDevice(
    () => {},
    (message) => failures.push(message),
  );
  device.connected = true;
  device.guardState = "starting";
  device.guardLine("not json");
  device.guardLine(JSON.stringify({ kind: "sample", rss_kib: 3_000_000 }));
  assert.equal(device.guardState, "starting");
  device.guardLine(JSON.stringify({ kind: "started", pid: 1 }));
  assert.equal(device.guardState, "active");
  device.guardLine(JSON.stringify({ kind: "termination_requested", limits: ["system_available_limit"] }));
  assert.equal(device.connected, false);
  assert.equal(device.guardState, "off");
  // The message carries the last reading so a stop is diagnosable from the log alone.
  assert.match(failures[0], /Memory guard stopped the game \(system_available_limit; game 2\.9 GiB resident/);
});

test("guard listeners receive every record until they unsubscribe", () => {
  const device = new GameDevice(() => {}, () => {});
  const kinds: unknown[] = [];
  const off = device.onGuard((record) => kinds.push(record.kind));
  device.guardLine(JSON.stringify({ kind: "sample", rss_kib: 1 }));
  device.guardLine(JSON.stringify({ kind: "memory_map", rss_kib: 1 }));
  off();
  device.guardLine(JSON.stringify({ kind: "sample", rss_kib: 2 }));
  assert.deepEqual(kinds, ["sample", "memory_map"]);
  assert.equal(device.lastGuardSample?.rss_kib, 2);
});

test("a monitor error marks the guard failed", () => {
  const device = new GameDevice(() => {}, () => {});
  device.connected = true;
  device.guardLine(JSON.stringify({ kind: "monitor_error", error: "ambiguous game" }));
  assert.equal(device.guardState, "failed");
});

test("reader interval defaults to 100 ms and rejects values outside 50–5000", () => {
  assert.equal(readerIntervalMs(undefined), 100);
  assert.equal(readerIntervalMs(""), 100);
  assert.equal(readerIntervalMs("500"), 500);
  for (const bad of ["49", "5001", "1.5", "fast"]) assert.throws(() => readerIntervalMs(bad), /50 to 5000/);
});

test("each action and hotkey is announced to input listeners before it is sent", async () => {
  const device = new GameDevice(() => {}, () => {});
  const sent: string[] = [];
  const heard: unknown[] = [];
  Object.assign(device, {
    rpc: async (op: string) => {
      sent.push(op);
      if (op === "capture")
        return { image: "", mimeType: "image/jpeg", width: 1920, height: 1080, windowId: 7, pid: 1, capturedAt: Date.now(), scope: "game-window" };
      return { delivered: true };
    },
  });
  const unsubscribe = device.onInput((input) => heard.push({ ...input, sentBefore: sent.length }));
  const frame = await device.capture();
  await device.action({ type: "click", x: 10, y: 20, button: 1 }, frame.id);
  await device.hotkey("HomeKeep");
  unsubscribe();
  await device.action({ type: "key", key: "B" }, frame.id);
  assert.deepEqual(heard, [
    { type: "click", x: 10, y: 20, button: 1, width: 1920, height: 1080, sentBefore: 1 },
    { type: "hotkey", name: "HomeKeep", width: 1920, height: 1080, sentBefore: 2 },
  ]);
});

test("a reader diagnostic naming a multiplayer game ends the connection; other refusals do not", () => {
  const failures: string[] = [];
  const device = new GameDevice(() => {}, (message) => failures.push(message));
  device.connected = true;
  device.readerDiagnostic("not an active local single-player map: mode=3 player=1 multiplayerGame=0 editor=1");
  assert.equal(device.connected, true);
  device.readerDiagnostic("not an active local single-player map: mode=14 player=2 multiplayerGame=1 editor=0");
  assert.equal(device.connected, false);
  assert.deepEqual(failures, ["Multiplayer game detected; Crusader Arena only plays single-player maps."]);
});

test("single-player confirmation needs a current ok reader sample", async () => {
  const device = new GameDevice(() => {}, () => {});
  assert.equal(await device.singlePlayerConfirmed(150), false);
  device.stats = { status: "unavailable", observation: null } as any;
  assert.equal(await device.singlePlayerConfirmed(150), false);
  device.stats = { status: "ok", valid_until_unix_ms: Date.now() - 1, observation: {} } as any;
  assert.equal(await device.singlePlayerConfirmed(150), false);
  setTimeout(() => {
    device.stats = { status: "ok", valid_until_unix_ms: Date.now() + 1500, observation: {} } as any;
  }, 50);
  assert.equal(await device.singlePlayerConfirmed(1000), true);
});
