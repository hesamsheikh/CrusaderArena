import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildReport, renderJson, renderMarkdown, scanEvents, seriesRows } from "./run-report.js";

const START = Date.parse("2026-09-29T12:00:00Z");

/** Synthetic run directories; none of this is real run data. */
const root = () => mkdtempSync(path.join(tmpdir(), "arena-report-"));
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const event = (event: Record<string, unknown>) => ({ at: 1, event });
const usage = (input: number, output: number, cacheRead: number, cacheWrite = 0) =>
  ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite });
const toolStart = (id: string, toolName: string, args: unknown = {}) => event({ type: "tool_execution_start", toolCallId: id, toolName, args });
const toolEnd = (id: string, toolName: string, result: unknown, isError = false) =>
  event({
    type: "tool_execution_end", toolCallId: id, toolName, isError,
    result: { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }, { type: "image", data: "AAAA" }] },
  });
const stats = (gameTime: number, extra: Record<string, unknown> = {}) => ({
  width: 1920, height: 1080,
  stats: {
    status: "ok",
    observation: {
      map_name: "Test Map", game_time: gameTime, gold: 900, population: 12, popularity: 80,
      own_troops: { total: 0 }, structures: { count: 9 }, settlement: { housing_cap: 30, total_food: 44 }, ...extra,
    },
  },
});

function writeRun(dir: string, folder: string, files: Record<string, string | object>) {
  const run = path.join(dir, folder);
  mkdirSync(run, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(run, name), typeof body === "string" ? body : JSON.stringify(body));
  return run;
}

function completeRun(dir: string) {
  writeRun(dir, "Model-A-Oasis-construction-20260929-120000Z-2026-09-29T12-00-00-000Z-aaaaaaaa", {
    "run.json": {
      id: "aaaaaaaa-1111-2222-3333-444444444444", model: { name: "Model A", modelId: "vendor/model-a" },
      benchmarkType: "Oasis construction", startedAt: START, endedAt: START + 900_000, status: "completed", turns: 3, tokens: 4170,
      progress: {
        compactions: 1, inference: { totalMs: 12_500 }, stopReason: "deadline",
        budget: { gameSeconds: 600, usedGameSeconds: 600.4, wallUsedSeconds: 880.5, endedBy: "game_time" },
        memory: { samples: 10, maxGameRssMiB: 3100, minAvailableMiB: 4500 },
      },
    },
    "episode.json": {
      episode: 1, benchmark: "Oasis construction", source: "final", map: "Oasis", gold: 970, population: 37, housing: 74,
      popularity: 100, total_food: 53, structures_map_wide: 33, troops: 0,
      // No net_worth recorded (older runner): the report values the goods itself.
      goods: { wood_planks: 10, stone: 20, iron: 2 },
    },
    "events.jsonl": jsonl([
      event({ type: "preparation_reply", reply: { role: "assistant", usage: usage(100, 10, 0) } }),
      // Skipped by the scanner: not an assistant message.
      event({ type: "message_end", message: { role: "user", usage: usage(9999, 9999, 9999) } }),
      // A first request that writes 400 tokens to the cache (Claude reports writes apart from input).
      event({ type: "message_end", message: { role: "assistant", usage: usage(1000, 40, 0, 400) } }),
      event({ type: "message_end", message: { role: "assistant", usage: usage(500, 20, 1500) } }),
      event({ type: "compaction_usage", usage: usage(600, 0, 0) }),
      // What OpenRouter billed; run.json has no total, so the report adds these up.
      event({ type: "request_cost", kind: "gameplay", dollars: 0.0125 }),
      event({ type: "request_cost", kind: "compaction", dollars: 0.0105 }),
      event({ type: "memory_sample", gameRssMiB: 2000 }),
      event({ type: "turn_start" }),
      toolStart("c1", "build_structure", { placements: [{ name: "Hovel", x: 1, y: 1 }, { name: "Farm", x: 2, y: 2 }, { name: "Well", x: 3, y: 3 }] }),
      toolEnd("c1", "build_structure", {
        placements: [
          { building: "Hovel", status: "placed" },
          { building: "Farm", status: "placed", retries: 2, retryMethod: "tile_map" },
          { building: "Well", status: "not_placed", retrySkipped: "no_free_spot_nearby", missing: { wood: 5 } },
        ],
      }),
      toolStart("c2", "build_structure", { placements: [{ name: "Hovel", x: 1, y: 1 }, { name: "Hovel", x: 5, y: 5 }] }),
      toolEnd("c2", "build_structure", "Placement target overlaps the bottom HUD; choose visible world terrain.", true),
      toolStart("c3", "place_near", { anchor: "stockpile", building: "Stockpile", count: 2 }),
      toolEnd("c3", "place_near", { status: "partly_placed", anchor: "stockpile", placed: [{ x: 1, y: 1 }], probes: 2 }),
      toolStart("c4", "expand_storage", { count: 1 }),
      toolEnd("c4", "expand_storage", { status: "not_placed", anchor: "stockpile", placed: [], probes: 20, stopped: "probe_limit" }),
      toolStart("c5", "observe"),
      toolEnd("c5", "observe", stats(1000)),
      toolStart("c6", "wait_and_observe"),
      toolEnd("c6", "wait_and_observe", stats(19000)),
    ]),
  });
}

