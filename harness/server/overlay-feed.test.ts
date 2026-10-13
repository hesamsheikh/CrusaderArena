import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OverlayStatusReader } from "./overlay-feed.js";
import { needsOverlayFeed } from "./version-checkout.js";

/** An earlier version's /api/state during a run: the run's progress as its last turn left it. */
function state(used: number, gameTime: number, extra: Record<string, unknown> = {}) {
  return {
    running: true,
    activeRunId: "r1",
    turns: 11,
    tokens: 350000,
    runs: [{
      id: "r1", folder: "run-r1", name: "Muse Wonder · Oasis by the Sea construction · 20261013", status: "running", cost: 0.617,
      model: { name: "Muse Wonder" },
      progress: { phase: "thinking", budget: { gameSeconds: 2000, usedGameSeconds: used, wallLimitSeconds: 21600, wallUsedSeconds: 300 } },
    }],
    stats: { status: "ok", observation: { game_time: gameTime, gold: 1000, population: 12, popularity: 100, resources_by_name: { stone: 25, wood_planks: 25 } } },
    ...extra,
  };
}

test("the overlay's figures come from an earlier version's host state", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "overlay-feed-"));
  const s = new OverlayStatusReader(dir).status(state(330, 20_000));
  assert.equal(s.phase, "THINKING");
  assert.equal(s.model, "Muse Wonder");
  assert.equal(s.run, "Muse Wonder · Oasis by the Sea construction · 20261013");
  assert.deepEqual(s.clock, { used: 330, total: 2000 });
  assert.equal(s.cost, 0.617);
  assert.equal(s.turns, 11);
  assert.deepEqual(s.stats, { gold: 1000, population: 12, popularity: 100, net_worth: 1000 + 25 * 7 + 25 });
});

test("between the host's updates the clock runs on with the game's ticks, never back", () => {
  const reader = new OverlayStatusReader(mkdtempSync(path.join(os.tmpdir(), "overlay-feed-")));
  assert.equal(reader.status(state(330, 20_000)).clock?.used, 330);
  // 40 ticks a real second for 30 s: 1,200 ticks = 40 game seconds, with the host's figure unchanged.
  assert.equal(reader.status(state(330, 21_200)).clock?.used, 370);
  // A turn ends: the host's figure catches up and becomes the new reference.
  assert.equal(reader.status(state(371, 21_230)).clock?.used, 371);
  assert.equal(reader.status(state(371, 21_260)).clock?.used, 372);
  assert.equal(reader.status(state(1999, 90_000)).clock?.used, 1999);
  assert.equal(reader.status(state(1999, 90_600)).clock?.used, 2000, "held to the budget");
  assert.equal(reader.status(state(400, 0, { stats: { status: "stale", observation: null } })).clock?.used, 400, "no reading: the host's figure");
  assert.equal(reader.status(state(400, 21_300, { running: false })).clock, null, "no run, no clock");
});

test("tool calls are counted from the run's events as the file grows", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "overlay-feed-"));
  mkdirSync(path.join(dir, "run-r1"));
  const events = path.join(dir, "run-r1", "events.jsonl");
  const call = JSON.stringify({ at: 1, event: { type: "tool_execution_start", toolName: "status" } }) + "\n";
  const reader = new OverlayStatusReader(dir);
  assert.equal(reader.status(state(1, 1)).tool_calls, null, "no events yet");
  appendFileSync(events, call + JSON.stringify({ at: 2, event: { type: "request_cost" } }) + "\n" + call.slice(0, 20));
  assert.equal(reader.status(state(1, 1)).tool_calls, 1, "a half-written line waits");
  appendFileSync(events, call.slice(20) + call);
  assert.equal(reader.status(state(1, 1)).tool_calls, 3);
});

test("this checkout has its own overlay, so only earlier rounds need the feed", () => {
  assert.equal(needsOverlayFeed("."), false);
});
