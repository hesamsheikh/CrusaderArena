/**
 * Unattended benchmark episodes through the running dashboard (npm run dev or start):
 * start the game through Steam on the Ubuntu host, load a save by name, pause,
 * run the agent with a game-time budget, record a scorecard, close the game.
 *
 *   npm run episodes -- --save "Oasis by the Sea-1" --map "Oasis by the Sea" \
 *     --benchmark "Oasis by the Sea construction" --model "Kimi K3" \
 *     --prompt-file prompt/objectives/oasis-by-the-sea.txt --game-minutes 10 --episodes 3
 *
 * --dry-run does everything except the agent run (no model cost); --keep-game leaves
 * the game running (paused) afterwards for manual inspection; --record records the game
 * while the agent acts and renders video.mp4 into the run folder after the scorecard.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { gameHost } from "./device.js";
import { netWorth } from "./market-prices.js";
import { renderVideo, type VideoResult } from "./video.js";
import type { Frame, GameAction, Run, State } from "../shared/protocol.js";

const { values: opts } = parseArgs({
  options: {
    save: { type: "string" },
    map: { type: "string" },
    benchmark: { type: "string", default: "Custom" },
    model: { type: "string" },
    prompt: { type: "string" },
    "prompt-file": { type: "string" },
    "game-minutes": { type: "string", default: "10" },
    "wall-limit-minutes": { type: "string", default: "60" },
    "default-wait": { type: "string", default: "5" },
    "context-budget": { type: "string", default: "120000" },
    episodes: { type: "string", default: "1" },
    "dry-run": { type: "boolean", default: false },
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
      `${root}/.venv-control/bin/python ${root}/tools/ubuntu/game-session.py ${command} --timeout ${timeout}`]);
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

/**
 * Starting net worth per save. The Free Build start trickles in over the first game minute
 * after loading (at load Oasis by the Sea-1 shows 120 gold and 12 wood), so growth is measured
 * from the full starting package instead: 1000 gold, 50 wood, 25 stone (watched live with no
 * input, 2026-09-30) and the 50 bread the granary receives, at the sell prices.
 */
const startingWorth: Record<string, number> = {
  "Oasis by the Sea-1": netWorth(1000, { wood_planks: 50, stone: 25, bread: 50 }).netWorth,
};

function scorecard(state: State, run?: Run, source: "final" | "last_observed" = "final", startWorth?: number) {
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
    ...(startWorth !== undefined ? { net_worth_start: startWorth, net_worth_growth: worth.netWorth - startWorth } : {}),
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

async function episode(n: number, total: number, modelId: string | undefined, prompt: string) {
  if (!opts["dry-run"]) await checkDashboardFresh();
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
    const startWorth = startingWorth[opts.save!];
    let run: Run | undefined;
    let lastGood: State | undefined;
    if (!opts["dry-run"]) {
      const { runId } = await api<{ runId: string }>("agent/run", {
        benchmarkType: opts.benchmark,
        modelId,
        prompt,
        config: {
          gameMinutes: Number(opts["game-minutes"]),
          wallLimitMinutes: Number(opts["wall-limit-minutes"]),
          defaultWaitSeconds: Number(opts["default-wait"]),
          contextBudget: Number(opts["context-budget"]),
          imageTokenEstimate: 4096,
          recordVideo: opts.record,
        },
        // Rendered below, after the scorecard, so the video's result card can show it.
        renderVideo: false,
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
      ? scorecard(final, run, "final", startWorth)
      : scorecard(lastGood, run, "last_observed", startWorth);
    const dir = run
      ? path.join("harness/runtime/runs", run.folder)
      : path.join("harness/runtime/episodes");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, run ? "episode.json" : `dry-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ episode: n, save: opts.save, benchmark: opts.benchmark, ...card }, null, 2));
    log(`Scorecard: ${file}`);
    // Renders run one at a time on this Mac, in the background of the next episode.
    if (run?.config?.recordVideo && run.progress?.recording?.frames)
      renders.push(renderVideo(dir, (text) => log(`Episode ${n}: ${text}`)));
    return card;
  } finally {
    await api("disconnect", {}).catch(() => {});
    if (opts["keep-game"]) log("Game left running (--keep-game); close it after inspection.");
    else {
      await gameSession("close", 60).catch((e) => log(`Close failed: ${e.message}`));
      log("Game closed");
    }
  }
}

async function main() {
  if (!opts.save) throw new Error("--save is required (the save name shown in Load Game).");
  const state = await api<State>("state").catch(() => {
    throw new Error(`The dashboard is not reachable on port ${opts.port}; start it with npm run dev.`);
  });
  if (state.running || state.connected) throw new Error("The dashboard is connected or running; disconnect it first.");
  let modelId: string | undefined;
  let prompt = "";
  if (!opts["dry-run"]) {
    const model = state.models.find((m) => m.id === opts.model || m.name === opts.model);
    if (!model?.keyConfigured) throw new Error("--model must name a saved model profile with an API key.");
    modelId = model.id;
    prompt = opts.prompt ?? (opts["prompt-file"] ? readFileSync(opts["prompt-file"], "utf8").trim() : "");
    if (!prompt) throw new Error("--prompt or --prompt-file is required for an agent run.");
  }
  const total = Number(opts.episodes);
  for (let n = 1; n <= total; n++) {
    const card = await episode(n, total, modelId, prompt);
    console.log(JSON.stringify(card));
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
