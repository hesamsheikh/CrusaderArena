import type { Run } from "../shared/protocol";

export const integer = (n: number) => Math.round(n).toLocaleString();

/** 838518 → "839K", 1_250_000 → "1.25M". */
export function compact(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${+(n / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}M`;
  if (abs >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (abs >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return integer(n);
}

/** 303 → "5m 03s", 3720 → "1h 02m", 42 → "42s". */
export function duration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    r = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

export function clock(at: number) {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

/** Budget-style duration without zero parts: 600 → "10m", 2700 → "45m", 90 → "1m 30s". */
export function span(seconds: number) {
  const s = Math.round(seconds);
  if (s % 3600 === 0 && s) return `${s / 3600}h`;
  if (s % 60 === 0 && s) return `${s / 60}m`;
  return duration(s);
}

export function when(at: number, now = Date.now()) {
  const diff = (now - at) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  const d = new Date(at),
    today = new Date(now);
  const time = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** Absolute date and time: "Sep 30, 00:34". */
export function stamp(at: number) {
  const d = new Date(at);
  return `${d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" })}, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
}

export const label = (key: string) =>
  key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
export const monthName = (m: number) => months[m] ?? `Month ${m + 1}`;

/** Game seconds left for game-time runs; runs saved before 2026-09-28 used a wall-clock duration. */
export function secondsLeft(run: Run, now: number) {
  const legacy = (run.config as { durationSeconds?: number } | undefined)
    ?.durationSeconds;
  if (legacy !== undefined && !run.progress?.budget) {
    const remaining =
      run.status === "running"
        ? (run.startedAt + legacy * 1000 - now) / 1000
        : (run.progress?.remainingSeconds ?? 0);
    return Math.ceil(Math.max(0, Math.min(legacy, remaining)));
  }
  return Math.ceil(Math.max(0, run.progress?.remainingSeconds ?? 0));
}

/** Wall-clock seconds the run has taken so far (or in total, once ended). */
export function elapsed(run: Run, now: number) {
  if (run.progress?.budget && run.status !== "running")
    return run.progress.budget.wallUsedSeconds;
  return (
    ((run.endedAt ?? (run.status === "running" ? now : run.startedAt)) -
      run.startedAt) /
    1000
  );
}

export function averageInference(run: Run) {
  const i = run.progress?.inference;
  return i?.completed ? i.totalMs / i.completed / 1000 : null;
}

/** Benchmark title for a run, falling back to the middle part of its generated name. */
export function runTitle(run: Run) {
  if (run.benchmarkType) return run.benchmarkType;
  const parts = run.name.split(" · ");
  return parts.length === 3 ? parts[1] : run.name;
}
