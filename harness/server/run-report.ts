/**
 * Compare saved benchmark runs: one row per run directory under harness/runtime/runs.
 * Offline and read-only; it never contacts the game, the dashboard or a model.
 *
 *   npm run report
 *   npm run report -- --benchmark "Oasis by the Sea" --model glm --since 2026-09-29
 *   npm run report -- --json > report.json
 *
 * Sources per run: run.json (model, status, budget, memory), episode.json (final scorecard),
 * logs.jsonl (the error that ended a failed run) and events.jsonl (token usage, tool calls and
 * results, last observation). Older runs lack some of these; missing values stay blank.
 * events.jsonl can be hundreds of MB (screenshots), so it is streamed and pre-filtered.
 */
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { netWorth } from "./market-prices.js";
import { idleBaseline } from "./baselines.js";
import { settingsLabel, type RunSeries } from "../shared/protocol.js";

/** "abc1234+def5678 p:0123abc t:4567def": commit (+ uncommitted changes), prompt and tool hashes. */
function harnessLabel(harness: Obj | undefined) {
  if (!harness || typeof harness.systemPromptSha256 !== "string") return null;
  const short = (value: unknown) => (typeof value === "string" ? value.slice(0, 7) : "?");
  const code = `${short(harness.commit)}${harness.dirty ? `+${short(harness.diffSha256)}` : ""}`;
  return `${code} p:${short(harness.systemPromptSha256)} t:${short(harness.toolsSha256)}`;
}

type Obj = Record<string, any>;

/** The game runs at 30 ticks per game second. */
const TICKS_PER_SECOND = 30;

export type BuildSummary = {
  /** build_structure placements requested (a failed call counts every placement it carried). */
  attempts: number;
  placed: number;
  /** Anything other than placed or unverified: rejected, not_placed, camera_moved, ... */
  failed: number;
  /** The clicks were delivered but nothing confirmed the building. */
  unverified: number;
  statuses: Record<string, number>;
  /** Extra clicks the harness made at other spots after a blocked target. */
  retries: number;
  retryMethods: Record<string, number>;
  retrySkipped: Record<string, number>;
  /** Placements refused for a resource shortfall (the `missing` field). */
  missing: number;
};

export type AnchorSummary = {
  /** place_near / expand_storage calls. */
  calls: number;
  /** Buildings placed across those calls. */
  placed: number;
  /** Calls that placed nothing (status not_placed) or errored. */
  failed: number;
  partlyPlaced: number;
};

export type EventSummary = {
  /** False when a line could not be parsed (typically the half-written last line of a live run). */
  complete: boolean;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** US dollars from request_cost events; absent when none were recorded. */
  cost?: number;
  /** "prices" when any of those costs came from the profile's prices rather than a provider's bill. */
  costSource?: "billed" | "prices";
  turnStarts: number;
  tools: Record<string, number>;
  toolErrors: number;
  build: BuildSummary;
  anchor: AnchorSummary;
  lastObservation?: Obj;
  firstGameTime?: number;
  lastGameTime?: number;
  /** Valid reader samples seen in tool results; a span needs at least two. */
  observations: number;
  peakGameRssMiB?: number;
};

