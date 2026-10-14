/**
 * Unattended benchmark episodes through the running dashboard (npm run dev or start):
 * start the game through Steam on the Ubuntu host, load a save by name, pause,
 * run the agent with a game-time budget, record a scorecard and the results (the whole state
 * at the end: results.ts), close the game. Every kind of run below records the same results.
 *
 *   npm run episodes -- --save "Oasis by the Sea-1" --map "Oasis by the Sea" \
 *     --benchmark "Oasis by the Sea construction" --model "Kimi K3" \
 *     --prompt-file prompt/objectives/oasis-by-the-sea.txt --game-minutes 25
 *
 * The episodes (3 by default) are independent runs of the same save. --playbook makes them a
 * learning series instead: each starts from the playbook the agent left at the end of the one
 * before, and the last episode's score is the series' score. An episode counts when it is a full-budget
 * score or the model itself ended it (series.ts). One stopped by the operator (Ctrl-C here, the
 * dashboard or the control monitor) pauses the series; one ended by the harness, game or provider is
 * run once more, then pauses it. --resume <series id> continues a paused series from that episode
 * with the playbook it started from. A series needs a benchmark version (benchmark-version.ts) and
 * a game machine whose helper and reader files match this checkout, unless --unversioned.
 *
 * After each episode that counts, once it is scored and the game saved and closed, the host
 * interviews the agent about its game in the conversation it played in (interview.ts); the
 * transcript goes to interview.md in the run's folder. --no-interview leaves it out. The next
 * episode's game loads meanwhile; the last episode's interview is left to the host, so the runner
 * exits without waiting for it, and a runner that finds one still running waits for it before its
 * agent run (the host runs one at a time).
 *
 * --idle measures the do-nothing baseline: no agent, the game runs untouched at the benchmark's
 * speed for the same game time, then the scorecard is read.
 *
 * --human is a reference game played by a person at the game machine: the runner loads the save,
 * sets the benchmark's speed and leaves the game paused; the player unpauses it, and when the
 * game-time budget is used up the runner pauses it, reads the scorecard, keeps a screenshot and
 * saves the game. One game unless --episodes says more.
 *
 * --dry-run does everything except the agent run (no model cost); --keep-game leaves
 * the game running (paused) afterwards for manual inspection; --record records the game
 * while the agent acts and, after the scorecard, renders video.mp4 into the run folder in the
 * background (tools/video/render-queue.py: one render at a time on this machine, at low priority;
 * the runner does not wait for it, so the next runner can start). --no-fast-waits plays every wait
 * at the benchmark speed instead of the game's top speed (fast waits: game-speed.ts).
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { gameHost, quote } from "./device.js";
import { netWorth } from "./market-prices.js";
import { idleBaseline } from "./baselines.js";
import { resultsMarkdown, runResults, type RunKind } from "./results.js";
import { renderInBackground } from "./video.js";
import { saveGame, type GameSave } from "./game-save.js";
import { setGameSpeed } from "./game-speed.js";
import { MENU_PROBES, menuScreen, type MenuScreen } from "./menu-screen.js";
import { forwardedArgs, readRounds, roundPlan, writeRound, type Round } from "./rounds.js";
import { freePort, gameMachineDifferences, installOverlay, needsOverlayFeed, prepareWorktree, startHost, stopHost, syncGameMachine } from "./version-checkout.js";
import { startOverlayFeed } from "./overlay-feed.js";
import { classify, counts, episodeSaveName, humanSaveName, nextAttempt, nextEpisode, resultOf, settingsDifferences, type Attempt, type SeriesRecord, type SeriesSettings } from "./series.js";
import { TICKS_PER_GAME_SECOND, costProblem, modelSettings, runConfigSchema, type Frame, type GameAction, type GameSpeedSetting, type ModelProfile, type Run, type RunConfig, type RunSeries, type State } from "../shared/protocol.js";

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
    "fallback-observation": { type: "string" },
    "screenshot-width": { type: "string" },
    "context-budget": { type: "string" },
    episodes: { type: "string" },
    playbook: { type: "boolean" },
    record: { type: "boolean" },
    "no-fast-waits": { type: "boolean" },
    // How to run, not what.
    resume: { type: "string" },
    unversioned: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    idle: { type: "boolean", default: false },
    human: { type: "boolean", default: false },
    restart: { type: "boolean", default: false },
    "keep-game": { type: "boolean", default: false },
    "no-interview": { type: "boolean", default: false },
    "new-round": { type: "boolean", default: false },
    port: { type: "string", default: process.env.PORT || "4317" },
  },
});
const DEFAULTS = {
  benchmark: "Custom", "game-minutes": "25", "wall-limit-minutes": "360", "default-wait": "5",
  "min-turn-seconds": "8", "fallback-observation": "when-needed", "screenshot-width": "1280", "context-budget": "120000", episodes: "3",
};
const setting = (name: keyof typeof DEFAULTS) => opts[name] ?? DEFAULTS[name];
const SETTING_FLAGS = ["save", "map", "benchmark", "model", "prompt", "prompt-file", "game-minutes", "wall-limit-minutes",
  "default-wait", "min-turn-seconds", "fallback-observation", "screenshot-width", "context-budget", "episodes", "playbook", "record", "no-fast-waits"] as const;
/** What an episode is run with: a series' settings, or the flags for --idle, --human and --dry-run. */
type Plan = { save: string; map?: string; benchmark: string; prompt: string; profileId?: string; config: RunConfig };

