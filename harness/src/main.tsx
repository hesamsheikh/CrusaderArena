import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  Castle,
  List,
  Moon,
  Monitor,
  Plus,
  Radio,
  Settings2,
  ShieldCheck,
  Square,
  Sun,
  X,
} from "lucide-react";
import type {
  Frame,
  GameAction,
  State,
  ModelProfile,
  Run,
  LogEntry,
} from "../shared/protocol";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "./style.css";
import { request } from "./api";
import { ModelForm, NewRunDialog, type RunDraft } from "./dialogs";
import { GameView } from "./GameView";
import { Kingdom, type Sample } from "./Kingdom";
import { Logs } from "./Logs";
import { Plan, RunDetail, RunVitals, RunsView } from "./runs";
import { Card, Pill, StatusBadge } from "./ui";
import { runTitle, when } from "./format";

const blank: State = {
  models: [],
  runs: [],
  activeRunId: null,
  streamingText: "",
  connected: false,
  connecting: false,
  deviceError: null,
  frame: null,
  stats: null,
  running: false,
  model: "kimi-k3",
  keyConfigured: false,
  modelStatus: "untested",
  tokens: 0,
  turns: 0,
  logs: [],
};

type Theme = "system" | "light" | "dark";
function storedTheme(): Theme {
  try {
    const t = localStorage.getItem("crusader-theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

type Route =
  | { page: "live" }
  | { page: "runs"; model: string }
  | { page: "run"; id: string };
function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  if (h.startsWith("run/")) return { page: "run", id: h.slice(4) };
  if (h.startsWith("runs/model/")) return { page: "runs", model: h.slice(11) };
  if (h === "runs") return { page: "runs", model: "all" };
  return { page: "live" };
}

/** Keep about ten minutes of client-side samples for the kingdom trend lines. */
const SAMPLE_MS = 2000,
  MAX_SAMPLES = 300;
/** Game preview capture interval outside runs, and while the operator has manual control. */
const FRAME_POLL_MS = 5000,
  MANUAL_FRAME_POLL_MS = 2000;

function App() {
  const [state, setState] = useState<State>(blank),
    [frame, setFrame] = useState<Frame | null>(null),
    [serverUp, setServerUp] = useState(true),
    [manual, setManual] = useState(false),
    [settings, setSettings] = useState(false),
    [newRun, setNewRun] = useState(false),
    [editing, setEditing] = useState<ModelProfile | undefined>(),
    [route, setRoute] = useState(() => parseRoute(window.location.hash)),
    [detail, setDetail] = useState<{ run: Run; logs: LogEntry[] } | null>(null),
    [draft, setDraft] = useState<RunDraft>({
      benchmarkType: "Custom",
      prompt: "",
      playMinutes: 10,
      wallLimitMinutes: 60,
      waitSeconds: 5,
      minTurnSeconds: 8,
      contextBudget: 120000,
      recordVideo: true,
      modelId: "",
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [live, setLive] = useState(true),
    [theme, setTheme] = useState<Theme>(storedTheme),
    [history, setHistory] = useState<Sample[]>([]),
    [lastReading, setLastReading] = useState<{
      observation: NonNullable<NonNullable<State["stats"]>["observation"]>;
      at: number;
    } | null>(null),
    [tick, setTick] = useState(Date.now());
  const frameRef = useRef<Frame | null>(null),
    historyKey = useRef("");
  const refresh = useCallback(async () => {
    try {
      const f = await request<Frame>("frame");
      frameRef.current = f;
      setFrame(f);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onmessage = (e) => {
      setState(JSON.parse(e.data));
      setServerUp(true);
    };
    source.onerror = () => setServerUp(false);
    return () => source.close();
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      localStorage.setItem("crusader-theme", theme);
    } catch {}
  }, [theme]);
  // Outside runs the preview captures every few seconds (faster under manual control; an action
  // refreshes at once). During a run it never captures: it shows the agent's own screenshots,
  // fetched when the host announces a new one.
  useEffect(() => {
    if (!state.connected) {
      setFrame(null);
      frameRef.current = null;
      setManual(false);
      return;
    }
    if (state.running) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!cancelled) {
        await refresh();
        if (!cancelled && live)
          timer = setTimeout(poll, manual ? MANUAL_FRAME_POLL_MS : FRAME_POLL_MS);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [state.connected, state.running, live, manual, refresh]);
  useEffect(() => {
    if (state.connected && state.running && live && state.frame && frameRef.current?.id !== state.frame.id)
      void refresh();
  }, [state.connected, state.running, live, state.frame?.id, refresh]);
  useEffect(() => {
    if (state.running || !serverUp || settings) setManual(false);
  }, [state.running, serverUp, settings]);
  useEffect(() => {
    const changed = () => {
      setRoute(parseRoute(window.location.hash));
      setManual(false);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);

  const stats =
    state.stats?.status === "ok" &&
    state.stats.valid_until_unix_ms &&
    state.stats.valid_until_unix_ms > tick
      ? state.stats.observation
      : null;
  // The reader drops out briefly (e.g. while the game is paused between turns);
  // keep showing the last good reading, labelled with its age.
  useEffect(() => {
    if (stats) setLastReading({ observation: stats, at: Date.now() });
  }, [stats]);
  useEffect(() => {
    if (!state.connected) setLastReading(null);
  }, [state.connected]);
  // Trend samples restart whenever the reader session or map changes.
  useEffect(() => {
    if (!stats) return;
    const key = `${state.stats?.session}:${stats.map_name}`;
    const sample: Sample = {
      at: Date.now(),
      gold: stats.gold,
      population: stats.population,
      popularity: stats.popularity,
      food: stats.settlement?.total_food ?? NaN,
    };
    setHistory((h) => {
      if (historyKey.current !== key) {
        historyKey.current = key;
        return [sample];
      }
      if (h.length && sample.at - h[h.length - 1].at < SAMPLE_MS) return h;
      return [...h, sample].slice(-MAX_SAMPLES);
    });
  }, [stats?.gold, stats?.population, stats?.popularity, tick]);

  const connected = state.connected && serverUp;
  const activeRun = state.runs.find((r) => r.id === state.activeRunId);
  const selectedRunId = route.page === "run" ? route.id : null;
  const selectedRun = state.runs.find((r) => r.id === selectedRunId);
  const draftModel =
    state.models.find((m) => m.id === draft.modelId) || state.models[0];
  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    request<{ run: Run; logs: LogEntry[] }>(`runs/${selectedRunId}`)
      .then((value) => {
        if (!cancelled) setDetail(value);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId, selectedRun?.logCount, selectedRun?.status]);

  const perform = async (fn: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const act = (action: GameAction, observed = frameRef.current) => {
    if (!manual || !observed || state.running) return;
    void perform(async () => {
      await request("action", { action, frameId: observed.id });
      await refresh();
    });
  };
  const toggleConnection = () =>
    void perform(() => request(connected ? "disconnect" : "connect", {}));
  const stop = () => void perform(() => request("agent/stop", {}));
  const openModel = (model?: ModelProfile) => {
    setEditing(model);
    setSettings(true);
  };
  const rerun = (run: Run) => {
    setDraft({
      modelId: run.modelId,
      prompt: run.prompt,
      benchmarkType: run.benchmarkType || "Custom",
      playMinutes: run.config?.playMinutes ?? run.config?.gameMinutes ?? 10,
      wallLimitMinutes: run.config?.wallLimitMinutes || 60,
      waitSeconds: run.config?.defaultWaitSeconds ?? 5,
      minTurnSeconds: run.config?.minTurnSeconds ?? 8,
      contextBudget: run.config?.contextBudget || 120000,
      recordVideo: run.config?.recordVideo ?? true,
    });
    setNewRun(true);
  };
  const blocker = !connected
    ? "Connect the game window first."
    : state.running
      ? "A run is already in progress."
      : !draftModel
        ? "Add a model first."
        : !draftModel.keyConfigured
          ? "This model needs an API key."
          : !draft.benchmarkType.trim()
            ? "Name the benchmark."
            : !draft.prompt.trim()
              ? "Write an instruction for the agent."
              : null;
  const modal = settings || newRun;
  const recent = [...state.runs]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 6);
  const guard = state.memoryGuard;

  return (
    <div className="shell">
      <aside className="sidebar" inert={modal}>
        <a href="#live" className="brand" aria-label="Crusader Arena home">
          <span className="brand-mark" aria-hidden>
            <Castle size={17} strokeWidth={1.6} />
          </span>
          <span>
            Crusader Arena
            <small>Stronghold Crusader benchmark</small>
          </span>
        </a>
        <nav className="nav" aria-label="Pages">
          <a href="#live" className={route.page === "live" ? "on" : ""}>
            <Radio size={15} />
            Live
            {state.running && (
              <span className="nav-live" title="A run is in progress" />
            )}
          </a>
          <a href="#runs" className={route.page !== "live" ? "on" : ""}>
            <List size={15} />
            Runs
            <span className="nav-count">{state.runs.length}</span>
          </a>
        </nav>
        <div className="side-section">
          <div className="side-head">
            <span>Models</span>
            <button
              className="icon-button small"
              aria-label="Add model"
              title="Add model"
              onClick={() => openModel()}
            >
              <Plus size={14} />
            </button>
          </div>
          <ul className="side-list">
            {state.models.map((m) => {
              const count = state.runs.filter((r) => r.modelId === m.id).length;
              const current = route.page === "runs" && route.model === m.id;
              return (
                <li key={m.id} className={current ? "on" : ""}>
                  <a href={`#runs/model/${m.id}`}>
                    <span className="model-glyph">{m.name.slice(0, 1)}</span>
                    <span className="truncate">{m.name}</span>
                    {!m.keyConfigured && (
                      <span className="needs-key" title="API key needed" />
                    )}
                    <span className="nav-count">{count}</span>
                  </a>
                  <button
                    className="icon-button small reveal"
                    aria-label={`${m.name} settings`}
                    title="Model settings"
                    onClick={() => openModel(m)}
                  >
                    <Settings2 size={13} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="side-section">
          <div className="side-head">
            <span>Recent runs</span>
          </div>
          <ul className="side-list recent">
            {recent.map((r) => (
              <li key={r.id} className={selectedRunId === r.id ? "on" : ""}>
                <a href={`#run/${r.id}`} title={r.name}>
                  <span className={`run-dot status-${r.status}`} aria-hidden />
                  <span className="truncate">
                    {runTitle(r)}
                    <small>
                      {r.model.name} · {when(r.startedAt, tick)}
                    </small>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
        <div className="side-foot">
          <ShieldCheck size={14} />
          <span>
            Input is scoped to the game window
            <small>Pi agent runtime · local host</small>
          </span>
        </div>
      </aside>

      <main inert={modal}>
        <header className="topbar">
          <div className="top-status">
            <Pill tone={!serverUp ? "bad" : connected ? "good" : "neutral"}>
              {!serverUp
                ? "Host offline"
                : connected
                  ? "Game connected"
                  : "Game disconnected"}
            </Pill>
            {state.connected && guard && (
              <Pill
                tone={
                  guard === "active"
                    ? "good"
                    : guard === "failed"
                      ? "bad"
                      : "neutral"
                }
              >
                Memory guard {guard === "active" ? "on" : guard}
              </Pill>
            )}
            {state.running && activeRun && route.page !== "live" && (
              <a href="#live" className="top-live">
                <Pill tone="accent" pulse>
                  {runTitle(activeRun)} ·{" "}
                  {activeRun.progress?.phase ?? "running"}
                </Pill>
              </a>
            )}
          </div>
          <div className="top-actions">
            <div
              className="theme-switch"
              role="radiogroup"
              aria-label="Color theme"
            >
              {(
                [
                  ["light", Sun],
                  ["system", Monitor],
                  ["dark", Moon],
                ] as const
              ).map(([t, Icon]) => (
                <button
                  key={t}
                  role="radio"
                  aria-checked={theme === t}
                  aria-label={`${t} theme`}
                  title={`${t[0].toUpperCase()}${t.slice(1)} theme`}
                  className={theme === t ? "on" : ""}
                  onClick={() => setTheme(t)}
                >
                  <Icon size={13} />
                </button>
              ))}
            </div>
            <button
              className="button primary"
              disabled={state.running}
              title={state.running ? "A run is already in progress" : undefined}
              onClick={() => setNewRun(true)}
            >
              <Plus size={14} />
              New run
            </button>
          </div>
        </header>

        <div className="content">
          {(!serverUp || error || state.deviceError) && (
            <div role="alert" className="alert">
              <span>
                {!serverUp
                  ? "Lost the connection to the local host. Reconnecting…"
                  : error || state.deviceError}
              </span>
              {serverUp && (
                <button
                  className="icon-button small"
                  aria-label="Dismiss message"
                  onClick={() => setError("")}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          )}

          {route.page === "live" && (
            <>
              <section className="page-head">
                <div>
                  <p className="eyebrow">
                    {state.running ? "Now running" : "Live"}
                  </p>
                  <h1>
                    {state.running && activeRun
                      ? runTitle(activeRun)
                      : connected
                        ? "Ready for the next run"
                        : "Connect the game to begin"}
                  </h1>
                  <p className="lede">
                    {state.running && activeRun ? (
                      <>
                        <StatusBadge status={activeRun.status} />
                        <span>{activeRun.model.name}</span>
                        <span>Started {when(activeRun.startedAt, tick)}</span>
                        {activeRun.progress?.phase && (
                          <span>Phase · {activeRun.progress.phase}</span>
                        )}
                      </>
                    ) : recent[0] ? (
                      <>
                        <span className="nosep">Last run</span>
                        <a className="text-link" href={`#run/${recent[0].id}`}>
                          {runTitle(recent[0])} · {recent[0].model.name}
                        </a>
                        <StatusBadge status={recent[0].status} />
                        <span>{when(recent[0].startedAt, tick)}</span>
                      </>
                    ) : (
                      <span>
                        Stronghold Crusader: Definitive Edition, observed
                        through the game window and a read-only stats reader.
                      </span>
                    )}
                  </p>
                </div>
                {state.running && activeRun && (
                  <div className="head-actions">
                    <a className="button ghost" href={`#run/${activeRun.id}`}>
                      Run details
                      <ArrowUpRight size={14} />
                    </a>
                    <button className="button danger" onClick={stop}>
                      <Square size={13} />
                      Stop run
                    </button>
                  </div>
                )}
              </section>
              {state.running && activeRun && (
                <RunVitals run={activeRun} now={tick} />
              )}
              <div className="live-grid">
                <div className="stack">
                  <GameView
                    frame={frame}
                    frameRef={frameRef}
                    connected={connected}
                    connecting={state.connecting}
                    running={state.running}
                    busy={busy}
                    manual={manual}
                    setManual={setManual}
                    live={live}
                    setLive={setLive}
                    refresh={() => void perform(refresh)}
                    act={act}
                    toggleConnection={toggleConnection}
                    now={tick}
                  />
                  <Kingdom
                    stats={stats ?? lastReading?.observation ?? null}
                    readingAge={
                      stats || !lastReading
                        ? 0
                        : Math.floor((tick - lastReading.at) / 1000)
                    }
                    history={history}
                    connected={connected}
                  />
                </div>
                <div className="stack">
                  {state.running && activeRun?.progress && (
                    <Plan run={activeRun} />
                  )}
                  <Card
                    title="Activity"
                    className="activity"
                    aside={
                      state.activeRunId && (
                        <a
                          className="text-link"
                          href={`#run/${state.activeRunId}`}
                        >
                          Full log <ArrowUpRight size={13} />
                        </a>
                      )
                    }
                  >
                    <Logs
                      entries={state.logs}
                      streaming={state.streamingText}
                      emptyText="Activity from the agent and the game appears here."
                    />
                  </Card>
                </div>
              </div>
            </>
          )}

          {route.page === "runs" && (
            <>
              <section className="page-head">
                <div>
                  <p className="eyebrow">Benchmark history</p>
                  <h1>
                    {route.model === "all"
                      ? "Runs"
                      : (state.models.find((m) => m.id === route.model)?.name ??
                        "Runs")}
                  </h1>
                  <p className="lede">
                    <span>
                      Every run is saved under harness/runtime/runs with its
                      logs, events and notebook.
                    </span>
                  </p>
                </div>
              </section>
              <RunsView
                runs={state.runs}
                models={state.models}
                modelFilter={route.model}
                now={tick}
              />
            </>
          )}

          {route.page === "run" &&
            (selectedRun ? (
              <RunDetail
                run={selectedRun}
                logs={detail?.run.id === selectedRunId ? detail.logs : null}
                streaming={
                  state.activeRunId === selectedRunId ? state.streamingText : ""
                }
                now={tick}
                rerun={() => rerun(selectedRun)}
                stop={stop}
              />
            ) : (
              <section className="page-head">
                <div>
                  <p className="eyebrow">Run</p>
                  <h1>{state.runs.length ? "Run not found" : "Loading…"}</h1>
                  <p className="lede">
                    <a className="text-link" href="#runs">
                      Back to all runs
                    </a>
                  </p>
                </div>
              </section>
            ))}
        </div>
      </main>

      {newRun && (
        <NewRunDialog
          draft={{ ...draft, modelId: draftModel?.id ?? "" }}
          update={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          models={state.models}
          close={() => setNewRun(false)}
          configure={(m) => {
            setNewRun(false);
            openModel(m);
          }}
          blocker={blocker}
          busy={busy}
          now={tick}
          start={() =>
            void perform(async () => {
              setManual(false);
              await request("agent/run", {
                benchmarkType: draft.benchmarkType,
                prompt: draft.prompt,
                config: {
                  playMinutes: draft.playMinutes,
                  wallLimitMinutes: draft.wallLimitMinutes,
                  defaultWaitSeconds: draft.waitSeconds,
                  minTurnSeconds: draft.minTurnSeconds,
                  contextBudget: draft.contextBudget,
                  imageTokenEstimate: 4096,
                  recordVideo: draft.recordVideo,
                },
                modelId: draftModel?.id,
              });
              setNewRun(false);
              window.location.hash = "live";
            })
          }
        />
      )}
      {settings && (
        <ModelForm
          model={editing}
          close={() => setSettings(false)}
          saved={(m) => setDraft((d) => ({ ...d, modelId: m.id }))}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