export type RunRow = {
  folder: string;
  id: string;
  started: string | null;
  model: string | null;
  /** Reasoning, output limit and providers the run recorded (newer runs only). */
  modelSettings: string | null;
  /** Short commit, "+" and the change hash when the code was uncommitted; prompt and tool hashes. */
  harness: string | null;
  /** The benchmark version the run recorded (benchmark-versions.json); null before versioning. */
  benchmarkVersion: string | null;
  /** The learning series the run is an episode of, if any. */
  series: RunSeries | null;
  benchmark: string | null;
  map: string | null;
  status: string | null;
  ended: string;
  endDetail: string | null;
  gameSeconds: number | null;
  /** "budget": the host's game-time meter; "observed": last minus first reader tick in the tool results. */
  gameSecondsSource: "budget" | "observed" | null;
  budgetGameSeconds: number | null;
  wallSeconds: number | null;
  inferenceSeconds: number | null;
  turns: number | null;
  compactions: number | null;
  tokens: {
    total: number | null;
    /** Uncached input; cache reads and writes are counted apart from it. */
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    /** Share of all input tokens read from the provider's cache. */
    cachedShare: number | null;
  };
  tokensPerGameMinute: number | null;
  /** US dollars: billed by OpenRouter, or the run's tokens at its profile's prices. */
  cost: number | null;
  /** "billed" by the provider, or worked out from list "prices"; null without a cost. */
  costSource: "billed" | "prices" | null;
  scorecard: {
    /** "final" / "last_observed" as recorded by npm run episodes; "last_tool_observation" when rebuilt from events. */
    source: string | null;
    /** From episode.json: whether netWorth is a full-budget score (null when not recorded). */
    valid: boolean | null;
    population: number | null;
    housing: number | null;
    popularity: number | null;
    gold: number | null;
    /** Gold plus stored goods at the marketplace sell price. */
    netWorth: number | null;
    /** Net worth change since the start of the run (runs that recorded the start only). */
    /** Net worth minus netWorthBaseline; null without a baseline for the save and budget. */
    netWorthGrowth: number | null;
    /** What doing nothing scores on the same save and game minutes (baselines.ts). */
    netWorthBaseline: number | null;
    totalFood: number | null;
    structures: number | null;
    troops: number | null;
  };
  tools: Record<string, number> | null;
  toolErrors: number | null;
  build: BuildSummary | null;
  anchor: AnchorSummary | null;
  memory: { peakGameRssMiB: number | null; minAvailableMiB: number | null; samples: number | null };
  /** Set when events.jsonl ended mid-line or run.json was unreadable. */
  incomplete: boolean;
};

export type Filters = { benchmark?: string; model?: string; since?: number };

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const norm = (text: unknown) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

function readJson(file: string): Obj | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function emptyBuild(): BuildSummary {
  return { attempts: 0, placed: 0, failed: 0, unverified: 0, statuses: {}, retries: 0, retryMethods: {}, retrySkipped: {}, missing: 0 };
}

const bump = (counts: Record<string, number>, key: unknown, by = 1) => {
  const name = String(key);
  counts[name] = (counts[name] ?? 0) + by;
};

function toolText(result: Obj | undefined): string | undefined {
  const part = Array.isArray(result?.content) ? result.content.find((c: Obj) => c?.type === "text") : undefined;
  return typeof part?.text === "string" ? part.text : undefined;
}

/** Stream one events.jsonl, keeping only what the report needs; undefined when the file is absent. */
export async function scanEvents(file: string): Promise<EventSummary | undefined> {
  if (!existsSync(file)) return undefined;
  const out: EventSummary = {
    complete: true, turnStarts: 0, tools: {}, toolErrors: 0, build: emptyBuild(), observations: 0,
    anchor: { calls: 0, placed: 0, failed: 0, partlyPlaced: 0 },
  };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let sawUsage = false;
  const addUsage = (u: Obj | undefined) => {
    if (!u) return;
    sawUsage = true;
    usage.input += num(u.input) ?? 0;
    usage.output += num(u.output) ?? 0;
    usage.cacheRead += num(u.cacheRead) ?? 0;
    usage.cacheWrite += num(u.cacheWrite) ?? 0;
    usage.total += num(u.totalTokens) ?? 0;
  };
  const pending = new Map<string, Obj>();
  const wanted = [
    '"message_end"', '"preparation_reply"', '"compaction_usage"', '"reflection_usage"', '"request_cost"',
    '"tool_execution_start"', '"tool_execution_end"', '"turn_start"', '"memory_sample"',
  ];
  try {
    const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!wanted.some((needle) => line.includes(needle))) continue;
      let event: Obj | undefined;
      try {
        event = JSON.parse(line)?.event;
      } catch {
        out.complete = false;
        continue;
      }
      if (!event) continue;
      switch (event.type) {
        case "message_end":
          if (event.message?.role === "assistant") addUsage(event.message.usage);
          break;
        case "preparation_reply":
          addUsage(event.reply?.usage);
          break;
        case "compaction_usage":
        case "reflection_usage":
          addUsage(event.usage);
          break;
        case "request_cost":
          out.cost = (out.cost ?? 0) + (num(event.dollars) ?? 0);
          // Events before sources were recorded came from OpenRouter's bill.
          out.costSource = event.source === "prices" || out.costSource === "prices" ? "prices" : "billed";
          break;
        case "turn_start":
          out.turnStarts++;
          break;
        case "memory_sample": {
          const rss = num(event.gameRssMiB);
          if (rss !== null) out.peakGameRssMiB = Math.max(out.peakGameRssMiB ?? 0, rss);
          break;
        }
        case "tool_execution_start":
          bump(out.tools, event.toolName);
          pending.set(String(event.toolCallId), event);
          break;
        case "tool_execution_end":
          recordToolEnd(out, event, pending.get(String(event.toolCallId)));
          pending.delete(String(event.toolCallId));
          break;
      }
    }
  } catch {
    out.complete = false;
  }
  if (sawUsage) out.usage = usage;
  return out;
}