const base = `http://127.0.0.1:${opts.port}/api/`;
/** Video renders this runner started in the background (renderInBackground). */
let backgroundRenders = 0;
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
 * Send one input on a fresh frame (`input` is the host endpoint and body for it). The bridge
 * refuses input while another window has focus; a Steam window or the control-monitor xterm took
 * focus during save loading (2026-09-29), so re-activate the game and retry a few times.
 */
async function sendOn(input: (f: Frame) => [path: string, body: object]) {
  for (let attempt = 0; ; attempt++) {
    const f = await frame();
    try {
      const [path, body] = input(f);
      await api(path, { ...body, frameId: f.id });
      return;
    } catch (error) {
      if (attempt >= 3 || !/not the active application/i.test(String(error))) throw error;
      log("The game lost focus; re-activating it");
      await gameSession("activate");
      await sleep(1000);
    }
  }
}
async function send(action: (f: Frame) => GameAction) {
  await sendOn((f) => ["action", { action: action(f) }]);
}
/**
 * Type a run of keys (a save's name) in one bridge request: one request a key took 0.71 s each
 * over SSH, 67 to 73 s for a save name (live, 2026-10-14). The bridge checks the game's focus
 * once, before the first key, so a refusal typed none of them and the run can go again whole.
 */
async function sendKeys(keys: string[]) {
  await sendOn(() => ["keys", { keys }]);
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

async function waitFor<T>(what: string, seconds: number, probe: () => Promise<T | undefined>, stoppable = true, intervalMs = 1000) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (stoppable) checkStop();
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(intervalMs);
  }
}

/**
 * The pre-game screen the game shows (menu-screen.ts), from a few pixel colours of a capture
 * sampled by tools/runner/screen_probe.py; null when that cannot run on this host (no python3 or
 * Pillow), and the runner then waits the old way.
 */
async function currentScreen(): Promise<MenuScreen | null> {
  const image = Buffer.from((await frame()).image, "base64");
  return new Promise((resolve) => {
    const child = spawn("python3", ["-I", "tools/runner/screen_probe.py", JSON.stringify(Object.values(MENU_PROBES))]);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      try {
        resolve(code === 0 ? menuScreen(JSON.parse(out)) : null);
      } catch {
        resolve(null);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(image);
  });
}
/**
 * Poll until `target` shows: true, false at the deadline, null when screens cannot be told apart
 * here. `meanwhile` runs after each look that shows something else.
 */
async function waitForScreen(target: MenuScreen, seconds: number, intervalMs = 1000, meanwhile?: () => Promise<unknown>) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    checkStop();
    const screen = await currentScreen();
    if (screen === null) return null;
    if (screen === target) return true;
    if (Date.now() > deadline) return false;
    await meanwhile?.();
    await sleep(intervalMs);
  }
}
/**
 * Where a click skips the startup videos and the promo splash: the screen centre, which on the
 * main menu is plain cover art well away from its buttons. Clicking each second brought the main
 * menu 25 s after launch instead of 49 s, and opened nothing (live 2026-10-11).
 */
const SKIP_CLICK = { x: 960, y: 540 };

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
/**
 * Logo, loading screen and promo splash took about 45 s after the window appeared (live
 * 2026-09-28). Only for a host that cannot tell the screens apart (currentScreen null).
 */
const STARTUP_SECONDS = 45;
/** Longest wait for the main menu from launch before Load Game is clicked anyway. */
const MENU_SECONDS = 180;

/**
 * Open the Load Game dialog from the main menu. The main menu and the dialog are recognised from
 * their colours as soon as they show; a host without the screen probe waits as before: the
 * startup sequence, then until three captures 3 s apart are identical (the animated menu and
 * dialog never were, so both waits ran to their 90 s and 15 s timeouts).
 */
