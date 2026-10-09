import { test } from "node:test";
import assert from "node:assert/strict";
import { backfillEvents, modelCost, requestCost } from "./cost.js";
import { costProblem } from "../shared/protocol.js";

// Claude Haiku 5.5's list prices (Anthropic's pricing page, 2026-10-09).
const haiku = {
  input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
  longPrompt: { above: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
};
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);

test("a request is priced by its whole prompt: input, cache reads and cache writes", () => {
  close(requestCost(haiku, { input: 1000, cacheRead: 50000, cacheWrite: 2000, output: 500 }), 0.0011);
  // 103,000 prompt tokens: every token of the request at the long-prompt rates.
  close(requestCost(haiku, { input: 1000, cacheRead: 100000, cacheWrite: 2000, output: 500 }), 0.008);
  close(requestCost(haiku, { input: 98000, cacheRead: 2000, output: 10 }), (0.1 * 98000 + 0.01 * 2000 + 0.5 * 10) / 1e6);
  // A 1-hour cache write costs twice the input rate.
  close(requestCost(haiku, { cacheWrite: 1000, cacheWrite1h: 400 }), (0.125 * 600 + 0.2 * 400) / 1e6);
  assert.deepEqual(modelCost(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(modelCost(haiku).tiers, [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }]);
});

test("runs need prices unless OpenRouter reports what it billed", () => {
  assert.equal(costProblem({ baseUrl: "https://openrouter.ai/api/v1" }), null);
  assert.match(costProblem({ baseUrl: "https://api.anthropic.com" })!, /prices/);
  assert.match(costProblem({ baseUrl: "https://api.moonshot.ai/v1" })!, /prices/);
  assert.equal(costProblem({ baseUrl: "https://api.anthropic.com", prices: haiku }), null);
});

test("backfilling puts a cost after every request that used tokens", () => {
  const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output });
  const lines = [
    { at: 1, event: { type: "preparation_reply", reply: { usage: usage(1000, 100) } } },
    { at: 2, event: { type: "message_end", message: { role: "user", content: "Go." } } },
    { at: 3, event: { type: "message_end", message: { role: "assistant", usage: usage(2000, 200) } } },
    // Refused before it started: no tokens, no cost.
    { at: 4, event: { type: "message_end", message: { role: "assistant", usage: usage(0, 0) } } },
    { at: 5, event: { type: "compaction_usage", usage: usage(3000, 300) } },
    { at: 6, event: { type: "turn_start" } },
    { at: 7, event: { type: "reflection_usage", usage: usage(4000, 400) } },
  ];
  const filled = backfillEvents(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", haiku)!;
  const out = filled.text.trim().split("\n").map((line) => JSON.parse(line));
  const costs = out.filter((line) => line.event.type === "request_cost");
  assert.deepEqual(costs.map((line) => [line.at, line.event.kind]), [[1, "preparation"], [3, "gameplay"], [5, "compaction"], [7, "reflection"]]);
  assert.ok(costs.every((line) => line.event.source === "prices" && line.event.backfilled === true));
  // Each cost follows its request.
  assert.equal(out[out.indexOf(costs[1]) - 1].at, 3);
  assert.equal(filled.requests, 4);
  assert.equal(filled.lines, lines.length + 4);
  close(filled.dollars, (0.1 * 10000 + 0.5 * 1000) / 1e6);
  assert.equal(backfillEvents(filled.text, haiku), null, "a run that records costs is left alone");
});