function recordToolEnd(out: EventSummary, end: Obj, start: Obj | undefined) {
  const name = String(end.toolName);
  const isError = end.isError === true;
  if (isError) out.toolErrors++;
  const text = toolText(end.result);
  let json: Obj | undefined;
  if (text && !isError) {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object") json = value;
    } catch {
      // Plain-text results (guide pages, acknowledgements) are not needed.
    }
  }
  // Every observing tool returns the reader's stats; the last valid one is the fallback scorecard.
  // Newer runs keep the full sample in details (the model sees a summary); older runs in the text.
  const readerStats = end.result?.details?.readerStats ?? json?.stats;
  const observation = readerStats?.status === "ok" ? readerStats.observation : undefined;
  if (observation) {
    out.lastObservation = observation;
    out.observations++;
    const tick = num(observation.game_time);
    if (tick !== null) {
      out.firstGameTime ??= tick;
      out.lastGameTime = tick;
    }
  }
  if (name === "build_structure") {
    const b = out.build;
    if (isError || !json) {
      // The whole call failed (for example "overlaps the bottom HUD"); it carried the requested placements.
      const carried = Array.isArray(start?.args?.placements) ? start!.args.placements.length : 1;
      b.attempts += carried;
      b.failed += carried;
      bump(b.statuses, "tool_error", carried);
      return;
    }
    // Older runs return one flat placement instead of a placements list.
    const entries: Obj[] = Array.isArray(json.placements) ? json.placements : json.status !== undefined ? [json] : [];
    for (const p of entries) {
      b.attempts++;
      bump(b.statuses, p.status);
      if (p.status === "placed") b.placed++;
      else if (p.status === "unverified") b.unverified++;
      else b.failed++;
      const retries = num(p.retries) ?? 0;
      b.retries += retries;
      if (retries && p.retryMethod) bump(b.retryMethods, p.retryMethod);
      if (p.retrySkipped) bump(b.retrySkipped, p.retrySkipped);
      if (p.missing) b.missing++;
    }
  } else if (name === "place_near" || name === "expand_storage") {
    const a = out.anchor;
    a.calls++;
    if (isError || !json) {
      a.failed++;
      return;
    }
    a.placed += Array.isArray(json.placed) ? json.placed.length : 0;
    if (json.status === "not_placed") a.failed++;
    if (json.status === "partly_placed") a.partlyPlaced++;
  }
}

/** Last error the run logged before "Run error: ...", which is what ended it. */
function lastLoggedError(dir: string): string | undefined {
  let last: string | undefined;
  try {
    for (const line of readFileSync(path.join(dir, "logs.jsonl"), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.kind === "error" && typeof entry.text === "string" && !entry.text.startsWith("Run error")) last = entry.text;
      } catch {
        // A half-written last line.
      }
    }
  } catch {
    return undefined;
  }
  return last?.replace(/^Error:\s*/, "").replace(/\s+/g, " ").trim();
}

function classifyEnd(run: Obj | undefined, errorText: string | undefined): { ended: string; detail: string | null } {
  if (!run) return { ended: "incomplete", detail: "run.json is missing or unreadable" };
  const status = typeof run.status === "string" ? run.status : "";
  const progress = run.progress ?? {};
  if (status === "completed") {
    // Older runs have no budget block: "deadline" was then a wall-clock duration.
    return { ended: progress.budget?.endedBy ?? (progress.stopReason === "turn_limit" ? "turn_limit" : "deadline"), detail: null };
  }
  if (status === "error") {
    if (errorText && /memory guard/i.test(errorText)) return { ended: "memory_guard", detail: errorText };
    return { ended: "error", detail: errorText ?? null };
  }
  return { ended: status || "incomplete", detail: null };
}