/** An early-format run: no budget, memory, episode or retry fields; flat build results. */
function oldRun(dir: string) {
  writeRun(dir, "Old-Bench-20260924-100000Z-2026-09-24T10-00-00-000Z-bbbbbbbb", {
    "run.json": {
      id: "bbbbbbbb-1111-2222-3333-444444444444", model: { name: "Model B", modelId: "model-b" },
      benchmarkType: "Cactus Valley construction", startedAt: Date.parse("2026-09-24T10:00:00Z"), endedAt: Date.parse("2026-09-24T10:05:00Z"),
      status: "error", turns: 2, tokens: 300, config: { durationSeconds: 300 }, progress: { stopReason: "error" },
    },
    "logs.jsonl": jsonl([
      { id: "1", at: 1, kind: "error", text: "Error: Provider returned an empty response" },
      { id: "2", at: 2, kind: "system", text: "Run error: error." },
    ]),
    "events.jsonl": jsonl([
      event({ type: "message_end", message: { role: "assistant", usage: usage(200, 50, 50) } }),
      toolStart("c1", "build_structure", { placements: [{ name: "Granary", x: 480, y: 520 }] }),
      toolEnd("c1", "build_structure", { building: "Granary", status: "unverified", feedback: [] }),
      toolStart("c2", "observe"),
      toolEnd("c2", "observe", stats(60000, { gold: 500, population: 3 })),
      toolStart("c3", "observe"),
      toolEnd("c3", "observe", stats(63000, { gold: 480, population: 4 })),
    ]),
  });
}

/** Still being written: run.json says running, no episode, and events.jsonl stops mid-line. */
function incompleteRun(dir: string) {
  const run = writeRun(dir, "Live-Bench-20260929-130000Z-2026-09-29T13-00-00-000Z-cccccccc", {
    "run.json": {
      id: "cccccccc-1111-2222-3333-444444444444", model: { name: "Model A", modelId: "vendor/model-a" },
      benchmarkType: "Oasis construction", startedAt: Date.parse("2026-09-29T13:00:00Z"), endedAt: null, status: "running", turns: 1, tokens: 700,
      progress: { budget: { gameSeconds: 600, usedGameSeconds: 42, wallUsedSeconds: 120 } },
    },
    "events.jsonl": jsonl([
      event({ type: "message_end", message: { role: "assistant", usage: usage(600, 100, 0) } }),
      toolStart("c1", "build_structure", { placements: [{ name: "Hovel", x: 1, y: 1 }] }),
    ]),
  });
  appendFileSync(path.join(run, "events.jsonl"), '{"at":5,"event":{"type":"tool_execution_end","toolCallId":"c1","toolNa');
}

test("a complete run reports budget, tokens, scorecard, build results and retries", async () => {
  const dir = root();
  completeRun(dir);
  const [row] = await buildReport(dir);
  assert.equal(row.id, "aaaaaaaa");
  assert.equal(row.model, "Model A");
  assert.equal(row.benchmark, "Oasis construction");
  assert.equal(row.map, "Oasis");
  assert.equal(row.ended, "game_time");
  assert.equal(row.gameSeconds, 600.4);
  assert.equal(row.gameSecondsSource, "budget");
  assert.equal(row.wallSeconds, 880.5);
  assert.equal(row.inferenceSeconds, 12.5);
  assert.equal(row.turns, 3);
  // In + cache reads + cache writes + output add up to the run total; 1500 of 4100 input tokens came from the cache.
  assert.deepEqual(row.tokens, { total: 4170, input: 2200, output: 70, cacheRead: 1500, cacheWrite: 400, cachedShare: 1500 / 4100 });
  assert.match(renderMarkdown([row]), /\| 2\.2k \| 1\.5k \| 400 \| 37% \| 70 \| \$0\.023 \|/);
  assert.ok(Math.abs(row.cost! - 0.023) < 1e-12);
  assert.ok(Math.abs(row.tokensPerGameMinute! - 4170 / (600.4 / 60)) < 1e-9);
  assert.deepEqual(row.scorecard, {
    // Recorded before episode.json had `valid`.
    source: "final", valid: null, population: 37, housing: 74, popularity: 100, gold: 970,
    // 970 gold + 10 wood × 1 + 20 stone × 7 + 2 iron × 23 at the sell prices.
    netWorth: 1166, netWorthGrowth: null, netWorthBaseline: null, totalFood: 53, structures: 33, troops: 0,
  });
  assert.equal(row.tools?.build_structure, 2);
  assert.equal(row.tools?.observe, 1);
  assert.equal(row.toolErrors, 1);
  // Three placements in the first call, plus the two carried by the failed call.
  assert.equal(row.build?.attempts, 5);
  assert.equal(row.build?.placed, 2);
  assert.equal(row.build?.failed, 3);
  assert.equal(row.build?.retries, 2);
  assert.deepEqual(row.build?.retryMethods, { tile_map: 1 });
  assert.deepEqual(row.build?.retrySkipped, { no_free_spot_nearby: 1 });
  assert.equal(row.build?.missing, 1);
  assert.deepEqual(row.anchor, { calls: 2, placed: 1, failed: 1, partlyPlaced: 1 });
  assert.equal(row.memory.peakGameRssMiB, 3100);
  assert.equal(row.memory.minAvailableMiB, 4500);
  assert.equal(row.incomplete, false);
});

