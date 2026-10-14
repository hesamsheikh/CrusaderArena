import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderInBackground, renderVideo } from "./video.js";

function fakeProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcess;
}

/** Ends a fake process's streams and emits `close`, as a real child_process would. */
function finish(child: ChildProcess, { stdout = "", stderr = "", code = 0 }: { stdout?: string; stderr?: string; code?: number } = {}) {
  (child.stdout as PassThrough).end(stdout);
  (child.stderr as PassThrough).end(stderr);
  setImmediate(() => child.emit("close", code));
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("renders a video, then compacts the recording, logging both", async () => {
  const logs: string[] = [];
  const renderArgs: string[][] = [];
  const compactArgs: string[][] = [];
  const renderChild = fakeProcess();
  const compactChild = fakeProcess();
  const promise = renderVideo(
    "runDir",
    (text) => logs.push(text),
    (args) => {
      renderArgs.push(args);
      return renderChild;
    },
    (args) => {
      compactArgs.push(args);
      return compactChild;
    },
  );
  await flush();
  finish(renderChild, { stdout: JSON.stringify({ output: "runDir/video.mp4", seconds: 12.3, turns: 2, frames: 40 }) });
  await flush();
  // Compaction starts in the same queue once the render has succeeded.
  assert.deepEqual(compactArgs, [["runDir", "--quiet"]]);
  finish(compactChild, { stdout: JSON.stringify({ runDir: { source_bytes: 57_000_000, video_bytes: 3_000_000 } }) });
  const result = await promise;
  assert.deepEqual(renderArgs, [["runDir", "--quiet"]]);
  assert.equal(result?.output, "runDir/video.mp4");
  assert.match(logs[0], /Video saved: runDir\/video\.mp4 \(0:12\)\./);
  assert.match(logs[1], /Recording compacted: 57 MB -> 3 MB\./);
});

test("a failed render resolves null and skips compaction", async () => {
  const logs: string[] = [];
  const compactCalls: string[][] = [];
  const renderChild = fakeProcess();
  const promise = renderVideo(
    "runDir",
    (text) => logs.push(text),
    () => renderChild,
    (args) => {
      compactCalls.push(args);
      return fakeProcess();
    },
  );
  await flush();
  finish(renderChild, { stderr: "boom\n", code: 1 });
  const result = await promise;
  assert.equal(result, null);
  assert.deepEqual(compactCalls, []);
  assert.match(logs[0], /Video render failed: boom/);
});

test("a compaction skip or failure is logged but the render result still resolves", async () => {
  const logs: string[] = [];
  const renderChild = fakeProcess();
  const compactChild = fakeProcess();
  const promise = renderVideo(
    "runDir",
    (text) => logs.push(text),
    () => renderChild,
    () => compactChild,
  );
  await flush();
  finish(renderChild, { stdout: JSON.stringify({ output: "runDir/video.mp4", seconds: 1, turns: 1, frames: 1 }) });
  await flush();
  finish(compactChild, { stdout: JSON.stringify({ runDir: "already compacted" }) });
  const result = await promise;
  assert.equal(result?.output, "runDir/video.mp4");
  assert.match(logs.at(-1)!, /Recording not compacted: already compacted\./);
});

test("the next render waits for the previous one's compaction to finish first", async () => {
  const events: string[] = [];
  const r1 = fakeProcess();
  const c1 = fakeProcess();
  const r2 = fakeProcess();
  const c2 = fakeProcess();
  const spawner = (tag: string, child: ChildProcess) => (args: string[]) => {
    events.push(`${tag}:${args[0]}`);
    return child;
  };

  const p1 = renderVideo("run1", () => {}, spawner("render", r1), spawner("compact", c1));
  await flush();
  finish(r1, { stdout: JSON.stringify({ output: "run1/video.mp4", seconds: 1, turns: 1, frames: 1 }) });
  await flush();
  // run2 is queued while run1's compaction is still pending; its render must not start yet.
  const p2 = renderVideo("run2", () => {}, spawner("render", r2), spawner("compact", c2));
  await flush();
  assert.deepEqual(events, ["render:run1", "compact:run1"]);
  finish(c1, { stdout: JSON.stringify({ run1: "no frames to compact" }) });
  await p1;
  await flush();
  assert.deepEqual(events, ["render:run1", "compact:run1", "render:run2"]);
  finish(r2, { stdout: JSON.stringify({ output: "run2/video.mp4", seconds: 1, turns: 1, frames: 1 }) });
  await flush();
  finish(c2, { stdout: JSON.stringify({ run2: "no frames to compact" }) });
  await p2;
});

test("a background render starts the queue detached, marks the run pending and returns at once", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "arena-video-"));
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  let unref = 0;
  const child = renderInBackground(dir, "series/runner.log", "Episode 2: ", (command, args, options) => {
    calls.push({ command, args, options: options as Record<string, unknown> });
    return Object.assign(new EventEmitter(), { unref: () => { unref++; } }) as unknown as ChildProcess;
  });
  assert.ok(child);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[0], /tools\/video\/render-queue\.py$/);
  assert.deepEqual(calls[0].args.slice(1), [dir, "--log", "series/runner.log", "--prefix", "Episode 2: "]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(unref, 1, "the runner does not wait for it");
  assert.ok(existsSync(path.join(dir, "render.pending")));
  assert.equal(readFileSync(path.join(dir, "render.log"), "utf8"), "", "its output goes to the run's render.log");
});
