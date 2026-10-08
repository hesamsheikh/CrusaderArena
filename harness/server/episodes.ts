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
 * --no-playbook runs them as independent runs instead. A failed episode is recorded and the
 * series goes on; if the harness or prompt files change under the dashboard, the series stops.
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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { gameHost, quote } from "./device.js";
import { netWorth } from "./market-prices.js";
import { idleBaseline } from "./baselines.js";
import { renderVideo, type VideoResult } from "./video.js";
import { setGameSpeed } from "./game-speed.js";
import { TICKS_PER_GAME_SECOND, type Frame, type GameAction, type GameSpeedSetting, type Run, type RunSeries, type State } from "../shared/protocol.js";

const { values: opts } = parseArgs({
  options: {
    save: { type: "string" },
    map: { type: "string" },
    benchmark: { type: "string", default: "Custom" },
    model: { type: "string" },
    prompt: { type: "string" },
    "prompt-file": { type: "string" },
    "game-minutes": { type: "string", default: "25" },
    "wall-limit-minutes": { type: "string", default: "360" },
    "default-wait": { type: "string", default: "5" },
    "min-turn-seconds": { type: "string", default: "8" },
    "context-budget": { type: "string", default: "120000" },
    episodes: { type: "string", default: "3" },
    "no-playbook": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    idle: { type: "boolean", default: false },
    restart: { type: "boolean", default: false },
    "keep-game": { type: "boolean", default: false },
    record: { type: "boolean", default: false },
    port: { type: "string", default: process.env.PORT || "4317" },
  },
});

