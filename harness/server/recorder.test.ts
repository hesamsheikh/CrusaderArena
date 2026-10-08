import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { FrameStreamParser, RunRecorder, frameStats } from "./recorder.js";
import type { Stats } from "../shared/protocol.js";

const frame = (t: number, jpeg: Buffer) =>
  Buffer.concat([Buffer.from(JSON.stringify({ t, w: 4, h: 2, sw: 8, sh: 4, bytes: jpeg.length, ms: 30 }) + "\n"), jpeg]);

function fakeRecorder() {
  const commands: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  child.stdin.on("data", (d: Buffer) => commands.push(...d.toString().trim().split("\n")));
  child.stdin.on("finish", () => child.emit("close", 0));
  return { child, commands, process: child as unknown as ChildProcessWithoutNullStreams };
}

const stats: Stats = {
  status: "ok",
  observation: {
    map_name: "Oasis",
    game_time: 900,
    paused: false,
    gold: 1000,
    population: 12,
    popularity: 95,
    wood_planks: 3,
    resources_by_name: { wood_planks: 40, stone: 5, iron: 0 },
    settlement: { housing_cap: 24, total_food: 60 } as never,
  },
};

test("frame stream parser reassembles headers and JPEG bytes split across any chunks", () => {
  const records: { header: Record<string, unknown>; jpeg?: string }[] = [];
  const parser = new FrameStreamParser((header, jpeg) => records.push({ header, jpeg: jpeg?.toString() }));
  const stream = Buffer.concat([
    Buffer.from(JSON.stringify({ event: "ready", pid: 7 }) + "\n"),
    frame(1, Buffer.from("first\njpeg")),
    Buffer.from(JSON.stringify({ event: "error", error: "window gone" }) + "\n"),
    frame(2, Buffer.from("second")),
  ]);
  for (let i = 0; i < stream.length; i++) parser.push(stream.subarray(i, i + 1));
  assert.deepEqual(records.map((r) => r.header.event ?? r.header.t), ["ready", 1, "error", 2]);
  assert.deepEqual(records.map((r) => r.jpeg), [undefined, "first\njpeg", undefined, "second"]);
});

test("frame stats keep the fields the video's stats bar shows", () => {
  assert.deepEqual(frameStats(stats), {
    gameTime: 900, paused: false, gold: 1000, population: 12, popularity: 95,
    housing: 24, food: 60, wood: 40, stone: 5, iron: 0,
  });
  assert.equal(frameStats({ status: "unavailable", observation: null }), null);
});

test("recorder captures only while active and stores frames with reader stats", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "arena-recorder-"));
  const fake = fakeRecorder();
  const events: Record<string, unknown>[] = [];
  const recorder = new RunRecorder(dir, () => stats, (e) => events.push(e), () => {},
    { fps: 3, burstFps: 9, burstSeconds: 2, width: 1440, quality: 70 },
    (args) => {
      assert.deepEqual(args, ["--fps", "3", "--burst-fps", "9", "--burst-seconds", "2", "--width", "1440", "--quality", "70"]);
      return fake.process;
    }, () => 5000);
  recorder.start();
  assert.deepEqual(fake.commands, []);
  recorder.setActive(true);
  recorder.setActive(true);
  recorder.input({ type: "click", x: 5, y: 6, button: 1, width: 1920, height: 1080 });
  fake.child.stdout.write(frame(4000, Buffer.from("jpeg-bytes")));
  await new Promise((resolve) => setImmediate(resolve));
  recorder.setActive(false);
  // Inputs while held (the host's pause key) are logged without a capture burst.
  recorder.input({ type: "key", key: "P", width: 1920, height: 1080 });
  const summary = await recorder.stop();
  recorder.input({ type: "key", key: "B", width: 1920, height: 1080 });
  assert.deepEqual(fake.commands, ["run", "burst", "hold", "quit"]);
  assert.deepEqual(readFileSync(path.join(dir, "recording/inputs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)), [
    { at: 5000, type: "click", x: 5, y: 6, button: 1, width: 1920, height: 1080 },
    { at: 5000, type: "key", key: "P", width: 1920, height: 1080 },
  ]);
  assert.equal(summary.frames, 1);
  assert.equal(summary.bytes, 10);
  assert.deepEqual(readdirSync(path.join(dir, "recording/frames")), ["000001.jpg"]);
  assert.equal(readFileSync(path.join(dir, "recording/frames/000001.jpg"), "utf8"), "jpeg-bytes");
  const row = JSON.parse(readFileSync(path.join(dir, "recording/frames.jsonl"), "utf8"));
  assert.deepEqual({ ...row, stats: row.stats.gold }, { i: 1, file: "000001.jpg", at: 5000, t: 4000, w: 4, h: 2, sw: 8, sh: 4, ms: 30, stats: 1000 });
  assert.deepEqual(events.map((e) => e.state ?? e.type), ["recording_started", "run", "hold", "recording_stopped"]);
});

test("an unexpected recorder exit is logged and restarted without stopping the run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const dir = mkdtempSync(path.join(tmpdir(), "arena-recorder-"));
  const first = fakeRecorder();
  const second = fakeRecorder();
  const spawned = [first.process, second.process];
  const logs: string[] = [];
  const recorder = new RunRecorder(dir, () => stats, () => {}, (text) => logs.push(text), undefined, () => spawned.shift()!);
  recorder.start();
  recorder.setActive(true);
  first.child.stderr.write("Expected one visible Stronghold game window\n");
  await new Promise((resolve) => setImmediate(resolve));
  first.child.emit("close", 1);
  assert.match(logs[0], /Recording interrupted \(Expected one visible Stronghold game window\)/);
  t.mock.timers.tick(2000);
  // The replacement resumes capturing because the run is still active.
  assert.deepEqual(second.commands, ["run"]);
  await recorder.stop();
  assert.deepEqual(second.commands, ["run", "hold", "quit"]);
});
