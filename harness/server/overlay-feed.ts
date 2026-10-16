/**
 * The game machine's run overlay (tools/ubuntu/overlay.py) for a round played on a version made
 * before it. That version's host sends the bridge no game clock and its monitor starts no
 * overlay, so this checkout's runner feeds the overlay instead: once a second it reads the round
 * host's state and sends the overlay's figures over its own SSH connection (overlay.py --feed),
 * which starts the overlay when a run's clock appears. Display only: the agent never sees the
 * overlay, and nothing here touches the run.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { TICKS_PER_GAME_SECOND } from "../shared/protocol.js";
import { gameHost, quote } from "./device.js";
import { netWorth } from "./market-prices.js";
import { armsCounted } from "./benchmark-rules.js";

/** One line for overlay.py --feed: the fields its panel shows, as the current host's status updates carry them. */
export type OverlayStatus = {
  phase: string;
  model: string;
  run: string;
  turns: number | null;
  tokens: number | null;
  clock: { used: number; total: number } | null;
  tool_calls: number | null;
  cost: number | null;
  stats: { gold?: number; population?: number; popularity?: number; net_worth?: number };
};

const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);

/**
 * Turns a host's /api/state, polled once a second, into overlay status. An earlier version's host
 * updates the run's game time only when a turn or tool changes it, so between updates the clock
 * runs on from the reader's game tick, as the current host's live clock does.
 */
export class OverlayStatusReader {
  private runId?: string;
  private startTick?: number;
  private budgetUsed?: number;
  private events = { file: "", offset: 0, calls: 0, partial: "" };
  constructor(private runsDir: string) {}

  status(state: any): OverlayStatus {
    const run = Array.isArray(state?.runs) ? state.runs.find((r: any) => r?.id === state.activeRunId) : undefined;
    if (run?.id !== this.runId) {
      this.runId = run?.id;
      this.startTick = this.budgetUsed = undefined;
      this.events = { file: "", offset: 0, calls: 0, partial: "" };
    }
    const obs = state?.stats?.observation;
    const gold = int(obs?.gold);
    return {
      phase: state?.running ? String(run?.progress?.phase || "agent running").toUpperCase() : run ? String(run.status ?? "").toUpperCase() : "IDLE",
      model: String(run?.model?.name ?? ""),
      run: String(run?.name ?? ""),
      turns: int(state?.turns) ?? null,
      tokens: int(state?.tokens) ?? null,
      clock: state?.running ? this.clock(run?.progress?.budget, obs) : null,
      tool_calls: run?.folder ? this.toolCalls(path.join(this.runsDir, run.folder, "events.jsonl")) : null,
      cost: typeof run?.cost === "number" ? run.cost : null,
      stats: obs
        ? {
            gold,
            population: int(obs.population),
            popularity: int(obs.popularity),
            net_worth: gold === undefined ? undefined : Math.round(netWorth(gold, obs.resources_by_name ?? {}, { arms: armsCounted(run?.benchmarkType) }).netWorth),
          }
        : {},
    };
  }

  private clock(budget: any, obs: any) {
    const total = budget?.gameSeconds, used = budget?.usedGameSeconds;
    if (typeof total !== "number" || typeof used !== "number" || total <= 0) return null;
    const tick = typeof obs?.game_time === "number" ? obs.game_time : undefined;
    if (tick === undefined) return { used: Math.min(used, total), total };
    // The run's start tick, from the latest game time the host recorded.
    if (this.startTick === undefined || used !== this.budgetUsed) {
      this.startTick = tick - used * TICKS_PER_GAME_SECOND;
      this.budgetUsed = used;
    }
    const live = (tick - this.startTick) / TICKS_PER_GAME_SECOND;
    return { used: Math.min(Math.max(live, used), total), total };
  }

  /** Tool calls so far: the run's tool_execution_start events, read as the file grows. */
  private toolCalls(file: string) {
    try {
      if (file !== this.events.file) this.events = { file, offset: 0, calls: 0, partial: "" };
      const size = statSync(file).size;
      if (size > this.events.offset) {
        const fd = openSync(file, "r");
        try {
          const buffer = Buffer.alloc(size - this.events.offset);
          readSync(fd, buffer, 0, buffer.length, this.events.offset);
          this.events.offset = size;
          const lines = (this.events.partial + buffer.toString("utf8")).split("\n");
          this.events.partial = lines.pop() ?? "";
          for (const line of lines) if (line.includes('"type":"tool_execution_start"')) this.events.calls++;
        } finally {
          closeSync(fd);
        }
      }
      return this.events.calls;
    } catch {
      return this.events.calls || null;
    }
  }
}

/**
 * Feeds the overlay from the host on `port` until the returned stop is called. Failures are only
 * logged once: a run never waits on the overlay.
 */
export function startOverlayFeed(port: string, runsDir: string, log: (line: string) => void) {
  const reader = new OverlayStatusReader(runsDir);
  let child: ChildProcess | undefined;
  let stopped = false, warned = false, startedAt = 0;
  const connect = () => {
    const { host, root } = gameHost();
    startedAt = Date.now();
    child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10", host,
      `${quote(`${root}/.venv-control/bin/python`)} ${quote(`${root}/tools/ubuntu/overlay.py`)} --feed`], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d) => (err = (err + d).slice(-300)));
    child.stdin?.on("error", () => {});
    child.on("error", () => {});
    child.on("close", (code) => {
      child = undefined;
      if (!stopped && !warned) {
        warned = true;
        log(`Run overlay feed ended (code ${code}${err.trim() ? `: ${err.trim()}` : ""}); retrying every 30 s`);
      }
    });
  };
  const timer = setInterval(async () => {
    if (!child && Date.now() - startedAt > 30_000) connect();
    const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.json()).catch(() => null);
    if (!state || !child?.stdin?.writable) return;
    try {
      child.stdin.write(JSON.stringify(reader.status(state)) + "\n");
    } catch {}
  }, 1000);
  timer.unref();
  connect();
  return () => {
    stopped = true;
    clearInterval(timer);
    child?.stdin?.end();
    const c = child;
    setTimeout(() => c?.kill(), 3000).unref();
  };
}