/** Folder names end in the ISO start time with dashes and the 8-hex run id. */
function folderIdentity(folder: string): { started: string | null; id: string } {
  const match = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-([0-9a-f]{8})$/.exec(folder);
  return match
    ? { started: `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`, id: match[6] }
    : { started: null, id: folder.slice(-8) };
}

export async function summarizeRun(dir: string): Promise<RunRow> {
  const folder = path.basename(dir);
  const run = readJson(path.join(dir, "run.json"));
  const episode = readJson(path.join(dir, "episode.json"));
  const events = await scanEvents(path.join(dir, "events.jsonl"));
  const progress: Obj = run?.progress ?? {};
  const budget: Obj = progress.budget ?? {};
  const fromFolder = folderIdentity(folder);
  const started = num(run?.startedAt) !== null ? new Date(run!.startedAt).toISOString() : fromFolder.started;
  const { ended, detail } = classifyEnd(run, run?.status === "error" ? lastLoggedError(dir) : undefined);

  // Game time: the host's meter when recorded, else the span of reader ticks seen in tool results.
  let gameSeconds = num(budget.usedGameSeconds);
  let gameSecondsSource: RunRow["gameSecondsSource"] = gameSeconds !== null ? "budget" : null;
  if (gameSeconds === null && events && events.observations >= 2 && events.firstGameTime !== undefined &&
      events.lastGameTime !== undefined && events.lastGameTime > events.firstGameTime) {
    gameSeconds = (events.lastGameTime - events.firstGameTime) / TICKS_PER_SECOND;
    gameSecondsSource = "observed";
  }
  const startedAt = num(run?.startedAt);
  const endedAt = num(run?.endedAt);
  const wallSeconds = num(budget.wallUsedSeconds) ??
    (startedAt !== null && endedAt !== null ? (endedAt - startedAt) / 1000 : null);

  const usage = events?.usage;
  const total = num(run?.tokens) ?? usage?.total ?? null;
  const tokensPerGameMinute = total !== null && gameSeconds ? total / (gameSeconds / 60) : null;
  const allInput = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;

  // Scorecard: episode.json when it carries a reading, else the last valid observation in the events.
  const observed = events?.lastObservation;
  const useEpisode = num(episode?.population) !== null;
  const card: RunRow["scorecard"] = useEpisode
    ? {
        source: typeof episode!.source === "string" ? episode!.source : "episode",
        valid: typeof episode!.valid === "boolean" ? episode!.valid : null,
        population: num(episode!.population),
        housing: num(episode!.housing),
        popularity: num(episode!.popularity),
        gold: num(episode!.gold),
        netWorth: num(episode!.net_worth) ?? (num(episode!.gold) !== null ? netWorth(num(episode!.gold), episode!.goods as Record<string, number>).netWorth : null),
        netWorthGrowth: null,
        netWorthBaseline: null,
        totalFood: num(episode!.total_food),
        structures: num(episode!.structures_map_wide),
        troops: num(episode!.troops),
      }
    : {
        source: observed ? "last_tool_observation" : null,
        valid: null,
        population: num(observed?.population),
        housing: num(observed?.settlement?.housing_cap),
        popularity: num(observed?.popularity),
        gold: num(observed?.gold),
        netWorth: num(observed?.gold) !== null ? netWorth(num(observed?.gold), observed?.resources_by_name).netWorth : null,
        netWorthGrowth: null,
        netWorthBaseline: null,
        totalFood: num(observed?.settlement?.total_food),
        structures: num(observed?.structures?.count),
        troops: num(observed?.own_troops?.total),
      };

  // Growth is computed here, not read from episode.json, so every run is measured the same way.
  const baseline = idleBaseline(episode?.save, num(run?.config?.gameMinutes) ?? undefined);
  if (baseline !== undefined && card.netWorth !== null) {
    card.netWorthBaseline = baseline;
    card.netWorthGrowth = card.netWorth - baseline;
  }
  const memory: Obj = progress.memory ?? {};
  return {
    folder,
    id: typeof run?.id === "string" ? run.id.slice(0, 8) : fromFolder.id,
    started,
    model: typeof run?.model?.name === "string" ? run.model.name : null,
    modelSettings: run?.model ? settingsLabel(run.model) : null,
    harness: harnessLabel(run?.harness),
    benchmarkVersion: typeof run?.benchmark?.version === "string" ? run.benchmark.version : null,
    series: seriesOf(run?.series) ?? seriesOf(episode?.series),
    benchmark: typeof run?.benchmarkType === "string" ? run.benchmarkType : typeof episode?.benchmark === "string" ? episode.benchmark : null,
    map: typeof episode?.map === "string" ? episode.map : typeof observed?.map_name === "string" ? observed.map_name : null,
    status: typeof run?.status === "string" ? run.status : null,
    ended,
    endDetail: detail,
    gameSeconds,
    gameSecondsSource,
    budgetGameSeconds: num(budget.gameSeconds),
    wallSeconds,
    inferenceSeconds: num(progress.inference?.totalMs) !== null ? progress.inference.totalMs / 1000 : null,
    turns: num(run?.turns) ?? (events ? events.turnStarts : null),
    compactions: num(progress.compactions),
    tokens: {
      total,
      input: usage?.input ?? null,
      output: usage?.output ?? null,
      cacheRead: usage?.cacheRead ?? null,
      cacheWrite: usage?.cacheWrite ?? null,
      cachedShare: allInput ? usage!.cacheRead / allInput : null,
    },
    tokensPerGameMinute,
    cost: num(run?.cost) ?? events?.cost ?? null,
    costSource: events?.costSource ?? (num(run?.cost) === null ? null : run?.model?.prices ? "prices" : "billed"),
    scorecard: card,
    tools: events ? events.tools : null,
    toolErrors: events ? events.toolErrors : null,
    build: events ? events.build : null,
    anchor: events ? events.anchor : null,
    memory: {
      peakGameRssMiB: num(memory.maxGameRssMiB) ?? events?.peakGameRssMiB ?? null,
      minAvailableMiB: num(memory.minAvailableMiB),
      samples: num(memory.samples),
    },
    incomplete: !run || run.status === "running" || (events !== undefined && !events.complete),
  };
}

