import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Agent } from "@earendil-works/pi-agent-core";
import {
  runNameFor,
  actionSchema,
  runConfigSchema,
  type State,
  type Frame,
} from "../shared/protocol.js";
import { Store } from "./store.js";
import { GameDevice } from "./device.js";
import { testModel, modelConfig } from "./model.js";
import { renderVideo } from "./video.js";
import { RunController } from "./controller.js";
import { benchmarkStamp, codeVersion } from "./version.js";
import { atlasHtml, atlasPages, type AtlasPageId } from "./visual-atlas.js";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const store = new Store(path.join(root, "harness/runtime"));
const port = Number(process.env.PORT || 4317);
const app = express();
const server = createServer(app);
const clients = new Set<express.Response>();
const state: State = {
  models: store.models(),
  runs: store.list(),
  activeRunId: null,
  streamingText: "",
  connected: false,
  connecting: false,
  deviceError: null,
  frame: null,
  stats: null,
  running: false,
  model: modelConfig().id,
  keyConfigured: !!process.env.MOONSHOT_API_KEY,
  modelStatus: "untested",
  tokens: 0,
  turns: 0,
  logs: [],
};
function safeError(e: unknown) {
  return store.redact(e instanceof Error ? e.message : String(e)) as string;
}
const serverStartedAt = Date.now();
function snapshot(): State {
  return {
    ...state,
    serverStartedAt,
    benchmark: { ...benchmarkStamp, commit: codeVersion.commit, dirty: codeVersion.dirty },
    streamingText: store.redact(state.streamingText),
    models: store.models(),
    runs: store.list(),
    memoryGuard: device.guardState,
    stats:
      state.stats?.valid_until_unix_ms &&
      state.stats.valid_until_unix_ms < Date.now()
        ? { status: "stale", observation: null }
        : state.stats,
  };
}
function broadcast() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const c of clients) {
    if (c.writableLength > 1024 * 1024) {
      c.end();
      clients.delete(c);
    } else c.write(data);
  }
}
function log(kind: State["logs"][number]["kind"], text: string) {
  const entry = {
    id: randomUUID(),
    at: Date.now(),
    kind,
    text: safeError(text),
  };
  state.logs.push(entry);
  if (state.logs.length > 300) state.logs.shift();
  if (state.activeRunId && state.running) store.log(state.activeRunId, entry);
  broadcast();
}
/** The screenshot `state.frame` describes, served to the dashboard during runs. */
let latestFrame: Frame | null = null;
function updateFrame(frame: Frame) {
  const { image, ...meta } = frame;
  latestFrame = frame;
  state.frame = meta;
  state.deviceError = null;
  broadcast();
}
let stopCurrent: ((reason?: "stopped" | "error") => void) | undefined;
/** Ends the active run for a host shutdown; unlike a stop, the game is still paused at the end. */
let interruptCurrent: (() => void) | undefined;
let currentRun: Promise<void> | undefined;
let agent: Agent | undefined;
// Reader samples arrive up to ~10 per second; the dashboard needs a few. Keep the
// latest sample and send at most one sample-driven update per 250 ms.
let statsBroadcast: NodeJS.Timeout | undefined;
let lastStatsBroadcast = 0;
const device = new GameDevice(
  (stats) => {
    if (!stats && device.readerDiagnostics)
      log("error", `Reader stream closed: ${device.readerDiagnostics}`);
    state.stats = stats;
    if (statsBroadcast) return;
    statsBroadcast = setTimeout(() => {
      statsBroadcast = undefined;
      lastStatsBroadcast = Date.now();
      broadcast();
    }, Math.max(0, lastStatsBroadcast + 250 - Date.now()));
  },
  (reason) => {
    state.connected = false;
    state.frame = null;
    state.deviceError = reason;
    stopCurrent?.("error");
    agent?.abort();
    log("error", reason);
  },
  () => {
    stopCurrent?.();
    agent?.abort();
    log(
      "system",
      "Stopped from the Ubuntu monitor. Input is blocked until locally re-enabled.",
    );
  },
);
// Local-only service: reject rebinding hosts and cross-origin mutations.
app.use((req, res, next) => {
  if (!["127.0.0.1", "localhost"].includes((req.hostname || "").toLowerCase()))
    return void res.status(403).json({ error: "Local access only." });
  if (req.path.startsWith("/api/") && req.method !== "GET") {
    if (req.get("X-Crusader-Client") !== "dashboard")
      return void res
        .status(403)
        .json({ error: "Missing local client header." });
    const origin = req.get("Origin");
    if (
      origin &&
      !["http://127.0.0.1:" + port, "http://localhost:" + port].includes(origin)
    )
      return void res.status(403).json({ error: "Origin rejected." });
  }
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "24kb" }));
app.get("/api/state", (_req, res) => res.json(snapshot()));
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  clients.add(res);
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  req.on("close", () => clients.delete(res));
});
app.post("/api/connect", async (_req, res) => {
  if (state.running || state.connecting)
    return void res
      .status(409)
      .json({ error: "An operation is already running." });
  state.connecting = true;
  state.deviceError = null;
  broadcast();
  try {
    const frame = await device.connect();
    state.connected = true;
    updateFrame(frame);
    log(
      "system",
      "Game window connected. Capture and controls are application-scoped.",
    );
    res.json({ ok: true });
  } catch (e) {
    state.connected = false;
    state.frame = null;
    state.deviceError = safeError(e);
    throw e;
  } finally {
    state.connecting = false;
    broadcast();
  }
});
app.post("/api/disconnect", (_req, res) => {
  stopCurrent?.();
  agent?.abort();
  device.disconnect();
  state.connected = false;
  state.frame = null;
  log("system", "Game connection closed.");
  res.json({ ok: true });
});
let capturePending: Promise<Frame> | null = null;
app.get("/api/frame", async (_req, res) => {
  if (!state.connected)
    return void res.status(409).json({ error: "Connect the game first." });
  // During a run the dashboard shows the agent's own screenshots and never captures: its captures
  // queued behind the agent's inputs on the bridge (costing game time) and pushed the agent's
  // targeting image out of the device's 64-frame store during long replies.
  if (state.running)
    return void (latestFrame && state.frame?.id === latestFrame.id
      ? res.json(latestFrame)
      : res.status(409).json({ error: "No screenshot from this run yet." }));
  if (!capturePending)
    capturePending = device.capture().finally(() => {
      capturePending = null;
    });
  const f = await capturePending;
  updateFrame(f);
  res.json(f);
});
app.post("/api/action", async (req, res) => {
  if (state.running)
    return void res
      .status(409)
      .json({ error: "Stop the agent before taking manual control." });
  const body = z
    .object({ action: actionSchema, frameId: z.string().uuid() })
    .strict()
    .parse(req.body);
  await device.action(body.action, body.frameId);
  log("action", JSON.stringify(body.action));
  res.json({ ok: true });
});
let testing = false;
app.post("/api/models", (req, res) => {
  if (state.running || testing)
    return void res.status(409).json({ error: "The model is busy." });
  const model = store.saveModel(req.body);
  broadcast();
  res.json(model);
});
app.get("/api/runs/:id", (req, res) => {
  res.json({ run: store.get(req.params.id), logs: store.logs(req.params.id) });
});
app.get("/api/runs/:id/logs", (req, res) => {
  const run = store.get(req.params.id);
  res.attachment(run.folder + "-logs.jsonl");
  res.type("application/x-ndjson").send(
    store
      .logs(run.id)
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
});
app.get("/api/runs/:id/events", (req, res) => {
  const run = store.get(req.params.id);
  res.attachment(run.folder + "-events.jsonl");
  res.sendFile(store.file(run.id, "events.jsonl"));
});
app.get("/api/runs/:id/notifications", (req, res) => {
  const run = store.get(req.params.id);
  const file = path.join(
    path.dirname(store.file(run.id, "run.json")),
    "notifications.jsonl",
  );
  if (!existsSync(file))
    return void res
      .status(404)
      .json({ error: "This run has no notification journal." });
  res.attachment(run.folder + "-notifications.jsonl");
  res.sendFile(file);
});
app.get("/api/runs/:id/guide", (req, res) => {
  const file = path.join(
    path.dirname(store.file(req.params.id, "run.json")),
    "controls-guide.html",
  );
  if (!existsSync(file))
    return void res
      .status(404)
      .json({ error: "No starting screenshot guide for this run." });
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
  );
  res.sendFile(file);
});
app.get("/api/guide/:page", (req, res) => {
  const id = req.params.page;
  if (!atlasPages.some((page) => page.id === id))
    return void res.status(404).json({ error: "Unknown guide page." });
  const html = atlasHtml(id as AtlasPageId);
  if (!html)
    return void res.status(404).json({ error: "Private guide image is unavailable." });
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
  );
  res.type("html").send(html);
});
app.post("/api/model/test", async (req, res) => {
  const model = store.model(z.string().uuid().parse(req.body.modelId));
  const key = store.key(model.id);
  if (!key)
    return void res
      .status(409)
      .json({ error: "Save an API key for this model first." });
  if (testing || state.running)
    return void res.status(409).json({ error: "The model is busy." });
  testing = true;
  state.modelStatus = "testing";
  broadcast();
  try {
    const reply = await testModel(model, key);
    state.modelStatus = "ready";
    log("system", `Model connected: ${model.modelId}. ${reply}`);
    res.json({ ok: true, reply });
  } catch (e) {
    state.modelStatus = "error";
    throw e;
  } finally {
    testing = false;
    broadcast();
  }
});
app.post("/api/agent/run", async (req, res) => {
  const { prompt, maxTurns, benchmarkType, modelId, config, renderVideo: renderAfter, series, playbook } = z
    .object({
      benchmarkType: z.string().trim().min(1).max(60),
      modelId: z.string().uuid(),
      prompt: z.string().trim().min(1).max(12000),
      maxTurns: z.number().int().min(1).max(12).optional(),
      config: runConfigSchema.default(() => runConfigSchema.parse({})),
      /** Render video.mp4 when a recorded run ends; the episode runner renders after its scorecard instead. */
      renderVideo: z.boolean().default(true),
      /** An episode of a learning series (npm run episodes) and the playbook it starts with. */
      series: z
        .object({
          id: z.string().regex(/^[A-Za-z0-9-]{1,80}$/),
          episode: z.number().int().min(1),
          episodes: z.number().int().min(1).max(20),
          attempt: z.number().int().min(1).max(20).optional(),
        })
        .strict()
        .refine((s) => s.episode <= s.episodes)
        .optional(),
      playbook: z.string().refine((text) => Buffer.byteLength(text) <= 8192, "The playbook is limited to 8192 bytes.").optional(),
    })
    .strict()
    .parse(req.body);
  if (state.running || testing)
    return void res.status(409).json({ error: "The model is busy." });
  const profile = store.model(modelId);
  const key = store.key(modelId);
  if (!key || !state.connected)
    return void res
      .status(409)
      .json({ error: "Connect the game and configure the model first." });
  if (device.guardState !== "active")
    return void res
      .status(409)
      .json({ error: "The memory guard is not active; reconnect the game before starting a run." });
  if (!(await device.singlePlayerConfirmed()))
    return void res.status(409).json({
      error: "The game reader has not confirmed a single-player map. Load one and wait for stats to appear; multiplayer is not supported.",
    });
  if (state.running || testing)
    return void res.status(409).json({ error: "The model is busy." });
  const run = store.create(
    runNameFor(profile.name, benchmarkType),
    modelId,
    prompt,
    maxTurns ?? null,
  );
  store.update(run.id, { config, ...(series ? { series } : {}) });
  store.setBenchmark(run.id, benchmarkType);
  let controller: RunController;
  try {
    controller = new RunController(
      run,
      store,
      device,
      profile,
      key,
      updateFrame,
      log,
      broadcast,
      { playbook },
    );
  } catch (e) {
    // Nothing has touched the game yet: record the run as failed and stay ready for the next.
    store.finish(run.id, "error");
    log("error", `Run could not start: ${safeError(e)}`);
    return void res.status(500).json({ error: safeError(e) });
  }
  state.running = true;
  state.activeRunId = run.id;
  state.logs = [];
  state.streamingText = "";
  state.model = profile.modelId;
  state.tokens = 0;
  state.turns = 0;
  log("user", prompt);
  stopCurrent = (reason) => controller.stop(reason);
  interruptCurrent = () => controller.interrupt();
  agent = controller.agent;
  const current = agent;
  current.subscribe((event) => {
    if (event.type === "message_update") {
      const delta = { ...event.assistantMessageEvent };
      if ("partial" in delta) delete (delta as { partial?: unknown }).partial;
      store.event(run.id, { type: event.type, delta });
      if (delta.type === "text_delta") {
        state.streamingText += delta.delta;
        broadcast();
      }
    } else if (event.type === "agent_end" || event.type === "turn_end") {
      store.event(run.id, { type: event.type });
    } else store.event(run.id, event);
    if (event.type === "turn_end") {
      state.turns = run.turns;
      state.tokens = run.tokens;
      broadcast();
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      state.streamingText = "";
      const msg = event.message;
      state.tokens = run.tokens;
      for (const c of msg.content)
        if (c.type === "text" && c.text) log("agent", c.text);
      // The controller retries transient provider failures and ends the run on the rest.
      if (msg.stopReason === "error") log("error", msg.errorMessage || "Model error.");
    }
    if (event.type === "tool_execution_start")
      log("system", `Using ${event.toolName}`);
    if (event.type === "tool_execution_end" && event.isError)
      log("error", JSON.stringify(event.result));
  });
  res.json({ ok: true, runId: run.id });
  currentRun = (async () => {
    let outcome: "completed" | "stopped" | "error" = "error";
    try {
      await controller.prepare();
      state.tokens = run.tokens;
      broadcast();
      outcome = await controller.runSession();
      state.modelStatus = outcome === "error" ? "error" : "ready";
    } catch (e) {
      outcome = controller.session.reason === "stopped" ? "stopped" : "error";
      if (outcome === "error") {
        controller.stop("error");
        // Kept in run.json: the episode runner tells model failures (no BEGIN) from the harness's.
        controller.progress.endError ??= safeError(e);
        controller.publish();
      }
      log("error", safeError(e));
    } finally {
      // Clear the busy state whatever happens below, or the host would refuse every later run.
      state.running = false;
      state.streamingText = "";
      agent = undefined;
      stopCurrent = undefined;
      interruptCurrent = undefined;
      try {
        log("system", `Run ${outcome}: ${run.progress?.stopReason || "error"}.`);
        store.update(run.id, { turns: state.turns });
        store.finish(run.id, outcome);
      } catch (e) {
        log("error", `Could not record the end of the run: ${safeError(e)}`);
      }
      state.tokens = run.tokens;
      broadcast();
      if (renderAfter && run.progress?.recording?.frames) {
        const folder = path.dirname(store.file(run.id, "run.json"));
        const report = (text: string) => {
          log("system", text);
          store.log(run.id, { id: randomUUID(), at: Date.now(), kind: "system", text });
        };
        report("Rendering the run video.");
        void renderVideo(folder, report);
      }
    }
  })();
  await currentRun;
  currentRun = undefined;
});