async function openLoadDialog(attempt: number, launchedAt: number) {
  const since = () => `${Math.round((Date.now() - launchedAt) / 1000)} s after launch`;
  const menu = await waitForScreen("main_menu", Math.max(20, (launchedAt + MENU_SECONDS * 1000 - Date.now()) / 1000), 1000,
    () => clickScaled(SKIP_CLICK.x, SKIP_CLICK.y).catch(() => {}));
  if (menu === null) {
    if (attempt === 1) await sleep(Math.max(0, launchedAt + STARTUP_SECONDS * 1000 - Date.now()));
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
    return;
  }
  log(menu ? `Main menu ${since()}` : `No main menu recognised ${since()}; clicking Load Game anyway`);
  await debugShot(`${attempt}-menu`);
  // The menu can show before it accepts input: click Load Game until the dialog shows.
  let dialog = false;
  for (let click = 0; click < 5 && !dialog; click++) {
    await clickScaled(670, 1018); // Main menu: Load Game
    dialog = (await waitForScreen("load_dialog", 3, 400)) === true;
  }
  if (!dialog) throw new Error("The Load Game dialog did not open.");
  log(`Load Game dialog open ${since()}`);
  await debugShot(`${attempt}-after-load-click`);
  // Recognised once nearly opaque; a moment more for it to finish fading in and fill its list.
  await sleep(1000);
}

