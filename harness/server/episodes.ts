/**
 * Unattended benchmark episodes through the running dashboard (npm run dev or start):
 * start the game through Steam on the Ubuntu host, load a save by name, pause,
 * run the agent with a game-time budget, record a scorecard, close the game.
 *
 *   npm run episodes -- --save "Oasis by the Sea-1" --map "Oasis by the Sea" \
 *     --benchmark "Oasis by the Sea construction" --model "Kimi K3" \
 *     --prompt-file prompt/objectives/oasis-by-the-sea.txt --game-minutes 25
 *
 * The episodes (3 by default) form a learning series: each starts from the playbook the agent
 * left at the end of the one before, and the last episode's score is the series' score.
 * --no-playbook runs them as independent runs instead. An episode counts when it is a full-budget
 * score or the model itself ended it (series.ts). One stopped by the operator (Ctrl-C here, the
 * dashboard or the control monitor) pauses the series; one ended by the harness, game or provider is
 * run once more, then pauses it. --resume <series id> continues a paused series from that episode
 * with the playbook it started from. A series needs a benchmark version (benchmark-version.ts) and
 * a game machine whose helper and reader files match this checkout, unless --unversioned.
 *
 * --idle measures the do-nothing baseline: no agent, the game runs untouched at the benchmark's
 * speed for the same game time, then the scorecard is read.
 *
 * --dry-run does everything except the agent run (no model cost); --keep-game leaves
 * the game running (paused) afterwards for manual inspection; --record records the game
 * while the agent acts and renders video.mp4 into the run folder after the scorecard.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { gameHost, quote } from "./device.js";
import { netWorth } from "./market-prices.js";
import { idleBaseline } from "./baselines.js";
import { renderVideo, type VideoResult } from "./video.js";
import { saveGame, type GameSave } from "./game-save.js";
import { setGameSpeed } from "./game-speed.js";
import { behaviourFiles } from "./benchmark-version.js";
import { classify, counts, episodeSaveName, nextAttempt, nextEpisode, resultOf, settingsDifferences, type Attempt, type SeriesRecord, type SeriesSettings } from "./series.js";
import { TICKS_PER_GAME_SECOND, modelSettings, runConfigSchema, type Frame, type GameAction, type GameSpeedSetting, type ModelProfile, type Run, type RunConfig, type RunSeries, type State } from "../shared/protocol.js";

const { values: opts } = parseArgs({
  options: {
    // Series settings: no defaults here, so --resume can refuse any that is given (see DEFAULTS).
    save: { type: "string" },
    map: { type: "string" },
    benchmark: { type: "string" },
    model: { type: "string" },
    prompt: { type: "string" },
    "prompt-file": { type: "string" },
    "game-minutes": { type: "string" },
    "wall-limit-minutes": { type: "string" },
    "default-wait": { type: "string" },
    "min-turn-seconds": { type: "string" },
    "context-budget": { type: "string" },
    episodes: { type: "string" },
    "no-playbook": { type: "boolean" },
    record: { type: "boolean" },
    // How to run, not what.
    resume: { type: "string" },
    unversioned: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    idle: { type: "boolean", default: false },
    restart: { type: "boolean", default: false },
    "keep-game": { type: "boolean", default: false },
    port: { type: "string", default: process.env.PORT || "4317" },
  },
});
const DEFAULTS = {
  benchmark: "Custom", "game-minutes": "25", "wall-limit-minutes": "360", "default-wait": "5",
  "min-turn-seconds": "8", "context-budget": "120000", episodes: "3",
};
const setting = (name: keyof typeof DEFAULTS) => opts[name] ?? DEFAULTS[name];
const SETTING_FLAGS = ["save", "map", "benchmark", "model", "prompt", "prompt-file", "game-minutes", "wall-limit-minutes",
  "default-wait", "min-turn-seconds", "context-budget", "episodes", "no-playbook", "record"] as const;
/** What an episode is run with: a series' settings, or the flags for --idle and --dry-run. */
type Plan = { save: string; map?: string; benchmark: string; prompt: string; profileId?: string; config: RunConfig };

