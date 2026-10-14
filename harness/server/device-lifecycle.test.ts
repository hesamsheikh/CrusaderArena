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

test("pressKey sends the host's own keys from the latest frame without a capture, and inputSerial counts every send", async () => {
  const device = new GameDevice(() => {}, () => {});
  const sent: string[] = [];
  Object.assign(device, {
    rpc: async (op: string) => {
      sent.push(op);
      if (op === "capture")
        return { image: "", mimeType: "image/jpeg", width: 1920, height: 1080, windowId: 7, pid: 1, capturedAt: Date.now(), scope: "game-window" };
      return { delivered: true };
    },
  });
  await assert.rejects(device.pressKey("P"), /Capture the game before sending a key/);
  assert.equal(device.inputSerial, 0, "a rejected send with no latest frame is not an input");
  await device.capture();
  await device.pressKey("P");
  assert.deepEqual(sent, ["capture", "action"], "no extra capture before the key");
  assert.equal(device.inputSerial, 1);
  await device.hotkey("HomeKeep");
  assert.equal(device.inputSerial, 2, "a hotkey counts too");
  await device.action({ type: "click", x: 1, y: 1, button: 1 }, device.latest!.id);
  assert.equal(device.inputSerial, 3, "and an ordinary action");
});

test("a run of keys goes to the bridge in one request, each key announced, with time for all of them", async () => {
  // A save's name, about 100 keys, took 0.71 s a key at one request each (live, 2026-10-14).
  const device = new GameDevice(() => {}, () => {});
  const calls: { op: string; extra: any; timeoutMs?: number }[] = [];
  Object.assign(device, {
    rpc: async (op: string, extra: any = {}, timeoutMs?: number) => {
      calls.push({ op, extra, timeoutMs });
      if (op === "capture")
        return { image: "", mimeType: "image/jpeg", width: 1920, height: 1080, windowId: 7, pid: 1, capturedAt: Date.now(), scope: "game-window" };
      return { delivered: true };
    },
  });
  const heard: unknown[] = [];
  device.onInput((input) => heard.push(input));
  const frame = await device.capture();
  const keys = [...Array<"ArrowRight">(38).fill("ArrowRight"), "S", "T", "Space", "1"] as const;
  await device.keys(keys, frame.id);
  const sent = calls.filter((c) => c.op === "action");
  assert.equal(sent.length, 1, "one request for the whole run");
  assert.deepEqual(sent[0].extra.action, { type: "keys", keys, windowId: 7, width: 1920, height: 1080 });
  assert.ok(sent[0].timeoutMs! >= 12_000 + keys.length * 120, "time for every key's 70 ms hold and 50 ms gap");
  assert.equal(heard.length, keys.length, "each key announced, as single keys are");
  await assert.rejects(device.keys([], frame.id), /1 to 200 keys/);
  await assert.rejects(device.keys(Array<"A">(201).fill("A"), frame.id), /1 to 200 keys/);
  await assert.rejects(device.keys(["A"], "00000000-0000-4000-8000-000000000000"), /Unknown or expired/);
  assert.equal(calls.filter((c) => c.op === "action").length, 1, "nothing sent for a refused run");
});

test("a request's time starts when the bridge gets to it, so the status line behind a save's run of keys does not time out", async (t) => {
  // The bridge answers one request at a time, in order. GLM 5.3 Flash's and GPT-6 Luna's saves
  // (live, 2026-10-14) typed about 100 keys in one 13 s request; the status line the host sends
  // every second waited behind it past its own 12 s, and the timeout disconnected the game.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const closed: string[] = [];
  const device = new GameDevice(() => {}, (reason) => closed.push(reason));
  const sent: { id: string; op: string }[] = [];
  Object.assign(device, {
    connected: true,
    child: { stdin: { writable: true, write: (line: string) => void sent.push(JSON.parse(line)), end() {} }, kill() {} },
  });
  const rpc = (op: string, timeoutMs?: number): Promise<unknown> => (device as any).rpc(op, {}, timeoutMs);
  const answer = (op: string) => device.bridgeLine(JSON.stringify({ id: sent.find((s) => s.op === op)!.id, result: { op } }));
  const keys = rpc("action", 12_000 + 100 * 250);
  t.mock.timers.tick(500);
  const status = rpc("status");
  t.mock.timers.tick(13_000);
  assert.deepEqual(closed, [], "the status line waits for the keys");
  answer("action");
  t.mock.timers.tick(100);
  answer("status");
  assert.deepEqual([await keys, await status], [{ op: "action" }, { op: "status" }]);
  // A request the bridge never answers still times out, 12 s after the bridge gets to it.
  const lost = rpc("ping").catch((e: Error) => e.message);
  t.mock.timers.tick(11_900);
  assert.deepEqual(closed, []);
  t.mock.timers.tick(200);
  assert.equal(await lost, "Game request timed out; reconnect before retrying.");
  assert.deepEqual(closed, ["Game bridge timed out."]);
});