/** Run directories under `runsDir`, oldest first; unrelated files and empty folders are skipped. */
export function runDirectories(runsDir: string): string[] {
  return readdirSync(runsDir)
    .map((name) => path.join(runsDir, name))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory() &&
          ["run.json", "events.jsonl", "logs.jsonl"].some((file) => existsSync(path.join(dir, file)));
      } catch {
        return false;
      }
    })
    .sort();
}

export function matches(row: RunRow, filters: Filters, modelId = ""): boolean {
  if (filters.benchmark && !norm(row.benchmark ?? row.folder).includes(norm(filters.benchmark))) return false;
  if (filters.model && !norm(`${row.model ?? ""} ${modelId} ${row.folder}`).includes(norm(filters.model))) return false;
  if (filters.since !== undefined && (row.started === null || Date.parse(row.started) < filters.since)) return false;
  return true;
}

export async function buildReport(runsDir: string, filters: Filters = {}): Promise<RunRow[]> {
  const rows: RunRow[] = [];
  for (const dir of runDirectories(runsDir)) {
    // Cheap pre-filter from run.json so filtered-out runs never stream their events.
    const run = readJson(path.join(dir, "run.json"));
    const prelim = {
      folder: path.basename(dir),
      started: num(run?.startedAt) !== null ? new Date(run!.startedAt).toISOString() : folderIdentity(path.basename(dir)).started,
      model: typeof run?.model?.name === "string" ? run.model.name : null,
      benchmark: typeof run?.benchmarkType === "string" ? run.benchmarkType : null,
    } as RunRow;
    if (!matches(prelim, filters, typeof run?.model?.modelId === "string" ? run.model.modelId : "")) continue;
    rows.push(await summarizeRun(dir));
  }
  return rows.sort((a, b) => (a.started ?? "").localeCompare(b.started ?? ""));
}

const compact = (value: number | null) => {
  if (value === null) return "";
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(0)}k`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
};
const whole = (value: number | null) => (value === null ? "" : String(Math.round(value)));
const percent = (value: number | null) => (value === null ? "" : `${Math.round(value * 100)}%`);
const dollars = (value: number | null) => (value === null ? "" : `$${value.toFixed(value < 1 ? 3 : 2)}`);
const counts = (record: Record<string, number> | undefined) =>
  record ? Object.entries(record).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${k}:${v}`).join(" ") : "";