const base = `http://127.0.0.1:${opts.port}/api/`;
const renders: Promise<VideoResult | null>[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The series' runner.log, once there is one: Ctrl-C also ends a `| tee`. */
let logFile: string | undefined;
const log = (text: string) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${text}`;
  console.log(line);
  if (logFile) appendFileSync(logFile, line + "\n");
};
process.stdout.on("error", () => {});

/**
 * Ctrl-C (or SIGTERM) stops the current episode: the dashboard run is stopped, the game closed and
 * the series paused there, to be continued with --resume. npm and tsx can pass on the same Ctrl-C
 * more than once, so only a second one at least 2 s later quits at once.
 */
let stopRequested = false;
let stopRequestedAt = 0;
function requestStop() {
  if (stopRequested) {
    if (Date.now() - stopRequestedAt < 2000) return;
    log("Second stop: quitting now. The game and a dashboard run may still be going.");
    process.exit(130);
  }
  stopRequested = true;
  stopRequestedAt = Date.now();
  log("Stop requested: ending this episode, closing the game and pausing the series. Ctrl-C again to quit at once.");
  api("agent/stop", {}).catch(() => {});
}
process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);
function checkStop() {
  if (stopRequested) throw new Error("Stopped by the operator.");
}

async function api<T = any>(route: string, body?: unknown): Promise<T> {
  const res = await fetch(base + route, body === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Crusader-Client": "dashboard" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${route}: ${data.error || res.status}`);
  return data as T;
}

/** tools/ubuntu/game-session.py on the game host; returns its JSON line. */
function gameSession(
  command: "status" | "launch" | "activate" | "close" | "saves" | "backup-save" | "restore-save" | "export-save",
  timeout = 180,
  names: string[] = [],
) {
  const { host, root } = gameHost();
  const nameArgs = names.map((name) => ` --name ${quote(name)}`).join("");
  return new Promise<any>((resolve, reject) => {
    const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10", host,
      `${quote(`${root}/.venv-control/bin/python`)} ${quote(`${root}/tools/ubuntu/game-session.py`)} ${command} --timeout ${timeout}${nameArgs}`]);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => {
      try {
        const result = JSON.parse(out.trim().split("\n").at(-1) || "{}");
        result.ok ? resolve(result) : reject(new Error(`game-session ${command}: ${result.error}`));
      } catch {
        reject(new Error(`game-session ${command}: no result`));
      }
    });
  });
}

async function frame() {
  checkStop();
  return api<Frame>("frame");
}
/**
 * Send one input on a fresh frame. The bridge refuses input while another window has focus; a
 * Steam window or the control-monitor xterm took focus during save loading (2026-09-29), so
 * re-activate the game and retry a few times.
 */
async function send(action: (f: Frame) => GameAction) {
  for (let attempt = 0; ; attempt++) {
    const f = await frame();
    try {
      await api("action", { action: action(f), frameId: f.id });
      return;
    } catch (error) {
      if (attempt >= 3 || !/not the active application/i.test(String(error))) throw error;
      log("The game lost focus; re-activating it");
      await gameSession("activate");
      await sleep(1000);
    }
  }
}
async function act(action: GameAction) {
  await send(() => action);
}
/** Click a point given in the tested 1920 × 1080 menu layout, scaled to the window. */
async function clickScaled(x: number, y: number) {
  await send((f) => ({ type: "click", x: Math.round((x * f.width) / 1920), y: Math.round((y * f.height) / 1080), button: 1 }));
}
function keysFor(text: string) {
  return [...text].map((c) => {
    if (/[a-z0-9]/i.test(c)) return c.toUpperCase();
    if (c === " ") return "Space";
    if (c === "-") return "-";
    throw new Error(`The save name contains an unsupported character: ${JSON.stringify(c)}`);
  });
}

async function waitFor<T>(what: string, seconds: number, probe: () => Promise<T | undefined>, stoppable = true) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (stoppable) checkStop();
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(1000);
  }
}