/** A device whose bridge answers every request; `sent` lists the requests in order. */
function bridged() {
  const device = new GameDevice(() => {}, () => {});
  const sent: string[] = [];
  Object.assign(device, {
    rpc: async (op: string) => {
      sent.push(op);
      if (op === "capture")
        return { image: "", mimeType: "image/jpeg", width: 1920, height: 1080, windowId: 7, pid: 1, capturedAt: Date.now(), scope: "game-window" };
      return { delivered: true };
    },
  });
  /** The reader's sample: the game clock at `tick` on map "m". */
  const clock = (tick: number) => {
    device.stats = { status: "ok", valid_until_unix_ms: Date.now() + 5000, observation: { game_time: tick, map_name: "m" } } as never;
  };
  return { device, sent, clock };
}

test("a screenshot ages in game seconds on the game clock: 40 of them, however long they took", async () => {
  const { device, clock } = bridged();
  clock(10_000);
  const frame = await device.capture();
  assert.equal(frame.gameTick, 10_000);
  // Long ago in real time (a paused game, or a wait played fast) but 39.9 game seconds of play: usable.
  Object.assign(frame, { receivedAt: Date.now() - 600_000 });
  clock(10_000 + 1197);
  await device.action({ type: "click", x: 1, y: 1, button: 1 }, frame.id);
  // Just past 40 game seconds, however recent in real time: expired.
  Object.assign(frame, { receivedAt: Date.now() });
  clock(10_000 + 1201);
  await assert.rejects(device.action({ type: "click", x: 1, y: 1, button: 1 }, frame.id), /expired \(older than 40 game seconds/);
  // Another map's clock is another game.
  device.stats = { status: "ok", valid_until_unix_ms: Date.now() + 5000, observation: { game_time: 10_001, map_name: "other" } } as never;
  await assert.rejects(device.action({ type: "click", x: 1, y: 1, button: 1 }, frame.id), /expired/);
});

test("input aimed from the live camera (an infinite age credit) takes any capture, however many game seconds old", async () => {
  // A tile target's clicks (build_structure, demolish_building, set_workshop) use the frame only for
  // the window: after text-only observations the latest capture can be minutes of play old.
  const { device, clock } = bridged();
  clock(10_000);
  const frame = await device.capture();
  clock(10_000 + 100 * 30);
  await device.action({ type: "click", x: 1, y: 1, button: 1 }, frame.id, undefined, Number.POSITIVE_INFINITY);
  await assert.rejects(device.action({ type: "click", x: 1, y: 1, button: 1 }, frame.id), /expired/, "a pixel target still ages");
});

test("the speed guard refuses game input while it throws, but not the host's pause and speed keys", async () => {
  const { device, sent } = bridged();
  const frame = await device.capture();
  device.speedGuard = () => { throw new Error("The game is not confirmed at speed 40; input refused."); };
  await assert.rejects(device.action({ type: "click", x: 1, y: 1, button: 1 }, frame.id), /not confirmed at speed 40/);
  await assert.rejects(device.hotkey("HomeKeep"), /not confirmed at speed 40/);
  await device.pressKey("-");
  assert.deepEqual(sent, ["capture", "action"], "only the speed key went out");
  device.speedGuard = undefined;
  await device.action({ type: "click", x: 1, y: 1, button: 1 }, frame.id);
  assert.equal(sent.length, 3);
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