app.post("/api/agent/stop", (_req, res) => {
  stopCurrent?.();
  agent?.abort();
  device.cancelQueued();
  log("system", "Stop requested. Queued actions cancelled.");
  res.json({ ok: true });
});
app.get("/api/logs/export", (_req, res) => {
  res.attachment("crusader-session.json");
  res.json({ exportedAt: new Date().toISOString(), ...snapshot() });
});
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Unknown API route." }),
);
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const message = safeError(err);
    log("error", message);
    if (!res.headersSent)
      res
        .status(err instanceof z.ZodError ? 400 : 502)
        .json({ error: message });
  },
);
app.use("/assets", express.static(path.join(root, "docs/assets")));
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(root, "harness/dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(root, "harness/dist/index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: path.join(root, "harness/vite.config.ts"),
    server: { middlewareMode: true, hmr: { server } },
  });
  app.use(vite.middlewares);
}
const tick = setInterval(() => {
  broadcast();
  const run = state.activeRunId ? store.get(state.activeRunId) : undefined;
  const stats = device.currentStats().observation;
  device.status({
    phase: state.running
      ? (run?.progress?.phase || "AGENT RUNNING").toUpperCase()
      : run
        ? run.status.toUpperCase()
        : "IDLE",
    model: run?.model.name || "",
    run: run?.name || "",
    turns: state.turns,
    tokens: state.tokens,
    stats: stats
      ? {
          gold: stats.gold,
          population: stats.population,
          troops: stats.own_troops?.total,
          paused: stats.paused,
        }
      : {},
  });
}, 1000);
tick.unref();
server.listen(port, "127.0.0.1", () =>
  console.log(`Crusader Arena: http://127.0.0.1:${port}`),
);
let shuttingDown = false;
async function shutdown(code = 0) {
  // A second Ctrl-C exits at once.
  if (shuttingDown) process.exit(code || 1);
  shuttingDown = true;
  clearInterval(tick);
  if (currentRun) {
    // End the run like a deadline so its final pause runs before the game connection closes.
    log("system", "Host shutting down: ending the run and pausing the game.");
    interruptCurrent?.();
    await Promise.race([currentRun, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  }
  device.disconnect();
  for (const c of clients) c.end();
  server.close();
  setTimeout(() => process.exit(code), 500).unref();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// A failed background task (a video render, a stray promise) must not take the host and its run down.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  log("error", `Unhandled host error: ${safeError(reason)}`);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  log("error", `Host error: ${safeError(error)}. Shutting down.`);
  void shutdown(1);
});
