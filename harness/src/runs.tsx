import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Circle,
  CircleDot,
  Copy,
  Download,
  FileText,
  RotateCcw,
  Square,
} from "lucide-react";
import type { LogEntry, ModelProfile, Run } from "../shared/protocol";
import { settingsLabel } from "../shared/protocol";
import { Card, Meter, Metric, StatusBadge } from "./ui";
import { Logs } from "./Logs";
import {
  averageInference,
  compact,
  duration,
  elapsed,
  integer,
  runTitle,
  secondsLeft,
  span,
  stamp,
  when,
} from "./format";

/** Budget usage, throughput and health of one run. */
export function RunVitals({ run, now }: { run: Run; now: number }) {
  const p = run.progress,
    b = p?.budget,
    legacy = !!run.legacySource;
  const gameTotal = b?.gameSeconds ?? (run.config?.gameMinutes ?? 0) * 60;
  const gameUsed = b
    ? b.usedGameSeconds
    : p
      ? Math.max(0, gameTotal - secondsLeft(run, now))
      : 0;
  const wallTotal =
    b?.wallLimitSeconds ?? (run.config?.wallLimitMinutes ?? 0) * 60;
  const wallUsed =
    run.status === "running"
      ? elapsed(run, now)
      : (b?.wallUsedSeconds ?? elapsed(run, now));
  const avg = averageInference(run);
  const context = p?.contextEstimate ?? 0,
    contextBudget = run.config?.contextBudget ?? 0;
  const inf = p?.inference;
  return (
    <div className="vitals">
      <Metric
        label="Game time"
        value={gameTotal ? duration(gameUsed) : "—"}
        unit={gameTotal ? `/ ${span(gameTotal)}` : undefined}
        note={
          b?.endedBy === "game_time"
            ? "Budget reached"
            : gameTotal
              ? `${duration(Math.max(0, gameTotal - gameUsed))} left`
              : "No game budget recorded"
        }
      >
        {gameTotal > 0 && (
          <Meter value={gameUsed} max={gameTotal} label="Game time used" />
        )}
      </Metric>
      <Metric
        label="Real time"
        value={duration(wallUsed)}
        unit={wallTotal ? `/ ${span(wallTotal)}` : undefined}
        note={
          b?.endedBy === "wall_limit"
            ? "Limit reached"
            : wallTotal
              ? `${duration(Math.max(0, wallTotal - wallUsed))} left`
              : "No limit recorded"
        }
      >
        {wallTotal > 0 && (
          <Meter value={wallUsed} max={wallTotal} label="Real time used" />
        )}
      </Metric>
      <Metric
        label="Context"
        value={contextBudget ? compact(context) : "—"}
        unit={contextBudget ? `/ ${compact(contextBudget)}` : undefined}
        note={
          p
            ? `${p.compactions} compaction${p.compactions === 1 ? "" : "s"}${p.compactions ? ` · ${(p.inference.compactionMs / 1000).toFixed(1)}s` : ""}`
            : "—"
        }
      >
        {contextBudget > 0 && (
          <Meter value={context} max={contextBudget} label="Context used" />
        )}
      </Metric>
      <Metric
        label="Turns"
        value={legacy ? "—" : integer(run.turns)}
        note={`${integer(run.logCount)} log entries`}
      />
      <Metric
        label="Tokens"
        value={legacy ? "—" : compact(run.tokens)}
        note={
          !legacy && run.turns
            ? `${compact(run.tokens / run.turns)} per turn`
            : "—"
        }
      />
      <Metric
        label="Avg inference"
        value={avg === null ? "—" : avg.toFixed(1)}
        unit={avg === null ? undefined : "s"}
        note={
          inf
            ? `${inf.completed} ok${inf.failed ? ` · ${inf.failed} failed` : ""}${inf.aborted ? ` · ${inf.aborted} aborted` : ""}`
            : "—"
        }
      />
      {p?.memory && (
        <Metric
          label="Game memory"
          value={compact(p.memory.maxGameRssMiB)}
          unit="MiB"
          note={`peak · ${compact(p.memory.minAvailableMiB)} MiB min free${p.memory.maxGameSwapMiB ? ` · ${p.memory.maxGameSwapMiB} MiB swap` : ""}`}
        />
      )}
    </div>
  );
}