/** Load a save by typing its name into the Load Game search box (main menu layout, live 2026-09-28). */
async function loadSave(save: string, map?: string, launchedAt = Date.now()) {
  const loaded = async () => {
    const state = await api<State>("state");
    const o = state.stats?.observation;
    return state.stats?.status === "ok" && o && (!map || o.map_name === map) ? o : undefined;
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await openLoadDialog(attempt, launchedAt);
      await clickScaled(1178, 976); // Search box
      await sleep(400);
      await sendKeys(keysFor(save));
      await sleep(1000);
      await debugShot(`${attempt}-typed`);
      await clickScaled(900, 261); // First matching row
      await sleep(800);
      await clickScaled(408, 877); // Load Game button
      return await waitFor("the save to load", 60, loaded, true, 250);
    } catch (error) {
      if (stopRequested) throw error;
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

/**
 * Starts the game, connects the dashboard and loads and pauses the episode's save. Split from
 * playEpisode so a series (runSeries) can run this for the next episode while the previous one's
 * interview is still going (interview.ts; docs/benchmark.md#the-interview): neither touches the
 * other's state (the interview only holds the finished run's conversation and the model API; this
 * only drives the game connection), so the two may run at once. A failure leaves the game machine
 * as episode() always did: disconnected, and closed unless --keep-game.
 */
async function prepareEpisode(n: number, plan: Plan) {
  checkStop();
  log(`Episode ${n}: starting the game`);
  try {
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
    log(`Loading "${plan.save}"`);
    const loaded = await loadSave(plan.save, plan.map, launchedAt);
    log(`Loaded ${loaded.map_name} at game tick ${loaded.game_time}; pausing`);
    await setPaused(true);
  } catch (error) {
    await api("disconnect", {}).catch(() => {});
    if (!opts["keep-game"]) await gameSession("close", 60).catch((e) => log(`Close failed: ${e.message}`));
    throw error;
  }
}

/**
 * Closes a game prepareEpisode got ready for an episode the series ends up not playing (the
 * operator stopped it, the dashboard went stale, or the last episode's save changed the benchmark
 * save). A prepare that already failed has cleaned up after itself (prepareEpisode's own catch).
 */
async function abandonPrepared(ready: Promise<void>) {
  const prepared = await ready.then(() => true, () => false);
  if (!prepared) return;
  await api("disconnect", {}).catch(() => {});
  if (opts["keep-game"]) { log("Game left running (--keep-game); close it after inspection."); return; }
  await gameSession("close", 60).catch((e) => log(`Close failed: ${e.message}`));
  log("Game closed");
}

/**
 * Runs the agent (or --idle/--human/--dry-run), scores and saves the episode, and closes the game.
 * The game must already be connected, loaded and paused (prepareEpisode).
 */
async function playEpisode(
  n: number,
  total: number,
  plan: Plan,
  series?: RunSeries,
  playbook?: string,
) {
  log(`Episode ${n}/${total}${series?.attempt && series.attempt > 1 ? ` (attempt ${series.attempt})` : ""}: playing`);
  try {
    const baseline = idleBaseline(plan.save, plan.config.gameMinutes);
    let run: Run | undefined;
    let lastGood: State | undefined;
    let idleGame: { speed: GameSpeedSetting; playedSeconds: number } | undefined;
    let humanGame: HumanGame | undefined;
    if (opts.idle) idleGame = await idle(plan.config.gameMinutes, plan.config.wallLimitMinutes);
    else if (opts.human) {
      humanGame = await human(plan.config.gameMinutes, plan.config.wallLimitMinutes);
      lastGood = humanGame.lastGood;
    } else if (!opts["dry-run"]) {
      checkStop();
      await waitForHostInterview();
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
    const source = final.stats?.status === "ok" || !lastGood ? "final" : "last_observed";
    const reading = source === "final" ? final : lastGood!;
    const card = scorecard(reading, run, source, baseline);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const kind: RunKind = run ? "agent" : humanGame ? "human" : opts.idle ? "idle" : "dry-run";
    const dir = run
      ? path.join("harness/runtime/runs", run.folder)
      : path.join("harness/runtime/episodes", `${kind}-${stamp}`);
    mkdirSync(dir, { recursive: true });
    if (humanGame)
      log(`Your game: net worth ${card.net_worth}${card.net_worth_growth !== undefined ? `, ${card.net_worth_growth} above doing nothing` : ""}${card.source === "final" ? "" : " (the last reading before the game was lost)"}`);
    // A human game's end as it looked when the budget ran out, before the Save dialog opens.
    let screenshot: string | undefined;
    if (humanGame && final.stats?.status === "ok") {
      screenshot = "screenshot.jpg";
      writeFileSync(path.join(dir, screenshot), Buffer.from((await frame()).image, "base64"));
    }
    // The finished game, saved to load and watch later: after scoring, while the game is paused.
    let gameSave: GameSave | undefined;
    if ((run || humanGame) && !stopRequested && final.stats?.status === "ok" && final.stats.observation?.paused) {
      gameSave = await saveGame({
        // Each run of keys in one bridge request, as loadSave types the save name.
        keys: sendKeys,
        click: clickScaled,
        settle: (seconds) => waitForStillScreen(seconds).then(() => {}),
        sleep,
        session: (command, names) => gameSession(command, 60, names),
        write: (file, data) => writeFileSync(path.join(dir, file), data),
      }, run ? episodeSaveName(run) : humanSaveName(plan.save, new Date()), plan.save, keysFor);
      log(gameSave.error ? `Game save failed: ${gameSave.error}` : `Game saved as "${gameSave.name}" (${gameSave.file})`);
    }
    const file = path.join(dir, run ? "episode.json" : "scorecard.json");
    writeFileSync(file, JSON.stringify({
      episode: n, save: plan.save, benchmark: plan.benchmark, ...(series ? { series } : {}),
      ...(idleGame ? { idle: { gameMinutes: plan.config.gameMinutes, gameSpeed: idleGame.speed, playedSeconds: idleGame.playedSeconds } } : {}),
      ...(humanGame ? { human: { gameMinutes: plan.config.gameMinutes, gameSpeed: humanGame.speed, playedSeconds: humanGame.playedSeconds, ended: humanGame.ended } } : {}),
      ...card,
      ...(screenshot ? { screenshot } : {}),
      ...(gameSave ? { game_save: gameSave } : {}),
    }, null, 2));
    log(`Scorecard: ${file}`);
    // The whole state at the end, in one format for every kind of run (results.ts).
    const observation = reading.stats?.observation;
    if (observation) {
      const results = runResults(observation, {
        kind,
        player: run ? run.model.name : humanGame ? "A person" : "Nobody",
        save: plan.save,
        ...(run ? { benchmark: plan.benchmark, run: { id: run.id, folder: run.folder } } : {}),
        source,
        readAt: reading.stats?.captured_unix_ms,
        playedSeconds: run ? run.progress?.budget?.usedGameSeconds : humanGame ? humanGame.playedSeconds : idleGame ? idleGame.playedSeconds : 0,
        budgetSeconds: plan.config.gameMinutes * 60,
      });
      writeFileSync(path.join(dir, "results.json"), JSON.stringify(results, null, 2) + "\n");
      writeFileSync(path.join(dir, "results.md"), resultsMarkdown(results));
      log(`Results: ${path.join(dir, "results.md")}`);
    } else log("No results: the game was never read.");
    // Rendered in the background, one render at a time on this Mac and at low priority, while
    // the next episode (or the next runner's) plays; its lines join this runner.log when done.
    if (run?.config?.recordVideo && run.progress?.recording?.frames && renderInBackground(dir, logFile, `Episode ${n}: `, undefined, log)) {
      backgroundRenders++;
      log(`Episode ${n}: video render queued in the background (${path.join(dir, "render.log")})`);
    }
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

/** One episode start to finish: prepareEpisode then playEpisode. runSeries overlaps these across episodes itself (below); --idle, --human and --dry-run (runPlain) have no interview to overlap with, so they use this as before. */
async function episode(n: number, total: number, plan: Plan, series?: RunSeries, playbook?: string) {
  await prepareEpisode(n, plan);
  return playEpisode(n, total, plan, series, playbook);
}

/**
 * The do-nothing baseline: the host sets the benchmark's game speed as an agent run does, then the
 * game runs with no input for the game-time budget, counted in reader ticks, and is paused for
 * the reading.
 */
async function idle(gameMinutes: number, wallLimitMinutes: number) {
  log(`Idle baseline: the game runs untouched for ${gameMinutes} game minute(s)`);
  await setPaused(false);
  const speed = await setBenchmarkSpeed();
  const started = Date.now();
  const first = await startTick("the idle baseline's budget");
  const budget = gameMinutes * 60 * TICKS_PER_GAME_SECOND;
  let tick = first;
  while (tick - first < budget) {
    if (Date.now() - started > wallLimitMinutes * 60_000)
      throw new Error(`The idle baseline passed the ${wallLimitMinutes}-minute real-time limit.`);
    await sleep(100);
    tick = (await clockReading())?.tick ?? tick;
  }
  await setPaused(true);
  const playedSeconds = Math.round((tick - first) / TICKS_PER_GAME_SECOND);
  log(`Idle baseline: paused after ${playedSeconds} game seconds`);
  return { speed, playedSeconds };
}

/** The reader's game clock and when the sample was taken, or null without a valid sample. */
async function clockReading() {
  const stats = (await api<State>("state")).stats;
  const tick = stats?.observation?.game_time;
  return stats?.status === "ok" && typeof tick === "number" && typeof stats.captured_unix_ms === "number"
    ? { tick, at: stats.captured_unix_ms }
    : null;
}

/** Set the benchmark's game speed as an agent run does; the game must be running. */
async function setBenchmarkSpeed() {
  const speed = await setGameSpeed({ clock: clockReading, press: (key) => act({ type: "key", key }), sleep });
  log(`Game speed set to ${speed.target}: measured ${speed.after} ticks/s (was ${speed.before}; ${speed.presses} key presses)`);
  return speed;
}

/** The game clock's tick to count a budget from. */
async function startTick(what: string) {
  for (let i = 0; i < 30; i++) {
    const tick = (await clockReading())?.tick;
    if (tick !== undefined) return tick;
    await sleep(100);
  }
  throw new Error(`No game-clock reading; cannot start ${what}.`);
}

type HumanGame = {
  speed: GameSpeedSetting;
  /** Game seconds played, from the clock at the start to the confirmed final pause. */
  playedSeconds: number;
  /** "readings_lost": no valid reader sample for HUMAN_LOST_SECONDS, e.g. a memory-guard stop. */
  ended: "budget" | "readings_lost";
  lastGood?: State;
};
/** How long a human game waits for a valid reader sample before scoring the last one it saw. */
const HUMAN_LOST_SECONDS = 120;

/**
 * A reference game played by a person at the game machine. The host sets the benchmark's game
 * speed as an agent run does and leaves the game paused for the player to start. The budget
 * counts game time in reader ticks, so time spent paused is free, as an agent's thinking is.
 * When the budget is used up the game is paused for the reading.
 */
async function human(gameMinutes: number, wallLimitMinutes: number): Promise<HumanGame> {
  await setPaused(false);
  const speed = await setBenchmarkSpeed();
  await setPaused(true);
  const first = await startTick("the game-time budget");
  log(`Your game: ${gameMinutes} game minutes. Click the game and press P to start; the clock stops while the game is paused. ` +
    "When the time is up the game pauses itself: leave it alone while it is scored, screenshotted and saved.");
  const budget = gameMinutes * 60 * TICKS_PER_GAME_SECOND;
  const started = Date.now();
  let tick = first;
  let seenAt = Date.now();
  let lastGood: State | undefined;
  let minutesLogged = 0;
  while (tick - first < budget) {
    checkStop();
    if (Date.now() - started > wallLimitMinutes * 60_000)
      throw new Error(`The game passed the ${wallLimitMinutes}-minute real-time limit.`);
    await sleep(100);
    const state = await api<State>("state").catch(() => undefined);
    const o = state?.stats?.status === "ok" ? state.stats.observation : undefined;
    if (o && typeof o.game_time === "number") {
      tick = o.game_time;
      seenAt = Date.now();
      lastGood = state;
      const minutes = Math.floor((tick - first) / TICKS_PER_GAME_SECOND / 60);
      if (minutes > minutesLogged) {
        minutesLogged = minutes;
        log(`Your game: ${minutes} of ${gameMinutes} game minutes, net worth ${netWorth(o.gold, o.resources_by_name ?? {}).netWorth}`);
      }
    } else if (Date.now() - seenAt > HUMAN_LOST_SECONDS * 1000) {
      log(`No valid game reading for ${HUMAN_LOST_SECONDS} s; the game may have closed (the memory guard?).`);
      return { speed, playedSeconds: Math.round((tick - first) / TICKS_PER_GAME_SECOND), ended: "readings_lost", lastGood };
    }
  }
  await setPaused(true);
  const end = (await clockReading())?.tick ?? tick;
  log(`Your game: paused after ${Math.round((end - first) / TICKS_PER_GAME_SECOND)} game seconds`);
  return { speed, playedSeconds: Math.round((end - first) / TICKS_PER_GAME_SECOND), ended: "budget", lastGood };
}

/** How long the runner waits for an interview before stopping it. */
const INTERVIEW_MINUTES = 30;

/**
 * The interview after an episode that counts (interview.ts): the host asks the agent about its
 * game in the conversation it played in, now that the episode is scored and the game saved and
 * closed. Its outcome is logged and never changes the episode's result; this never throws, so
 * runSeries can run it alongside the next episode's prepareEpisode without a failed interview
 * failing the series. Setting `follow.detached` stops following it and leaves it to the host.
 */
async function interview(runId: string, series: RunSeries, follow: { detached: boolean } = { detached: false }) {
  try {
    await api("agent/interview", { runId, series });
  } catch (error) {
    log(`No interview: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  let deadline = Date.now() + INTERVIEW_MINUTES * 60_000;
  let stopSent = false;
  let answered = 0;
  for (;;) {
    await sleep(2000);
    if (follow.detached) return;
    const current = (await api<State>("state").catch(() => undefined))?.interview;
    if (current?.runId === runId) {
      if (current.status !== "running") {
        log(current.status === "completed"
          ? `Interview: ${current.answered} answers in interview.md`
          : `Interview ${current.status}${current.error ? `: ${current.error}` : ""}${current.answered ? `; ${current.answered} of ${current.questions} answers in interview.md` : ""}`);
        return;
      }
      if (current.answered > answered) {
        answered = current.answered;
        log(`Interview: ${answered} of ${current.questions} questions answered`);
      }
    }
    if (Date.now() > deadline) {
      if (stopSent) {
        log("The interview did not stop; going on without it.");
        return;
      }
      log(`The interview is still running after ${INTERVIEW_MINUTES} minutes; stopping it.`);
      await api("agent/stop", {}).catch(() => {});
      stopSent = true;
      deadline = Date.now() + 60_000;
    }
  }
}

/**
 * Waits while the host at `url` is still interviewing an earlier run (a runner leaves its last
 * interview to the host: runSeries), since the host refuses an agent run until it ends; one still
 * running after INTERVIEW_MINUTES is stopped, and waited for until it has ended (the host takes a
 * moment to wind an interview down, and an agent run sent meanwhile was refused).
 */
async function waitForHostInterview(url = base, stoppable = true) {
  let deadline = Date.now() + INTERVIEW_MINUTES * 60_000;
  let logged = false;
  let stopped = false;
  for (;;) {
    if (stoppable) checkStop();
    const state = await fetch(url + "state").then((res) => res.json() as Promise<State>).catch(() => undefined);
    const current = state?.interview;
    if (current?.status !== "running") return;
    if (!logged) {
      log(`Waiting for the host to finish the interview of run ${current.runId.slice(0, 8)}`);
      logged = true;
    }
    if (Date.now() > deadline) {
      if (stopped) {
        log("The interview did not end within a minute of stopping it; going on.");
        return;
      }
      log(`That interview is still running after ${INTERVIEW_MINUTES} minutes; stopping it.`);
      await fetch(url + "agent/stop", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Crusader-Client": "dashboard" }, body: "{}",
      }).catch(() => {});
      stopped = true;
      deadline = Date.now() + 60_000;
    }
    await sleep(2000);
  }
}

/**
 * Game-machine files that differ from this checkout: the window bridge, reader stream, memory guard
 * and reader sources run there from a copy synced by hand, so a version needs them to match. (The
 * reader binaries are not compared; rebuild them after syncing the sources.)
 */
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
  const unpriced = costProblem(profile);
  if (unpriced) throw new Error(`${profile.name}: ${unpriced}`);
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
  const remote = await gameMachineDifferences(".");
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
  // The previous counted episode's interview (interview.ts), left running (never awaited) below
  // so the next episode's game can load alongside it; joined before the next agent run or a
  // pause, and at the series' end left to the host (below). interview() never throws, so a failed
  // interview cannot fail the series.
  let pendingInterview: Promise<void> | undefined;
  let following: { detached: boolean } | undefined;
  const waitInterview = async () => {
    if (!pendingInterview) return;
    await pendingInterview;
    pendingInterview = undefined;
  };
  // The next episode's game, started early (below) while the previous one's interview runs; only
  // used when it is still for the episode about to be played, and closed unplayed otherwise.
  let prepared: { n: number; ready: Promise<void> } | undefined;
  for (let n = nextEpisode(record); n !== null; n = nextEpisode(record)) {
    try {
      await checkDashboardFresh();
    } catch (error) {
      if (prepared?.n === n) { await abandonPrepared(prepared.ready); prepared = undefined; }
      await waitInterview();
      pause(`before episode ${n}: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    if (stopRequested) {
      if (prepared?.n === n) { await abandonPrepared(prepared.ready); prepared = undefined; }
      await waitInterview();
      pause(`stopped by the operator before episode ${n}`);
      break;
    }
    const attempt = nextAttempt(record.results, n);
    const playbook = settings.learning ? playbookAfter(n - 1) : undefined;
    const series = settings.learning ? { id: record.id, episode: n, episodes: record.episodes, attempt } : undefined;
    let result: Attempt;
    let gameSave: GameSave | undefined;
    try {
      const ready = prepared?.n === n ? prepared.ready : prepareEpisode(n, plan);
      prepared = undefined;
      // The previous episode's interview, if any, must be done before this one's agent run
      // starts (the dashboard refuses /api/agent/run while it is: index.ts).
      await Promise.all([ready, waitInterview()]);
      const { card, run, gameSave: saved } = await playEpisode(n, record.episodes, plan, series, playbook);
      gameSave = saved;
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
      prepared = undefined;
      const message = error instanceof Error ? error.message : String(error);
      result = { episode: n, attempt, ...classify({ error: message, stopRequested }), error: message };
    }
    record.results.push(result);
    writeSeries(record);
    log(`Episode ${n}, attempt ${attempt}: ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`);
    // Left running: see pendingInterview above.
    if (counts(result) && result.run && !opts["no-interview"]) {
      following = { detached: false };
      pendingInterview = interview(result.run, { id: record.id, episode: n, episodes: record.episodes, ...(attempt > 1 ? { attempt } : {}) }, following);
      pendingInterview.catch(() => {});
    }
    if (gameSave?.benchmarkSaveChanged) {
      await waitInterview();
      pause(`after episode ${n}: ${gameSave.error}; check the benchmark save before continuing`);
      break;
    }
    if (counts(result)) {
      retried = false;
      // Start the next episode's game now, while its predecessor's interview (just kicked off
      // above) is still going; the loop's top joins or abandons it next time around.
      const next = nextEpisode(record);
      if (next !== null) {
        const ready = prepareEpisode(next, plan);
        ready.catch(() => {});
        prepared = { n: next, ready };
      }
      continue;
    }
    if (result.outcome === "infrastructure" && !retried) {
      retried = true;
      log(`Running episode ${n} again from the same playbook.`);
      continue;
    }
    await waitInterview();
    pause(result.outcome === "stopped" ? `episode ${n}: ${result.reason}` : `episode ${n} failed twice (${result.reason ?? result.outcome})`);
    break;
  }
  // The last episode's interview needs only the host and the model API: it is left to the host,
  // so this runner can exit and a queued one start its game; that one waits for it before its
  // agent run (waitForHostInterview).
  if (pendingInterview && following) {
    following.detached = true;
    pendingInterview = undefined;
    log("The interview continues on the host; its answers go to interview.md in the run folder.");
  }
  if (prepared) await abandonPrepared(prepared.ready);
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

/** --idle, --human and --dry-run: no agent and no series. */
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

/**
 * Plays the run on the round's version instead (rounds.ts): that commit's worktree, its game-machine
 * files on the game machine, its host on the first free port after this one and its own runner with
 * these arguments.
 * Returns the runner's exit code.
 */
async function playElsewhere(round: Round) {
  log(`${opts.resume ? "This series" : `Benchmark "${setting("benchmark")}"`} plays on its round's version ${round.version} (since ${round.since}), not this checkout's; running it from ${round.commit.slice(0, 7)}. --new-round would move the round to this version.`);
  const dir = await prepareWorktree(round, log);
  await syncGameMachine(dir, log);
  // A version made before the run overlay gets this checkout's, fed by this runner.
  const feedOverlay = needsOverlayFeed(dir);
  if (feedOverlay) await installOverlay(log).catch((e) => log(`Run overlay not installed: ${e instanceof Error ? e.message : e}`));
  const port = String(await freePort(Number(opts.port) + 1));
  const host = await startHost(dir, port, round, log);
  const stopFeed = feedOverlay ? startOverlayFeed(port, path.resolve("harness/runtime/runs"), log) : undefined;
  try {
    const child = spawn(process.execPath, [path.join(dir, "node_modules/tsx/dist/cli.mjs"), "harness/server/episodes.ts", ...forwardedArgs(process.argv.slice(2), port)],
      { cwd: dir, env: { ...process.env, PORT: port }, stdio: "inherit" });
    // A stop goes to the round's runner, which stops its own run.
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
    return await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  } finally {
    stopFeed?.();
    // The round's runner is done, so a stop is this runner's again: it ends the wait below. A round's
    // runner may leave its last interview to its host, which stopping the host would end.
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    process.on("SIGINT", requestStop);
    process.on("SIGTERM", requestStop);
    await waitForHostInterview(`http://127.0.0.1:${port}/api/`, true).catch(() => log("Stopped waiting for the round host's interview."));
    await stopHost(host);
    log(`${round.version} host stopped`);
  }
}

/** Records the checkout's version as the benchmark's round after a valid run that starts one. */
function recordRound(state: State, benchmark: string, record: SeriesRecord) {
  const b = state.benchmark;
  if (!b?.version || !b.commit || b.dirty || !record.results.some((r) => r.valid)) return;
  writeRound(benchmark, { version: b.version, fingerprint: b.fingerprint, commit: b.commit, since: new Date().toISOString().slice(0, 10) });
  log(`Round: "${benchmark}" now plays on ${b.version}; commit benchmark-rounds.json.`);
}

async function main() {
  const state = await api<State>("state").catch(() => {
    throw new Error(`The dashboard is not reachable on port ${opts.port}; start it with npm run dev.`);
  });
  if (state.running || state.connected) throw new Error("The dashboard is connected or running; disconnect it first.");
  if (opts.idle && opts.human) throw new Error("--idle and --human are different runs; pass one.");
  const agent = !opts["dry-run"] && !opts.idle && !opts.human;
  if (opts["new-round"] && !agent) throw new Error("--new-round is for agent runs.");
  // Every agent run on a benchmark plays on its round's version (rounds.ts).
  const resumed = opts.resume ? loadSeries(opts.resume) : undefined;
  const benchmark = resumed?.settings?.benchmark ?? setting("benchmark");
  const decision = agent && !opts.unversioned
    ? roundPlan(readRounds(), benchmark, { version: state.benchmark?.version ?? null, fingerprint: state.benchmark?.fingerprint ?? "", commit: state.benchmark?.commit ?? null }, !!opts["new-round"])
    : { kind: "here" as const, startsRound: false };
  if (decision.kind === "elsewhere") {
    process.exitCode = await playElsewhere(decision.round);
    return;
  }
  // The game machine plays this checkout's reader and helpers.
  await syncGameMachine(".", log);
  if (opts.resume) {
    if (!agent) throw new Error("--resume continues an agent series; leave out --idle, --human and --dry-run.");
    const given = SETTING_FLAGS.filter((flag) => opts[flag] !== undefined);
    if (given.length) throw new Error(`--resume runs the series with its own settings; leave out ${given.map((f) => `--${f}`).join(", ")}.`);
    await runSeries(state, resumed!, true);
    if (decision.startsRound) recordRound(state, benchmark, resumed!);
  } else {
    if (!opts.save) throw new Error("--save is required (the save name shown in Load Game).");
    const total = Number(opts.episodes ?? (opts.human ? "1" : DEFAULTS.episodes));
    if (!Number.isInteger(total) || total < 1 || total > 20) throw new Error("--episodes must be 1 to 20.");
    const config = runConfigSchema.parse({
      gameMinutes: Number(setting("game-minutes")),
      wallLimitMinutes: Number(setting("wall-limit-minutes")),
      defaultWaitSeconds: Number(setting("default-wait")),
      minTurnSeconds: Number(setting("min-turn-seconds")),
      fallbackObservation: setting("fallback-observation"),
      screenshotWidth: Number(setting("screenshot-width")),
      contextBudget: Number(setting("context-budget")),
      imageTokenEstimate: 4096,
      recordVideo: opts.record ?? false,
      fastWaits: !opts["no-fast-waits"],
    });
    const plan: Plan = { save: opts.save, map: opts.map, benchmark: setting("benchmark"), prompt: "", config };
    if (!agent) await runPlain(plan, total);
    else {
      const model = state.models.find((m) => m.id === opts.model || m.name === opts.model);
      if (!model?.keyConfigured) throw new Error("--model must name a saved model profile with an API key.");
      const prompt = opts.prompt ?? (opts["prompt-file"] ? readFileSync(opts["prompt-file"], "utf8").trim() : "");
      if (!prompt) throw new Error("--prompt or --prompt-file is required for an agent run.");
      const id = `${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "")}-${randomUUID().slice(0, 8)}`;
      const record: SeriesRecord = {
        id, save: plan.save, map: plan.map, benchmark: plan.benchmark, model: model.name, episodes: total,
        results: [], status: "running",
        settings: {
          save: plan.save, map: plan.map, benchmark: plan.benchmark, prompt, config,
          learning: !!opts.playbook, ...current(state, model.id),
        },
      };
      await runSeries(state, record, false);
      if (decision.startsRound) recordRound(state, plan.benchmark, record);
    }
  }
  if (backgroundRenders)
    log(`${backgroundRenders} video render(s) go on in the background; each run folder's render.log follows it, and its lines join this log.`);
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
