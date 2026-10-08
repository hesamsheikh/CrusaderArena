import test from "node:test";
import assert from "node:assert/strict";
import type { Run } from "../shared/protocol.js";
import { classify, counts, nextAttempt, nextEpisode, resultOf, settingsDifferences, type Attempt, type SeriesSettings } from "./series.js";

const run = (status: Run["status"], progress: Partial<NonNullable<Run["progress"]>> = {}) =>
  ({ status, progress } as unknown as Run);

test("an episode counts when valid or ended by the model; stops and other failures are run again", () => {
  assert.deepEqual(classify({ run: run("completed"), valid: true }), { outcome: "valid" });
  assert.equal(classify({ run: run("error", { endError: "Error: No tool calls in 4 replies in a row." }), valid: false }).outcome, "model_failure");
  assert.equal(classify({ run: run("error", { endError: "Error: Model stopped: length" }), valid: false }).outcome, "model_failure");
  // The operator: Ctrl-C in the runner, the dashboard or monitor (a stopped run), a host shutdown.
  assert.equal(classify({ run: run("stopped", { stopReason: "stopped" }), valid: false }).outcome, "stopped");
  assert.equal(classify({ error: "Timed out waiting for the save to load.", stopRequested: true }).outcome, "stopped");
  // The harness, game, provider or a limit.
  const memory = classify({ run: run("completed", { stopReason: "memory_guard" }), valid: false, invalid: ["ended by memory_guard"] });
  assert.deepEqual(memory, { outcome: "infrastructure", reason: "ended by memory_guard" });
  assert.equal(classify({ run: run("error", { endError: "Error: 502 Provider returned error" }), valid: false }).outcome, "infrastructure");
  assert.equal(classify({ run: run("completed"), valid: false, invalid: ["ended by wall_limit"] }).outcome, "infrastructure");
  assert.equal(classify({ run: run("interrupted"), valid: false }).outcome, "infrastructure");
  assert.equal(classify({ error: "game-session launch: no result" }).outcome, "infrastructure");
});

test("a series resumes at the first episode without a result, counting attempts", () => {
  const results: Attempt[] = [
    { episode: 1, attempt: 1, outcome: "valid", net_worth: 1400 },
    { episode: 2, attempt: 1, outcome: "infrastructure" },
    { episode: 2, attempt: 2, outcome: "stopped" },
  ];
  assert.equal(nextEpisode({ results, episodes: 3 }), 2);
  assert.equal(nextAttempt(results, 2), 3);
  assert.equal(resultOf(results, 2), undefined);
  results.push({ episode: 2, attempt: 3, outcome: "model_failure", net_worth: 900 });
  assert.equal(nextEpisode({ results, episodes: 3 }), 3);
  assert.equal(resultOf(results, 2)?.attempt, 3);
  assert.ok(counts(results.at(-1)!));
  results.push({ episode: 3, attempt: 1, outcome: "valid" });
  assert.equal(nextEpisode({ results, episodes: 3 }), null);
});

test("a resume refuses another benchmark version, commit, guide or model setting", () => {
  const settings = {
    model: { profileId: "p", name: "GLM", modelId: "z-ai/glm", baseUrl: "https://openrouter.ai/api/v1", reasoning: "medium", maxTokens: 32768, providers: ["z-ai/fp8"], allowFallbacks: false },
    version: { version: "v1", fingerprint: "f1", guide: "g", commit: "abc1234" },
  } as SeriesSettings;
  assert.deepEqual(settingsDifferences(settings, settings), []);
  const changed = settingsDifferences(settings, {
    model: { ...settings.model, reasoning: "high" },
    version: { ...settings.version, version: "v2", fingerprint: "f2", commit: "def5678" },
  });
  assert.deepEqual(changed, [
    "benchmark version v1 → v2",
    "benchmark fingerprint",
    "code commit abc1234 → def5678",
    'model reasoning "medium" → "high"',
  ]);
});
