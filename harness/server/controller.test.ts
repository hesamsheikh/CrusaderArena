import test from "node:test";
import assert from "node:assert/strict";
import { isPreparedReply, runSystemPrompt } from "./preparation.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Store } from "./store.js";
import { RunController, isTransientProviderError } from "./controller.js";
import { GameEvents } from "./game-events.js";
import type { GameDevice } from "./device.js";
import { Session, requestTimeout } from "./session.js";
import { pruneImages, contextEstimate } from "./context.js";
import { RunMemory } from "./run-memory.js";
import { availableAtlasPages, constructionAtlasInstalled } from "./visual-atlas.js";
import { runConfigSchema, type Frame, type GameSpeedSetting, type RunSeries } from "../shared/protocol.js";
import type { SpeedControl } from "./game-speed.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const usage = {
  input: 10,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 20,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const call = (name: string, args: object) => ({
  type: "toolCall" as const,
  id: crypto.randomUUID(),
  name,
  arguments: args,
});
const message = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "test",
  model: "test",
  usage,
  stopReason: content.some((b) => b.type === "toolCall") ? "toolUse" : "stop",
  timestamp: Date.now(),
});
function fixture(
  turns: number | null = 3,
  defaultWait = 0,
  gameMinutes = 10,
  recording: { spawnRecorder?: (args: string[]) => ChildProcessWithoutNullStreams } = {},
  learning?: { series: RunSeries; playbook: string },
  /** Off unless a test sets it, so the other tests count only the waits they cause. */
  minTurnSeconds = 0,
  /** The fake game has no running clock, so speed setting is stubbed unless a test replaces it. */
  gameSpeed: (control: SpeedControl) => Promise<GameSpeedSetting> = async () => ({ target: 40, before: 40, after: 40, presses: 0 }),
) {
  const store = new Store(
    mkdtempSync(path.join(tmpdir(), "arena-controller-")),
    {},
  );
  const profile = store.models()[0];
  const run = store.create(
    "test",
    profile.id,
    "Keep the current map and verify progress.",
    turns,
  );
  store.update(run.id, {
    config: runConfigSchema.parse({
      gameMinutes,
      wallLimitMinutes: 0.5,
      defaultWaitSeconds: defaultWait,
      minTurnSeconds,
      recordVideo: !!recording.spawnRecorder,
    }),
    ...(learning ? { series: learning.series } : {}),
  });
  let clock = 0,
    captures = 0,
    paused = false,
    statsExpiry = Date.now() + 5000;
  let latest: Frame | null = null;
  let unavailableSamples = 0;
  // Reader game clock (ticks) and stream generation; tests advance them explicitly.
  let gameTick = 1000,
    generation = 1,
    mapName = "map-1";
  // Reader camera, off by default. With it the window is 16:9, a minimap click moves the camera
  // to the keep at tile (50, 60) and Z zooms out up to 40 tiles wide.
  let camera: Record<string, number> | null = null;
  let handoffHook = () => {};
  const handoffs: { messages: AgentMessage[]; system: string; tools: string[] }[] = [];
  const reflections: { messages: AgentMessage[]; system: string; tools: string[] }[] = [];
  let reflectionReply = (_call: number): { text: string; stopReason?: string } => ({
    text: "# Playbook\n- Place the granary beside the keep first.",
  });
  let handoffReply = (_call: number): { text: string; stopReason?: string } => ({
    text: "Verified prior progress. Continue the exact preserved plan and notebook. No uncertain action should be replayed.",
  });
  const actions: unknown[] = [];
  const ageCredits: number[] = [];
  const logMessages: string[] = [];
  const events = new GameEvents();
  const guardListeners = new Set<(record: Record<string, unknown>) => void>();
  const device = {
    events,
    get latest() {
      return latest;
    },
    capture: async () => {
      captures++;
      latest = {
        id: "frame",
        image: "test",
        mimeType: "image/jpeg",
        width: camera ? 1920 : 100,
        height: camera ? 1080 : 100,
        receivedAt: Date.now(),
        capturedAt: Date.now(),
        pid: 1,
        windowId: 1,
        scope: "game-window",
      } as Frame;
      return latest;
    },
    currentStats: () => unavailableSamples-- > 0
      ? { status: "unavailable", observation: null }
      : {
          status: "ok",
          generation,
          valid_until_unix_ms: statsExpiry,
          observation: { paused, game_time: gameTick, map_name: mapName, ...(camera ? { camera } : {}) },
          ...(camera ? { captured_unix_ms: Date.now() } : {}),
        },
    action: async (action: unknown, _id: string, guard?: () => void, ageCreditMs = 0) => {
      guard?.();
      actions.push(action);
      ageCredits.push(ageCreditMs);
      paused = (action as { key?: string }).key === "P" ? !paused : paused;
      const input = action as { type?: string; key?: string; button?: number };
      if (camera && input.key === "Z" && camera.tiles_wide < 40)
        camera = { ...camera, tiles_wide: camera.tiles_wide + 10, tiles_high: camera.tiles_high + 10 };
      if (camera && input.type === "click" && input.button === 1) camera = { ...camera, centre_tile_x: 50, centre_tile_y: 60 };
      statsExpiry += 2000;
    },
    // A 100×100 map with the keep's 3×3 tiles around (50, 60).
    mapSummary: async () => ({
      size: 100,
      rows: Array.from({ length: 100 }, (_, y) => (y >= 59 && y <= 61 ? ".49K3.48" : ".100")),
      bounds: { x0: 0, y0: 0, x1: 99, y1: 99 },
    }),
    cancelQueued: () => {},
    status: () => {},
    onGuard: (listener: (record: Record<string, unknown>) => void) => {
      guardListeners.add(listener);
      return () => guardListeners.delete(listener);
    },
  } as unknown as GameDevice;
  const controller = new RunController(
    run,
    store,
    device,
    profile,
    "",
    () => {},
    (_kind, text) => logMessages.push(text),
    () => {},
    {
      now: () => clock,
      handoff: async (messages, system, tools) => {
        handoffHook();
        handoffs.push({ messages, system, tools: tools.map((t) => t.name) });
        return { ...handoffReply(handoffs.length), usage: { totalTokens: 7 } };
      },
      prepare: async (input, system) => prepareHook(input, system),
      reflection: async (messages, system, tools) => {
        reflections.push({ messages, system, tools: tools.map((t) => t.name) });
        return { ...reflectionReply(reflections.length), usage: { totalTokens: 11 } };
      },
      spawnRecorder: recording.spawnRecorder,
      playbook: learning?.playbook,
      gameSpeed,
    },
  );
  let prepareHook = async (_input: AgentMessage, _system: string) => message([{ type: "text", text: "Ready.\nBEGIN" }]);
  const requests: Context[] = [];
  function provider(fn: (turn: number) => AssistantMessage["content"], pause = false) {
    const respond = (ctx: Context) => {
      requests.push({
        systemPrompt: ctx.systemPrompt,
        messages: structuredClone(ctx.messages),
      });
      const stream = createAssistantMessageEventStream();
      const m = message(fn(requests.length));
      // Simulate growing provider input usage instead of reporting 10 tokens
      // regardless of transcript size. Keep separate budget tests exact.
      m.usage = {
        ...usage,
        input: Math.ceil(
          // About one token per two bytes, as before the 2.5-byte estimate.
          (contextEstimate(ctx.messages, ctx.systemPrompt || "") * 2.5) / 2,
        ),
      };
      stream.push({
        type: "done",
        reason: m.stopReason as "stop" | "toolUse",
        message: m,
      });
      return stream;
    };
    controller.agent.streamFunction = pause
      ? async (_m, ctx) => {
          await controller.runtime.beforeInference?.();
          return respond(ctx);
        }
      : (_m, ctx) => respond(ctx);
  }
  return {
    controller,
    store,
    run,
    events,
    provider,
    requests,
    actions,
    ageCredits,
    isPaused: () => paused,
    guard: (record: Record<string, unknown>) => guardListeners.forEach((l) => l(record)),
    setUnavailableSamples: (n: number) => { unavailableSamples = n; },
    setCamera: (value: Record<string, number>) => { camera = value; },
    logMessages,
    captures: () => captures,
    setHandoffHook: (fn: () => void) => {
      handoffHook = fn;
    },
    handoffs,
    setHandoffReply: (fn: typeof handoffReply) => {
      handoffReply = fn;
    },
    reflections,
    setReflectionReply: (fn: typeof reflectionReply) => {
      reflectionReply = fn;
    },
    setPrepareHook: (fn: typeof prepareHook) => {
      prepareHook = fn;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    advanceTicks: (ticks: number) => {
      gameTick += ticks;
    },
    resetClock: () => {
      generation++;
      gameTick = 0;
    },
    /** A transient reader gap: the stream generation advances, the game does not change. */
    bumpGeneration: () => {
      generation++;
    },
    changeMap: () => {
      generation++;
      mapName = "map-2";
    },
  };
}
test("host pauses for each inference, resumes for tools and waits, and credits paused image age", async () => {
  const f = fixture(2);
  f.provider((n) => n === 1
    ? [call("game_action", { type: "key", key: "Z" }), call("wait_and_observe", { seconds: 0 })]
    : [{ type: "text", text: "Observed." }], true);
  assert.equal(await f.controller.runSession(), "completed", JSON.stringify(f.logMessages));
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.actions.map((a) => (a as { key?: string }).key), ["P", "P", "Z", "P"]);
  assert.ok(f.ageCredits[2] > 0);
  assert.equal(f.isPaused(), true);
});
test("reading tools before any action leave the game paused; the first action unpauses it", async () => {
  const f = fixture(3);
  const pausedAt: Record<string, boolean> = {};
  for (const tool of f.controller.agent.state.tools) {
    const execute = tool.execute;
    tool.execute = (...args) => {
      pausedAt[tool.name] = f.isPaused();
      return execute(...args);
    };
  }
  f.provider((n) => n === 1
    ? [
        call("status", {}),
        call("building_info", { name: "Hovel" }),
        call("game_action", { type: "key", key: "Z" }),
        call("wait_and_observe", { seconds: 0 }),
      ]
    : n === 2
      ? [call("get_inventory", {}), call("update_plan", { plan: [{ step: "Read", status: "in_progress" }] })]
      : [{ type: "text", text: "Done." }], true);
  assert.equal(await f.controller.runSession(), "completed", JSON.stringify(f.logMessages));
  assert.deepEqual(pausedAt, {
    observe: false, // The host's first screenshot, taken with the game running.
    status: true, building_info: true, game_action: false, wait_and_observe: false,
    get_inventory: true, update_plan: true,
  });
  // Pause for reply 1, unpause at its first action, pause for reply 2; reply 2 only reads.
  assert.deepEqual(f.actions.map((a) => (a as { key?: string }).key), ["P", "P", "Z", "P"]);
  assert.equal(f.isPaused(), true);
});
test("each run records the code, system prompt and tools it ran with", () => {
  const f = fixture(1);
  const harness = f.run.harness!;
  assert.ok(harness.commit === null || /^[0-9a-f]{40}$/.test(harness.commit));
  assert.match(harness.systemPromptSha256, /^[0-9a-f]{64}$/);
  assert.match(harness.toolsSha256, /^[0-9a-f]{64}$/);
  if (harness.dirty === false) assert.equal(harness.diffSha256, undefined);
  // Same configuration, same hashes.
  assert.deepEqual(fixture(1).run.harness, harness);
});
test("replies that only read end the run after twelve turns instead of idling for free", async () => {
  const f = fixture(20);
  f.provider(() => [call("status", {})], true);
  assert.equal(await f.controller.runSession(), "error");
  assert.equal(f.requests.length, 12);
  assert.ok(f.logMessages.some((m) => /No game action or wait/.test(m)), JSON.stringify(f.logMessages));
});
test("brief reader freshness gaps do not end a timed run", async () => {
  const f = fixture(1);
  f.setUnavailableSamples(2);
  f.provider(() => [{ type: "text", text: "Observed." }]);
  assert.equal(await f.controller.runSession(), "completed", JSON.stringify(f.logMessages));
});
test("the screen layout lives in the system prompt; the first screenshot notes an untested size", async () => {
  const f = fixture(2);
  f.provider(() => [{ type: "text", text: "Continue with a fresh view." }]);
  assert.equal(await f.controller.runSession(), "completed", JSON.stringify(f.logMessages));
  const first = f.requests[0].messages.find((m) => m.role === "user");
  assert.ok(first && Array.isArray(first.content));
  assert.ok(first.content.some((part) => part.type === "image"));
  // Cached with the system prompt and never lost to compaction.
  for (const request of f.requests) assert.match(request.systemPrompt!, /## Screen layout[\s\S]*1\. Castle Buildings \(left 43%/);
  assert.ok(first.content.some((part) => part.type === "text" && part.text.includes("This screenshot is 100 × 100")));
  const available = availableAtlasPages();
  if (available.length)
    assert.ok(first.content.some((part) => part.type === "text" && part.text.includes(`guide_page(page): ${available[0].id}`)));
  const overviewInstalled = available.some((page) => page.id === "construction-overview");
  assert.equal(first.content.filter((part) => part.type === "image").length, overviewInstalled ? 2 : 1);
  if (overviewInstalled) {
    assert.ok(first.content.some((part) => part.type === "text" && part.text.includes("HISTORICAL BUILDING GUIDE: Construction categories")));
    const images = first.content.filter((part) => part.type === "image");
    assert.equal(images[0]?.mimeType, "image/png");
    assert.equal(images.at(-1)?.data, "test");
  }
  const later = f.requests[1].messages.filter((m) => m.role === "user").at(-1);
  assert.ok(later && Array.isArray(later.content));
  assert.ok(!later.content.some((part) => part.type === "text" && part.text.includes("This screenshot is 100 × 100")));
  const guide = readFileSync(path.join(f.controller.memory.directory, "controls-guide.html"), "utf8");
  assert.ok(guide.includes("Starting screenshot legend"));
  assert.ok(guide.includes("<span>7</span>"));
  const guideTool = f.controller.agent.state.tools.find((tool) => tool.name === "guide_page");
  assert.ok(guideTool);
  const reference = await guideTool.execute("test-guide", { page: available[0]?.id || "farm" });
  assert.ok(reference.content.some((part) => part.type === (available.length ? "image" : "text")));
});
test("preparation pauses game, sends the combined tray guide, then starts timed play after BEGIN", async () => {
  const f = fixture(1);
  let guideSeen = false;
  f.setPrepareHook(async (input, system) => {
    assert.match(system, /^# Crusader Arena: you are being evaluated/);
    assert.match(system, /Game reference: Stronghold Crusader/);
    assert.equal(input.role, "user");
    if (input.role !== "user") throw new Error("Expected preparation user message");
    if (!Array.isArray(input.content)) throw new Error("Expected multimodal preparation message");
    // The combined guide image is private; a checkout without it sends the text guide only.
    assert.equal(input.content.some((part) => part.type === "image" && part.mimeType === "image/png"), constructionAtlasInstalled());
    assert.ok(input.content.some((part) => part.type === "text" && part.text.includes("HISTORICAL CONSTRUCTION MENU GUIDE")));
    guideSeen = true;
    f.advance(50_000);
    return message([{ type: "text", text: "I understand the objective.\nBEGIN" }]);
  });
  await f.controller.prepare();
  assert.ok(guideSeen);
  assert.equal(f.controller.session.remaining(), 30_000);
  assert.deepEqual(f.actions, [{ type: "key", key: "P" }]);
  f.provider(() => [{ type: "text", text: "Fresh live view received." }]);
  assert.equal(await f.controller.runSession(), "completed");
  assert.deepEqual(f.actions, [{ type: "key", key: "P" }, { type: "key", key: "P" }, { type: "key", key: "P" }]);
  const first = f.requests[0].messages;
  assert.equal(first[0]?.role, "user");
  assert.equal(first[1]?.role, "assistant");
  assert.ok(first.some((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((part) => part.type === "image" && part.data === "test")));
  assert.ok(!first.some((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((part) => part.type === "text" && part.text.includes("HISTORICAL BUILDING GUIDE: Construction categories"))));
});
test("preparation waits for a fresh reader sample before contacting the model", async () => {
  const f = fixture(1);
  f.setUnavailableSamples(2);
  let prepared = false;
  f.setPrepareHook(async () => {
    prepared = true;
    assert.equal(f.isPaused(), true);
    return message([{ type: "text", text: "BEGIN" }]);
  });
  await f.controller.prepare();
  assert.equal(prepared, true);
  assert.deepEqual(f.actions, [{ type: "key", key: "P" }]);
});
test("preparation without BEGIN leaves the game paused and the timer unstarted", async () => {
  const f = fixture(1);
  let requests = 0;
  f.setPrepareHook(async () => (requests++, message([{ type: "text", text: "I need more time." }])));
  await assert.rejects(f.controller.prepare(), /BEGIN/);
  assert.equal(requests, 3);
  assert.deepEqual(f.actions, [{ type: "key", key: "P" }]);
  assert.equal(f.controller.session.remaining(), 30_000);
});
test("a decorated BEGIN is accepted and a missing one is retried", async () => {
  assert.ok(isPreparedReply("Plan: granary first.\n**BEGIN**"));
  assert.ok(isPreparedReply("Ready.\nBEGIN."));
  assert.ok(!isPreparedReply("I will BEGIN soon"));
  const f = fixture(1);
  let requests = 0;
  f.setPrepareHook(async () => message([{ type: "text", text: ++requests === 1 ? "Understood." : "Understood.\nBEGIN" }]));
  await f.controller.prepare();
  assert.equal(requests, 2);
});
test("actions receive one default observation after the batch; explicit zero replaces it", async () => {
  const f = fixture(3, 10);
  const waits: number[] = [];
  f.controller.session.waitGame = async (seconds) => {
    waits.push(seconds);
    f.controller.session.check();
    return false;
  };
  f.provider((n) =>
    n === 1
      ? [
          call("game_action", { type: "key", key: "Z" }),
          call("game_action", { type: "key", key: "X" }),
        ]
      : n === 2
        ? [
            call("game_action", { type: "key", key: "Z" }),
            call("wait_and_observe", { seconds: 0 }),
          ]
        : [call("notebook_read", {})],
  );
  assert.equal(await f.controller.runSession(), "completed");
  assert.deepEqual(waits, [0, 10, 0]);
  assert.equal(f.captures(), 5);
  assert.equal(f.actions.filter((a) => (a as { key?: string }).key !== "P").length, 3);
  assert.equal(f.run.turns, 3);
});
test("notes and plans do not incur waits; ordinary final text continues with fallback", async () => {
  const f = fixture(4, 10);
  const waits: number[] = [];
  f.controller.session.waitGame = async (n) => {
    waits.push(n);
    return false;
  };
  f.provider((n) =>
    n === 1
      ? [
          call("update_plan", {
            plan: [{ step: "Observe economy", status: "in_progress" }],
          }),
        ]
      : n === 2
        ? [
            call("notebook_write", {
              revision: 0,
              text: "Verified: starting game is paused.",
            }),
          ]
        : n === 3
          ? [{ type: "text", text: "I will continue." }]
          : [call("observe", {})],
  );
  await f.controller.runSession();
  assert.deepEqual(waits, [0, 10]);
  assert.equal(f.requests.length, 4);
  assert.match(JSON.stringify(f.requests[2].messages), /starting game is paused/);
});
test("deadline reached during inference blocks all subsequent game actions", async () => {
  const f = fixture(null);
  f.provider(() => {
    f.advance(30001);
    return [call("game_action", { type: "key", key: "X" })];
  });
  assert.equal(await f.controller.runSession(), "completed");
  // Only the host finalization P is allowed, never the model X.
  assert.deepEqual(f.actions, [{ type: "key", key: "P" }]);
  assert.equal(f.run.progress?.stopReason, "deadline");
  assert.match(f.run.progress?.finalPause || "", /Confirmed paused/);
});
test("after the final pause the host centres on the keep, zooms out and saves an overview", async () => {
  const f = fixture(null);
  f.setCamera({ centre_tile_x: 10, centre_tile_y: 10, tiles_wide: 20, tiles_high: 20, pixels_per_unit_scale: 1 });
  f.provider(() => {
    f.advance(30001);
    return [call("game_action", { type: "key", key: "X" })];
  });
  assert.equal(await f.controller.runSession(), "completed");
  // After the pause: a minimap click to the keep's tile, then Z until the view stops widening.
  assert.deepEqual(
    f.actions.map((a) => (a as { key?: string }).key ?? `click ${(a as { button?: number }).button}`),
    ["P", "click 1", "Z", "Z", "Z"],
  );
  assert.equal(f.isPaused(), true);
  assert.match(f.run.progress?.finalPause || "", /Confirmed paused/);
  assert.equal(readFileSync(path.join(f.controller.memory.directory, "final-overview.jpg"), "base64"), "test");
  const overview = readFileSync(f.store.file(f.run.id, "events.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line).event).find((e) => e?.type === "final_overview");
  assert.deepEqual([overview.keep, overview.centre], [{ x: 50, y: 60 }, "arrived"]);
  assert.equal(overview.zoomOutSteps, 2);
  assert.equal(overview.camera.tiles_wide, 40);
  assert.ok(f.logMessages.some((m) => /Final overview saved/.test(m)));
});
test("operator stop overrides continuation and never toggles pause", async () => {
  const f = fixture(null);
  f.provider(() => {
    f.controller.stop();
    return [call("game_action", { type: "key", key: "P" })];
  });
  assert.equal(await f.controller.runSession(), "stopped");
  assert.deepEqual(f.actions, []);
});
test("a host shutdown ends the run as stopped but still pauses the game", async () => {
  const f = fixture(null);
  // The game is running (no pause during this fake inference) when the host shuts down.
  f.provider(() => {
    f.controller.interrupt();
    return [call("game_action", { type: "key", key: "P" })];
  });
  assert.equal(await f.controller.runSession(), "stopped");
  // No agent action ran; only the host's final pause.
  assert.deepEqual(f.actions, [{ type: "key", key: "P" }]);
  assert.equal(f.isPaused(), true);
  assert.match(String(f.controller.progress.finalPause), /Confirmed paused/);
});
test("multiple compactions retain exact plan, notes and objective in actual next requests, under one system prompt", async () => {
  const f = fixture(7);
  f.controller.memory.updatePlan([
    { step: "Keep evidence", status: "in_progress" },
  ]);
  f.controller.memory.writeNotebook(0, "Observed no validated enemy text.");
  f.provider(() => [
    { type: "text", text: "Evidence ".repeat(5750) },
    call("observe", {}),
  ]);
  assert.equal(await f.controller.runSession(), "completed", JSON.stringify(f.logMessages));
  assert.ok(f.controller.memory.compactions >= 2, `compactions=${f.controller.memory.compactions}`);
  // Byte-identical for the whole run, so provider prompt caches stay valid.
  assert.equal(new Set(f.requests.map((r) => r.systemPrompt)).size, 1);
  assert.match(f.requests[0].systemPrompt!, /Keep the current map/);
  // After each compaction the plan and notebook travel in the replacement message.
  const afterCompaction = f.requests.filter((r) => JSON.stringify(r.messages).includes("Context was compacted"));
  assert.ok(afterCompaction.length >= 2);
  for (const request of afterCompaction) {
    const text = JSON.stringify(request.messages);
    assert.match(text, /Keep evidence/);
    assert.match(text, /in_progress/);
    assert.match(text, /no validated enemy text/);
  }
  const disk = JSON.parse(
    readFileSync(
      path.join(f.controller.memory.directory, "checkpoint.json"),
      "utf8",
    ),
  );
  assert.deepEqual(disk.plan, f.controller.memory.plan);
  assert.equal(disk.notebook.revision, 1);
  assert.equal(disk.progress.phase, "completed");
});
test("the handoff request repeats the gameplay request; a tool call instead of a handoff falls back to text only", async () => {
  const f = fixture(7);
  await f.controller.prepare();
  // The first handoff reply calls a tool; the text-only retry answers.
  f.setHandoffReply((call) => call === 1 ? { text: "", stopReason: "toolUse" } : {
    text: "Verified prior progress. Continue the exact preserved plan and notebook. No uncertain action should be replayed.",
  });
  f.provider(() => [
    { type: "text", text: "Evidence ".repeat(5750) },
    call("observe", {}),
  ]);
  assert.equal(await f.controller.runSession(), "completed", JSON.stringify(f.logMessages));
  assert.ok(f.controller.memory.compactions >= 1);
  const [first, retry] = f.handoffs;
  const images = (messages: AgentMessage[]) =>
    messages.flatMap((m) => ("content" in m && Array.isArray(m.content) ? m.content : []) as { type: string }[])
      .filter((part) => part.type === "image").length;
  // Same system prompt, tools and messages (images included) as gameplay, plus the instruction.
  assert.equal(first.system, f.requests[0].systemPrompt);
  assert.deepEqual(first.tools, f.controller.agent.state.tools.map((t) => t.name));
  assert.match(JSON.stringify(first.messages.at(-1)), /about to be compacted/);
  assert.ok(images(first.messages) > 0);
  // It continues the last gameplay request, which differs only where a screenshot was pruned
  // since; up to that request's oldest kept screenshot it is byte-identical (the cached prefix).
  const before = f.requests.filter((r) => !JSON.stringify(r.messages).includes("Context was compacted")).at(-1)!;
  const textOnly = (messages: AgentMessage[]) =>
    JSON.stringify(pruneImages(messages, 0, new Set(messages.slice(0, 2))));
  assert.equal(textOnly(first.messages.slice(0, before.messages.length)), textOnly(before.messages));
  const oldest = before.messages.findIndex((m, i) => i >= 2 && images([m]) > 0);
  assert.equal(JSON.stringify(first.messages.slice(0, oldest)), JSON.stringify(before.messages.slice(0, oldest)));
  // The retry has no tools and no images.
  assert.deepEqual(retry.tools, []);
  assert.equal(images(retry.messages), 0);
  assert.match(JSON.stringify(retry.messages.at(-1)), /about to be compacted/);
});
test("failed handoff preserves old transcript and stops without replay", async () => {
  const f = fixture(4);
  f.controller.memory.installHandoff = () => {
    throw new Error("Disk checkpoint failed");
  };
  f.provider(() => [
    { type: "text", text: "Evidence ".repeat(6000) },
    call("observe", {}),
  ]);
  assert.equal(await f.controller.runSession(), "error");
  assert.equal(f.controller.memory.compactions, 0);
  assert.ok(
    JSON.stringify(f.controller.agent.state.messages).includes(
      "Evidence Evidence",
    ),
  );
  assert.equal(f.actions.filter((a) => (a as { key?: string }).key !== "P").length, 0);
});
test("journal retains a captured event after the live buffer expires", async () => {
  const f = fixture(2);
  f.provider((n) => {
    if (n === 1)
      f.events.ingest(
        {
          status: "ok",
          session: "a",
          generation: 1,
          captured_unix_ms: 1,
          events: [
            {
              kind: "visible_message_observed",
              id: "old",
              channel: "Panel_Feedback",
              text: "Wrong terrain",
            },
          ],
        },
        1,
      );
    return [call("observe", {})];
  });
  await f.controller.runSession();
  assert.equal(f.events.since(0).events.length, 0);
  const result = await f.controller.memory.notifications(0);
  assert.equal(
    result.events.find((e) => e.id === "old")?.text,
    "Wrong terrain",
  );
});
test("notebooks are isolated, revision guarded, bounded and survive reload", () => {
  const a = fixture(),
    b = fixture();
  a.controller.memory.writeNotebook(0, "One observation.");
  assert.throws(() => a.controller.memory.writeNotebook(0, "stale"), /Stale/);
  assert.throws(
    () => a.controller.memory.editNotebook(1, "absent", "x"),
    /exactly once/,
  );
  assert.throws(
    () => a.controller.memory.writeNotebook(1, "界".repeat(3000)),
    /8192/,
  );
  a.controller.memory.editNotebook(1, "One", "Two");
  assert.equal(b.controller.memory.notebook.text, "");
  assert.equal(
    new RunMemory(a.controller.memory.directory, () => {}).notebook.text,
    "Two observation.",
  );
});
test("pruning preserves tool IDs and results and only keeps two images", () => {
  const m = [1, 2, 3].flatMap((n) => [
    message([call("observe", {})]),
    {
      role: "toolResult" as const,
      toolCallId: "id" + n,
      toolName: "observe",
      isError: false,
      content: [
        { type: "image" as const, data: "image" + n, mimeType: "image/jpeg" },
      ],
      timestamp: 1,
    },
  ]);
  const p = pruneImages(m);
  assert.equal(p.length, 6);
  assert.equal(JSON.stringify(p).match(/"type":"image"/g)?.length, 2);
  assert.ok(JSON.stringify(p).includes("id1"));
  assert.ok(JSON.stringify(m).includes("image1"));
});
test("long wait is promptly interruptible and expired session cannot act", async () => {
  let now = 0;
  let cancelled = 0;
  const s = new Session(
    10,
    () => cancelled++,
    () => now,
  );
  s.start();
  const pending = s.wait(300);
  s.stop("stopped");
  await assert.rejects(pending, /stopped/);
  assert.equal(cancelled, 1);
  const t = new Session(
    10,
    () => cancelled++,
    () => now,
  );
  t.start();
  now = 10001;
  assert.throws(() => t.check(), /deadline/);
  assert.equal(cancelled, 2);
});

test("synthetic long session continues for 60 turns across repeated compactions", async () => {
  const f = fixture(60);
  f.controller.memory.updatePlan([
    { step: "Maintain observed progress", status: "in_progress" },
  ]);
  f.controller.memory.writeNotebook(0, "Preserve this run-specific evidence.");
  f.provider(() => {
    f.advance(100);
    return [
      { type: "text", text: "Observed evidence. ".repeat(1500) },
      call("observe", {}),
    ];
  });
  assert.equal(await f.controller.runSession(), "completed", JSON.stringify(f.logMessages));
  assert.equal(f.requests.length, 60);
  assert.ok(f.controller.memory.compactions >= 10, `compactions=${f.controller.memory.compactions}`);
  assert.equal(f.controller.memory.notebook.revision, 1);
  assert.ok(JSON.stringify(f.controller.agent.state.messages).length < 110000);
});

test("deadline during compaction cannot install a late handoff", async () => {
  const f = fixture(3);
  f.setHandoffHook(() => f.advance(30001));
  f.provider(() => [
    { type: "text", text: "Evidence ".repeat(10000) },
    call("observe", {}),
  ]);
  assert.equal(await f.controller.runSession(), "completed");
  assert.equal(f.controller.memory.compactions, 0);
  assert.equal(f.run.progress?.stopReason, "deadline");
  assert.deepEqual(f.actions, [{ type: "key", key: "P" }]);
});

test("provider timeout clamps fractional remaining time to a positive integer", () => {
  assert.equal(requestTimeout(54321.987), 54321);
  assert.equal(requestTimeout(180000), 90000);
  assert.equal(requestTimeout(0.5), 1);
});

test("a turn lasts the minimum: looks wait it out, a turn without one is topped up, reading-only turns are free", async () => {
  const f = fixture(5, 5, 10, {}, undefined, 8);
  const waits: number[] = [];
  // Game waits advance the reader clock by the waited game seconds.
  f.controller.session.waitGame = async (seconds) => {
    waits.push(seconds);
    f.advanceTicks(seconds * 30);
    f.controller.session.check();
    return false;
  };
  f.provider((n) => {
    if (n === 1) {
      f.advanceTicks(60); // The turn's tools run the game for 2 game seconds.
      return [call("game_action", { type: "key", key: "Z" }), call("observe", {})];
    }
    if (n === 2) return [call("game_action", { type: "key", key: "X" }), call("wait_and_observe", { seconds: 3 })];
    if (n === 3) return [call("game_action", { type: "key", key: "Z" }), call("wait_and_observe", { seconds: 10 })];
    if (n === 4) return [call("game_action", { type: "key", key: "X" })];
    return [call("status", {})];
  });
  assert.equal(await f.controller.runSession(), "completed", JSON.stringify(f.logMessages));
  // The first screenshot; observe waits out turn 1's last 6 s and wait_and_observe(3) is
  // lengthened to 8, so neither turn is topped up; turn 3 waits as asked; turn 4 looked at
  // nothing, so the host lets the minimum pass; turn 5 only read.
  assert.deepEqual(waits, [0, 6, 8, 10, 8]);
  assert.match(JSON.stringify(f.requests[1].messages.at(-1)), /Minimum turn \(8 game seconds\): the host let 6 more game seconds pass before this screenshot/);
  assert.match(JSON.stringify(f.requests[2].messages.at(-1)), /the host let 5 more game seconds pass/);
  assert.doesNotMatch(JSON.stringify(f.requests[3].messages.at(-1)), /Minimum turn/);
  assert.match(JSON.stringify(f.requests[4].messages.at(-1)), /the host let 8 game seconds pass/);
  assert.match(f.requests[0].systemPrompt!, /A reply whose tools run the game lasts at least 8 game seconds/);
  assert.doesNotMatch(runSystemPrompt(fixture(1).run), /lasts at least/);
});

test("explicit N-second observation replaces the configured default exactly once", async () => {
  const f = fixture(3, 10);
  const waits: number[] = [];
  f.controller.session.waitGame = async (n) => {
    waits.push(n);
    f.controller.session.check();
    return false;
  };
  f.provider((n) =>
    n === 1
      ? [
          call("game_action", { type: "key", key: "Z" }),
          call("wait_and_observe", { seconds: 3 }),
        ]
      : [call("observe", {})],
  );
  await f.controller.runSession();
  assert.deepEqual(waits, [0, 3]);
  assert.equal(f.captures(), 6);
});

test("request timing logs first content once and resets it before the next request", async () => {
  const f = fixture(1);
  f.controller.agent.streamFunction = () => {
    f.controller.runtime.requestStarted!();
    const stream = createAssistantMessageEventStream();
    const m = message([call("observe", {})]);
    stream.push({ type: "start", partial: m });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: m });
    stream.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: "{",
      partial: m,
    });
    stream.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: "}",
      partial: m,
    });
    stream.push({ type: "done", reason: "toolUse", message: m });
    return stream;
  };
  assert.equal(await f.controller.runSession(), "completed");
  f.controller.runtime.timing(1000, "toolUse", "gameplay");
  f.controller.runtime.requestStarted!();
  f.controller.runtime.timing(100, "error", "gameplay");
  const events = readFileSync(
    path.join(f.controller.memory.directory, "events.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).event);
  assert.equal(
    events.filter((e) => e.type === "inference_first_delta").length,
    1,
  );
  const timings = events.filter((e) => e.type === "inference_timing");
  assert.equal(typeof timings[0].firstDeltaMs, "number");
  assert.ok(timings[0].afterFirstDeltaMs >= 0);
  assert.equal(timings[1].firstDeltaMs, null);
  assert.equal(timings[1].afterFirstDeltaMs, null);
});

test("the game-time budget ends the run and blocks further game actions", async () => {
  const f = fixture(null, 0, 0.5); // 0.5 game minutes = 900 ticks
  f.provider(() => {
    f.advanceTicks(1000);
    return [call("game_action", { type: "key", key: "X" })];
  });
  assert.equal(await f.controller.runSession(), "completed");
  assert.equal(f.run.progress?.stopReason, "deadline");
  assert.equal(f.run.progress?.budget?.endedBy, "game_time");
  assert.deepEqual(f.actions, [{ type: "key", key: "P" }]);
  assert.match(f.requests[0].systemPrompt!, /The budget is \*\*0\.5 minutes of game time\*\* \(30 game seconds/);
  const observation = f.requests[0].messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []) as { type: string; text?: string }[])
    .find((part) => part.type === "text" && part.text?.includes("run_clock"));
  assert.ok(observation?.text);
  assert.deepEqual(JSON.parse(observation.text).run_clock, { game_time_left: "30 s", game_time_used: "0 s", game_time_budget: "30 s", real_minutes_left: 0 });
});

test("every request shows the game time left: the last tool result of a reply carries it unless it has run_clock", async () => {
  const f = fixture(3);
  f.provider((n) =>
    n === 1
      ? [call("status", {}), call("building_info", { name: "Hovel" })]
      : n === 2
        ? [call("game_action", { type: "key", key: "Z" }), call("observe", {})]
        : [{ type: "text", text: "Done." }],
  );
  assert.equal(await f.controller.runSession(), "completed", JSON.stringify(f.logMessages));
  const results = (request: number) =>
    f.requests[request].messages.filter((m) => m.role === "toolResult").slice(-2).map((m) => JSON.stringify(m.content));
  const [status, info] = results(1);
  assert.doesNotMatch(status, /Game time left/);
  assert.match(info, /Game time left: 10 min of 10 min\./);
  const [, observed] = results(2);
  assert.match(observed, /run_clock/);
  assert.doesNotMatch(observed, /Game time left:/);
});

test("the host sets the game speed before the budget starts and the agent cannot change it", async () => {
  let pausedWhileSetting: boolean | undefined;
  const f = fixture(2, 0, 10, {}, undefined, 0, async (control) => {
    pausedWhileSetting = f.isPaused();
    await control.press("+");
    return { target: 40, before: 35.4, after: 40.4, presses: 1 };
  });
  f.provider((n) => (n === 1 ? [call("game_action", { type: "key", key: "+" })] : [{ type: "text", text: "Done." }]));
  assert.equal(await f.controller.runSession(), "completed", JSON.stringify(f.logMessages));
  assert.equal(pausedWhileSetting, false);
  // The host's press only: the agent's + fails the tool's key schema.
  assert.deepEqual(f.actions.filter((a) => (a as { key?: string }).key === "+").length, 1);
  assert.deepEqual(f.run.progress?.gameSpeed, { target: 40, before: 35.4, after: 40.4, presses: 1 });
  assert.ok(f.logMessages.some((m) => /Game speed set to 40: measured 40\.4 ticks\/s \(was 35\.4; 1 key presses\)/.test(m)));
  assert.match(f.requests[0].systemPrompt!, /fixed speed of 40/);
});

test("a game clock reset (reload or map change) ends the run with an error", async () => {
  const f = fixture(null);
  f.provider(() => {
    f.resetClock();
    return [call("game_action", { type: "key", key: "X" })];
  });
  assert.equal(await f.controller.runSession(), "error");
  assert.ok(f.logMessages.some((m) => /clock reset/.test(m)), JSON.stringify(f.logMessages));
  assert.ok(!f.actions.some((a) => (a as { key?: string }).key === "X"));
});

test("game-time waits end when the ticks advance, and a stalled clock is bounded", async () => {
  let tick = 0;
  const session = new Session(60, () => {}, undefined, { budgetTicks: 100000, clock: () => ({ tick, map: "m" }) });
  session.start();
  const timer = setInterval(() => { tick += 30; }, 20);
  const started = performance.now();
  await session.waitGame(2); // 60 ticks
  clearInterval(timer);
  assert.ok(performance.now() - started < 1000);
  assert.ok(tick >= 60);
  // A stalled clock ends the wait after about three real seconds per game second.
  let now = 0;
  const stalled = new Session(60, () => {}, () => (now += 500), { budgetTicks: 100000, clock: () => ({ tick: 5, map: "m" }) });
  stalled.start();
  await stalled.waitGame(1);
  assert.equal(stalled.gameUsedTicks(), 0);
  session.close();
  stalled.close();
});

test("a reader gap (new stream generation) does not end the run; a map change does", async () => {
  const f = fixture(2);
  f.provider(() => {
    f.bumpGeneration();
    f.advanceTicks(30);
    return [{ type: "text", text: "Observed." }];
  });
  assert.equal(await f.controller.runSession(), "completed", JSON.stringify(f.logMessages));
  const g = fixture(null);
  g.provider(() => {
    g.changeMap();
    return [call("game_action", { type: "key", key: "X" })];
  });
  assert.equal(await g.controller.runSession(), "error");
});

test("transient provider failures are retried; others end the run", async () => {
  assert.ok(isTransientProviderError("Provider returned an empty response"));
  assert.ok(isTransientProviderError("503 Service Unavailable"));
  assert.ok(!isTransientProviderError("Invalid API key"));
  const f = fixture(1);
  let calls = 0;
  const failing = (ctx: Context) => {
    calls++;
    const stream = createAssistantMessageEventStream();
    const m = calls === 1
      ? { ...message([]), stopReason: "error" as const, errorMessage: "Provider returned an empty response" }
      : message([{ type: "text", text: "Observed." }]);
    stream.push(calls === 1 ? { type: "error", reason: "error", error: m } : { type: "done", reason: "stop", message: m });
    void ctx;
    return stream;
  };
  f.controller.agent.streamFunction = (_m, ctx) => failing(ctx);
  assert.equal(await f.controller.runSession(), "completed", JSON.stringify(f.logMessages));
  assert.equal(calls, 2);
  assert.ok(f.logMessages.some((m) => /retrying/.test(m)));
});

test("a reply cut off at the output-token limit is discarded and retried with a nudge", async () => {
  const f = fixture(1);
  let calls = 0;
  let nudged = false;
  f.controller.agent.streamFunction = (_m, ctx) => {
    calls++;
    const stream = createAssistantMessageEventStream();
    if (calls === 1) {
      const m = { ...message([{ type: "thinking", thinking: "loop" }]), stopReason: "length" as const };
      stream.push({ type: "done", reason: "length", message: m });
    } else {
      nudged = JSON.stringify(ctx.messages.at(-1)).includes("ran out of output tokens");
      stream.push({ type: "done", reason: "stop", message: message([{ type: "text", text: "Observed." }]) });
    }
    return stream;
  };
  assert.equal(await f.controller.runSession(), "completed", JSON.stringify(f.logMessages));
  assert.equal(calls, 2);
  assert.ok(nudged);
});

test("memory-guard samples are recorded with the game clock and summarised in progress", async () => {
  const f = fixture(1);
  f.provider((turn) => {
    if (turn === 1) {
      f.guard({ kind: "sample", rss_kib: 4 * 1048576, swap_kib: 0, available_kib: 9 * 1048576, threads: 100 });
      f.guard({ kind: "sample", rss_kib: 5 * 1048576, swap_kib: 1048576, available_kib: 6 * 1048576, threads: 101 });
    }
    return [{ type: "text", text: "Observed." }];
  });
  assert.equal(await f.controller.runSession(), "completed");
  const events = readFileSync(path.join(f.controller.memory.directory, "events.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line).event);
  const samples = events.filter((e) => e.type === "memory_sample");
  assert.equal(samples.length, 2);
  assert.equal(samples[1].gameRssMiB, 5120);
  assert.equal(typeof samples[1].paused, "boolean");
  assert.deepEqual(f.run.progress?.memory, { samples: 2, maxGameRssMiB: 5120, maxGameSwapMiB: 1024, minAvailableMiB: 6144 });
  // Listening stops with the run.
  f.guard({ kind: "sample", rss_kib: 1, available_kib: 1 });
  assert.equal(f.run.progress?.memory?.samples, 2);
});

test("a recorded run captures while tools and waits run and holds while the model thinks", async () => {
  const commands: string[] = [];
  const recorder = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  recorder.stdin.on("data", (d: Buffer) => commands.push(...d.toString().trim().split("\n")));
  recorder.stdin.on("finish", () => recorder.emit("close", 0));
  const f = fixture(2, 0, 10, { spawnRecorder: () => recorder as unknown as ChildProcessWithoutNullStreams });
  const atRequest: string[] = [];
  f.provider((n) => {
    atRequest.push(commands.filter((c) => c !== "ping").at(-1) ?? "");
    return n === 1
      ? [call("game_action", { type: "key", key: "Z" }), call("wait_and_observe", { seconds: 0 })]
      : [{ type: "text", text: "Observed." }];
  }, true);
  assert.equal(await f.controller.runSession(), "completed", JSON.stringify(f.logMessages));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(atRequest, ["hold", "hold"]);
  assert.deepEqual(commands.filter((c) => c !== "ping"), ["run", "hold", "run", "hold", "quit"]);
  assert.deepEqual(f.controller.progress.recording, { frames: 0, bytes: 0 });
  const events = readFileSync(f.store.file(f.run.id, "events.jsonl"), "utf8");
  assert.match(events, /"recording_state","state":"hold"/);
  assert.match(events, /"recording_stopped"/);
});

test("the preparation guide opens every request unchanged, through image pruning and compaction", async () => {
  const f = fixture(7);
  await f.controller.prepare();
  f.provider(() => [
    { type: "text", text: "Evidence ".repeat(5750) },
    call("observe", {}),
  ]);
  assert.equal(await f.controller.runSession(), "completed", JSON.stringify(f.logMessages));
  assert.ok(f.controller.memory.compactions >= 2, `compactions=${f.controller.memory.compactions}`);
  const guide = JSON.stringify(f.requests[0].messages.slice(0, 2));
  assert.match(guide, /HISTORICAL CONSTRUCTION MENU GUIDE/);
  if (constructionAtlasInstalled()) assert.match(guide, /"type":"image","data":"[^"]{100}/);
  // Byte-identical in every request, so the provider caches it with the system prompt.
  for (const request of f.requests) assert.equal(JSON.stringify(request.messages.slice(0, 2)), guide);
  // Screenshots are still pruned to the newest two.
  for (const request of f.requests) {
    const shots = request.messages.slice(2).flatMap((m) => (Array.isArray(m.content) ? m.content : []) as { type: string }[])
      .filter((part) => part.type === "image");
    assert.ok(shots.length <= 2);
  }
  assert.ok(f.requests.some((r) => JSON.stringify(r.messages[2]).includes("The preparation guide above is kept for reference")));
});

test("a learning episode starts from its playbook, can edit it during play and rewrites it after the episode", async () => {
  const series = { id: "series-test", episode: 2, episodes: 3 };
  const f = fixture(2, 0, 10, {}, { series, playbook: "- Wood first." });
  let preparation = "";
  f.setPrepareHook(async (input) => {
    preparation = JSON.stringify(input);
    return message([{ type: "text", text: "Ready.\nBEGIN" }]);
  });
  await f.controller.prepare();
  assert.match(preparation, /Learning series: episode 2 of 3/);
  assert.match(preparation, /Wood first/);
  const tools = f.controller.agent.state.tools.map((t) => t.name);
  for (const name of ["playbook_read", "playbook_write", "playbook_edit"]) assert.ok(tools.includes(name));
  f.provider((turn) => turn === 1
    ? [call("playbook_edit", { revision: 0, before: "- Wood first.", after: "- Wood first.\n- Quarry needs an ox tether." }), call("observe", {})]
    : [call("observe", {})]);
  assert.equal(await f.controller.runSession(), "completed", JSON.stringify(f.logMessages));
  // The reflection saw the playbook as edited during play, with the same tools as gameplay.
  assert.equal(f.reflections.length, 1);
  const [reflection] = f.reflections;
  assert.deepEqual(reflection.tools, tools);
  const instruction = JSON.stringify(reflection.messages.at(-1));
  assert.match(instruction, /Episode 2 of 3 is over/);
  assert.match(instruction, /ox tether/);
  // Its reply is the next version, on disk for the episode runner.
  assert.equal(f.controller.memory.playbook?.text, "# Playbook\n- Place the granary beside the keep first.");
  assert.equal(f.controller.memory.playbook?.revision, 2);
  const file = path.join(f.controller.memory.directory, "playbook.md");
  assert.equal(readFileSync(file, "utf8"), "# Playbook\n- Place the granary beside the keep first.");
});

test("a reflection that calls a tool is asked again as text; a failed one keeps the playbook", async () => {
  const series = { id: "series-test", episode: 1, episodes: 3 };
  const f = fixture(1, 0, 10, {}, { series, playbook: "" });
  await f.controller.prepare();
  f.setReflectionReply((call) => call === 1 ? { text: "", stopReason: "toolUse" } : { text: "- Build houses early." });
  f.provider(() => [call("observe", {})]);
  await f.controller.runSession();
  assert.deepEqual(f.reflections.map((r) => r.tools.length > 0), [true, false]);
  assert.equal(f.controller.memory.playbook?.text, "- Build houses early.");

  const g = fixture(1, 0, 10, {}, { series, playbook: "- Keep this." });
  await g.controller.prepare();
  g.setReflectionReply(() => ({ text: "x".repeat(9000) }));
  g.provider(() => [call("observe", {})]);
  await g.controller.runSession();
  assert.equal(g.controller.memory.playbook?.text, "- Keep this.");
  assert.ok(g.logMessages.some((text) => /Reflection failed/.test(text)));
});

test("a run outside a learning series has no playbook tools and no reflection", async () => {
  const f = fixture(1);
  await f.controller.prepare();
  assert.ok(!f.controller.agent.state.tools.some((t) => t.name.startsWith("playbook")));
  f.provider(() => [call("observe", {})]);
  await f.controller.runSession();
  assert.equal(f.reflections.length, 0);
  assert.equal(f.controller.memory.playbook, null);
});

test("what the provider billed is kept per request and summed in run.json", () => {
  const f = fixture(1);
  f.controller.runtime.cost?.("gameplay", 0.012);
  f.controller.runtime.cost?.("compaction", 0.003);
  assert.ok(Math.abs(f.store.get(f.run.id).cost! - 0.015) < 1e-12);
  const events = readFileSync(f.store.file(f.run.id, "events.jsonl"), "utf8");
  assert.match(events, /"type":"request_cost","kind":"compaction","dollars":0.003/);
});