export function Plan({ run }: { run: Run }) {
  const plan = run.progress?.plan ?? [];
  const done = plan.filter((i) => i.status === "completed").length;
  return (
    <Card
      title="Plan"
      aside={
        plan.length ? (
          <span className="muted">
            {done} of {plan.length} done
          </span>
        ) : undefined
      }
    >
      {plan.length ? (
        <ol className="plan">
          {plan.map((item, i) => (
            <li key={i} className={`plan-${item.status}`}>
              {item.status === "completed" ? (
                <Check size={14} aria-label="Completed" />
              ) : item.status === "in_progress" ? (
                <CircleDot size={14} aria-label="In progress" />
              ) : (
                <Circle size={14} aria-label="Pending" />
              )}
              <span>{item.step}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="empty">The agent has not written a plan yet.</p>
      )}
    </Card>
  );
}

type SortKey =
  "startedAt" | "duration" | "turns" | "tokens" | "game" | "inference";
const statusGroups = [
  { id: "all", name: "All" },
  { id: "running", name: "Running" },
  { id: "completed", name: "Completed" },
  { id: "error", name: "Error" },
  { id: "other", name: "Other" },
] as const;
const groupOf = (s: Run["status"]) =>
  s === "running" || s === "completed" || s === "error" ? s : "other";

export function RunsView({
  runs,
  models,
  modelFilter,
  now,
}: {
  runs: Run[];
  models: ModelProfile[];
  modelFilter: string;
  now: number;
}) {
  const [status, setStatus] = useState<string>("all");
  const [benchmark, setBenchmark] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: "startedAt",
    desc: true,
  });
  const benchmarks = useMemo(
    () => [...new Set(runs.map(runTitle))].sort(),
    [runs],
  );
  const scoped = runs.filter(
    (r) =>
      (modelFilter === "all" || r.modelId === modelFilter) &&
      (benchmark === "all" || runTitle(r) === benchmark),
  );
  const counts: Record<string, number> = { all: scoped.length };
  for (const r of scoped)
    counts[groupOf(r.status)] = (counts[groupOf(r.status)] ?? 0) + 1;
  const value = (r: Run): number => {
    switch (sort.key) {
      case "duration":
        return elapsed(r, now);
      case "turns":
        return r.legacySource ? -1 : r.turns;
      case "tokens":
        return r.legacySource ? -1 : r.tokens;
      case "game":
        return r.progress?.budget?.usedGameSeconds ?? -1;
      case "inference":
        return averageInference(r) ?? -1;
      default:
        return r.startedAt;
    }
  };
  const shown = scoped
    .filter((r) => status === "all" || groupOf(r.status) === status)
    .sort((a, b) => (sort.desc ? value(b) - value(a) : value(a) - value(b)));
  const header = (key: SortKey, name: string, numeric = true) => (
    <th
      className={numeric ? "num" : ""}
      aria-sort={
        sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"
      }
    >
      <button
        onClick={() =>
          setSort({ key, desc: sort.key === key ? !sort.desc : true })
        }
      >
        {name}
        {sort.key === key &&
          (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
      </button>
    </th>
  );
  return (
    <>
      <div className="toolbar">
        <div className="segmented" role="tablist" aria-label="Filter by status">
          {statusGroups.map((g) => (
            <button
              key={g.id}
              role="tab"
              aria-selected={status === g.id}
              className={status === g.id ? "on" : ""}
              onClick={() => setStatus(g.id)}
            >
              {g.name}
              <span className="count">{counts[g.id] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="toolbar-selects">
          <select
            aria-label="Filter by model"
            value={modelFilter}
            onChange={(e) =>
              (window.location.hash =
                e.target.value === "all"
                  ? "runs"
                  : `runs/model/${e.target.value}`)
            }
          >
            <option value="all">All models</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by benchmark"
            value={benchmark}
            onChange={(e) => setBenchmark(e.target.value)}
          >
            <option value="all">All benchmarks</option>
            {benchmarks.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Card flush>
        <div className="table-wrap">
          <table className="runs-table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                {header("startedAt", "Started", false)}
                {header("duration", "Duration")}
                {header("game", "Game time")}
                {header("turns", "Turns")}
                {header("tokens", "Tokens")}
                {header("inference", "Avg inference")}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const b = r.progress?.budget;
                const avg = averageInference(r);
                return (
                  <tr
                    key={r.id}
                    onClick={() => (window.location.hash = `run/${r.id}`)}
                  >
                    <td className="run-cell">
                      <a
                        href={`#run/${r.id}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {runTitle(r)}
                      </a>
                      <span>{r.model.name}</span>
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="muted nowrap">{when(r.startedAt, now)}</td>
                    <td className="num">{duration(elapsed(r, now))}</td>
                    <td className="num">
                      {b ? (
                        <span className="cell-meter">
                          <Meter
                            value={b.usedGameSeconds}
                            max={b.gameSeconds}
                            warnAt={2}
                            label="Game time used"
                          />
                          {duration(b.usedGameSeconds)}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num">
                      {r.legacySource ? "—" : integer(r.turns)}
                    </td>
                    <td className="num">
                      {r.legacySource ? "—" : compact(r.tokens)}
                    </td>
                    <td className="num">
                      {avg === null ? "—" : `${avg.toFixed(1)}s`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!shown.length && (
            <p className="empty pad">No runs match these filters.</p>
          )}
        </div>
      </Card>
    </>
  );
}

export function RunDetail({
  run,
  logs,
  streaming,
  now,
  rerun,
  stop,
}: {
  run: Run;
  logs: LogEntry[] | null;
  streaming: string;
  now: number;
  rerun: () => void;
  stop: () => void;
}) {
  const p = run.progress;
  const [copied, setCopied] = useState(false);
  const path = `harness/runtime/runs/${run.folder}/`;
  return (
    <>
      <section className="page-head">
        <div>
          <nav className="crumbs">
            <a href="#runs">Runs</a>
            <span>/</span>
            <a href={`#runs/model/${run.modelId}`}>{run.model.name}</a>
          </nav>
          <h1>{runTitle(run)}</h1>
          <p className="lede">
            <StatusBadge status={run.status} />
            <span>{run.model.name}</span>
            <span>Started {stamp(run.startedAt)}</span>
            {p?.phase && run.status === "running" && (
              <span>Phase · {p.phase}</span>
            )}
          </p>
        </div>
        <div className="head-actions">
          <a
            className="button ghost"
            href={`/api/runs/${run.id}/logs`}
            download
          >
            <Download size={14} />
            Export logs
          </a>
          {run.status === "running" ? (
            <button className="button danger" onClick={stop}>
              <Square size={13} />
              Stop run
            </button>
          ) : (
            <button className="button primary" onClick={rerun}>
              <RotateCcw size={14} />
              Run again
            </button>
          )}
        </div>
      </section>
      <RunVitals run={run} now={now} />
      {(p?.stopReason || p?.finalPause) && (
        <p className="note">
          {p.stopReason && (
            <>
              <strong>Stopped:</strong> {p.stopReason}.{" "}
            </>
          )}
          {p.finalPause}
        </p>
      )}
      {run.legacySource && (
        <p className="note">
          Imported from previous session logs. Streaming events and usage were
          not recorded in that version.
        </p>
      )}
      <div className="split">
        <Card
          title="Activity"
          className="activity tall"
          aside={
            <span className="muted">
              {integer(run.logCount)} entries · {integer(run.eventCount)} events
            </span>
          }
        >
          {logs ? (
            <Logs entries={logs} streaming={streaming} searchable />
          ) : (
            <p className="empty">Loading logs…</p>
          )}
        </Card>
        <div className="stack">
          <Card title="Instruction">
            <p className="prompt">{run.prompt}</p>
          </Card>
          {p && <Plan run={run} />}
          {p && (
            <Card
              title="Notebook"
              aside={
                <span className="muted">Revision {p.notebook.revision}</span>
              }
            >
              {p.notebook.text ? (
                <pre className="notebook">{p.notebook.text}</pre>
              ) : (
                <p className="empty">No notes yet.</p>
              )}
            </Card>
          )}
          {p?.playbook && (
            <Card
              title="Playbook"
              aside={
                <span className="muted">Revision {p.playbook.revision}</span>
              }
            >
              {p.playbook.text ? (
                <pre className="notebook">{p.playbook.text}</pre>
              ) : (
                <p className="empty">Empty: the first episode of its series.</p>
              )}
            </Card>
          )}
          {run.config && (
            <Card title="Configuration">
              <dl className="facts">
                <div>
                  <dt>Game-time budget</dt>
                  <dd>{run.config.gameMinutes} game min</dd>
                </div>
                <div>
                  <dt>Real-time limit</dt>
                  <dd>{run.config.wallLimitMinutes} min</dd>
                </div>
                <div>
                  <dt>Screenshot wait</dt>
                  <dd>{run.config.defaultWaitSeconds} game s</dd>
                </div>
                {run.config.minTurnSeconds !== undefined && (
                  <div>
                    <dt>Minimum turn</dt>
                    <dd>{run.config.minTurnSeconds} game s</dd>
                  </div>
                )}
                <div>
                  <dt>Context budget</dt>
                  <dd>{integer(run.config.contextBudget)} tokens</dd>
                </div>
                <div>
                  <dt>Video</dt>
                  <dd>
                    {!run.config.recordVideo
                      ? "Not recorded"
                      : run.progress?.recording
                        ? `${integer(run.progress.recording.frames)} frames recorded${run.progress.recording.lastError ? ` (last recorder error: ${run.progress.recording.lastError})` : ""}; video.mp4 in the run folder`
                        : "Recording"}
                  </dd>
                </div>
                <div>
                  <dt>Image estimate</dt>
                  <dd>{integer(run.config.imageTokenEstimate)} tokens</dd>
                </div>
                <div>
                  <dt>Model ID</dt>
                  <dd className="mono">{run.model.modelId}</dd>
                </div>
                <div>
                  <dt>Model settings</dt>
                  <dd>{settingsLabel(run.model) ?? "Not recorded"}</dd>
                </div>
                {run.series && (
                  <div>
                    <dt>Learning series</dt>
                    <dd>
                      Episode {run.series.episode} of {run.series.episodes} ({run.series.id})
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Harness</dt>
                  <dd className="mono">
                    {run.harness
                      ? `${run.harness.commit?.slice(0, 7) ?? "unknown"}${run.harness.dirty ? ` + changes ${run.harness.diffSha256?.slice(0, 7) ?? ""}` : ""} · prompt ${run.harness.systemPromptSha256.slice(0, 7)} · tools ${run.harness.toolsSha256.slice(0, 7)}`
                      : "Not recorded"}
                  </dd>
                </div>
              </dl>
            </Card>
          )}
          <Card title="Files">
            <button
              className="path"
              title="Copy folder path"
              onClick={() => {
                void navigator.clipboard?.writeText(path).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              <code>{path}</code>
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
            <ul className="files">
              <li>
                <a href={`/api/runs/${run.id}/logs`} download>
                  <FileText size={14} /> Logs <span>JSONL</span>
                </a>
              </li>
              {!run.legacySource && (
                <li>
                  <a href={`/api/runs/${run.id}/events`} download>
                    <FileText size={14} /> Full events <span>JSONL</span>
                  </a>
                </li>
              )}
              {p && (
                <li>
                  <a href={`/api/runs/${run.id}/notifications`} download>
                    <FileText size={14} /> Notification journal{" "}
                    <span>JSONL</span>
                  </a>
                </li>
              )}
              {run.config && (
                <li>
                  <a
                    href={`/api/runs/${run.id}/guide`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <FileText size={14} /> Annotated controls guide{" "}
                    <span>HTML ↗</span>
                  </a>
                </li>
              )}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