/** EPISODE_DEBUG=1 saves a screenshot after each save-loading step. */
async function debugShot(step: string) {
  if (!process.env.EPISODE_DEBUG) return;
  mkdirSync("harness/runtime/episodes", { recursive: true });
  writeFileSync(`harness/runtime/episodes/debug-${Date.now()}-${step}.jpg`, Buffer.from((await frame()).image, "base64"));
}

/**
 * Wait until three captures 3 s apart are identical. The Firefly logo and the promo
 * splash are also still for a while, so callers first wait out the startup sequence.
 */
async function waitForStillScreen(seconds: number) {
  let previous = "";
  let same = 0;
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const image = (await frame()).image;
    same = image === previous ? same + 1 : 0;
    if (same >= 2) return true;
    previous = image;
    await sleep(3000);
  }
  return false;
}
/** Logo, loading screen and promo splash took about 45 s after the window appeared (live 2026-09-28). */
const STARTUP_SECONDS = 45;

/** Load a save by typing its name into the Load Game search box (main menu layout, live 2026-09-28). */
async function loadSave(save: string, map?: string, launchedAt = Date.now()) {
  const loaded = async () => {
    const state = await api<State>("state");
    const o = state.stats?.observation;
    return state.stats?.status === "ok" && o && (!map || o.map_name === map) ? o : undefined;
  };
  await sleep(Math.max(0, launchedAt + STARTUP_SECONDS * 1000 - Date.now()));
  for (let attempt = 1; attempt <= 3; attempt++) {
    await waitForStillScreen(90);
    await debugShot(`${attempt}-menu`);
    // The menu can look ready before it accepts input: click Load Game until the screen changes.
    for (let click = 0; click < 5; click++) {
      const before = (await frame()).image;
      await clickScaled(670, 1018); // Main menu: Load Game
      await sleep(1500);
      if ((await frame()).image !== before) break;
    }
    await debugShot(`${attempt}-after-load-click`);
    // The dialog fades in and fills its list; Backspace outside the search box would close it.
    await waitForStillScreen(15);
    await clickScaled(1178, 976); // Search box
    await sleep(400);
    for (const key of keysFor(save)) await act({ type: "key", key: key as never });
    await sleep(1000);
    await debugShot(`${attempt}-typed`);
    await clickScaled(900, 261); // First matching row
    await sleep(800);
    await clickScaled(408, 877); // Load Game button
    try {
      return await waitFor("the save to load", 60, loaded);
    } catch (error) {
      const shot = (await frame()).image;
      mkdirSync("harness/runtime/episodes", { recursive: true });
      const file = `harness/runtime/episodes/load-failure-${attempt}-${Date.now()}.jpg`;
      writeFileSync(file, Buffer.from(shot, "base64"));
      const state = await api<State>("state").catch(() => undefined);
      log(`Load attempt ${attempt} failed; screenshot ${file}; reader ${state?.stats?.status ?? "none"}, map ${JSON.stringify(state?.stats?.observation?.map_name)}`);
      if (attempt === 3) throw error;
    }
  }
  throw new Error("unreachable");
}

async function setPaused(paused: boolean) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await api<State>("state");
    if (state.stats?.status === "ok" && state.stats.observation?.paused === paused) return;
    if (state.stats?.status === "ok") await act({ type: "key", key: "P" });
    await sleep(1500);
  }
  throw new Error(`Could not confirm the game ${paused ? "paused" : "running"}.`);
}

/**
 * Why an agent episode's net worth is not a full-budget score, if it is not: the run did not
 * complete, a limit other than the game-time budget ended it, the final pause was not confirmed, or
 * the reading is the last one seen during play. Empty for a valid episode.
 */
function invalidity(run: Run, source: "final" | "last_observed") {
  const reasons: string[] = [];
  if (run.status !== "completed")
    reasons.push(`run ${run.status}${run.progress?.stopReason ? ` (${run.progress.stopReason})` : ""}`);
  const endedBy = run.progress?.budget?.endedBy;
  if (endedBy !== "game_time") reasons.push(endedBy ? `ended by ${endedBy}` : "game-time budget not used up");
  if (!run.progress?.finalPause?.startsWith("Confirmed paused")) reasons.push("final pause not confirmed");
  if (source !== "final") reasons.push("scored from the last reading during play");
  return reasons;
}