const columns: [string, (row: RunRow) => string][] = [
  ["Run", (r) => r.id + (r.incomplete ? "*" : "")],
  ["Started (UTC)", (r) => (r.started ? r.started.slice(0, 16).replace("T", " ") : "")],
  ["Model", (r) => r.model ?? ""],
  ["Model settings", (r) => r.modelSettings ?? ""],
  ["Harness", (r) => r.harness ?? ""],
  ["Version", (r) => r.benchmarkVersion ?? ""],
  ["Benchmark", (r) => r.benchmark ?? ""],
  ["Map", (r) => r.map ?? ""],
  ["Ended", (r) => (r.ended === "error" && r.endDetail ? `error: ${r.endDetail.slice(0, 48)}${r.endDetail.length > 48 ? "…" : ""}` : r.ended)],
  ["Game s", (r) => (r.gameSeconds === null ? "" : (r.gameSecondsSource === "observed" ? "~" : "") + whole(r.gameSeconds))],
  ["Wall s", (r) => whole(r.wallSeconds)],
  ["Turns", (r) => whole(r.turns)],
  ["Tokens", (r) => compact(r.tokens.total)],
  ["In", (r) => compact(r.tokens.input)],
  ["Cache read", (r) => compact(r.tokens.cacheRead)],
  ["Cache write", (r) => compact(r.tokens.cacheWrite)],
  ["Cached %", (r) => percent(r.tokens.cachedShare)],
  ["Out", (r) => compact(r.tokens.output)],
  ["Cost", (r) => (r.costSource === "prices" ? "~" : "") + dollars(r.cost)],
  ["Tok/game min", (r) => compact(r.tokensPerGameMinute)],
  ["Pop", (r) => whole(r.scorecard.population)],
  ["Housing", (r) => whole(r.scorecard.housing)],
  ["Popularity", (r) => whole(r.scorecard.popularity)],
  ["Net worth", (r) => whole(r.scorecard.netWorth) + (r.scorecard.valid === false ? "!" : "")],
  ["Growth", (r) => whole(r.scorecard.netWorthGrowth)],
  ["Gold", (r) => whole(r.scorecard.gold)],
  ["Food", (r) => whole(r.scorecard.totalFood)],
  ["Structures", (r) => whole(r.scorecard.structures)],
  ["Troops", (r) => whole(r.scorecard.troops)],
  ["Score src", (r) => r.scorecard.source ?? ""],
  ["Build att/placed/fail", (r) => (r.build?.attempts ? `${r.build.attempts}/${r.build.placed}/${r.build.failed}${r.build.unverified ? ` (+${r.build.unverified} unverified)` : ""}` : "")],
  ["Anchor calls/placed/fail", (r) => (r.anchor?.calls ? `${r.anchor.calls}/${r.anchor.placed}/${r.anchor.failed}` : "")],
  ["Retries", (r) => (r.build?.attempts ? String(r.build.retries) : "")],
  ["Retry methods", (r) => counts(r.build?.retryMethods)],
  ["Retry skipped", (r) => counts(r.build?.retrySkipped)],
  ["Peak RSS MiB", (r) => whole(r.memory.peakGameRssMiB)],
  ["Tool errs", (r) => whole(r.toolErrors)],
  ["Tools", (r) => counts(r.tools ?? undefined)],
];

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ");

function seriesOf(value: unknown): RunSeries | null {
  const s = value as Obj | undefined;
  return typeof s?.id === "string" && num(s.episode) !== null && num(s.episodes) !== null
    ? { id: s.id, episode: s.episode, episodes: s.episodes, ...(num(s.attempt) !== null ? { attempt: s.attempt } : {}) }
    : null;
}

export type SeriesRow = {
  id: string;
  model: string | null;
  benchmark: string | null;
  episodes: number;
  /** Net worth by episode; null where an episode is missing or has no reading. */
  netWorth: (number | null)[];
  /** Whether each episode's net worth is a full-budget score (null when not recorded). */
  valid: (boolean | null)[];
  /** The last episode's net worth: the series' score. */
  final: number | null;
  /** Final minus episode 1: how much the agent improved with its playbook. */
  change: number | null;
  cost: number | null;
  /** "prices" when any episode's cost was worked out from list prices. */
  costSource: "billed" | "prices" | null;
};