test("an old-format run shows blanks instead of failing and derives what it can", async () => {
  const dir = root();
  oldRun(dir);
  const [row] = await buildReport(dir);
  assert.equal(row.ended, "error");
  assert.equal(row.endDetail, "Provider returned an empty response");
  assert.equal(row.gameSeconds, 100);
  assert.equal(row.gameSecondsSource, "observed");
  assert.equal(row.wallSeconds, 300);
  assert.equal(row.budgetGameSeconds, null);
  assert.equal(row.memory.peakGameRssMiB, null);
  assert.equal(row.scorecard.source, "last_tool_observation");
  assert.equal(row.scorecard.gold, 480);
  assert.equal(row.scorecard.population, 4);
  assert.equal(row.build?.attempts, 1);
  assert.equal(row.build?.unverified, 1);
  assert.equal(row.build?.failed, 0);
  assert.equal(row.build?.retries, 0);
  const markdown = renderMarkdown([row]);
  assert.match(markdown, /error: Provider returned an empty response/);
  assert.match(markdown, /~100/);
  assert.doesNotMatch(markdown, /undefined|NaN|null/);
});

test("an incomplete run survives a half-written events line and a missing run.json", async () => {
  const dir = root();
  incompleteRun(dir);
  writeRun(dir, "Orphan-20260929-140000Z-2026-09-29T14-00-00-000Z-dddddddd", { "logs.jsonl": "" });
  const rows = await buildReport(dir);
  assert.equal(rows.length, 2);
  const [live, orphan] = rows;
  assert.equal(live.ended, "running");
  assert.equal(live.incomplete, true);
  assert.equal(live.gameSeconds, 42);
  assert.equal(live.tokens.total, 700);
  assert.equal(live.tools?.build_structure, 1);
  // Started but never finished: no result, so nothing is counted as placed or failed.
  assert.equal(live.build?.attempts, 0);
  assert.equal(live.scorecard.source, null);
  assert.equal(orphan.id, "dddddddd");
  assert.equal(orphan.started, "2026-09-29T14:00:00.000Z");
  assert.equal(orphan.ended, "incomplete");
  assert.equal(orphan.incomplete, true);
  assert.equal(orphan.model, null);
  assert.match(renderMarkdown(rows), /cccccccc\*/);
  // Every row keeps the same keys in JSON, with null for unknowns.
  const parsed = JSON.parse(renderJson(rows));
  assert.equal(parsed[1].tokens.total, null);
  assert.equal(parsed[1].tools, null);
});

test("filters select by benchmark, model and start date; the table is one row per run", async () => {
  const dir = root();
  completeRun(dir);
  oldRun(dir);
  incompleteRun(dir);
  assert.equal((await buildReport(dir)).length, 3);
  assert.deepEqual((await buildReport(dir, { benchmark: "oasis" })).map((r) => r.id), ["aaaaaaaa", "cccccccc"]);
  assert.deepEqual((await buildReport(dir, { benchmark: "cactus valley" })).map((r) => r.id), ["bbbbbbbb"]);
  assert.deepEqual((await buildReport(dir, { model: "vendor/model-a" })).map((r) => r.id), ["aaaaaaaa", "cccccccc"]);
  assert.deepEqual((await buildReport(dir, { model: "MODEL B" })).map((r) => r.id), ["bbbbbbbb"]);
  assert.deepEqual((await buildReport(dir, { since: Date.parse("2026-09-29") })).map((r) => r.id), ["aaaaaaaa", "cccccccc"]);
  assert.deepEqual(await buildReport(dir, { model: "nobody" }), []);
  const lines = renderMarkdown(await buildReport(dir)).split("\n").filter((line) => line.startsWith("|"));
  assert.equal(lines.length, 2 + 3);
});