function scorecard(state: State, run?: Run, source: "final" | "last_observed" = "final", baseline?: number) {
  const o = state.stats?.observation;
  const s = o?.settlement;
  const goods = o?.resources_by_name ?? {};
  const worth = netWorth(o?.gold, goods);
  const invalid = run ? invalidity(run, source) : [];
  return {
    // "last_observed": the game was gone at the end (e.g. a memory-guard stop), so these are the
    // last valid reader values seen while the run was in progress.
    source,
    // Agent episodes only: whether net_worth is a full-budget score (a series' score must be).
    ...(run ? { valid: invalid.length === 0, ...(invalid.length ? { invalid } : {}) } : {}),
    map: o?.map_name,
    date: s ? { month: s.month, year: s.year } : null,
    game_time: o?.game_time,
    // Economy score: gold plus stored goods at the marketplace sell price (market-prices.ts).
    net_worth: worth.netWorth,
    goods_value: worth.goodsValue,
    // Growth: what the run added beyond leaving the game alone for the same budget (baselines.ts).
    ...(baseline !== undefined ? { net_worth_baseline: baseline, net_worth_growth: worth.netWorth - baseline } : {}),
    gold: o?.gold,
    population: o?.population,
    housing: s?.housing_cap,
    popularity: o?.popularity,
    total_food: s?.total_food,
    goods: Object.fromEntries(Object.entries(goods).filter(([, v]) => v)),
    structures_map_wide: o?.structures?.count,
    troops: o?.own_troops?.total,
    ...(run ? {
      run: {
        id: run.id,
        folder: run.folder,
        status: run.status,
        stopReason: run.progress?.stopReason,
        budget: run.progress?.budget,
        turns: run.turns,
        tokens: run.tokens,
        inference: run.progress?.inference,
        memory: run.progress?.memory,
      },
    } : {}),
  };
}

/**
 * The agent runs inside the dashboard server, which loads the harness once at start. Refuse
 * to run when harness or prompt files changed since then (runs 8 and 9 ran older code).
 */
async function checkDashboardFresh() {
  const started = (await api<State>("state")).serverStartedAt;
  if (!started) throw new Error("The dashboard does not report its start time; restart it (npm run dev).");
  const newer: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(ts|md)$/.test(entry.name) && !entry.name.endsWith(".test.ts") && statSync(file).mtimeMs > started) newer.push(file);
    }
  };
  for (const dir of ["harness/server", "harness/shared", "prompt"]) walk(dir);
  if (newer.length) throw new Error(`The dashboard started before these files changed; restart it (npm run dev): ${newer.join(", ")}`);
}