/** One row per learning series among the runs, in the order of their first episode. */
export function seriesRows(rows: RunRow[]): SeriesRow[] {
  const groups = new Map<string, RunRow[]>();
  for (const row of rows) if (row.series) groups.set(row.series.id, [...(groups.get(row.series.id) ?? []), row]);
  return [...groups].map(([id, runs]) => {
    const episodes = Math.max(...runs.map((r) => r.series!.episodes));
    // An episode run again (after a stop or an infrastructure failure) counts by its last attempt.
    const episode = (i: number) => runs
      .filter((r) => r.series!.episode === i + 1)
      .sort((a, b) => (b.series!.attempt ?? 1) - (a.series!.attempt ?? 1))[0];
    const netWorth = Array.from({ length: episodes }, (_, i) => episode(i)?.scorecard.netWorth ?? null);
    const valid = Array.from({ length: episodes }, (_, i) => episode(i)?.scorecard.valid ?? null);
    const [first, final] = [netWorth[0], netWorth[episodes - 1]];
    const costs = runs.map((r) => r.cost).filter((c): c is number => c !== null);
    return {
      id,
      model: runs[0].model,
      benchmark: runs[0].benchmark,
      episodes,
      netWorth,
      valid,
      final,
      change: first !== null && final !== null ? final - first : null,
      cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      costSource: runs.some((r) => r.costSource === "prices") ? "prices" : costs.length ? "billed" : null,
    };
  });
}

const seriesColumns: [string, (row: SeriesRow) => string][] = [
  ["Series", (r) => r.id],
  ["Model", (r) => r.model ?? ""],
  ["Benchmark", (r) => r.benchmark ?? ""],
  ["Net worth by episode", (r) => r.netWorth.map((v, i) => (v === null ? "–" : whole(v) + (r.valid[i] === false ? "!" : ""))).join(" → ")],
  ["Final", (r) => (r.final === null ? "" : whole(r.final) + (r.valid.at(-1) === false ? "!" : ""))],
  ["Change from episode 1", (r) => (r.change === null ? "" : `${r.change > 0 ? "+" : ""}${whole(r.change)}`)],
  ["Cost", (r) => (r.costSource === "prices" ? "~" : "") + dollars(r.cost)],
];

export function renderMarkdown(rows: RunRow[]): string {
  const header = `| ${columns.map(([name]) => name).join(" | ")} |`;
  const rule = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map(([, get]) => cell(get(row))).join(" | ")} |`);
  const legend = [
    "",
    "`~` game seconds derived from reader ticks (no budget recorded); `*` incomplete run (still writing, or unreadable run.json / events); `!` not a full-budget score (episode.json `invalid` says why).",
    "Build att/placed/fail counts build_structure placements; Anchor counts place_near and expand_storage calls, buildings placed, and calls that placed nothing.",
    "Tokens = run total: In (uncached input) + Cache read + Cache write + Out. Cached % is the share of all input read from the provider's cache. Cost is what OpenRouter billed; `~` marks a cost worked out from the run's tokens and its model's list prices (other endpoints). Blank cells were not recorded for that run.",
  ];
  const series = seriesRows(rows);
  const seriesTable = series.length
    ? [
        "",
        "Learning series: each episode starts from the playbook the one before left; the last episode's net worth is the series' score.",
        "",
        `| ${seriesColumns.map(([name]) => name).join(" | ")} |`,
        `| ${seriesColumns.map(() => "---").join(" | ")} |`,
        ...series.map((row) => `| ${seriesColumns.map(([, get]) => cell(get(row))).join(" | ")} |`),
      ]
    : [];
  return [header, rule, ...body, ...legend, ...seriesTable].join("\n");
}

export function renderJson(rows: RunRow[]): string {
  return JSON.stringify(rows, (_key, value) => (value === undefined ? null : value), 2);
}

async function main() {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "harness/runtime/runs" },
      benchmark: { type: "string" },
      model: { type: "string" },
      since: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const runsDir = path.resolve(values.runs!);
  if (!existsSync(runsDir) || !statSync(runsDir).isDirectory()) throw new Error(`Runs directory not found: ${runsDir}`);
  const filters: Filters = { benchmark: values.benchmark, model: values.model };
  if (values.since !== undefined) {
    filters.since = Date.parse(values.since);
    if (Number.isNaN(filters.since)) throw new Error(`--since is not a date: ${values.since}`);
  }
  const rows = await buildReport(runsDir, filters);
  console.log(values.json ? renderJson(rows) : renderMarkdown(rows));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  });
}
