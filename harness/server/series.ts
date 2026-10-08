/**
 * The record of a series of benchmark episodes (npm run episodes) and the rules for running an
 * episode again. An episode counts when it is a full-budget score or when the model itself ended
 * it; an episode stopped by the operator or ended by the harness, the game, the network or the
 * provider is run again, from the same playbook, so a series can be paused and resumed.
 */
import type { BenchmarkStamp, ModelSettings, Run, RunConfig } from "../shared/protocol.js";

/** What became of one run of an episode. */
export type Outcome =
  /** A full-budget score. */
  | "valid"
  /** The model ended the run (see MODEL_FAILURES); it counts, invalid. */
  | "model_failure"
  /** Stopped by the operator (Ctrl-C, the dashboard, the control monitor, a host shutdown). */
  | "stopped"
  /** Anything else: the harness, game, reader, network, provider, memory guard or a limit. */
  | "infrastructure";

/** Errors that mean the model, not the harness, ended the run. */
export const MODEL_FAILURES = [
  /No tool calls in \d+ replies in a row/,
  /Model stopped: length/,
  /did not finish its preparation reply with BEGIN/,
];

export type Attempt = {
  episode: number;
  attempt: number;
  outcome: Outcome;
  reason?: string;
  run?: string;
  folder?: string;
  status?: string;
  net_worth?: number;
  net_worth_growth?: number;
  valid?: boolean;
  invalid?: string[];
  error?: string;
};

/** Everything an episode of the series is run with; a resume must match it. */
export type SeriesSettings = {
  save: string;
  map?: string;
  benchmark: string;
  /** The model profile and the settings it had when the series started. */
  model: { profileId: string; name: string; modelId: string; baseUrl: string } & ModelSettings;
  prompt: string;
  config: RunConfig;
  /** Whether the playbook carries over (a learning series) or the episodes are independent. */
  learning: boolean;
  /** The host's benchmark version and code when the series started. */
  version: BenchmarkStamp & { commit: string | null };
};

export type SeriesRecord = {
  id: string;
  save: string;
  map?: string;
  benchmark: string;
  /** The model profile's name. */
  model: string;
  episodes: number;
  /** Every run of every episode, in order; an episode's last attempt is its result. */
  results: Attempt[];
  status: "running" | "paused" | "completed";
  /** Why the series stopped before its last episode. */
  stopped?: string;
  settings: SeriesSettings;
};

export function classify(input: {
  run?: Run;
  valid?: boolean;
  invalid?: string[];
  /** The runner's own error, when the episode failed outside the agent run. */
  error?: string;
  /** The operator asked the runner to stop. */
  stopRequested?: boolean;
}): { outcome: Outcome; reason?: string } {
  const { run } = input;
  if (input.stopRequested || run?.status === "stopped")
    return { outcome: "stopped", reason: run?.progress?.stopReason ? `stopped (${run.progress.stopReason})` : "stopped by the operator" };
  if (input.error || !run) return { outcome: "infrastructure", reason: input.error ?? "no agent run" };
  if (input.valid) return { outcome: "valid" };
  const endError = run.progress?.endError ?? "";
  if (run.status === "error" && MODEL_FAILURES.some((pattern) => pattern.test(endError)))
    return { outcome: "model_failure", reason: endError };
  return { outcome: "infrastructure", reason: [...(input.invalid ?? []), ...(endError ? [endError] : [])].join("; ") || run.status };
}

/** An attempt the series keeps as the episode's result. */
export const counts = (attempt: Attempt) => attempt.outcome === "valid" || attempt.outcome === "model_failure";

/** The episode's result: its counting attempt, if any. */
export function resultOf(results: Attempt[], episode: number) {
  return results.filter((a) => a.episode === episode && counts(a)).at(-1);
}

/** The first episode without a result, or null when every episode has one. */
export function nextEpisode(record: Pick<SeriesRecord, "results" | "episodes">) {
  for (let n = 1; n <= record.episodes; n++) if (!resultOf(record.results, n)) return n;
  return null;
}

export function nextAttempt(results: Attempt[], episode: number) {
  return results.filter((a) => a.episode === episode).length + 1;
}

/** Differences between the settings a series started with and what a resume would run. */
export function settingsDifferences(series: SeriesSettings, now: { version: SeriesSettings["version"]; model: SeriesSettings["model"] }) {
  const differences: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (series.version.version !== now.version.version) differences.push(`benchmark version ${series.version.version} → ${now.version.version}`);
  if (series.version.fingerprint !== now.version.fingerprint) differences.push("benchmark fingerprint");
  if (series.version.guide !== now.version.guide) differences.push("preparation guide images");
  if (series.version.commit !== now.version.commit) differences.push(`code commit ${series.version.commit?.slice(0, 7)} → ${now.version.commit?.slice(0, 7)}`);
  for (const key of ["modelId", "baseUrl", "reasoning", "maxTokens", "providers", "allowFallbacks"] as const)
    if (!same(series.model[key], now.model[key])) differences.push(`model ${key} ${JSON.stringify(series.model[key])} → ${JSON.stringify(now.model[key])}`);
  return differences;
}