test("scanEvents reads the full reader sample from details when the model saw a summary", async () => {
  const dir = root();
  const full = stats(5400, { gold: 777 }).stats;
  writeRun(dir, "x", {
    "events.jsonl": jsonl([
      toolStart("c1", "observe"),
      event({
        type: "tool_execution_end", toolCallId: "c1", toolName: "observe", isError: false,
        result: {
          content: [{ type: "text", text: JSON.stringify({ stats: { status: "ok", gold: 777 } }) }],
          details: { frameId: "f", readerStats: full },
        },
      }),
    ]),
  });
  const summary = await scanEvents(path.join(dir, "x", "events.jsonl"));
  assert.equal(summary?.observations, 1);
  assert.equal(summary?.lastObservation?.gold, 777);
  assert.equal(summary?.lastGameTime, 5400);
});

test("scanEvents ignores a missing file and a run with no usage", async () => {
  const dir = root();
  assert.equal(await scanEvents(path.join(dir, "nope.jsonl")), undefined);
  writeRun(dir, "x", { "events.jsonl": jsonl([event({ type: "turn_start" })]) });
  const summary = await scanEvents(path.join(dir, "x", "events.jsonl"));
  assert.equal(summary?.usage, undefined);
  assert.equal(summary?.turnStarts, 1);
  assert.equal(summary?.complete, true);
});

test("a learning series is scored by its last episode, with the change from the first", async () => {
  const dir = root();
  const series = (episode: number) => ({ id: "20261008-series1", episode, episodes: 3 });
  // Episode 2 failed before any reading; the series still has a final score. Episode 3 hit the
  // real-time limit, so its net worth is marked as not a full-budget score.
  for (const [episode, worth, cost] of [[1, 1300, 0.4], [2, null, 0.1], [3, 1650, 0.5]] as const)
    writeRun(dir, `Model-A-Oasis-20261008-12000${episode}Z-2026-10-08T12-00-0${episode}-000Z-s000000${episode}`, {
      "run.json": {
        id: `s000000${episode}-1111-2222-3333-444444444444`, model: { name: "Model A", modelId: "vendor/model-a" },
        benchmarkType: "Oasis construction", startedAt: START + episode * 1000, status: "completed", turns: 3, tokens: 100,
        cost, series: series(episode),
      },
      ...(worth === null ? {} : { "episode.json": {
        episode, series: series(episode), source: "final", map: "Oasis", gold: worth, population: 10, net_worth: worth,
        ...(episode === 3 ? { valid: false, invalid: ["ended by wall_limit"] } : { valid: true }),
      } }),
    });
  completeRun(dir);
  const rows = await buildReport(dir);
  const [row] = seriesRows(rows);
  assert.equal(seriesRows(rows).length, 1);
  assert.deepEqual(row.netWorth, [1300, null, 1650]);
  assert.deepEqual(row.valid, [true, null, false]);
  assert.equal(row.final, 1650);
  assert.equal(row.change, 350);
  assert.ok(Math.abs(row.cost! - 1.0) < 1e-12);
  assert.match(renderMarkdown(rows), /\| 20261008-series1 \| Model A \| Oasis construction \| 1300 → – → 1650! \| 1650! \| \+350 \| \$1\.00 \|/);
});

test("growth is net worth minus what doing nothing scores on the same save and budget", async () => {
  const dir = root();
  // An older episode.json stored growth against the starting package; the report recomputes it.
  for (const [id, minutes] of [["g0000025", 25], ["g0000010", 10]] as const)
    writeRun(dir, `Model-A-Oasis-20261008-170000Z-2026-10-08T17-00-00-000Z-${id}`, {
      "run.json": {
        id: `${id}-1111-2222-3333-444444444444`, model: { name: "Model A", modelId: "vendor/model-a" },
        benchmarkType: "Oasis by the Sea construction", startedAt: START, status: "completed", turns: 3, tokens: 100,
        config: { gameMinutes: minutes },
      },
      "episode.json": { episode: 1, save: "Oasis by the Sea-1", source: "final", gold: 1100, population: 20, net_worth: 1500, net_worth_growth: 75 },
    });
  const rows = await buildReport(dir);
  const scored = rows.find((r) => r.id === "g0000025")!;
  assert.equal(scored.scorecard.netWorthBaseline, 1304);
  assert.equal(scored.scorecard.netWorthGrowth, 196);
  // No baseline was measured for a 10-minute budget, so that run has no growth.
  const other = rows.find((r) => r.id === "g0000010")!;
  assert.equal(other.scorecard.netWorthBaseline, null);
  assert.equal(other.scorecard.netWorthGrowth, null);
});