async function episode(
  n: number,
  total: number,
  plan: Plan,
  series?: RunSeries,
  playbook?: string,
) {
  checkStop();
  log(`Episode ${n}/${total}${series?.attempt && series.attempt > 1 ? ` (attempt ${series.attempt})` : ""}: starting the game`);
  const before = await gameSession("status");
  if (before.running) {
    if (!opts.restart) throw new Error("A game is already running; close it or pass --restart.");
    await gameSession("close", 60);
  }
  await gameSession("launch", 180);
  const launchedAt = Date.now();
  await gameSession("activate");
  await waitFor("the dashboard connection", 90, async () => {
    try {
      await api("connect", {});
      return true;
    } catch {
      await gameSession("activate").catch(() => {});
      return undefined;
    }
  });
  try {
    log(`Loading "${plan.save}"`);
    const loaded = await loadSave(plan.save, plan.map, launchedAt);
    log(`Loaded ${loaded.map_name} at game tick ${loaded.game_time}; pausing`);
    await setPaused(true);
    const baseline = idleBaseline(plan.save, plan.config.gameMinutes);
    let run: Run | undefined;
    let lastGood: State | undefined;
    let idleSpeed: GameSpeedSetting | undefined;
    if (opts.idle) idleSpeed = await idle(plan.config.gameMinutes, plan.config.wallLimitMinutes);
    else if (!opts["dry-run"]) {
      checkStop();
      const { runId } = await api<{ runId: string }>("agent/run", {
        benchmarkType: plan.benchmark,
        modelId: plan.profileId,
        prompt: plan.prompt,
        config: plan.config,
        // Rendered below, after the scorecard, so the video's result card can show it.
        renderVideo: false,
        ...(series ? { series, playbook: playbook ?? "" } : {}),
      });
      log(`Agent run ${runId} started`);
      await sleep(3000);
      // Not stoppable: a stop request stops the dashboard run, and this wait sees it end.
      await waitFor("the agent run to finish", plan.config.wallLimitMinutes * 60 + 600, async () => {
        const state = await api<State>("state");
        if (state.stats?.status === "ok" && state.stats.observation) lastGood = state;
        return state.running ? undefined : true;
      }, false);
      run = (await api<{ run: Run }>(`runs/${runId}`)).run;
      log(`Run ${run.status}: ${run.progress?.stopReason ?? "?"}; ${run.turns} turns`);
    }
    // A single read can land on a transient unavailable reader sample; wait for a valid one.
    let final = await api<State>("state");
    for (let i = 0; i < 20 && final.stats?.status !== "ok"; i++) {
      await sleep(500);
      final = await api<State>("state");
    }
    const card = final.stats?.status === "ok" || !lastGood
      ? scorecard(final, run, "final", baseline)
      : scorecard(lastGood, run, "last_observed", baseline);
    const dir = run
      ? path.join("harness/runtime/runs", run.folder)
      : path.join("harness/runtime/episodes");
    mkdirSync(dir, { recursive: true });
    // The finished game, saved to load and watch later: after scoring, while the game is paused.
    let gameSave: GameSave | undefined;
    if (run && !stopRequested && final.stats?.status === "ok" && final.stats.observation?.paused) {
      gameSave = await saveGame({
        key: (key) => act({ type: "key", key: key as never }),
        click: clickScaled,
        settle: (seconds) => waitForStillScreen(seconds).then(() => {}),
        sleep,
        session: (command, names) => gameSession(command, 60, names),
        write: (file, data) => writeFileSync(path.join(dir, file), data),
      }, episodeSaveName(run), plan.save, keysFor);
      log(gameSave.error ? `Game save failed: ${gameSave.error}` : `Game saved as "${gameSave.name}" (${gameSave.file})`);
    }
    const file = path.join(dir, run ? "episode.json" : `${opts.idle ? "idle" : "dry-run"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({
      episode: n, save: plan.save, benchmark: plan.benchmark, ...(series ? { series } : {}),
      ...(opts.idle ? { idle: { gameMinutes: plan.config.gameMinutes, gameSpeed: idleSpeed } } : {}), ...card,
      ...(gameSave ? { game_save: gameSave } : {}),
    }, null, 2));
    log(`Scorecard: ${file}`);
    // Renders run one at a time on this Mac, in the background of the next episode.
    if (run?.config?.recordVideo && run.progress?.recording?.frames)
      renders.push(renderVideo(dir, (text) => log(`Episode ${n}: ${text}`)));
    return { card, run, gameSave };
  } finally {
    await api("disconnect", {}).catch(() => {});
    if (opts["keep-game"]) log("Game left running (--keep-game); close it after inspection.");
    else {
      await gameSession("close", 60).catch((e) => log(`Close failed: ${e.message}`));
      log("Game closed");
    }
  }
}

/**
 * The do-nothing baseline: the host sets the benchmark's game speed as an agent run does, then the
 * game runs with no input for the game-time budget, counted in reader ticks, and is paused for
 * the reading.
 */
async function idle(gameMinutes: number, wallLimitMinutes: number) {
  log(`Idle baseline: the game runs untouched for ${gameMinutes} game minute(s)`);
  await setPaused(false);
  const reading = async () => {
    const stats = (await api<State>("state")).stats;
    const tick = stats?.observation?.game_time;
    return stats?.status === "ok" && typeof tick === "number" && typeof stats.captured_unix_ms === "number"
      ? { tick, at: stats.captured_unix_ms }
      : null;
  };
  const speed = await setGameSpeed({ clock: reading, press: (key) => act({ type: "key", key }), sleep });
  log(`Game speed set to ${speed.target}: measured ${speed.after} ticks/s (was ${speed.before}; ${speed.presses} key presses)`);
  const started = Date.now();
  let first: number | undefined;
  for (let i = 0; i < 30 && first === undefined; i++) {
    first = (await reading())?.tick;
    if (first === undefined) await sleep(100);
  }
  if (first === undefined) throw new Error("No game-clock reading; cannot start the idle baseline's budget.");
  const budget = gameMinutes * 60 * TICKS_PER_GAME_SECOND;
  let tick = first;
  while (tick - first < budget) {
    if (Date.now() - started > wallLimitMinutes * 60_000)
      throw new Error(`The idle baseline passed the ${wallLimitMinutes}-minute real-time limit.`);
    await sleep(100);
    tick = (await reading())?.tick ?? tick;
  }
  await setPaused(true);
  log(`Idle baseline: paused after ${Math.round((tick - first) / TICKS_PER_GAME_SECOND)} game seconds`);
  return speed;
}

/**
 * Game-machine files that differ from this checkout: the window bridge, reader stream, memory guard
 * and reader sources run there from a copy synced by hand, so a version needs them to match. (The
 * reader binaries are not compared; rebuild them after syncing the sources.)
 */
async function gameMachineDifferences() {
  const files = behaviourFiles().filter((file) => /^(tools\/ubuntu|src|cmake)\//.test(file) || file === "CMakeLists.txt");
  const local = new Map(files.map((file) => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
  const { host, root } = gameHost();
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host,
      `cd ${quote(root)} && sha256sum -- ${files.map(quote).join(" ")} 2>/dev/null; true`]);
    let text = "";
    child.stdout.on("data", (d) => (text += d));
    child.on("error", reject);
    child.on("close", () => resolve(text));
  });
  const remote = new Map(output.split("\n").filter(Boolean).map((line) => {
    const [hash, ...name] = line.split("  ");
    return [name.join("  "), hash] as const;
  }));
  return files.filter((file) => remote.get(file) !== local.get(file));
}

const seriesDir = (id: string) => path.join("harness/runtime/series", id);

function writeSeries(record: SeriesRecord) {
  writeFileSync(path.join(seriesDir(record.id), "series.json"), JSON.stringify(record, null, 2));
}

function loadSeries(id: string): SeriesRecord {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) throw new Error(`Not a series ID: ${JSON.stringify(id)}.`);
  const file = path.join(seriesDir(id), "series.json");
  if (!existsSync(file)) throw new Error(`No series ${id} under harness/runtime/series.`);
  const record = JSON.parse(readFileSync(file, "utf8")) as SeriesRecord;
  if (!record.settings) throw new Error(`Series ${id} was made before series could be resumed; start a new one.`);
  if (record.status === "completed") throw new Error(`Series ${id} is already complete.`);
  return record;
}

/** The host's benchmark version and code, and a model profile's current settings. */
function current(state: State, profileId: string): Pick<SeriesSettings, "version" | "model"> {
  const profile = state.models.find((m) => m.id === profileId) as ModelProfile | undefined;
  if (!profile?.keyConfigured) throw new Error("The series' model profile is gone or has no API key.");
  const b = state.benchmark;
  return {
    version: { version: b?.version ?? null, fingerprint: b?.fingerprint ?? "unknown", guide: b?.guide ?? null, commit: b?.commit ?? null },
    model: { profileId, name: profile.name, modelId: profile.modelId, baseUrl: profile.baseUrl, ...modelSettings(profile) },
  };
}

/** Run or continue an agent series until every episode has a result, or pause it. */
async function runSeries(state: State, record: SeriesRecord, resuming: boolean) {
  const { settings } = record;
  const now = current(state, settings.model.profileId);
  // Runs are comparable only under one benchmark version, with the game machine in step.
  const problems: string[] = [];
  if (!state.benchmark) problems.push("the dashboard reports no benchmark version (restart it)");
  else {
    if (!state.benchmark.version) problems.push(`no benchmark version for fingerprint ${state.benchmark.fingerprint.slice(0, 12)} (npm run benchmark-version -- check)`);
    if (state.benchmark.dirty) problems.push("uncommitted changes to the harness, prompt or tools");
  }
  const remote = await gameMachineDifferences();
  if (remote.length) problems.push(`the game machine's copy differs: ${remote.join(", ")}`);
  if (problems.length) {
    if (!opts.unversioned) throw new Error(`Not a versioned benchmark run: ${problems.join("; ")}. Fix it, or pass --unversioned for a trial run.`);
    log(`Unversioned run: ${problems.join("; ")}`);
  }
  if (resuming) {
    const differences = settingsDifferences(settings, now);
    if (differences.length) throw new Error(`Series ${record.id} cannot continue on different settings: ${differences.join("; ")}.`);
  }
  mkdirSync(seriesDir(record.id), { recursive: true });
  logFile = path.join(seriesDir(record.id), "runner.log");
  const plan: Plan = { save: settings.save, map: settings.map, benchmark: settings.benchmark, prompt: settings.prompt, profileId: settings.model.profileId, config: settings.config };
  const playbookAfter = (n: number) => {
    const file = path.join(seriesDir(record.id), `playbook-after-episode-${n}.md`);
    return n > 0 && existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  log(`${resuming ? "Resuming" : settings.learning ? "Learning" : "Independent"} series ${record.id}: ${record.episodes} episode(s), benchmark ${now.version.version ?? "unversioned"}${settings.learning ? "; the playbook carries over between them" : ""}`);
  record.status = "running";
  delete record.stopped;
  writeSeries(record);
  const pause = (reason: string) => {
    record.status = "paused";
    record.stopped = reason;
    writeSeries(record);
    log(`Series paused: ${reason}. Continue it with: npm run episodes -- --resume ${record.id}`);
    process.exitCode = 1;
  };
  // An infrastructure failure is run again once at once; a second one pauses the series.
  let retried = false;
  // Saving the finished game changed the benchmark save: stop before another episode loads it.
  let benchmarkSaveChanged: string | undefined;
  for (let n = nextEpisode(record); n !== null; n = nextEpisode(record)) {
    try {
      await checkDashboardFresh();
    } catch (error) {
      pause(`before episode ${n}: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    if (stopRequested) {
      pause(`stopped by the operator before episode ${n}`);
      break;
    }
    const attempt = nextAttempt(record.results, n);
    const playbook = settings.learning ? playbookAfter(n - 1) : undefined;
    const series = settings.learning ? { id: record.id, episode: n, episodes: record.episodes, attempt } : undefined;
    let result: Attempt;
    try {
      const { card, run, gameSave } = await episode(n, record.episodes, plan, series, playbook);
      benchmarkSaveChanged = gameSave?.benchmarkSaveChanged ? gameSave.error : undefined;
      console.log(JSON.stringify(card));
      result = {
        episode: n, attempt, ...classify({ run, valid: card.valid, invalid: card.invalid, stopRequested }),
        run: run?.id, folder: run?.folder, status: run?.status, net_worth: card.net_worth,
        net_worth_growth: card.net_worth_growth, valid: card.valid, ...(card.invalid ? { invalid: card.invalid } : {}),
      };
      // What the agent left in its playbook (after its reflection) starts the next episode.
      if (counts(result) && settings.learning) {
        const file = run ? path.join("harness/runtime/runs", run.folder, "playbook.md") : "";
        writeFileSync(path.join(seriesDir(record.id), `playbook-after-episode-${n}.md`), file && existsSync(file) ? readFileSync(file, "utf8") : playbook ?? "");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { episode: n, attempt, ...classify({ error: message, stopRequested }), error: message };
    }
    record.results.push(result);
    writeSeries(record);
    log(`Episode ${n}, attempt ${attempt}: ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`);
    if (benchmarkSaveChanged) {
      pause(`after episode ${n}: ${benchmarkSaveChanged}; check the benchmark save before continuing`);
      break;
    }
    if (counts(result)) {
      retried = false;
      continue;
    }
    if (result.outcome === "infrastructure" && !retried) {
      retried = true;
      log(`Running episode ${n} again from the same playbook.`);
      continue;
    }
    pause(result.outcome === "stopped" ? `episode ${n}: ${result.reason}` : `episode ${n} failed twice (${result.reason ?? result.outcome})`);
    break;
  }
  if (nextEpisode(record) === null) {
    record.status = "completed";
    writeSeries(record);
  }
  const worth = Array.from({ length: record.episodes }, (_, i) => {
    const r = resultOf(record.results, i + 1);
    return !r ? "–"
      : r.outcome === "model_failure" ? `${r.net_worth ?? "?"} (ended by the model: ${r.reason})`
        : r.valid === false ? `${r.net_worth} (not a full-budget score: ${(r.invalid ?? []).join("; ")})`
          : String(r.net_worth);
  });
  log(`Net worth by episode: ${worth.join(" → ")}`);
}

/** --idle and --dry-run: no agent and no series. */
async function runPlain(plan: Plan, total: number) {
  for (let n = 1; n <= total && !stopRequested; n++) {
    try {
      const { card } = await episode(n, total, plan);
      console.log(JSON.stringify(card));
    } catch (error) {
      log(`Episode ${n} failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}

async function main() {
  const state = await api<State>("state").catch(() => {
    throw new Error(`The dashboard is not reachable on port ${opts.port}; start it with npm run dev.`);
  });
  if (state.running || state.connected) throw new Error("The dashboard is connected or running; disconnect it first.");
  const agent = !opts["dry-run"] && !opts.idle;
  if (opts.resume) {
    if (!agent) throw new Error("--resume continues an agent series; leave out --idle and --dry-run.");
    const given = SETTING_FLAGS.filter((flag) => opts[flag] !== undefined);
    if (given.length) throw new Error(`--resume runs the series with its own settings; leave out ${given.map((f) => `--${f}`).join(", ")}.`);
    await runSeries(state, loadSeries(opts.resume), true);
  } else {
    if (!opts.save) throw new Error("--save is required (the save name shown in Load Game).");
    const total = Number(setting("episodes"));
    if (!Number.isInteger(total) || total < 1 || total > 20) throw new Error("--episodes must be 1 to 20.");
    const config = runConfigSchema.parse({
      gameMinutes: Number(setting("game-minutes")),
      wallLimitMinutes: Number(setting("wall-limit-minutes")),
      defaultWaitSeconds: Number(setting("default-wait")),
      minTurnSeconds: Number(setting("min-turn-seconds")),
      contextBudget: Number(setting("context-budget")),
      imageTokenEstimate: 4096,
      recordVideo: opts.record ?? false,
    });
    const plan: Plan = { save: opts.save, map: opts.map, benchmark: setting("benchmark"), prompt: "", config };
    if (!agent) await runPlain(plan, total);
    else {
      const model = state.models.find((m) => m.id === opts.model || m.name === opts.model);
      if (!model?.keyConfigured) throw new Error("--model must name a saved model profile with an API key.");
      const prompt = opts.prompt ?? (opts["prompt-file"] ? readFileSync(opts["prompt-file"], "utf8").trim() : "");
      if (!prompt) throw new Error("--prompt or --prompt-file is required for an agent run.");
      const id = `${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "")}-${randomUUID().slice(0, 8)}`;
      await runSeries(state, {
        id, save: plan.save, map: plan.map, benchmark: plan.benchmark, model: model.name, episodes: total,
        results: [], status: "running",
        settings: {
          save: plan.save, map: plan.map, benchmark: plan.benchmark, prompt, config,
          learning: !opts["no-playbook"], ...current(state, model.id),
        },
      }, false);
    }
  }
  if (renders.length) {
    log(`Waiting for ${renders.length} video render(s)`);
    await Promise.all(renders);
  }
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