const base = `http://127.0.0.1:${opts.port}/api/`;
const renders: Promise<VideoResult | null>[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (text: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);

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
function gameSession(command: "status" | "launch" | "activate" | "close", timeout = 180) {
  const { host, root } = gameHost();
  return new Promise<any>((resolve, reject) => {
    const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10", host,
      `${quote(`${root}/.venv-control/bin/python`)} ${quote(`${root}/tools/ubuntu/game-session.py`)} ${command} --timeout ${timeout}`]);
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

async function waitFor<T>(what: string, seconds: number, probe: () => Promise<T | undefined>) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
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

function scorecard(state: State, run?: Run, source: "final" | "last_observed" = "final", baseline?: number) {
  const o = state.stats?.observation;
  const s = o?.settlement;
  const goods = o?.resources_by_name ?? {};
  const worth = netWorth(o?.gold, goods);
  return {
    // "last_observed": the game was gone at the end (e.g. a memory-guard stop), so these are the
    // last valid reader values seen while the run was in progress.
    source,
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
  modelId: string | undefined,
  prompt: string,
  series?: RunSeries,
  playbook?: string,
) {
  log(`Episode ${n}/${total}: starting the game`);
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
    log(`Loading "${opts.save}"`);
    const loaded = await loadSave(opts.save!, opts.map, launchedAt);
    log(`Loaded ${loaded.map_name} at game tick ${loaded.game_time}; pausing`);
    await setPaused(true);
    const baseline = idleBaseline(opts.save, Number(opts["game-minutes"]));
    let run: Run | undefined;
    let lastGood: State | undefined;
    let idleSpeed: GameSpeedSetting | undefined;
    if (opts.idle) idleSpeed = await idle(Number(opts["game-minutes"]), Number(opts["wall-limit-minutes"]));
    else if (!opts["dry-run"]) {
      const { runId } = await api<{ runId: string }>("agent/run", {
        benchmarkType: opts.benchmark,
        modelId,
        prompt,
        config: {
          gameMinutes: Number(opts["game-minutes"]),
          wallLimitMinutes: Number(opts["wall-limit-minutes"]),
          defaultWaitSeconds: Number(opts["default-wait"]),
          minTurnSeconds: Number(opts["min-turn-seconds"]),
          contextBudget: Number(opts["context-budget"]),
          imageTokenEstimate: 4096,
          recordVideo: opts.record,
        },
        // Rendered below, after the scorecard, so the video's result card can show it.
        renderVideo: false,
        ...(series ? { series, playbook: playbook ?? "" } : {}),
      });
      log(`Agent run ${runId} started`);
      await sleep(3000);
      await waitFor("the agent run to finish", Number(opts["wall-limit-minutes"]) * 60 + 600, async () => {
        const state = await api<State>("state");
        if (state.stats?.status === "ok" && state.stats.observation) lastGood = state;
        return state.running ? undefined : true;
      });
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
    const file = path.join(dir, run ? "episode.json" : `${opts.idle ? "idle" : "dry-run"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({
      episode: n, save: opts.save, benchmark: opts.benchmark, ...(series ? { series } : {}),
      ...(opts.idle ? { idle: { gameMinutes: Number(opts["game-minutes"]), gameSpeed: idleSpeed } } : {}), ...card,
    }, null, 2));
    log(`Scorecard: ${file}`);
    // Renders run one at a time on this Mac, in the background of the next episode.
    if (run?.config?.recordVideo && run.progress?.recording?.frames)
      renders.push(renderVideo(dir, (text) => log(`Episode ${n}: ${text}`)));
    return { card, run };
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

async function main() {
  if (!opts.save) throw new Error("--save is required (the save name shown in Load Game).");
  const state = await api<State>("state").catch(() => {
    throw new Error(`The dashboard is not reachable on port ${opts.port}; start it with npm run dev.`);
  });
  if (state.running || state.connected) throw new Error("The dashboard is connected or running; disconnect it first.");
  let modelId: string | undefined;
  let prompt = "";
  const agent = !opts["dry-run"] && !opts.idle;
  if (agent) {
    const model = state.models.find((m) => m.id === opts.model || m.name === opts.model);
    if (!model?.keyConfigured) throw new Error("--model must name a saved model profile with an API key.");
    modelId = model.id;
    prompt = opts.prompt ?? (opts["prompt-file"] ? readFileSync(opts["prompt-file"], "utf8").trim() : "");
    if (!prompt) throw new Error("--prompt or --prompt-file is required for an agent run.");
  }
  const total = Number(opts.episodes);
  if (!Number.isInteger(total) || total < 1 || total > 20) throw new Error("--episodes must be 1 to 20.");
  const learning = agent && !opts["no-playbook"];
  const id = `${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "")}-${randomUUID().slice(0, 8)}`;
  const seriesDir = path.join("harness/runtime/series", id);
  const results: Record<string, unknown>[] = [];
  let playbook = "";
  let stopped: string | undefined;
  if (learning) {
    mkdirSync(seriesDir, { recursive: true });
    log(`Learning series ${id}: ${total} episode(s); the playbook carries over between them`);
  }
  for (let n = 1; n <= total; n++) {
    const series = learning ? { id, episode: n, episodes: total } : undefined;
    // Changed harness or prompt files would leave every later episode on older code: stop.
    if (agent) {
      try {
        await checkDashboardFresh();
      } catch (error) {
        stopped = `Stopped before episode ${n}: ${error instanceof Error ? error.message : String(error)}`;
        log(stopped);
        break;
      }
    }
    try {
      const { card, run } = await episode(n, total, modelId, prompt, series, playbook);
      console.log(JSON.stringify(card));
      // What the agent left in its playbook (after its reflection) starts the next episode.
      const file = run ? path.join("harness/runtime/runs", run.folder, "playbook.md") : "";
      if (learning && file && existsSync(file)) playbook = readFileSync(file, "utf8");
      results.push({ episode: n, run: run?.id, folder: run?.folder, status: run?.status, net_worth: card.net_worth, net_worth_growth: card.net_worth_growth });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Episode ${n} failed: ${message}`);
      results.push({ episode: n, error: message });
    }
    if (learning) {
      writeFileSync(path.join(seriesDir, `playbook-after-episode-${n}.md`), playbook);
      writeSeries();
    }
  }
  function writeSeries() {
    writeFileSync(path.join(seriesDir, "series.json"), JSON.stringify({
      id, save: opts.save, map: opts.map, benchmark: opts.benchmark, model: opts.model, episodes: total, results,
      ...(stopped ? { stopped } : {}),
    }, null, 2));
  }
  if (learning && stopped) writeSeries();
  const worth = results.map((r) => (typeof r.net_worth === "number" ? String(r.net_worth) : "failed"));
  if (worth.length) log(`Net worth by episode: ${worth.join(" → ")}`);
  if (stopped || results.every((r) => r.error)) process.exitCode = 1;
  if (renders.length) {
    log(`Waiting for ${renders.length} video render(s)`);
    await Promise.all(renders);
  }
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
