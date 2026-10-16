import { test } from "node:test";
import assert from "node:assert/strict";
import { GameEvents } from "./game-events.js";
import { makeAgent, type AgentRuntime } from "./model.js";
import { ObservationCycle } from "./session.js";
import { Warnings } from "./warnings.js";
import { menuClicks as trayClicks } from "./construction-ui.js";
import { tilePixel } from "./anchors.js";
import type { GameDevice, TileRegion } from "./device.js";
import { TileMap, footprintRect, type Rect } from "./tile-map.js";

test("observe delivers buffered warnings once even after current stats expire", async () => {
  const events = new GameEvents();
  const device = {
    events,
    capture: async () => ({
      id: "frame",
      image: "",
      mimeType: "image/jpeg",
      width: 1920,
      height: 1080,
      scope: "game-window",
    }),
    currentStats: () => ({ status: "unavailable", observation: null }),
    // Frames do not age in these tests (GameDevice.frameAge).
    frameAge: () => 0,
  } as unknown as GameDevice;
  const agent = makeAgent(
    device,
    () => {},
    () => {},
    1,
    {
      id: "test",
      name: "test",
      modelId: "test",
      baseUrl: "https://example.invalid",
      keyConfigured: false,
    },
    "",
  );
  const now = Date.now();
  events.ingest(
    {
      status: "ok",
      session: "s",
      generation: 1,
      captured_unix_ms: now,
      events: [
        {
          kind: "visible_message_observed",
          id: "warning",
          channel: "Feedback_1",
          text: "Cannot place that there",
        },
      ],
    },
    now,
  );
  events.ingest({ status: "stale" }, now);
  const tool = agent.state.tools.find((t) => t.name === "observe")!;
  const get = async () => {
    const result = await tool.execute("call", {});
    const text = result.content.find((c) => c.type === "text");
    assert.ok(text && text.type === "text");
    return JSON.parse(text.text);
  };
  const first = await get();
  assert.equal(first.width, 1920);
  assert.equal(first.height, 1080);
  assert.deepEqual(first.stats, { status: "unavailable", reader_status: "unavailable" });
  assert.deepEqual(first.game_events, [{ text: "Cannot place that there", seconds_ago: 0 }]);
  assert.deepEqual((await get()).game_events, []);
});

test("observations carry game values and messages, not reader bookkeeping", async () => {
  const events = new GameEvents();
  const reader = {
    status: "ok", session: "s", generation: 1, sequence: 7, captured_unix_ms: Date.now(),
    valid_until_unix_ms: Date.now() + 1500, lifecycle_reset: false, events: [],
    observation: {
      schema: 1, coherence: "double_read_equal", atomic: false, map_name: "m", game_time: 900,
      gold: 1000, population: 5, popularity: 60, tax_index: 3, wood_planks: 41, resources: [0, 0, 41],
      resources_by_name: { wood_planks: 41, stone: 25, bread: 50, hops: 0, iron: 0 },
      own_troops: { total: 0, by_type: { archer: 0 } },
      managed_heap: { heap_bytes: 1, used_bytes: 1 },
      structures: { count: 9, limit: 10 },
      placement: { action: 5, sub_action: 2 },
      camera: { centre_tile_x: 100, centre_tile_y: 120, tiles_wide: 40, tiles_high: 30, pixels_per_unit_scale: 1 },
      settlement: {
        month: 6, year: 1194, housing_cap: 10, peasants_available: 2, total_food: 50, months_of_food: 4,
        rationing: 2, food_types_eaten: 1, food_types_available: 1, efficiency: 0, upcoming_popularity: 25,
        popularity_factors: { food: 25, tax: 0 },
      },
      visible_messages: [], message_coverage: "visible_ui_only",
    },
  };
  const device = {
    events,
    capture: async () => ({ id: "frame", image: "", mimeType: "image/jpeg", width: 1920, height: 1080, scope: "game-window" }),
    currentStats: () => reader,
    // Frames do not age in these tests (GameDevice.frameAge).
    frameAge: () => 0,
  } as unknown as GameDevice;
  // One agent per benchmark kind; each keeps its own event cursor from creation.
  const agentFor = (military: boolean) => makeAgent(device, () => {}, () => {}, 1,
    { id: "t", name: "t", modelId: "t", baseUrl: "https://example.invalid", keyConfigured: false }, "", {
      session: { check() {}, gameBudgetSeconds: 600, gameRemainingSeconds: () => 590, remaining: () => 60000 },
      cycle: { observe() {} },
      memory: { delivery() {} },
      config: { contextBudget: 120000 },
      military,
      phase() {}, changed() {}, timing() {},
    } as unknown as AgentRuntime);
  const economy = agentFor(false);
  const military = agentFor(true);
  // A message still on screen is reported again after each brief reader gap.
  const message = (id: string, generation: number) => ({
    ...reader, generation, events: [{ kind: "visible_message_observed", id, channel: "Keep_Message", text: "  Site your granary  " }],
  });
  const start = Date.now() - 10_000;
  events.ingest(message("a", 1), start);
  for (let generation = 2; generation < 40; generation++) {
    events.ingest({ status: "unavailable" }, start + generation * 100);
    events.ingest(message(`m${generation}`, generation), start + generation * 100 + 50);
  }
  const observe = async (agent: ReturnType<typeof makeAgent>) => {
    const result = await agent.state.tools.find((t) => t.name === "observe")!.execute("observe", {});
    const text = result.content.find((c) => c.type === "text");
    assert.ok(text && text.type === "text");
    return { json: JSON.parse(text.text), details: result.details as { readerStats: unknown } };
  };
  const { json, details } = await observe(economy);
  assert.deepEqual(json.game_events.map((e: any) => e.text), ["Site your granary"]);
  assert.equal(json.reader_unavailable_seconds, undefined, "brief gaps are not reported");
  assert.deepEqual(Object.keys(json).sort(), ["game_events", "height", "run_clock", "stats", "width"]);
  assert.deepEqual(json.stats, {
    status: "ok", date: "July 1194", gold: 1000,
    population: { current: 5, housing: 10, idle_peasants: 2 },
    popularity: { current: 60, upcoming_change: 1, factors: { food: 1 } },
    tax_level: 3,
    food: { total: 50, rationing: "full", types_eaten: 1, types_available: 1 },
    // Goods with none stored are left out (the prompt says an unlisted good has none).
    goods: { wood_planks: 41, stone: 25, bread: 50 },
    placement_mode: "placing",
    camera: { centre_tile: [100, 120], zoom: 1 },
  });
  assert.equal(details.readerStats, reader, "the full sample stays in details for reports");
  assert.deepEqual((await observe(military)).json.stats.troops, { total: 0, by_type: {} });
});

test("build_structure reports a single rejected placement and leaves placement mode", async () => {
  const events = new GameEvents();
  const actions: unknown[] = [];
  let captures = 0;
  const device = {
    events,
    capture: async () => ({
      id: `frame-${++captures}`,
      image: "",
      mimeType: "image/jpeg",
      width: 1920,
      height: 1080,
      scope: "game-window",
    }),
    action: async (action: unknown) => {
      actions.push(action);
      if (actions.length === 3) events.ingest({
        status: "ok",
        session: "s",
        generation: 1,
        captured_unix_ms: Date.now(),
        events: [{
          kind: "visible_message_observed",
          id: "invalid-farm",
          channel: "Panel_Feedback",
          text: "Farms must be placed on an oasis.",
        }],
      });
    },
    currentStats: () => ({ status: "unavailable", observation: null }),
    // Frames do not age in these tests (GameDevice.frameAge).
    frameAge: () => 0,
  } as unknown as GameDevice;
  const agent = makeAgent(device, () => {}, () => {}, 1, {
    id: "test", name: "test", modelId: "test",
    baseUrl: "https://example.invalid", keyConfigured: false,
  }, "");
  await agent.state.tools.find((tool) => tool.name === "observe")!.execute("observe", {});
  const result = await agent.state.tools.find((tool) => tool.name === "build_structure")!
    .execute("build", { placements: [{ name: "Apple Orchard", x: 700, y: 440 }] });
  assert.equal(captures, 1, "no screenshot after building");
  assert.deepEqual(actions, [
    { type: "click", x: 949, y: 1055, button: 1 },
    { type: "click", x: 1166, y: 974, button: 1 },
    { type: "click", x: 700, y: 440, button: 1 },
    { type: "click", x: 700, y: 440, button: 3 },
  ]);
  const first = result.content[0];
  assert.equal(first.type, "text");
  if (first.type === "text") {
    const report = JSON.parse(first.text);
    assert.equal(report.feedbackCoverage, "reader_unavailable");
    assert.equal(report.placements[0].status, "rejected");
    assert.deepEqual(report.placements[0].feedback, ["Farms must be placed on an oasis."]);
  }
  assert.ok(result.content.every((part) => part.type === "text"), "text-only result");
});

test("build_structure batches placements from one image and attributes feedback to each", async () => {
  const events = new GameEvents();
  const actions: { button: number; x: number; y: number }[] = [];
  let captures = 0;
  let clock = 1_000_000;
  let visible: { channel: string; text: string }[] = [];
  const sentAt: number[] = [];
  let sequence = 0;
  // Each reader sample is captured after the latest click and carries the currently visible panel text.
  const sample = () => ({
    status: "ok",
    session: "s",
    generation: 1,
    captured_unix_ms: clock + 300,
    valid_until_unix_ms: Date.now() + 1500,
    observation: { map_name: "m", visible_messages: visible },
    events: visible.map((m) => ({
      kind: "visible_message_observed", id: `e${++sequence}`, channel: m.channel, text: m.text,
    })),
  });
  let stats: any = sample();
  const device = {
    events,
    capture: async () => ({
      id: `frame-${++captures}`, image: "", mimeType: "image/jpeg",
      width: 1920, height: 1080, scope: "game-window",
    }),
    action: async (action: any) => {
      actions.push(action);
      sentAt.push(Date.now());
      clock += 100;
      const world = action.button === 1 && action.y < 900;
      if (world) {
        // Second world target is rejected; the first and third are silent.
        visible = actions.filter((a) => a.button === 1 && a.y < 900).length === 2
          ? [{ channel: "Panel_Feedback", text: "Needs to be placed adjacent to the stockpile." }]
          : [];
        stats = sample();
        events.ingest(stats);
      }
      return { delivered: true, at: clock };
    },
    currentStats: () => stats,
    // Frames do not age in these tests (GameDevice.frameAge).
    frameAge: () => 0,
  } as unknown as GameDevice;
  const agent = makeAgent(device, () => {}, () => {}, 1, {
    id: "test", name: "test", modelId: "test",
    baseUrl: "https://example.invalid", keyConfigured: false,
  }, "");
  await agent.state.tools.find((tool) => tool.name === "observe")!.execute("observe", {});
  const result = await agent.state.tools.find((tool) => tool.name === "build_structure")!
    .execute("build", { placements: [
      { name: "Hovel", x: 500, y: 400 },
      { name: "Stockpile", x: 600, y: 500 },
      { name: "Woodcutter", x: 700, y: 300 },
    ] });
  assert.equal(captures, 1, "no screenshot for the whole batch");
  assert.equal(actions.length, 10);
  assert.deepEqual(actions.at(-1), { type: "click", x: 700, y: 300, button: 3 });
  const first = result.content[0];
  assert.ok(first.type === "text");
  const report = JSON.parse(first.text);
  assert.equal(report.feedbackCoverage, "reader_active");
  assert.deepEqual(report.placements.map((p: any) => p.status), ["unverified", "rejected", "unverified"]);
  assert.deepEqual(report.placements[1].feedback, ["Needs to be placed adjacent to the stockpile."]);
  // Category clicks are actions 0, 3 and 6; the tray page changes before the first two only.
  assert.ok(sentAt[1] - sentAt[0] >= 750, "waits for a newly opened tray page");
  assert.ok(sentAt[4] - sentAt[3] >= 750, "waits after switching category");
  assert.ok(sentAt[7] - sentAt[6] < 500, "no wait when the same page is already open");
});

test("build_structure reuses the construction tray's open category across calls, and forgets it once anything else sends input", async () => {
  const events = new GameEvents();
  const actions: { button: number; x: number; y: number }[] = [];
  const sentAt: number[] = [];
  let captures = 0;
  let inputSerial = 0;
  // No placement field: select() always reports "unchecked", but still records the open category
  // (placement.ts select() sets it before checking whether a reader sample confirmed anything).
  // captured_unix_ms tracks real time so each click's settle() resolves in ~SETTLE_MS, not its
  // full timeout.
  // A camera is present so observe() does not wait out its full 1.5 s poll for one.
  const stats = () => ({
    status: "ok", session: "s", generation: 1,
    captured_unix_ms: Date.now(), valid_until_unix_ms: Date.now() + 1500,
    observation: {
      map_name: "m", visible_messages: [],
      camera: { centre_tile_x: 100, centre_tile_y: 100, tiles_wide: 30, tiles_high: 68, pixels_per_unit_scale: 1 },
    },
  });
  const device = {
    events,
    capture: async () => ({ id: `frame-${++captures}`, image: "", mimeType: "image/jpeg", width: 1920, height: 1080, scope: "game-window" }),
    get inputSerial() {
      return inputSerial;
    },
    action: async (action: { button: number; x: number; y: number }) => {
      inputSerial++;
      actions.push(action);
      sentAt.push(Date.now());
      return { delivered: true, at: Date.now() };
    },
    hotkey: async () => {
      inputSerial++;
      return { at: Date.now() };
    },
    currentStats: stats,
    // Frames do not age in these tests (GameDevice.frameAge).
    frameAge: () => 0,
  } as unknown as GameDevice;
  const agent = makeAgent(device, () => {}, () => {}, 1, {
    id: "test", name: "test", modelId: "test", baseUrl: "https://example.invalid", keyConfigured: false,
  }, "");
  const tool = (name: string) => agent.state.tools.find((t) => t.name === name)!;
  await tool("observe").execute("observe", {});
  const build = (x: number, y: number) => tool("build_structure").execute("build", { placements: [{ name: "Hovel", x, y }] });
  await build(500, 400);
  // Each call sends category, button, target, then a right-click to leave placement mode.
  assert.ok(sentAt[1] - sentAt[0] >= 750, "no memory yet: the first call waits for the tray to fade in");
  await build(520, 400);
  assert.ok(sentAt[5] - sentAt[4] < 500, "the same category is remembered from the first call");
  // Another tool sends input to the game; the remembered category must be forgotten.
  await tool("game_action").execute("ga", { type: "click", x: 10, y: 950, button: 1 });
  await build(540, 400);
  assert.ok(sentAt[10] - sentAt[9] >= 750, "a third call waits again after something else touched the game");
});

test("build_structure does not blame a later placement for reappearing feedback", async () => {
  const events = new GameEvents();
  const rejection = "Farms must be placed on an oasis.";
  let clock = 1_000_000;
  let sequence = 0;
  let visible: { channel: string; text: string }[] = [];
  let worldClicks = 0;
  const sample = () => ({
    status: "ok", session: "s", generation: 1,
    captured_unix_ms: clock + 300, valid_until_unix_ms: Date.now() + 1500,
    observation: { map_name: "m", visible_messages: visible },
    events: [],
  });
  let stats: any = sample();
  const device = {
    events,
    capture: async () => ({ id: "frame", image: "", mimeType: "image/jpeg", width: 1920, height: 1080, scope: "game-window" }),
    action: async (action: any) => {
      clock += 100;
      if (action.button === 1 && action.y >= 900) visible = []; // A menu rollover hides panel feedback.
      if (action.button === 1 && action.y < 900) {
        worldClicks++;
        visible = [{ channel: "Panel_Feedback", text: rejection }]; // First rejection, then the same text reappears.
        stats = sample();
        events.ingest({ ...stats, events: [{ kind: "visible_message_observed", id: `e${++sequence}`, channel: "Panel_Feedback", text: rejection }] });
      } else stats = sample();
      return { delivered: true, at: clock };
    },
    currentStats: () => stats,
    // Frames do not age in these tests (GameDevice.frameAge).
    frameAge: () => 0,
  } as unknown as GameDevice;
  const agent = makeAgent(device, () => {}, () => {}, 1, {
    id: "test", name: "test", modelId: "test",
    baseUrl: "https://example.invalid", keyConfigured: false,
  }, "");
  await agent.state.tools.find((tool) => tool.name === "observe")!.execute("observe", {});
  const result = await agent.state.tools.find((tool) => tool.name === "build_structure")!
    .execute("build", { placements: [
      { name: "Apple Orchard", x: 620, y: 170 },
      { name: "Hovel", x: 1250, y: 300 },
    ] });
  assert.equal(worldClicks, 2);
  const first = result.content[0];
  assert.ok(first.type === "text");
  assert.deepEqual(JSON.parse(first.text).placements.map((p: any) => p.status), ["rejected", "possibly_rejected"]);
});

test("build_structure reports an invalid target on its own, without stopping the rest of the batch", async () => {
  const actions: unknown[] = [];
  const device = {
    events: new GameEvents(),
    capture: async () => ({
      id: "frame", image: "", mimeType: "image/jpeg", width: 1920, height: 1080, scope: "game-window",
    }),
    action: async (action: unknown) => { actions.push(action); },
    currentStats: () => ({ status: "unavailable", observation: null }),
    // Frames do not age in these tests (GameDevice.frameAge).
    frameAge: () => 0,
  } as unknown as GameDevice;
  const agent = makeAgent(device, () => {}, () => {}, 1, {
    id: "test", name: "test", modelId: "test",
    baseUrl: "https://example.invalid", keyConfigured: false,
  }, "");
  await agent.state.tools.find((tool) => tool.name === "observe")!.execute("observe", {});
  const result = await agent.state.tools.find((tool) => tool.name === "build_structure")!.execute("build", {
    placements: [{ name: "Hovel", x: 500, y: 1000 }, { name: "Hovel", x: 500, y: 400 }],
  });
  const first = result.content[0];
  assert.ok(first.type === "text");
  const report = JSON.parse(first.text);
  assert.equal(report.placements[0].status, "invalid_target");
  assert.match(report.placements[0].reason, /bottom HUD/);
  assert.match(report.placements[0].reason, /below \d+/, "names the pixel boundary");
  assert.equal(report.placements[1].status, "unverified", "the rest of the batch still ran");
  // Nothing was sent for the invalid target; the valid one was placed and placement mode was left there.
  assert.ok(!actions.some((a: any) => a.y === 1000));
  assert.ok(actions.some((a: any) => (a as any).x === 500 && (a as any).y === 400 && (a as any).button === 1));
  assert.deepEqual(actions.at(-1), { type: "click", x: 500, y: 400, button: 3 });
});

test("build_structure sends nothing and leaves placement mode untouched when every target is invalid", async () => {
  const actions: unknown[] = [];
  const device = {
    events: new GameEvents(),
    capture: async () => ({
      id: "frame", image: "", mimeType: "image/jpeg", width: 1920, height: 1080, scope: "game-window",
    }),
    action: async (action: unknown) => { actions.push(action); },
    currentStats: () => ({ status: "unavailable", observation: null }),
    // Frames do not age in these tests (GameDevice.frameAge).
    frameAge: () => 0,
  } as unknown as GameDevice;
  const agent = makeAgent(device, () => {}, () => {}, 1, {
    id: "test", name: "test", modelId: "test",
    baseUrl: "https://example.invalid", keyConfigured: false,
  }, "");
  await agent.state.tools.find((tool) => tool.name === "observe")!.execute("observe", {});
  const result = await agent.state.tools.find((tool) => tool.name === "build_structure")!.execute("build", {
    placements: [{ name: "Hovel", x: 500, y: 1000 }],
  });
  const first = result.content[0];
  assert.ok(first.type === "text");
  const report = JSON.parse(first.text);
  assert.equal(report.placements[0].status, "invalid_target");
  assert.deepEqual(actions, [], "no exit click: placement mode was never entered");
});

/** Simulated game and reader: placement mode, camera, wood and the map-wide structure count. */
type SimState = { action: number; sub: number; wood: number; structures: number; camera: number; worldClicks: number; sel: number | null; messages: { channel: string; text: string }[]; flat: boolean; pointer: { x: number; y: number } | null; moves: number };
function simulatedGame(options: {
  blocked?: (x: number, y: number) => boolean;
  ignoreButtons?: boolean;
  moveCameraAfterWorldClicks?: number;
  unavailableReads?: number[];
  /** Hotkey anchors: the first press selects the building type, the second centres the camera. */
  anchors?: Record<string, { camera: number; type: number }>;
  /** Game feedback text for a terrain click in placement mode (may move the camera). */
  reject?: (x: number, y: number, state: SimState) => string | undefined;
  /** Building type under a click outside placement mode (opens its panel). */
  buildingAt?: (x: number, y: number) => number | undefined;
  /** FlattenLandscape has no visible effect (e.g. the key is unbound). */
  flatIgnored?: boolean;
  /**
   * Native tile layers: ordinary land around the camera centre (tile 99 + camera, 100),
   * edited by this callback. Without it the device has no tile reader.
   */
  tiles?: (set: (layer: keyof TileRegion["layers"], x: number, y: number, v: number) => void, centre: { x: number; y: number }) => void;
  /** A timed run's runtime (cycle, session); without it the agent runs untimed. */
  runtime?: AgentRuntime;
  /** Runs on every construction-menu button click (e.g. to move the camera while selecting). */
  onButton?: (state: SimState) => void;
  /** Whether a click in demolish mode hits one of the player's buildings; the demolish button works unless `demolishIgnored`. */
  demolishable?: (x: number, y: number) => boolean;
  demolishIgnored?: boolean;
  /** The player's building records by engine type, as the reader counts them. */
  buildings?: Record<string, number>;
  /**
   * What a minimap click does: by default it centres the camera on the tile it names (along x only:
   * the simulated camera moves on one axis), except in placement mode, where it does nothing (live
   * 2026-10-12); "ignored" never moves the camera.
   */
  minimap?: "ignored";
  /** The whole map's summary rows (run-length letters, 200 × 200); plain land by default. */
  mapRows?: string[];
  /** The products of the two-product workshop whose panel buildingAt opens (goods numbers). */
  workshop?: { making: number; next: number };
  /**
   * Milliseconds after a right-click that leaves placement mode during which reads still return
   * the sample from before it (captured before the click), as the live reader's can.
   */
  staleAfterExitMs?: number;
  /** Gold and popularity the reader shows, read afresh on every sample (600 and 90 by default). */
  economy?: { gold: number; popularity: number };
  /** Going to a bookmark also ends placement mode (live it keeps it, 2026-10-12). */
  bookmarkLeavesPlacement?: boolean;
  /** Engine building types by instance id in the tile reads (structure_types). */
  structureTypes?: Record<string, number>;
  /** The reader's storage positions and contents (observation.storage). */
  storage?: Record<string, unknown>;
  /** The map tile the game picks under the pointer at a window pixel (observation.mouse_tile); without it the reader has no such field. */
  cursor?: (x: number, y: number, state: SimState) => { x: number; y: number };
  /** A screenshot's age in game seconds (GameDevice.frameAge); 0 by default. */
  frameAge?: () => number;
} = {}) {
  const events = new GameEvents();
  const actions: any[] = [];
  const state: SimState = { action: 0, sub: 52, wood: 100, structures: 18, camera: 1, worldClicks: 0, sel: null, messages: [], flat: false, pointer: null, moves: 0 };
  const buttonIds: Record<string, number> = { "866,978": 54, "872,934": 52, "880,992": 57 };
  for (const [name, id] of [["Stockpile", 52], ["Granary", 80], ["Woodcutter", 57], ["Dairy Farm", 73], ["Dancing Bear", 324], ["Iron Mine", 68], ["Armory", 1011]] as const) {
    const button = (trayClicks({ width: 1920, height: 1080 }, name) as { x: number; y: number }[]).at(-1)!;
    buttonIds[`${button.x},${button.y}`] = id;
  }
  const hotkeys: string[] = [];
  let tileReads = 0;
  // How many inputs had been sent when each tile read started.
  const tileReadsAt: number[] = [];
  const bookmarks = new Map<string, number>();
  const feedback = (text: string) => {
    state.messages = [{ channel: "Panel_Feedback", text }];
    events.ingest({ status: "ok", session: "s", generation: 1, captured_unix_ms: Date.now(),
      events: [{ kind: "visible_message_observed", id: crypto.randomUUID(), channel: "Panel_Feedback", text }] }, Date.now());
  };
  const stats = () => ({
    status: "ok", session: "s", generation: 1,
    captured_unix_ms: Date.now(), valid_until_unix_ms: Date.now() + 1500,
    observation: {
      map_name: "m", visible_messages: state.messages, gold: options.economy?.gold ?? 600, population: 2,
      popularity: options.economy?.popularity ?? 90,
      ...(options.buildings ? { buildings: options.buildings } : {}),
      ...(options.storage ? { storage: options.storage } : {}),
      ...(options.cursor ? { mouse_tile: state.pointer ? options.cursor(state.pointer.x, state.pointer.y, state) : null } : {}),
      resources_by_name: { wood_planks: state.wood },
      structures: { count: state.structures, limit: 3999 },
      placement: { action: state.action, sub_action: state.sub },
      camera: options.tiles
        ? { centre_tile_x: 99 + state.camera, centre_tile_y: 100, tiles_wide: 30, tiles_high: 68, pixels_per_unit_scale: 1 }
        : { centre_tile_x: state.camera, centre_tile_y: 1, tiles_wide: 30, tiles_high: 68, pixels_per_unit_scale: 1 },
      selected_workshop: state.sel !== null && [12, 13, 14].includes(state.sel) && options.workshop ? { id: 15, type: state.sel, ...options.workshop } : null,
      selected_building: state.sel === null ? null : {
        id: 15, type: state.sel, have_stats: state.sel === 3 ? 1 : 0, workers_have: 0, job_vacancies: 1, workers_needed: 1,
        working: 0, turned_off: 0, keep_access: 1, hp: 0, max_hp: 0, no_resources: 0,
      },
    },
  });
  let captures = 0;
  let inputSerial = 0;
  // The screenshot-age credit each input was sent with (Infinity waives the age limit).
  const ageCredits: number[] = [];
  let latest: unknown = null;
  const device = {
    events,
    capture: async () => {
      captures++;
      latest = { id: "frame", image: state.flat ? "flat" : "", mimeType: "image/jpeg", width: 1920, height: 1080, receivedAt: Date.now(), scope: "game-window" };
      return latest;
    },
    get latest() {
      return latest;
    },
    get inputSerial() {
      return inputSerial;
    },
    action: async (action: any, _frameId?: string, _guard?: unknown, ageCreditMs = 0) => {
      inputSerial++;
      actions.push(action);
      ageCredits.push(ageCreditMs);
      if (options.staleAfterExitMs && action.button === 3 && state.action === 5) {
        stale = { ...stats(), captured_unix_ms: Date.now() - 1 };
        staleUntil = Date.now() + options.staleAfterExitMs;
      }
      const id = buttonIds[`${action.x},${action.y}`];
      if (action.type === "click") state.pointer = { x: action.x, y: action.y };
      if (action.button === 1 && action.x >= 1605 && action.x <= 1770 && action.y >= 892 && action.y <= 1056) {
        // The minimap: invert minimapFraction for the simulated 200 × 200 map (anchors.ts).
        if (options.minimap !== "ignored" && state.action !== 5) {
          const c = options.tiles ? { x: 99 + state.camera, y: 100 } : { x: state.camera, y: 1 };
          const axis = (centre: number, f: number, lo: number, hi: number) =>
            Math.min(Math.max(centre - 62.5, lo), hi - 125) + f * 125;
          const u = axis(c.x - c.y, (action.x - 1605) / 165, -199, 199), v = axis(c.x + c.y, (action.y - 892) / 164, 0, 398);
          const x = Math.round((u + v) / 2);
          state.camera = options.tiles ? x - 99 : x;
        }
        return { delivered: true, at: Date.now() };
      }
      if (action.button === 3) { state.action = 0; state.sel = null; }
      else if (state.sel !== null && options.workshop && action.y === 998 && (action.x === 1368 || action.x === 1448)) {
        // A workshop panel's two product buttons (bows/crossbows, swords/maces, spears/pikes).
        const pairs: Record<number, [number, number]> = { 12: [17, 18], 13: [22, 21], 14: [19, 20] };
        options.workshop.next = pairs[state.sel][action.x === 1368 ? 0 : 1];
      } else if (action.x === 1537 && action.y === 1016) { if (!options.demolishIgnored) state.action = 6; }
      else if (state.action === 6 && action.y < 900) { if (options.demolishable?.(action.x, action.y)) state.structures--; }
      else if (id && !options.ignoreButtons) { state.action = 5; state.sub = id; options.onButton?.(state); }
      else if (action.y < 900 && state.action === 5) {
        state.worldClicks++;
        const text = options.reject?.(action.x, action.y, state);
        if (text) feedback(text);
        else if (!options.blocked?.(action.x, action.y)) { state.wood -= 6; state.structures++; }
        if (state.worldClicks === options.moveCameraAfterWorldClicks) state.camera++;
      } else if (action.y < 900) state.sel = options.buildingAt?.(action.x, action.y) ?? state.sel;
      return { delivered: true, at: Date.now() };
    },
    ...(options.tiles ? {
      tiles: async (x0: number, y0: number, w: number, h: number): Promise<TileRegion> => {
        tileReads++;
        tileReadsAt.push(actions.length);
        const layers = Object.fromEntries(["structure", "organism", "logic", "logic2", "height", "occupancy", "walk", "gfx"]
          .map((n) => [n, Array(w * h).fill(n === "logic" ? 0x8000 : n === "height" ? 8 : 0)])) as TileRegion["layers"];
        options.tiles!((layer, x, y, v) => {
          if (x >= x0 && y >= y0 && x < x0 + w && y < y0 + h) layers[layer][(y - y0) * w + (x - x0)] = v;
        }, { x: 99 + state.camera, y: 100 });
        return { x0, y0, w, h, stable: true, layers, ...(options.structureTypes ? { structure_types: options.structureTypes } : {}) };
      },
    } : {}),
    move: async (point: { x: number; y: number }) => {
      state.pointer = { ...point };
      state.moves++;
      // The tile under the pointer shows at once here, so the reply's time lies before the
      // margin Placer.aim waits out after it (no real time passes on a timed runtime's clock).
      return { at: Date.now() - 1000 };
    },
    mapSummary: async () => ({ size: 200, rows: options.mapRows ?? Array.from({ length: 200 }, () => ".200"), bounds: { x0: 0, y0: 0, x1: 199, y1: 199 } }),
    hotkey: async (name: string) => {
      inputSerial++;
      hotkeys.push(name);
      if (name === "FlattenLandscape" && !options.flatIgnored) state.flat = !state.flat;
      const anchor = options.anchors?.[name];
      if (anchor) {
        if (state.sel === anchor.type) state.camera = anchor.camera;
        else state.sel = anchor.type;
      } else if (name.startsWith("SetBookmark")) bookmarks.set(name.slice(11), state.camera);
      else if (name.startsWith("GotoBookmark") && bookmarks.has(name.slice(12))) {
        state.camera = bookmarks.get(name.slice(12))!;
        if (options.bookmarkLeavesPlacement) state.action = 0;
      }
      return { at: Date.now() };
    },
    // A live stream's unavailable sample still carries its capture time.
    currentStats: () => (options.unavailableReads?.includes(++reads) ? { status: "unavailable", captured_unix_ms: Date.now(), observation: null }
      : Date.now() < staleUntil ? stale : stats()),
    // Frames do not age in these tests unless asked (GameDevice.frameAge).
    frameAge: () => options.frameAge?.() ?? 0,
  } as unknown as GameDevice;
  let reads = 0;
  let stale: unknown = null;
  let staleUntil = 0;
  const agent = makeAgent(device, () => {}, () => {}, 1, {
    id: "test", name: "test", modelId: "test", baseUrl: "https://example.invalid", keyConfigured: false,
  }, "", options.runtime);
  const tool = (name: string) => agent.state.tools.find((t) => t.name === name)!;
  const build = async (placements: object[]) => {
    await tool("observe").execute("observe", {});
    const result = await tool("build_structure").execute("build", { placements });
    const first = result.content[0];
    assert.ok(first.type === "text");
    return JSON.parse(first.text);
  };
  const run = async (name: string, args: object = {}) => {
    const result = await tool(name).execute(name, args);
    const text = result.content.find((c) => c.type === "text");
    assert.ok(text && text.type === "text");
    return { json: JSON.parse(text.text), images: result.content.filter((c) => c.type === "image").length };
  };
  return {
    actions, ageCredits, state, build, hotkeys, run, tool, tileReads: () => tileReads, tileReadsAt: () => tileReadsAt,
    observe: () => tool("observe").execute("observe", {}),
    captures: () => captures,
  };
}

test("build_structure confirms placed and silently blocked buildings from reader evidence", async () => {
  const game = simulatedGame({ blocked: (x) => x === 600 });
  const report = await game.build([{ name: "Hovel", x: 500, y: 400 }, { name: "Hovel", x: 600, y: 400, exact: true }]);
  assert.deepEqual(report.placements.map((p: any) => p.status), ["placed", "not_placed"]);
  // The reference cost, not the stock change around the click (arriving goods show in that too).
  assert.equal(report.placements[0].cost, "6 wood");
  assert.equal(report.placements[0].change, undefined);
  assert.equal(report.placements[1].cost, undefined);
});

test("a build_structure call straight after another one selects the same building again", async () => {
  // The reader could still show the first call's placement mode after its exit right-click; the
  // second call read its starting point from that sample and reported not_selected for a building
  // the game had selected (17 placements in 9 back-to-back calls, 1.5.1 to 1.6.3).
  const game = simulatedGame({ staleAfterExitMs: 150 });
  await game.observe();
  const statuses = async (id: string, x: number) => {
    const result = await game.tool("build_structure").execute(id, { placements: [{ name: "Hovel", x, y: 400 }] });
    const first = result.content[0];
    assert.ok(first.type === "text");
    return JSON.parse(first.text).placements.map((p: { status: string }) => p.status);
  };
  assert.deepEqual(await statuses("b1", 500), ["placed"]);
  assert.deepEqual(await statuses("b2", 600), ["placed"]);
});

test("build_structure skips remaining targets when the camera moves", async () => {
  const game = simulatedGame({ moveCameraAfterWorldClicks: 1 });
  const report = await game.build([{ name: "Hovel", x: 500, y: 400 }, { name: "Hovel", x: 600, y: 400 }]);
  assert.deepEqual(report.placements.map((p: any) => p.status), ["placed", "camera_moved"]);
  assert.ok(!game.actions.some((a) => a.x === 600 && a.button === 1), "second target never clicked");
  assert.match(report.note, /camera moved/i);
});

test("build_structure retries an unselected building once and never clicks its target", async () => {
  const game = simulatedGame({ ignoreButtons: true });
  const report = await game.build([{ name: "Hovel", x: 500, y: 400 }]);
  assert.deepEqual(report.placements.map((p: any) => p.status), ["not_selected"]);
  assert.equal(game.actions.filter((a) => a.x === 866 && a.y === 978).length, 2, "building button retried");
  assert.ok(!game.actions.some((a) => a.x === 500 && a.button === 1));
});

test("a transient unavailable reader sample is not a camera move", async () => {
  // Reads 1–2 happen during observe, read 3 is the start check; read 4 is the camera guard's first look.
  const game = simulatedGame({ unavailableReads: [4] });
  const report = await game.build([{ name: "Hovel", x: 500, y: 400 }]);
  assert.deepEqual(report.placements.map((p: any) => p.status), ["placed"]);
});

test("an unavailable sample just before a terrain click does not leave the placement unverified", async () => {
  // One unavailable read anywhere around the click: before waiting for a valid "before" sample,
  // read 8 (the click's) gave `unverified`, which is never retried.
  for (let n = 5; n <= 11; n++) {
    const game = simulatedGame({ unavailableReads: [n] });
    const report = await game.build([{ name: "Hovel", x: 500, y: 400 }]);
    assert.equal(report.placements[0].status, "placed", `unavailable read ${n}`);
  }
});

const worldClicks = (actions: any[]) => actions.filter((a) => a.button === 1 && a.y < 900);
const menuClicks = (actions: any[]) => actions.filter((a) => a.button === 1 && a.y >= 900);

test("build_structure retries a silently blocked target at a nearby spot without reselecting", async () => {
  const game = simulatedGame({ blocked: (x, y) => x === 500 && y === 400 });
  const report = await game.build([{ name: "Hovel", x: 500, y: 400 }]);
  const [placement] = report.placements;
  assert.equal(placement.status, "placed");
  assert.deepEqual(placement.at, { x: 564, y: 432 });
  assert.deepEqual(placement.offsetTiles, [2, 0]);
  assert.equal(placement.retries, 1);
  assert.equal(game.state.structures, 19);
  assert.equal(menuClicks(game.actions).length, 2, "category and building clicked once");
  assert.equal(worldClicks(game.actions).length, 2);
});

test("build_structure places a good thing through the Town page's good-factor subpage", async () => {
  const game = simulatedGame({});
  const report = await game.build([{ name: "Dancing Bear", x: 500, y: 400 }]);
  assert.equal(report.placements[0].status, "placed");
  assert.deepEqual(menuClicks(game.actions).map((a) => [a.x, a.y]), [[999, 1055], [1481, 1006], [1005, 985]]);
});

test("build_structure gives up after one ring of blocked nearby spots", async () => {
  const game = simulatedGame({ blocked: () => true });
  const report = await game.build([{ name: "Hovel", x: 960, y: 500 }]);
  assert.equal(report.placements[0].status, "not_placed");
  assert.equal(report.placements[0].retries, 6);
  assert.equal(report.placements[0].at, undefined);
  assert.equal(worldClicks(game.actions).length, 7);
  assert.equal(game.state.structures, 18);
});

test("build_structure does not retry exact placements", async () => {
  const game = simulatedGame({ blocked: () => true });
  const report = await game.build([{ name: "Hovel", x: 960, y: 500, exact: true }]);
  assert.equal(report.placements[0].status, "not_placed");
  assert.equal(report.placements[0].retries, undefined);
  assert.equal(worldClicks(game.actions).length, 1);
});

test("build_structure retries keep clear of later targets in the batch", async () => {
  const game = simulatedGame({ blocked: (x, y) => x === 960 && y === 500 });
  const report = await game.build([{ name: "Hovel", x: 960, y: 500 }, { name: "Hovel", x: 1024, y: 532 }]);
  assert.deepEqual(report.placements.map((p: any) => p.status), ["placed", "placed"]);
  // The first ring spot (1024, 532) is the second target, so the retry went the other way.
  assert.deepEqual(report.placements[0].at, { x: 896, y: 468 });
  assert.equal(report.placements[1].at, undefined);
});

test("build_structure stops retrying when the camera moves", async () => {
  const game = simulatedGame({ blocked: () => true, moveCameraAfterWorldClicks: 1 });
  const report = await game.build([{ name: "Hovel", x: 960, y: 500 }]);
  assert.equal(report.placements[0].status, "not_placed");
  assert.equal(report.placements[0].retryStopped, "camera_moved");
  assert.equal(worldClicks(game.actions).length, 1, "no clicks from the old view");
  assert.match(report.note, /camera moved/i);
});

test("an unavailable sample at observe time still records the camera for retries", async () => {
  // Read 1 is observe's camera lookup; it waits for the next valid sample (live 2026-09-28 gap).
  const game = simulatedGame({ blocked: (x, y) => x === 500 && y === 400, unavailableReads: [1] });
  const report = await game.build([{ name: "Hovel", x: 500, y: 400 }]);
  assert.equal(report.placements[0].status, "placed");
  assert.equal(report.placements[0].retries, 1);
});

test("build_structure caps nearby retries per call", async () => {
  const game = simulatedGame({ blocked: () => true });
  // 6 a placement and 24 a call: four blocked hovels take them all, the fifth is clicked once.
  const report = await game.build([
    { name: "Hovel", x: 400, y: 300 }, { name: "Hovel", x: 1200, y: 300 }, { name: "Hovel", x: 800, y: 700 },
    { name: "Hovel", x: 400, y: 600 }, { name: "Hovel", x: 1200, y: 600 },
  ]);
  assert.deepEqual(report.placements.map((p: any) => p.retries), [6, 6, 6, 6, undefined]);
  assert.equal(worldClicks(game.actions).length, 29);
});

test("center_on uses the game's select-then-centre hotkey and closes the panel", async () => {
  const game = simulatedGame({ anchors: { Granary: { camera: 20, type: 19 } } });
  await game.observe();
  const { json, images } = await game.run("center_on", { target: "granary" });
  assert.equal(json.status, "centred");
  assert.deepEqual(game.hotkeys, ["Granary", "Granary"]);
  assert.equal(game.state.camera, 20);
  assert.equal(game.state.sel, null, "panel closed by a right-click");
  assert.equal(images, 1, "a fresh screenshot of the new view");
  // observe() once, then observe() again for the returned screenshot: centerOn and its right-click
  // dismiss send with the first one instead of capturing their own.
  assert.equal(game.captures(), 2);
});

test("center_on reports a missing building without moving the camera", async () => {
  const game = simulatedGame();
  await game.observe();
  const { json } = await game.run("center_on", { target: "market" });
  assert.equal(json.status, "not_found");
  assert.equal(game.state.camera, 1);
});

test("saved views return the camera through game bookmarks", async () => {
  const game = simulatedGame({ anchors: { HomeKeep: { camera: 30, type: 41 } } });
  await game.observe();
  assert.deepEqual((await game.run("save_view", { name: "Home" })).json.views, ["home"]);
  await game.run("center_on", { target: "keep" });
  assert.equal(game.state.camera, 30);
  const back = await game.run("go_to_view", { name: "home" });
  assert.equal(game.state.camera, 1);
  assert.equal(back.images, 1);
  assert.deepEqual(game.hotkeys.filter((h) => h.includes("Bookmark")), ["SetBookmark1", "GotoBookmark1"]);
});

test("expand_storage locates the stockpile by a rejected click, then probes outward until one fits", async () => {
  const STOCK = 7;
  const fits = tilePixel({ width: 1920, height: 1080 }, { tiles_wide: 30, tiles_high: 68 }, 5, 0);
  const game = simulatedGame({
    // Away from the stockpile the game rejects the click and shows the existing stockpile.
    reject: (_x, _y, state) => {
      if (state.camera === STOCK) return undefined;
      state.camera = STOCK;
      return "Needs to be placed adjacent to the stockpile.";
    },
    blocked: (x, y) => !(x === fits.x && y === fits.y),
  });
  await game.observe();
  const { json } = await game.run("expand_storage", { kind: "stockpile" });
  assert.equal(json.status, "placed", JSON.stringify(json));
  assert.deepEqual(json.placed.map((p: any) => [p.x, p.y, p.side, p.tilesOut]), [[fits.x, fits.y, "down-right", 5]]);
  // Two 5-tile stockpiles touch at 5 tiles apart; the search starts one tile inside that.
  assert.equal(json.probes, 2, "tile 4 blocked, tile 5 placed");
  assert.ok(game.hotkeys.includes("SetBookmark0"), "the located stockpile view is bookmarked");
  assert.equal(game.state.action, 0, "placement mode left");
  // observe() once, and its frame serves centerOnStockpile's locating clicks and the probes that
  // follow: no capture just to send another click or dismiss the panel.
  assert.equal(game.captures(), 1);
});

test("inspect_building reads the opened panel and closes it", async () => {
  // A timed runtime's waits return at once: a click that opens nothing waits 4 s for a panel, twice.
  const game = simulatedGame({ buildingAt: (x, y) => (x === 700 && y === 500 ? 3 : undefined), runtime: timedRuntime().runtime });
  await game.observe();
  const { json } = await game.run("inspect_building", { x: 700, y: 500 });
  assert.equal(json.building.name, "Woodcutter's Hut");
  assert.deepEqual(json.building.workers, { have: 0, needed: 1, vacancies: 1 });
  assert.equal(game.state.sel, null);
  const empty = await game.run("inspect_building", { x: 300, y: 300 });
  assert.equal(empty.json.building, null);
  assert.match(empty.json.remedy, /give a tile of its footprint/);
  // Over the HUD: a status with a remedy, nothing clicked.
  const clicks = game.actions.length;
  const hud = await game.run("inspect_building", { x: 300, y: 1000 });
  assert.equal(hud.json.status, "invalid_target");
  assert.equal(game.actions.length, clicks);
});

/** Simulated tile layers with one building instance (`id`) on the 4×4 footprint x 99–102, y 99–102. */
const oneBuilding = (id: number) => (set: (layer: keyof TileRegion["layers"], x: number, y: number, v: number) => void) => {
  for (let x = 99; x <= 102; x++) for (let y = 99; y <= 102; y++) set("structure", x, y, id);
};

test("inspect_building takes a map tile, with no screenshot, and clicks the middle of the building on it", async () => {
  // The simulated reader names every open panel instance 15.
  const game = simulatedGame({ tiles: oneBuilding(15), buildingAt: () => 3 });
  const { json, images } = await game.run("inspect_building", { tile_x: 100, tile_y: 101 });
  assert.equal(images, 0);
  assert.equal(json.tile_x, 100);
  assert.equal(json.building.name, "Woodcutter's Hut", JSON.stringify(json));
  assert.ok(!("warning" in json));
  assert.deepEqual(game.actions.map((a) => a.button), [1, 3], "one click on the building, one to close its panel");
  assert.equal(game.captures(), 1, "one bookkeeping capture; no screenshot was ever taken");
});

test("a building drawn over the target: inspect_building says the panel is the one in front, set_workshop leaves it alone", async () => {
  // The tile map shows instance 20 on the tile, but every click opens instance 15, the building in
  // front: the middle, the back corner and the roof are each tried (Muse Wonder's fletchers behind
  // an armory, 1.6.3).
  const inspect = simulatedGame({ tiles: oneBuilding(20), buildingAt: () => 11 });
  const { json } = await inspect.run("inspect_building", { tile_x: 100, tile_y: 100 });
  assert.equal(json.building.name, "Armory", JSON.stringify(json));
  assert.match(json.warning, /^This is the panel of the Armory drawn in front of the building on that tile/);
  const left = inspect.actions.filter((a) => a.button === 1).length;
  assert.equal(left, 3, "the middle, the back corner and the roof");
  // A workshop in front of a workshop: its product stays as it was.
  const workshop = { making: 17, next: 17 };
  const set = simulatedGame({ tiles: oneBuilding(20), buildingAt: () => 12, workshop });
  const { json: refused } = await set.run("set_workshop", { product: "crossbows", tile_x: 100, tile_y: 100 });
  assert.equal(refused.status, "not_a_workshop", JSON.stringify(refused));
  assert.equal(refused.opened, "Fletchers' Workshop");
  assert.match(refused.reason, /drawn over this one/);
  assert.equal(workshop.next, 17, "no product button was pressed");
  // The workshop's own panel is set as before.
  const own = simulatedGame({ tiles: oneBuilding(15), buildingAt: () => 12, workshop: { making: 17, next: 17 } });
  const { json: done } = await own.run("set_workshop", { product: "crossbows", tile_x: 100, tile_y: 100 });
  assert.equal(done.status, "set", JSON.stringify(done));
});

test("status summarises the reader without a screenshot or input", async () => {
  const game = simulatedGame();
  const { json, images } = await game.run("status");
  assert.equal(json.status, "ok");
  assert.equal(json.placement_mode, "none");
  assert.equal(images, 0);
  assert.equal(game.actions.length, 0);
});

test("timed runs refuse Escape and P before sending input", async () => {
  const actions: unknown[] = [];
  const device = {
    events: new GameEvents(),
    capture: async () => ({ id: "frame", image: "", mimeType: "image/jpeg", width: 1920, height: 1080, scope: "game-window" }),
    action: async (action: unknown) => { actions.push(action); return { delivered: true }; },
    currentStats: () => ({ status: "unavailable", observation: null }),
    // Frames do not age in these tests (GameDevice.frameAge).
    frameAge: () => 0,
  } as unknown as GameDevice;
  const runtime = {
    session: { check() {}, wait: async () => {}, gameBudgetSeconds: 600, gameRemainingSeconds: () => 600, remaining: () => 60000 },
    cycle: { observe() {}, action() {}, actions: 0 },
    memory: { delivery() {} },
    config: { contextBudget: 120000 },
    phase() {}, changed() {}, timing() {},
  } as unknown as AgentRuntime;
  const agent = makeAgent(device, () => {}, () => {}, 1, {
    id: "test", name: "test", modelId: "test", baseUrl: "https://example.invalid", keyConfigured: false,
  }, "", runtime);
  const tool = (name: string) => agent.state.tools.find((t) => t.name === name)!;
  await tool("observe").execute("observe", {});
  await assert.rejects(tool("game_action").execute("esc", { type: "key", key: "Escape" }), /right-click/);
  await assert.rejects(tool("game_action").execute("p", { type: "key", key: "P" }), /owns pause/);
  assert.deepEqual(actions, []);
});

test("flat_view toggles the flattened landscape on, captures it and toggles it back", async () => {
  const game = simulatedGame();
  const { json, images } = await game.run("flat_view");
  assert.equal(json.status, "ok");
  assert.equal(images, 2, "flat image, then the normal targeting frame");
  assert.deepEqual(game.hotkeys, ["FlattenLandscape", "FlattenLandscape"]);
  assert.equal(game.state.flat, false);
});

test("flat_view presses once and reports when the view does not change", async () => {
  const game = simulatedGame({ flatIgnored: true });
  const { json, images } = await game.run("flat_view");
  assert.equal(json.status, "unchanged");
  assert.equal(images, 1);
  assert.deepEqual(game.hotkeys, ["FlattenLandscape"]);
});

/** find_sites' sites, which come grouped by the ground under them, as one list. */
const allSites = (json: { sites?: Record<string, unknown[]> }): any[] => Object.values(json.sites ?? {}).flat();

// Pixel/tile mapping for the tile-enabled simulator (camera centre tile 99 + camera, 100).
const tileView = (camera = 1) => new TileMap(
  { x0: 0, y0: 0, w: 0, h: 0, stable: true, layers: {} as TileRegion["layers"] },
  { centre_tile_x: 99 + camera, centre_tile_y: 100, tiles_wide: 30, tiles_high: 68 },
  { width: 1920, height: 1080 },
);
const disjoint = (a: ReturnType<typeof footprintRect>, b: ReturnType<typeof footprintRect>) =>
  a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1;

test("build_structure moves a silently blocked target to the nearest spot the tile map shows free", async () => {
  const view = tileView();
  const target = view.pixel({ x: 100, y: 100 });
  const trees = { x1: 97, y1: 97, x2: 103, y2: 103 };
  const game = simulatedGame({
    tiles: (set) => { for (let x = trees.x1; x <= trees.x2; x++) for (let y = trees.y1; y <= trees.y2; y++) set("organism", x, y, 1); },
    blocked: (x, y) => x === target.x && y === target.y,
  });
  const report = await game.build([{ name: "Hovel", ...target }]);
  const p = report.placements[0];
  assert.equal(p.status, "placed", JSON.stringify(p));
  assert.equal(p.retryMethod, "tile_map");
  assert.equal(p.retries, 1, "the first computed spot is free");
  assert.ok(disjoint(footprintRect(view.tileAt(p.at), 4), trees));
  assert.equal(game.tileReads(), 1);
  assert.equal(p.moved, `The target was blocked, so it was placed 5 tiles away, at tile (${p.tile.x}, ${p.tile.y}).`);
});

test("a blocked target is moved only within reach of it; past that it names the nearest spot that fits", async () => {
  // Trees over 95..105 leave a hovel (4×4, reach 5) no free spot within 5 tiles of tile 100.
  // The search had reached 12 tiles: a 4-tile workshop went 10 tiles off (Kimi K3, 1.7.1).
  const view = tileView();
  const target = view.pixel({ x: 100, y: 100 });
  const trees = { x1: 95, y1: 95, x2: 105, y2: 105 };
  const game = simulatedGame({
    tiles: (set) => { for (let x = trees.x1; x <= trees.x2; x++) for (let y = trees.y1; y <= trees.y2; y++) set("organism", x, y, 1); },
    blocked: (x, y) => x === target.x && y === target.y,
  });
  const p = (await game.build([{ name: "Hovel", ...target }])).placements[0];
  assert.equal(p.status, "not_placed", JSON.stringify(p));
  assert.equal(p.reach, 5);
  const away = Math.max(Math.abs(p.nearestFit.offsetTiles[0]), Math.abs(p.nearestFit.offsetTiles[1]));
  assert.ok(away > 5, JSON.stringify(p.nearestFit));
  assert.ok(disjoint(footprintRect(p.nearestFit.tile, 4), trees));
  assert.equal(p.remedy, `Nothing fits within 5 tiles of that spot. The nearest spot where it fits is tile (${p.nearestFit.tile.x}, ${p.nearestFit.tile.y}), ${away} tiles away: place it there by tile_x/tile_y if that suits, or find_sites (building "Hovel") lists others.`);
  assert.equal(p.retries, undefined, "no spot past reach is tried");
});

test("a farm refused for its ground is retried on oasis grass from the tile map", async () => {
  const view = tileView();
  const target = view.pixel({ x: 100, y: 100 });
  const game = simulatedGame({
    tiles: (set) => { for (let x = 104; x <= 116; x++) for (let y = 94; y <= 106; y++) set("logic2", x, y, 16); },
    reject: (x, y) => (x === target.x && y === target.y ? "Farms must be placed on an oasis." : undefined),
  });
  const report = await game.build([{ name: "Dairy Farm", ...target }]);
  const p = report.placements[0];
  assert.equal(p.status, "placed", JSON.stringify(p));
  assert.equal(p.retryMethod, "tile_map");
  const r = footprintRect(view.tileAt(p.at), 10);
  assert.ok(r.x1 >= 104 && r.x2 <= 116 && r.y1 >= 94 && r.y2 <= 106, "the whole farm is on the oasis");
});

test("an iron mine refused for its ground is retried on ore from the tile map", async () => {
  const view = tileView();
  const target = view.pixel({ x: 100, y: 100 });
  // Ore fills a wide area around the target, so any nearby retry still lands on it.
  const ore = { x1: 85, y1: 85, x2: 115, y2: 115 };
  const game = simulatedGame({
    // 0x80000: the ORE bit (tile-map.ts resourceGround), replacing the default buildable land.
    tiles: (set) => { for (let x = ore.x1; x <= ore.x2; x++) for (let y = ore.y1; y <= ore.y2; y++) set("logic", x, y, 0x80000); },
    reject: (x, y) => (x === target.x && y === target.y ? "Iron mine must be built on Iron ore." : undefined),
  });
  const report = await game.build([{ name: "Iron Mine", ...target }]);
  const p = report.placements[0];
  assert.equal(p.status, "placed", JSON.stringify(p));
  assert.equal(p.retryMethod, "tile_map");
  assert.notDeepEqual(p.at, { x: target.x, y: target.y });
  const r = footprintRect(view.tileAt(p.at), 4);
  assert.ok(r.x1 >= ore.x1 && r.x2 <= ore.x2 && r.y1 >= ore.y1 && r.y2 <= ore.y2, "the whole iron mine footprint is on ore");
});

test("build_structure moves a workplace that would have no open side, without clicking its target", async () => {
  const view = tileView();
  const target = view.pixel({ x: 100, y: 100 });
  // A woodcutter (3×3) on tile 100 covers 99..101; bushes on all four sides close it in.
  const ring = (set: (layer: keyof TileRegion["layers"], x: number, y: number, v: number) => void) => {
    for (let i = 99; i <= 101; i++) {
      set("organism", 98, i, 1); set("organism", 102, i, 1); set("organism", i, 98, 1); set("organism", i, 102, 1);
    }
  };
  const game = simulatedGame({ tiles: ring });
  const report = await game.build([{ name: "Woodcutter", ...target }]);
  const p = report.placements[0];
  assert.equal(p.status, "placed", JSON.stringify(p));
  assert.equal(p.access, "no_open_side");
  assert.equal(p.retryMethod, "tile_map");
  assert.notDeepEqual(p.at, { x: target.x, y: target.y });
  assert.ok(!game.actions.some((a) => a.button === 1 && a.x === target.x && a.y === target.y), "the closed-in target is never clicked");
  assert.equal(game.tileReads(), 1, "the map read at observe time is reused");
  // exact: true places it as asked and warns.
  const exact = simulatedGame({ tiles: ring });
  const [e] = (await exact.build([{ name: "Woodcutter", ...target, exact: true }])).placements;
  assert.equal(e.status, "placed");
  assert.equal(e.access, "no_open_side");
  assert.equal(e.at, undefined);
});

test("find_sites lists non-overlapping fitting spots with the farm's oasis share", async () => {
  const game = simulatedGame({
    tiles: (set) => { for (let x = 100; x <= 121; x++) for (let y = 95; y <= 106; y++) set("logic2", x, y, -128); },
  });
  await game.observe();
  const { json, images } = await game.run("find_sites", { building: "Dairy Farm", count: 2 });
  assert.equal(images, 0);
  assert.equal(allSites(json).length, 2, JSON.stringify(json));
  assert.ok(allSites(json).every((s: any) => s.oasisShare === 1));
  const view = tileView();
  const [a, b] = allSites(json).map((s: any) => footprintRect(view.tileAt(s), 10));
  assert.ok(disjoint(a, b));
});

test("place_near clicks computed flush spots beside the anchor when the tile map is available", async () => {
  const game = simulatedGame({
    anchors: { HomeKeep: { camera: 5, type: 41 } },
    // A 7×7 keep centred on the camera once centred on it.
    tiles: (set, c) => { for (let x = c.x - 3; x <= c.x + 3; x++) for (let y = c.y - 3; y <= c.y + 3; y++) set("structure", x, y, 4); },
  });
  await game.observe();
  const { json } = await game.run("place_near", { building: "Hovel", anchor: "keep", count: 2, side: "down-left" });
  assert.equal(json.method, "tile_map", JSON.stringify(json));
  assert.equal(json.status, "placed");
  assert.equal(json.probes, 2, "one click per hovel");
  assert.deepEqual(json.placed.map((p: any) => p.side), ["down-left", "down-left"]);
  const view = tileView(5);
  const keep = { x1: 101, y1: 97, x2: 107, y2: 103 };
  for (const p of json.placed) {
    const r = footprintRect(view.tileAt(p), 4);
    assert.equal(r.y1, keep.y2 + 1, "flush against the keep's +y side");
    assert.ok(disjoint(r, keep));
  }
  // observe() once, and its frame serves centerOn and the probes that follow it.
  assert.equal(game.captures(), 1);
  // place_near's tile read (after the observation's own) started before the building was selected,
  // so it ran during the menu clicks.
  assert.equal(game.tileReadsAt().length, 2);
  assert.equal(menuClicks(game.actions.slice(0, game.tileReadsAt()[1])).length, 0);
  assert.ok(menuClicks(game.actions).length > 0);
});

test("a tool that leaves the screenshot unusable is named in the next 'Observe the game first' error", async () => {
  const game = simulatedGame({
    anchors: { HomeKeep: { camera: 5, type: 41 } },
    tiles: (set, c) => { for (let x = c.x - 3; x <= c.x + 3; x++) for (let y = c.y - 3; y <= c.y + 3; y++) set("structure", x, y, 4); },
  });
  await game.observe();
  // place_near returns text only and clears the screenshot; it does not observe again.
  await game.run("place_near", { building: "Hovel", anchor: "keep", count: 1 });
  await assert.rejects(
    game.run("build_structure", { placements: [{ name: "Hovel", x: 500, y: 400 }] }),
    /Observe the game first: place_near returned no screenshot\./,
  );
});

test("a free target that fails is retried elsewhere when affordable, and reported when short of wood", async () => {
  const target = tileView().pixel({ x: 100, y: 100 });
  // The ground is free, but the click places nothing: an unmodelled rule (e.g. near the signpost).
  const game = simulatedGame({ tiles: () => {}, blocked: (x, y) => x === target.x && y === target.y });
  const p = (await game.build([{ name: "Hovel", ...target }])).placements[0];
  assert.equal(p.status, "placed", JSON.stringify(p));
  assert.equal(p.retryMethod, "tile_map");
  assert.notDeepEqual(p.at, { x: target.x, y: target.y });
  // With too little wood (a hovel costs 6), checked from the reader before the first click,
  // the harness clicks nothing and says what is missing.
  const poor = simulatedGame({ tiles: () => {}, blocked: (x, y) => x === target.x && y === target.y });
  poor.state.wood = 2;
  const q = (await poor.build([{ name: "Hovel", ...target }])).placements[0];
  assert.equal(q.status, "not_placed");
  assert.equal(q.retrySkipped, "not_enough_resources");
  assert.deepEqual(q.missing, { wood: 4 });
  assert.equal(worldClicks(poor.actions).length, 0, "the shortfall was known before any click");
});

test("build_structure re-checks affordability after an earlier placement in the same batch", async () => {
  // Far enough apart that the second target's footprint does not overlap the first hovel.
  const game = simulatedGame({ tiles: () => {} });
  game.state.wood = 8;
  const report = await game.build([{ name: "Hovel", x: 500, y: 400 }, { name: "Hovel", x: 1400, y: 800 }]);
  assert.equal(report.placements[0].status, "placed", JSON.stringify(report.placements));
  assert.equal(game.state.wood, 2, "the first hovel's cost left the stock");
  assert.equal(report.placements[1].status, "not_placed");
  assert.equal(report.placements[1].retrySkipped, "not_enough_resources");
  assert.deepEqual(report.placements[1].missing, { wood: 4 });
  assert.equal(worldClicks(game.actions).length, 1, "only the affordable placement was clicked");
});

test("place_near moves on past a spot refused by a rule the tile map does not model", async () => {
  const game = simulatedGame({
    anchors: { HomeKeep: { camera: 5, type: 41 } },
    tiles: (set, c) => { for (let x = c.x - 3; x <= c.x + 3; x++) for (let y = c.y - 3; y <= c.y + 3; y++) set("structure", x, y, 4); },
    reject: (_x, _y, state) => (state.worldClicks === 1 ? "Too close to signpost to build." : undefined),
  });
  await game.observe();
  const { json } = await game.run("place_near", { building: "Hovel", anchor: "keep", count: 2 });
  assert.equal(json.status, "placed", JSON.stringify(json));
  assert.equal(json.probes, 3, "one refused spot, then two placements");
  assert.deepEqual(json.feedback, ["Too close to signpost to build."]);
  // Out of wood: no click at all.
  const poor = simulatedGame({
    anchors: { HomeKeep: { camera: 5, type: 41 } },
    tiles: (set, c) => { for (let x = c.x - 3; x <= c.x + 3; x++) for (let y = c.y - 3; y <= c.y + 3; y++) set("structure", x, y, 4); },
  });
  poor.state.wood = 3;
  await poor.observe();
  const r = (await poor.run("place_near", { building: "Hovel", anchor: "keep", count: 1 })).json;
  assert.equal(r.stopped, "not_enough_resources");
  assert.deepEqual(r.missing, { wood: 3 });
  assert.equal(r.probes, 0);
});

test("place_near aims each flush spot through the live camera, not the map's", async () => {
  // The view moves a tile while the building is selected, after the map was read; clicking the
  // map's pixels would land a tile off (Kimi K3's stockpile, 2026-10-12).
  const game = simulatedGame({
    anchors: { HomeKeep: { camera: 5, type: 41 } },
    tiles: (set, c) => { for (let x = c.x - 3; x <= c.x + 3; x++) for (let y = c.y - 3; y <= c.y + 3; y++) set("structure", x, y, 4); },
    onButton: (state) => { if (state.camera === 5) state.camera = 6; },
  });
  await game.observe();
  const { json } = await game.run("place_near", { building: "Hovel", anchor: "keep", count: 1, side: "down-left" });
  assert.equal(json.status, "placed", JSON.stringify(json));
  const keep = { x1: 101, y1: 97, x2: 107, y2: 103 };
  // The map's spot, centred on the keep's side: through the view the click landed in, it is the
  // same tiles (a click on the map's pixels would land one tile to the -x side).
  const r = footprintRect(tileView(6).tileAt(json.placed[0]), 4);
  assert.deepEqual(r, { x1: 102, y1: keep.y2 + 1, x2: 105, y2: keep.y2 + 4 });
});

test("place_near probes the view when every spot the map gave is refused without a word", async () => {
  // Trees everywhere but one hovel spot flush against the keep, which the game refuses silently.
  const view = tileView(5);
  const spot = { x1: 103, y1: 104, x2: 106, y2: 107 };
  let mapPixel: { x: number; y: number } | undefined;
  const game = simulatedGame({
    anchors: { HomeKeep: { camera: 5, type: 41 } },
    tiles: (set, c) => {
      for (let x = c.x - 20; x <= c.x + 20; x++) for (let y = c.y - 20; y <= c.y + 20; y++) {
        const inKeep = Math.abs(x - c.x) <= 3 && Math.abs(y - c.y) <= 3;
        const inSpot = x >= spot.x1 && x <= spot.x2 && y >= spot.y1 && y <= spot.y2;
        set(inKeep ? "structure" : "organism", x, y, inKeep ? 4 : inSpot ? 0 : 1);
      }
    },
    blocked: (x, y) => {
      mapPixel ??= { x, y };
      return x === mapPixel.x && y === mapPixel.y;
    },
  });
  await game.observe();
  const { json } = await game.run("place_near", { building: "Hovel", anchor: "keep", count: 1, side: "down-left" });
  assert.equal(json.method, "tile_map_then_probing", JSON.stringify(json));
  assert.equal(json.status, "placed");
  assert.ok(json.probes >= 2, "the map's spot, then at least one probe");
  assert.deepEqual(footprintRect(view.tileAt(mapPixel!), 4), spot, "the first click was the map's only spot");
});

test("place_near puts the first Armory against the keep from the tile map, with no armory to touch", async () => {
  // Storage must touch its kind only once one stands; the first armory used to find nothing to touch
  // and fall back to probing (Claude Haiku 5.5, 2026-10-13).
  const game = simulatedGame({
    anchors: { HomeKeep: { camera: 5, type: 41 } },
    tiles: (set, c) => { for (let x = c.x - 3; x <= c.x + 3; x++) for (let y = c.y - 3; y <= c.y + 3; y++) set("structure", x, y, 4); },
  });
  await game.observe();
  const { json } = await game.run("place_near", { building: "Armory", anchor: "keep", count: 1, side: "down-left" });
  assert.equal(json.method, "tile_map", JSON.stringify(json));
  assert.equal(json.status, "placed");
  assert.equal(json.probes, 1, "one click, no probing");
  const keep = { x1: 101, y1: 97, x2: 107, y2: 103 };
  assert.ok(disjoint(footprintRect(tileView(5).tileAt(json.placed[0]), 4), keep));
});

test("expand_storage goes back to the anchor's view when choosing the building moved the view", async () => {
  // Choosing an Armory, Granary or Stockpile centres the view on the first one (live 2026-10-12); it
  // stopped GPT-6.1 Sol's expand_storage with camera_moved before any spot was tried (1.6.3).
  const armory = (set: (layer: keyof TileRegion["layers"], x: number, y: number, v: number) => void, c: { x: number; y: number }) => {
    for (let x = c.x - 2; x <= c.x + 1; x++) for (let y = c.y - 2; y <= c.y + 1; y++) set("structure", x, y, 4);
  };
  const game = simulatedGame({ anchors: { Armoury: { camera: 5, type: 11 } }, tiles: armory, onButton: (state) => { state.camera += 40; } });
  await game.observe();
  const { json } = await game.run("expand_storage", { kind: "armory", count: 1 });
  assert.equal(json.status, "placed", JSON.stringify(json));
  assert.deepEqual(game.hotkeys.filter((h) => h.includes("Bookmark")), ["SetBookmark9", "GotoBookmark9"]);
  assert.equal(game.state.camera, 5, "placed from the anchor's view");
  // A view that does not come back (the bookmark leaves placement mode, say) still stops the call.
  const lost = simulatedGame({ anchors: { Armoury: { camera: 5, type: 11 } }, tiles: armory, onButton: (state) => { state.camera += 40; }, bookmarkLeavesPlacement: true });
  await lost.observe();
  const { json: stopped } = await lost.run("expand_storage", { kind: "armory", count: 1 });
  assert.equal(stopped.stopped, "camera_moved", JSON.stringify(stopped));
  assert.equal(stopped.probes, 0);
  // A building that does not move the view sets no bookmark.
  const hovel = simulatedGame({ anchors: { HomeKeep: { camera: 5, type: 41 } }, tiles: armory });
  await hovel.observe();
  await hovel.run("place_near", { building: "Hovel", anchor: "keep", count: 1 });
  assert.ok(!hovel.hotkeys.some((h) => h.includes("Bookmark9")));
});

test("place_near refuses a Granary against another anchor while one stands, before any input", async () => {
  // Choosing it centres the view on the first granary (GLM 5.3 Flash against the keep, 2026-10-12).
  const game = simulatedGame({ buildings: { "19": 1 }, anchors: { HomeKeep: { camera: 5, type: 41 } } });
  await game.observe();
  const { json } = await game.run("place_near", { building: "Granary", anchor: "keep" });
  assert.equal(json.stopped, "view_jumps", JSON.stringify(json));
  assert.match(json.remedy, /expand_storage \(kind granary\)/);
  assert.equal(game.actions.length + game.hotkeys.length, 0);
});

test("a second Marketplace is refused before the menu, which would move the view to the first", async () => {
  const game = simulatedGame({ buildings: { "26": 1 } });
  const report = await game.build([{ name: "Marketplace", x: 900, y: 400 }]);
  assert.equal(report.placements[0].status, "already_built", JSON.stringify(report));
  assert.match(report.placements[0].remedy, /market_trade uses it/);
  assert.equal(game.actions.length, 0, "nothing is clicked, not even the menu");
  const near = simulatedGame({ buildings: { "26": 1 }, anchors: { HomeKeep: { camera: 5, type: 41 } } });
  await near.observe();
  const { json } = await near.run("place_near", { building: "Marketplace", anchor: "keep" });
  assert.equal(json.stopped, "already_built");
  assert.equal(near.actions.length + near.hotkeys.length, 0);
});

test("build_structure leaves placement mode with an on-screen right-click when selecting moved the view", async () => {
  const game = simulatedGame({
    tiles: () => {},
    onButton: (state) => { state.camera += 40; },
  });
  const [p] = (await game.build([{ name: "Hovel", tile_x: 101, tile_y: 100 }])).placements;
  assert.equal(p.status, "not_on_screen", JSON.stringify(p));
  assert.match(p.reason, /moved the view away/);
  const exit = game.actions.at(-1);
  assert.equal(exit.button, 3);
  assert.ok(exit.x >= 0 && exit.x < 1920 && exit.y >= 0 && exit.y < 1080, JSON.stringify(exit));
});

// --- Tile targeting (find_sites and build_structure work without an observed screenshot) ---

test("find_sites works without any observation, from the live camera alone", async () => {
  const game = simulatedGame({
    tiles: (set) => { for (let x = 100; x <= 121; x++) for (let y = 95; y <= 106; y++) set("logic2", x, y, -128); },
  });
  const { json, images } = await game.run("find_sites", { building: "Dairy Farm", count: 2 });
  assert.equal(images, 0);
  assert.equal(allSites(json).length, 2, JSON.stringify(json));
  // Tiles only: no screenshot shows this view, so there are no pixels to give.
  assert.ok(allSites(json).every((s: any) => typeof s.tile_x === "number" && typeof s.tile_y === "number" && s.x === undefined && s.y === undefined));
  assert.match(json.note, /no x\/y/);
  const [a, b] = allSites(json).map((s: any) => footprintRect({ x: s.tile_x, y: s.tile_y }, 10));
  assert.ok(disjoint(a, b));
  assert.equal(game.captures(), 1, "one bookkeeping capture for the window size; no screenshot was ever taken");
});

test("find_sites gives pixels too while the latest screenshot shows the live view, and tiles only once the camera moved", async () => {
  const game = simulatedGame({
    tiles: (set, centre) => { for (let x = centre.x - 15; x <= centre.x + 15; x++) for (let y = 95; y <= 106; y++) set("logic2", x, y, -128); },
  });
  await game.observe();
  const seen = await game.run("find_sites", { building: "Dairy Farm", count: 1 });
  const site = allSites(seen.json)[0];
  // The pixel matches the tile through the screenshot's camera.
  assert.deepEqual(tileView().pixel({ x: site.tile_x, y: site.tile_y }), { x: site.x, y: site.y });
  game.state.camera = 2; // the view moves after the screenshot
  const moved = await game.run("find_sites", { building: "Dairy Farm", count: 1 });
  assert.equal(allSites(moved.json).length, 1, JSON.stringify(moved.json));
  assert.equal(allSites(moved.json)[0].x, undefined, "no pixels: the screenshot shows another view");
  assert.equal(game.captures(), 1, "the screenshot's capture only");
});

/** Iron ore at x 170–180, y 95–105: in the tile layers and as "I" in the map summary. */
const oreOutOfView = {
  tiles: (set: (layer: keyof TileRegion["layers"], x: number, y: number, v: number) => void) => {
    for (let x = 170; x <= 180; x++) for (let y = 95; y <= 105; y++) set("logic", x, y, 0x80000);
  },
  mapRows: Array.from({ length: 200 }, (_, y) => (y >= 95 && y <= 105 ? ".170I11.19" : ".200")),
};

test("find_sites searches around a map tile anywhere on the map, without moving the camera", async () => {
  const game = simulatedGame(oreOutOfView);
  await game.observe();
  const { json } = await game.run("find_sites", { building: "Iron Mine", tile_x: 175, tile_y: 100, count: 2 });
  assert.deepEqual(json.searchedAround, { tile_x: 175, tile_y: 100 });
  const ore = json.sites.iron_ore;
  assert.equal(ore.length, 2, JSON.stringify(json));
  assert.ok(ore.every((s: any) => s.tile_x >= 170 && s.tile_x <= 180 && s.x === undefined), "tiles only: these spots are off screen");
  assert.equal(game.state.camera, 1, "the camera did not move");
  assert.equal(game.actions.length, 0);
  const half = await game.run("find_sites", { building: "Iron Mine", tile_x: 175 });
  assert.equal(half.json.status, "invalid");
});

test("find_sites with no spot on the building's own ground in view searches around the nearest such ground on the map", async () => {
  const game = simulatedGame(oreOutOfView);
  const { json } = await game.run("find_sites", { building: "Iron Mine", count: 1 });
  assert.deepEqual([json.searchedAround.tile_x, json.searchedAround.tile_y], [175, 100], JSON.stringify(json));
  assert.match(json.searchedAround.why, /nearest iron ore on the map/);
  const [site] = json.sites.iron_ore;
  // build_structure then reaches it by moving the camera.
  const { json: built } = await game.run("build_structure", { placements: [{ name: "Iron Mine", tile_x: site.tile_x, tile_y: site.tile_y }] });
  assert.equal(built.placements[0].status, "placed", JSON.stringify(built));
  assert.equal(built.placements[0].view, "moved_to_tile");
});

test("find_sites offers another granary only flush with the one standing, wherever it is asked", async () => {
  // The game refuses a second granary anywhere else ("Needs to be placed adjacent to the granary."),
  // and four 1.6.3 games and a live test placed one where find_sites had said (2026-10-14).
  const standing = { x1: 100, y1: 98, x2: 103, y2: 101 };
  const granary = (set: (layer: keyof TileRegion["layers"], x: number, y: number, v: number) => void) => {
    for (let x = standing.x1; x <= standing.x2; x++) for (let y = standing.y1; y <= standing.y2; y++) set("structure", x, y, 7);
  };
  const game = simulatedGame({
    tiles: granary, structureTypes: { "7": 19 }, buildings: { "19": 1 },
    storage: { piles: [], granaries: [{ tile: [standing.x1, standing.y1], amount: 40, capacity: 250 }], truncated: false },
  });
  // Asked around a tile 60 away: the search moves to the granary.
  const { json } = await game.run("find_sites", { building: "Granary", tile_x: 160, tile_y: 100, count: 2 });
  assert.deepEqual([json.searchedAround.tile_x, json.searchedAround.tile_y], [standing.x1, standing.y1], JSON.stringify(json));
  assert.match(json.searchedAround.why, /must touch one of your granaries/);
  const sites = allSites(json);
  assert.equal(sites.length, 2, JSON.stringify(json));
  for (const s of sites) {
    const f = footprintRect({ x: s.tile_x, y: s.tile_y }, 4);
    const touching = f.x1 <= standing.x2 + 1 && standing.x1 <= f.x2 + 1 && f.y1 <= standing.y2 + 1 && standing.y1 <= f.y2 + 1;
    assert.ok(touching && disjoint(f, standing), JSON.stringify(s));
  }
  assert.match(json.note, /flush with your granaries/);
  // In the view too.
  const view = await game.run("find_sites", { building: "Granary", count: 1 });
  assert.match(view.json.searchedAround.why, /must touch one of your granaries/);
  // With no granary yet, the usual search.
  const first = simulatedGame({ tiles: () => {} });
  const { json: plain } = await first.run("find_sites", { building: "Granary", count: 1 });
  assert.ok(!plain.searchedAround && allSites(plain).length === 1, JSON.stringify(plain));
});

test("build_structure and expand_storage aim each click by the tile the game picks under the pointer, so clicks a tile off still build on their tiles", async () => {
  // On Large Barren Desert's start every building placed by tile went one tile off, and each flush
  // stockpile spot on the +x side was refused as not adjacent (live 2026-10-14).
  for (const error of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 0 }]) {
    const granaries: Rect[] = [{ x1: 100, y1: 98, x2: 103, y2: 101 }];
    const storage = { piles: [], granaries: [{ tile: [100, 98], amount: 40, capacity: 250 }], truncated: false };
    const structureTypes: Record<string, number> = { "7": 19 };
    const woodcutters: { x: number; y: number }[] = [];
    // The tile the game picks under a window pixel: tilePixel turned back at the simulated camera, `error` off.
    const picked = (px: number, py: number, camera: number) => {
      const u = (px - 960) / 32, v = (py - 540) / (1080 / 68) + 8 / 8.7;
      return { x: 99 + camera + Math.round((u + v) / 2) + error.x, y: 100 + Math.round((v - u) / 2) + error.y };
    };
    const overlaps = (a: Rect, b: Rect) => a.x1 <= b.x2 && b.x1 <= a.x2 && a.y1 <= b.y2 && b.y1 <= a.y2;
    const flush = (a: Rect, b: Rect) => !overlaps(a, b) &&
      ((a.x1 === b.x2 + 1 || b.x1 === a.x2 + 1) && a.y1 <= b.y2 && b.y1 <= a.y2 || (a.y1 === b.y2 + 1 || b.y1 === a.y2 + 1) && a.x1 <= b.x2 && b.x1 <= a.x2);
    const granary = 80;
    const game = simulatedGame({
      anchors: { Granary: { camera: 1, type: 19 } },
      tiles: (set) => granaries.forEach((g, i) => { for (let x = g.x1; x <= g.x2; x++) for (let y = g.y1; y <= g.y2; y++) set("structure", x, y, 7 + i); }),
      structureTypes, buildings: { "19": 1 }, storage, runtime: timedRuntime().runtime,
      cursor: (px, py, state) => picked(px, py, state.camera),
      reject: (px, py, state) => {
        if (state.sub !== granary) return undefined;
        const f = footprintRect(picked(px, py, state.camera), 4);
        return granaries.some((g) => overlaps(f, g)) || granaries.some((g) => flush(f, g)) ? undefined : "Needs to be placed adjacent to the granary.";
      },
      // Over a granary: refused without a message. Otherwise it stands, and the reader shows it.
      blocked: (px, py) => {
        const t = picked(px, py, game.state.camera);
        if (game.state.sub !== granary) {
          woodcutters.push(t);
          return false;
        }
        const f = footprintRect(t, 4);
        if (granaries.some((g) => overlaps(f, g))) return true;
        structureTypes[String(7 + granaries.length)] = 19;
        granaries.push(f);
        storage.granaries.push({ tile: [f.x1, f.y1], amount: 0, capacity: 0 });
        return false;
      },
    });
    const label = JSON.stringify(error);
    const first = await game.run("expand_storage", { kind: "granary", count: 2 });
    assert.equal(first.json.status, "placed", `${label} ${JSON.stringify(first.json)}`);
    assert.equal(first.json.probes, 2, `no click refused: ${label} ${JSON.stringify(first.json)}`);
    const second = await game.run("expand_storage", { kind: "granary", count: 1 });
    assert.equal(second.json.probes, 1, `${label} ${JSON.stringify(second.json)}`);
    granaries.forEach((g, i) => i && assert.ok(granaries.slice(0, i).some((h) => flush(g, h)), `${label} ${JSON.stringify(granaries)}`));
    // A build_structure tile target in the same view lands on its tile.
    const built = await game.run("build_structure", { placements: [{ name: "Woodcutter", tile_x: 95, tile_y: 108 }] });
    assert.equal(built.json.placements[0].status, "placed", `${label} ${JSON.stringify(built.json)}`);
    assert.deepEqual(woodcutters, [{ x: 95, y: 108 }], label);
    // The first target in the view took a second pointer move to find its offset; the others one each.
    assert.equal(game.state.moves, error.x || error.y ? 5 : 4, label);
  }
});

test("find_sites says when no woodcutter spot has trees in reach: where the nearest grove is, or that the map has none", async () => {
  // GLM 5.3 Flash's search around a tile on Large Barren Desert listed "trees": 0 under the usual
  // note, and it built four woodcutters on a map with no trees (1.6.3).
  const treeless = simulatedGame({ tiles: () => {} });
  const around = await treeless.run("find_sites", { building: "Woodcutter", tile_x: 110, tile_y: 100, count: 2 });
  assert.ok(allSites(around.json).length && allSites(around.json).every((s: any) => s.trees === 0), JSON.stringify(around.json));
  assert.match(around.json.note, /^No trees within 12 tiles of these spots, so a woodcutter there would have nothing to cut\. map_overview lists no tree groves on this map\.$/);
  const view = await treeless.run("find_sites", { building: "Woodcutter", count: 2 });
  assert.match(view.json.note, /nothing to cut: map_overview lists no tree groves on this map/);
  // A grove elsewhere on the map (block 150–159 of the summary): the note names it.
  const grove = simulatedGame({
    tiles: () => {},
    mapRows: Array.from({ length: 200 }, (_, y) => (y >= 150 && y <= 159 ? ".150T10.40" : ".200")),
  });
  const far = await grove.run("find_sites", { building: "Woodcutter", tile_x: 110, tile_y: 100, count: 1 });
  assert.match(far.json.note, /The nearest tree grove is around \(155, 155\): find_sites with that tile_x\/tile_y lists spots beside it\./);
  // Spots with trees in reach keep the usual note.
  const wooded = simulatedGame({ tiles: (set) => { set("organism", 112, 100, 1); set("logic", 112, 100, 0x8000 | 0x1000); set("logic", 112, 101, 0x8000 | 0x2000); } });
  const near = await wooded.run("find_sites", { building: "Woodcutter", tile_x: 110, tile_y: 100, count: 1 });
  assert.ok(allSites(near.json).some((s: any) => s.trees > 0), JSON.stringify(near.json));
  assert.match(near.json.note, /^Sites are grouped by the ground under them/);
});

test("set_workshop clicks the workshop, presses the product's button, reads the choice back and closes the panel", async () => {
  const game = simulatedGame({ buildingAt: () => 12, workshop: { making: 17, next: 17 } });
  await game.observe();
  const { json } = await game.run("set_workshop", { product: "crossbows", x: 900, y: 400 });
  assert.deepEqual(json, { status: "set", x: 900, y: 400, workshop: "Fletchers' Workshop", making: "bows", next: "crossbows" });
  assert.deepEqual(game.actions.map((a) => [a.x, a.y, a.button]), [[900, 400, 1], [1448, 998, 1], [960, 130, 3]]);
  const again = await game.run("set_workshop", { product: "crossbows", x: 900, y: 400 });
  assert.equal(again.json.status, "already");
  // Swords come from a blacksmith, and a woodcutter's panel is no workshop's; both close the panel.
  const wrong = await game.run("set_workshop", { product: "swords", x: 900, y: 400 });
  assert.equal(wrong.json.status, "wrong_workshop");
  assert.match(wrong.json.remedy, /Blacksmith's Workshop; this one makes bows or crossbows/);
  const woodcutter = simulatedGame({ buildingAt: () => 3 });
  await woodcutter.observe();
  const none = await woodcutter.run("set_workshop", { product: "bows", x: 900, y: 400 });
  assert.equal(none.json.status, "not_a_workshop");
  assert.equal(woodcutter.actions.at(-1).button, 3);
});

test("build_structure places a tile target without any observation, using the live camera", async () => {
  const target = tileView().pixel({ x: 100, y: 100 });
  const game = simulatedGame({ tiles: () => {} });
  const { json } = await game.run("build_structure", { placements: [{ name: "Hovel", tile_x: 100, tile_y: 100 }] });
  const p = json.placements[0];
  assert.equal(p.status, "placed", JSON.stringify(p));
  assert.deepEqual(p.tile, { x: 100, y: 100 });
  assert.equal(p.x, target.x);
  assert.equal(p.y, target.y);
  assert.equal(game.captures(), 1, "one bookkeeping capture; no screenshot was ever taken");
});

test("build_structure moves the camera to an off-screen tile target, then places it", async () => {
  // Claude Haiku 5.5 lost its iron mines to tile targets off screen (2026-10-11).
  const game = simulatedGame({ tiles: () => {} });
  const { json } = await game.run("build_structure", { placements: [{ name: "Hovel", tile_x: 160, tile_y: 100 }] });
  const p = json.placements[0];
  assert.equal(p.status, "placed", JSON.stringify(p));
  assert.equal(p.view, "moved_to_tile");
  assert.deepEqual(p.tile, { x: 160, y: 100 });
  assert.equal(game.state.camera, 61, "the camera is centred on the target");
  const minimap = game.actions.findIndex((a) => a.x >= 1605 && a.y >= 892 && a.button === 1);
  const menu = game.actions.findIndex((a) => a.y > 1000 && a.x < 1200);
  assert.ok(minimap >= 0 && minimap < menu, "the camera moves before the building is chosen");
});

/**
 * A plateau of height 130 over tiles 70..100 on both axes, and the tile the game picks under a window
 * pixel of the simulated view: of the tiles drawn in the pixel's column, the frontmost drawn within a
 * row of it (raised ground is drawn higher), as TileMap.tileAt finds it.
 */
const plateau = {
  heightAt: (t: { x: number; y: number }) => (t.x >= 70 && t.x <= 100 && t.y >= 70 && t.y <= 100 ? 130 : 8),
  tiles: (set: (layer: keyof TileRegion["layers"], x: number, y: number, v: number) => void) => {
    for (let x = 70; x <= 100; x++) for (let y = 70; y <= 100; y++) set("height", x, y, 130);
  },
  picked(px: number, py: number, camera: number) {
    const row = 1080 / 68, cx = 99 + camera;
    const u = (px - 960) / 32, v = (py - 540) / row + 8 / 8.7;
    const flat = { x: Math.round(cx + (u + v) / 2), y: Math.round(100 + (v - u) / 2) };
    for (let j = 32; j >= -4; j--) {
      const t = { x: flat.x + j, y: flat.y + j };
      if (Math.abs(540 + (t.x - cx + t.y - 100 - this.heightAt(t) / 8.7) * row - py) < row) return t;
    }
    return flat;
  },
};

test("build_structure moves the camera to a raised tile drawn off screen while its flat position is on it, and builds on it", async () => {
  // Near the top edge a hovel on The Sinkhole's slope, clicked at its flat position, went 4 tiles off
  // (GLM 5.3 Flash, live 2026-10-14). Tile (86, 86) is drawn above the screen in the first view.
  const built: { x: number; y: number }[] = [];
  const game = simulatedGame({
    tiles: plateau.tiles,
    cursor: (px, py, state) => plateau.picked(px, py, state.camera),
    blocked: (px, py) => {
      built.push(plateau.picked(px, py, game.state.camera));
      return false;
    },
  });
  assert.ok(tileView().pixel({ x: 86, y: 86 }).y > 20, "on screen when flat");
  const { json } = await game.run("build_structure", { placements: [{ name: "Hovel", tile_x: 86, tile_y: 86 }] });
  const p = json.placements[0];
  assert.equal(p.status, "placed", JSON.stringify(p));
  assert.equal(p.view, "moved_to_tile");
  assert.deepEqual(built, [{ x: 86, y: 86 }]);
  assert.equal(p.cursorTile, undefined, "the game showed the tile under the pointer");
});

test("demolish_building and the panel tools move the camera to a raised tile drawn off screen while its flat position is on it", async () => {
  // A building on the plateau's tiles 86..87, drawn above the screen in the first view.
  const inside = (t: { x: number; y: number }) => t.x >= 86 && t.x <= 87 && t.y >= 86 && t.y <= 87;
  const options = {
    tiles: (set: (layer: keyof TileRegion["layers"], x: number, y: number, v: number) => void) => {
      plateau.tiles(set);
      for (let x = 86; x <= 87; x++) for (let y = 86; y <= 87; y++) set("structure", x, y, 15);
    },
    cursor: (px: number, py: number, state: { camera: number }) => plateau.picked(px, py, state.camera),
  };
  const game = simulatedGame({ ...options, demolishable: (x, y) => inside(plateau.picked(x, y, game.state.camera)) });
  const { json } = await game.run("demolish_building", { tile_x: 86, tile_y: 86 });
  assert.equal(json.status, "demolished", JSON.stringify(json));
  assert.equal(game.state.camera, -20, "centred where the raised tile is drawn mid-screen (x only here)");
  const inspect = simulatedGame({ ...options, buildingAt: (x, y) => (inside(plateau.picked(x, y, inspect.state.camera)) ? 3 : undefined) });
  const { json: panel } = await inspect.run("inspect_building", { tile_x: 86, tile_y: 86 });
  assert.equal(panel.building?.name, "Woodcutter's Hut", JSON.stringify(panel));
});

test("build_structure reports a tile target the camera cannot bring into view as not_on_screen, clicking no terrain", async () => {
  // The simulated camera moves along x only, so tile (1, 1) never comes into view.
  const game = simulatedGame({ tiles: () => {} });
  const { json } = await game.run("build_structure", { placements: [{ name: "Hovel", tile_x: 1, tile_y: 1 }] });
  const p = json.placements[0];
  assert.equal(p.status, "not_on_screen", JSON.stringify(p));
  assert.match(p.reason, /could not bring the tile into view/);
  assert.match(p.remedy, /further in/);
  assert.ok(game.actions.every((a) => a.x >= 1605 && a.y >= 892), "only minimap clicks: no menu, terrain or exit click");
});

test("build_structure goes back to a tile target's bookmarked view when choosing a Stockpile moved the view", async () => {
  // Choosing a Stockpile centres the view on the first one (Claude Opus 5.5 and GPT-6.1 Sol,
  // 2026-10-12); the minimap does nothing in placement mode, a camera bookmark does.
  const game = simulatedGame({ tiles: () => {}, onButton: (state) => { state.camera += 40; } });
  const [p] = (await game.build([{ name: "Stockpile", tile_x: 101, tile_y: 100 }])).placements;
  assert.equal(p.status, "placed", JSON.stringify(p));
  assert.equal(p.view, "moved_back_to_tile");
  assert.deepEqual(game.hotkeys, ["SetBookmark9", "GotoBookmark9"]);
  // A building that does not normally move the view gets no bookmark; if the view moves anyway,
  // the tile is reported off screen, and nothing is clicked there.
  const other = simulatedGame({ tiles: () => {}, onButton: (state) => { state.camera += 40; } });
  const [q] = (await other.build([{ name: "Hovel", tile_x: 101, tile_y: 100 }])).placements;
  assert.equal(q.status, "not_on_screen", JSON.stringify(q));
  assert.match(q.reason, /moved the view away/);
  assert.deepEqual(other.hotkeys, []);
});

test("build_structure leaves placement mode before moving the camera to a later off-screen tile target", async () => {
  // The first placement leaves placement mode on, in which the minimap does nothing.
  const game = simulatedGame({ tiles: () => {} });
  const report = await game.build([{ name: "Hovel", tile_x: 100, tile_y: 100 }, { name: "Hovel", tile_x: 160, tile_y: 100 }]);
  assert.deepEqual(report.placements.map((p: any) => [p.status, p.view]), [["placed", undefined], ["placed", "moved_to_tile"]], JSON.stringify(report));
  const minimap = game.actions.findIndex((a) => a.x >= 1605 && a.y >= 892 && a.button === 1);
  assert.equal(game.actions[minimap - 1].button, 3, "a right-click left placement mode first");
});

test("build_structure takes 8 placements in one call, and skips pixel targets once their screenshot is too old for another", async () => {
  // GLM 5.3 Flash asked twice for more than 4 per call (2026-10-14, 15).
  const many = simulatedGame({ tiles: () => {} });
  const tiles = Array.from({ length: 8 }, (_, i) => ({ name: "Woodcutter", tile_x: 96 + 2 * (i % 4), tile_y: 96 + 3 * Math.floor(i / 4) }));
  const report = await many.build(tiles);
  assert.equal(report.placements.length, 8, JSON.stringify(report));
  assert.ok(report.placements.every((p: any) => p.status === "placed"), JSON.stringify(report.placements.map((p: any) => p.status)));
  // A screenshot 31 game seconds old leaves less than a placement's time before its 40: the pixel
  // target is skipped with a remedy, nothing is clicked for it, and the tile target still builds.
  const old = simulatedGame({ tiles: () => {}, frameAge: () => 31 });
  const mixed = await old.build([{ name: "Hovel", x: 500, y: 400 }, { name: "Hovel", tile_x: 100, tile_y: 100 }]);
  assert.deepEqual(mixed.placements.map((p: any) => p.status), ["screenshot_expired", "placed"], JSON.stringify(mixed));
  assert.match(mixed.placements[0].remedy, /tile_x\/tile_y/);
});

test("build_structure rejects a placement that gives neither or both coordinate pairs", async () => {
  const game = simulatedGame({ tiles: () => {} });
  const neither = await game.run("build_structure", { placements: [{ name: "Hovel" }] });
  assert.equal(neither.json.placements[0].status, "invalid_target");
  const both = await game.run("build_structure", {
    placements: [{ name: "Hovel", x: 500, y: 400, tile_x: 100, tile_y: 100 }],
  });
  assert.equal(both.json.placements[0].status, "invalid_target");
  assert.deepEqual(game.actions, [], "a shape error sends nothing");
});

test("build_structure handles a batch mixing a pixel and a tile target", async () => {
  const game = simulatedGame({ tiles: () => {} });
  const report = await game.build([
    { name: "Hovel", x: 500, y: 400 },
    { name: "Hovel", tile_x: 110, tile_y: 110 },
  ]);
  assert.deepEqual(report.placements.map((p: any) => p.status), ["placed", "placed"]);
  assert.deepEqual(report.placements[1].tile, { x: 110, y: 110 });
});

test("build_structure retries a blocked tile target at a nearby tile the map shows free, without any observation", async () => {
  const view = tileView();
  const target = view.pixel({ x: 100, y: 100 });
  const trees = { x1: 97, y1: 97, x2: 103, y2: 103 };
  const game = simulatedGame({
    tiles: (set) => { for (let x = trees.x1; x <= trees.x2; x++) for (let y = trees.y1; y <= trees.y2; y++) set("organism", x, y, 1); },
    blocked: (x, y) => x === target.x && y === target.y,
  });
  const { json } = await game.run("build_structure", { placements: [{ name: "Hovel", tile_x: 100, tile_y: 100 }] });
  const p = json.placements[0];
  assert.equal(p.status, "placed", JSON.stringify(p));
  assert.equal(p.retryMethod, "tile_map");
  assert.equal(p.retries, 1, "the first computed spot is free");
  assert.ok(p.tile, "reports the tile actually placed");
  assert.ok(disjoint(footprintRect(p.tile, 4), trees));
  assert.equal(game.captures(), 1, "one bookkeeping capture; no observation needed for the retry either");
});

test("a tile-only batch sends with the latest capture and no screenshot age limit; a pixel batch keeps its screenshot's", async () => {
  const game = simulatedGame({ tiles: () => {} });
  await game.observe();
  await game.run("build_structure", { placements: [{ name: "Hovel", tile_x: 100, tile_y: 100 }] });
  assert.ok(game.ageCredits.length > 0 && game.ageCredits.every((c) => c === Infinity), String(game.ageCredits));
  assert.equal(game.captures(), 1, "the observation's capture is reused for the window's size and identity");
  game.ageCredits.length = 0;
  await game.build([{ name: "Hovel", x: 500, y: 400 }]);
  assert.ok(game.ageCredits.length > 0 && game.ageCredits.every((c) => Number.isFinite(c)), String(game.ageCredits));
  // A mixed batch: the pixel target's clicks keep the limit, the tile target's do not.
  game.ageCredits.length = 0;
  const before = game.actions.length;
  await game.build([{ name: "Hovel", x: 500, y: 400 }, { name: "Hovel", tile_x: 110, tile_y: 110 }]);
  const sent = game.actions.slice(before);
  const terrain = (x: number, y: number) => sent.findIndex((a) => a.x === x && a.y === y && a.button !== 3);
  const tile = tileView().pixel({ x: 110, y: 110 });
  assert.ok(Number.isFinite(game.ageCredits[terrain(500, 400)]));
  assert.equal(game.ageCredits[terrain(tile.x, tile.y)], Infinity);
});

test("a blocked tile target is retried in the live view, not the view of an older screenshot", async () => {
  // Trees around tile (101, 100) in whichever view; the screenshot was taken at camera 1, the
  // live view is camera 2 by the time of the placement.
  const trees = { x1: 98, y1: 97, x2: 104, y2: 103 };
  const live = tileView(2);
  const target = live.pixel({ x: 101, y: 100 });
  const game = simulatedGame({
    tiles: (set) => { for (let x = trees.x1; x <= trees.x2; x++) for (let y = trees.y1; y <= trees.y2; y++) set("organism", x, y, 1); },
    blocked: (x, y) => x === target.x && y === target.y,
  });
  await game.observe();
  game.state.camera = 2;
  const { json } = await game.run("build_structure", { placements: [{ name: "Hovel", tile_x: 101, tile_y: 100 }] });
  const p = json.placements[0];
  assert.equal(p.status, "placed", JSON.stringify(p));
  assert.equal(p.retryMethod, "tile_map");
  assert.ok(disjoint(footprintRect(p.tile, 4), trees), "the retry spot is free in the live view's map");
  // The retry click is the placed tile projected through the live camera.
  assert.deepEqual(p.at, live.pixel(p.tile));
  assert.equal(game.tileReads(), 2, "the screenshot's map, then one read for the live view");
});

test("a tile target's retries stop when the live camera moves", async () => {
  const target = tileView().pixel({ x: 100, y: 100 });
  const game = simulatedGame({
    tiles: () => {},
    blocked: (x, y) => x === target.x && y === target.y,
    moveCameraAfterWorldClicks: 1,
  });
  const { json } = await game.run("build_structure", { placements: [{ name: "Hovel", tile_x: 100, tile_y: 100 }] });
  const p = json.placements[0];
  assert.equal(p.status, "not_placed", JSON.stringify(p));
  assert.equal(p.retryStopped, "camera_moved");
  assert.equal(game.actions.filter((a) => a.button !== 3 && a.y < 900).length, 1, "no retry click in a view the spots were not computed for");
});

test("build_structure reuses the map find_sites read for the live view, also for a retry", async () => {
  let blocked: { x: number; y: number } | undefined;
  const game = simulatedGame({
    tiles: (set) => { for (let x = 104; x <= 106; x++) for (let y = 99; y <= 101; y++) set("organism", x, y, 1); },
    blocked: (x, y) => x === blocked?.x && y === blocked?.y,
  });
  const { json: found } = await game.run("find_sites", { building: "Hovel", count: 1 });
  const site = allSites(found)[0];
  blocked = tileView().pixel({ x: site.tile_x, y: site.tile_y });
  const { json } = await game.run("build_structure", { placements: [{ name: "Hovel", tile_x: site.tile_x, tile_y: site.tile_y }] });
  const p = json.placements[0];
  assert.equal(p.status, "placed", JSON.stringify(json));
  assert.equal(p.retryMethod, "tile_map");
  assert.equal(game.tileReads(), 1, "find_sites' read serves the retry; nothing is read again");
  // Any other input in between (here a placement) makes it stale.
  await game.run("build_structure", { placements: [{ name: "Hovel", tile_x: site.tile_x, tile_y: site.tile_y }] });
  assert.equal(game.tileReads(), 2);
});

/** A runtime for a timed run whose game clock advances only through waitGame. */
function timedRuntime() {
  const waits: number[] = [];
  let ticks = 0;
  const cycle = new ObservationCycle();
  const runtime = {
    runId: "test",
    session: {
      check() {}, wait: async () => {},
      waitGame: async (seconds: number) => { waits.push(seconds); ticks += seconds * 30; return false; },
      gameUsedTicks: () => ticks,
      gameBudgetSeconds: 600, gameRemainingSeconds: () => 600 - ticks / 30, remaining: () => 60000,
    },
    cycle,
    memory: { delivery() {} },
    config: { contextBudget: 120000, minTurnSeconds: 0 },
    pausedMilliseconds: () => 0,
    phase() {}, changed() {}, timing() {},
  } as unknown as AgentRuntime;
  return { runtime, cycle, waits };
}

test("wait_and_observe with screenshot false waits the same, returns the reading as text and keeps the old frame", async () => {
  const { runtime, waits } = timedRuntime();
  const game = simulatedGame({ runtime });
  await game.observe();
  const result = await game.tool("wait_and_observe").execute("wait", { seconds: 5, screenshot: false });
  const texts = result.content.flatMap((c) => (c.type === "text" ? [c.text] : []));
  assert.equal(result.content.filter((c) => c.type === "image").length, 0);
  assert.match(texts[0], /No screenshot taken; call observe or wait_and_observe/);
  const json = JSON.parse(texts.at(-1)!);
  assert.deepEqual(waits, [5]);
  assert.equal(game.captures(), 1, "no capture");
  assert.ok(json.run_clock && json.stats, JSON.stringify(json));
  assert.equal(json.width, undefined, "no image, so no image size");
  // The screenshot from before the wait still targets pixels: a click is accepted against it.
  await game.tool("game_action").execute("click", { type: "click", x: 500, y: 400 });
  assert.ok(game.actions.some((a) => a.x === 500 && a.y === 400));
});

test("wait_and_observe reminds the model after 3 game minutes of only waiting, until it acts again", async () => {
  const { runtime } = timedRuntime();
  const game = simulatedGame({ runtime });
  await game.observe();
  const texts = async (seconds: number) => {
    const result = await game.tool("wait_and_observe").execute("wait", { seconds, screenshot: false });
    return result.content.flatMap((c) => (c.type === "text" ? [c.text] : []));
  };
  assert.ok(!(await texts(120)).some((t) => /only waited/.test(t)), "2 game minutes: no reminder");
  const late = await texts(90);
  assert.ok(late.some((t) => /only waited and read for 3 game minutes in a row/.test(t)), late.join("\n"));
  // An action starts the count again; a camera move or an inspection would not.
  await game.tool("game_action").execute("key", { type: "key", key: "Z" });
  assert.ok(!(await texts(60)).some((t) => /only waited/.test(t)), "after an action: no reminder");
});

test("a warning ends wait_and_observe early and leads its observation, once", async () => {
  const economy = { gold: 600, popularity: 52 };
  const { runtime } = timedRuntime();
  let ticks = 0;
  const interrupts: (number | undefined)[] = [];
  Object.assign(runtime, { warnings: new Warnings() });
  Object.assign(runtime.session, {
    gameUsedTicks: () => ticks,
    waitGame: async (seconds: number, _until?: unknown, interrupt?: { check: () => boolean; afterSeconds: number }) => {
      interrupts.push(interrupt?.afterSeconds);
      // Twenty game seconds in, popularity is 12 points down and gold under 500.
      ticks += 20 * 30;
      Object.assign(economy, { popularity: 40, gold: 450 });
      if (interrupt?.check()) return "interrupted";
      ticks += (seconds - 20) * 30;
      return false;
    },
  });
  const game = simulatedGame({ runtime, economy });
  await game.observe();
  const texts = async () => (await game.tool("wait_and_observe").execute("wait", { seconds: 90, screenshot: false }))
    .content.flatMap((c) => (c.type === "text" ? [c.text] : []));
  const first = await texts();
  assert.deepEqual(interrupts, [0], "warnings may end the wait once the turn's minimum has passed (none owed here)");
  assert.ok(first.some((t) => /^A warning ended the wait early/.test(t)), first.join("\n"));
  assert.deepEqual(JSON.parse(first.at(-1)!).warnings,
    ["Popularity fell from 52 to 40 since your last observation.", "Gold is low: 450 left, down from 600 at your last observation."]);
  // That observation is the new start: the same values bring nothing again, and the wait runs out.
  const second = await texts();
  assert.ok(!second.some((t) => /warning ended/.test(t)), second.join("\n"));
  assert.equal(JSON.parse(second.at(-1)!).warnings, undefined);
});

test("only input that works from the screenshot marks the turn as pixel input", async () => {
  const { runtime, cycle } = timedRuntime();
  const game = simulatedGame({ runtime, tiles: () => {} });
  await game.observe();
  cycle.begin();
  await game.run("build_structure", { placements: [{ name: "Hovel", tile_x: 100, tile_y: 100 }] });
  assert.equal(cycle.acted, true);
  assert.equal(cycle.pixelInput, false, "a tile placement does not work from the screenshot");
  await game.tool("game_action").execute("key", { type: "key", key: "Z" });
  assert.equal(cycle.pixelInput, true, "a key such as zoom changes what the screenshot shows");
  await game.observe();
  cycle.begin();
  await game.run("build_structure", { placements: [{ name: "Hovel", x: 500, y: 400 }] });
  assert.equal(cycle.pixelInput, true, "a pixel placement is");
  await game.observe();
  cycle.begin();
  await game.tool("game_action").execute("click", { type: "click", x: 500, y: 400 });
  assert.equal(cycle.pixelInput, true, "a click is");
});

test("a tile target waits for a valid camera sample instead of reporting not_on_screen", async () => {
  // Read 1 is the placer's reader check; read 2 the tile target's camera.
  const game = simulatedGame({ tiles: () => {}, unavailableReads: [2] });
  const { json } = await game.run("build_structure", { placements: [{ name: "Hovel", tile_x: 100, tile_y: 100 }] });
  assert.equal(json.placements[0].status, "placed", JSON.stringify(json));
});

test("find_sites waits for a valid camera sample", async () => {
  const game = simulatedGame({ tiles: () => {}, unavailableReads: [1] });
  const { json } = await game.run("find_sites", { building: "Hovel", count: 1 });
  assert.equal(allSites(json).length, 1, JSON.stringify(json));
});

test("a tile target is projected again when the view moves while the building is selected", async () => {
  const game = simulatedGame({ tiles: () => {}, onButton: (state) => { state.camera = 2; } });
  const { json } = await game.run("build_structure", { placements: [{ name: "Hovel", tile_x: 101, tile_y: 100 }] });
  const p = json.placements[0];
  assert.equal(p.status, "placed", JSON.stringify(p));
  assert.deepEqual({ x: p.x, y: p.y }, tileView(2).pixel({ x: 101, y: 100 }), "clicked where the tile is in the moved view");
});

test("an offset retry of a tile target reports the tile it went to", async () => {
  // No tile reader: retries step by fixed offsets, in tiles, from the requested tile.
  const camera = { centre_tile_x: 1, centre_tile_y: 1, tiles_wide: 30, tiles_high: 68 };
  const target = new TileMap({ x0: 0, y0: 0, w: 0, h: 0, stable: true, layers: {} as TileRegion["layers"] }, camera, { width: 1920, height: 1080 }).pixel({ x: 5, y: 5 });
  const game = simulatedGame({ blocked: (x, y) => x === target.x && y === target.y });
  const { json } = await game.run("build_structure", { placements: [{ name: "Hovel", tile_x: 5, tile_y: 5 }] });
  const p = json.placements[0];
  assert.equal(p.status, "placed", JSON.stringify(p));
  assert.equal(p.retryMethod, "offsets");
  assert.deepEqual(p.tile, { x: 5 + p.offsetTiles[0], y: 5 + p.offsetTiles[1] });
  assert.notDeepEqual(p.tile, { x: 5, y: 5 });
});

test("find_sites ignores near_x/near_y when no screenshot shows the live view", async () => {
  const game = simulatedGame({ tiles: () => {} });
  const { json } = await game.run("find_sites", { building: "Hovel", count: 1, near_x: 100, near_y: 100 });
  assert.match(json.nearIgnored, /no(t| screenshot)|does not show/);
  assert.equal(allSites(json).length, 1);
});

test("find_sites groups spots by the ground under them, so the agent decides which to take", async () => {
  // Oasis grass west of x 100; plain ground from x 100 on.
  const game = simulatedGame({ tiles: (set) => { for (let x = 80; x <= 99; x++) for (let y = 80; y <= 120; y++) set("logic2", x, y, -128); } });
  const { json } = await game.run("find_sites", { building: "Hovel", count: 2 });
  assert.deepEqual(Object.keys(json.sites), ["plain", "oasis_grass"], "plain ground first for a hovel, the farmland offered apart");
  for (const site of json.sites.plain) assert.ok(footprintRect({ x: site.tile_x, y: site.tile_y }, 4).x1 >= 100);
  for (const site of json.sites.oasis_grass) assert.ok(footprintRect({ x: site.tile_x, y: site.tile_y }, 4).x1 <= 99);
  const farm = await game.run("find_sites", { building: "Apple Orchard", count: 1 });
  assert.deepEqual(Object.keys(farm.json.sites), ["oasis_grass"]);
});

test("a blocked hovel is retried off oasis grass, which the harness keeps for farms", async () => {
  const target = tileView().pixel({ x: 100, y: 100 });
  const game = simulatedGame({
    // Oasis grass everywhere except plain ground from x 103 on, within a hovel's reach of 5 tiles.
    tiles: (set) => { for (let x = 80; x <= 102; x++) for (let y = 80; y <= 120; y++) set("logic2", x, y, -128); },
    blocked: (x, y) => x === target.x && y === target.y,
  });
  const { json } = await game.run("build_structure", { placements: [{ name: "Hovel", tile_x: 100, tile_y: 100 }] });
  const p = json.placements[0];
  assert.equal(p.status, "placed", JSON.stringify(p));
  assert.ok(footprintRect(p.tile, 4).x1 >= 103, `retried onto ${JSON.stringify(p.tile)}`);
});

test("demolish_building selects the demolish tool, clicks a tile's building and checks the count fell", async () => {
  const target = tileView().pixel({ x: 102, y: 101 });
  const game = simulatedGame({ tiles: () => {}, demolishable: (x, y) => x === target.x && y === target.y });
  const before = game.state.structures;
  const { json } = await game.run("demolish_building", { tile_x: 102, tile_y: 101 });
  assert.equal(json.status, "demolished", JSON.stringify(json));
  assert.equal(game.state.structures, before - 1);
  assert.equal(game.state.action, 0, "demolish mode left with a right-click");
  assert.deepEqual(game.actions.map((a) => [a.x, a.y, a.button]), [[1537, 1016, 1], [target.x, target.y, 1], [target.x, target.y, 3]]);
});

test("demolish_building reports nothing demolished, a tool that did not start, and an off-screen tile, each with a remedy", async () => {
  const nothing = await simulatedGame({ tiles: () => {} }).run("demolish_building", { tile_x: 102, tile_y: 101 });
  assert.equal(nothing.json.status, "not_demolished");
  assert.match(nothing.json.remedy, /keep cannot be demolished/);
  const game = simulatedGame({ tiles: () => {}, demolishIgnored: true });
  const stuck = await game.run("demolish_building", { tile_x: 102, tile_y: 101 });
  assert.equal(stuck.json.status, "not_selected");
  assert.ok(game.actions.every((a) => a.y >= 900), "the map was never clicked");
  // The camera is moved to a tile off screen; one it cannot reach (the simulated camera moves along x
  // only) is reported, with a remedy that does not repeat the move.
  const far = await simulatedGame({ tiles: () => {} }).run("demolish_building", { tile_x: 1, tile_y: 1 });
  assert.equal(far.json.status, "not_on_screen");
  assert.match(far.json.remedy, /further in/);
});

test("demolish_building and the panel tools aim a tile target by the tile the game picks under the pointer", async () => {
  // Clicks projected at a tile went one tile off on Large Barren Desert's start (live 2026-10-14):
  // a corner tile then misses its building, and a small building's middle opens nothing.
  const small = { x1: 100, y1: 100, x2: 101, y2: 101 };
  const inside = (t: { x: number; y: number }) => t.x >= small.x1 && t.x <= small.x2 && t.y >= small.y1 && t.y <= small.y2;
  for (const error of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]) {
    const label = JSON.stringify(error);
    // The tile the game picks under a window pixel: tilePixel turned back at the simulated camera, `error` off.
    const picked = (px: number, py: number, camera: number) => {
      const u = (px - 960) / 32, v = (py - 540) / (1080 / 68) + 8 / 8.7;
      return { x: 99 + camera + Math.round((u + v) / 2) + error.x, y: 100 + Math.round((v - u) / 2) + error.y };
    };
    const options = {
      tiles: (set: (layer: keyof TileRegion["layers"], x: number, y: number, v: number) => void) => {
        for (let x = small.x1; x <= small.x2; x++) for (let y = small.y1; y <= small.y2; y++) set("structure", x, y, 15);
      },
      cursor: (px: number, py: number, state: { camera: number }) => picked(px, py, state.camera),
      runtime: timedRuntime().runtime,
    };
    const inspect = simulatedGame({ ...options, buildingAt: (x, y) => (inside(picked(x, y, inspect.state.camera)) ? 3 : undefined) });
    const { json } = await inspect.run("inspect_building", { tile_x: 100, tile_y: 100 });
    assert.equal(json.building?.name, "Woodcutter's Hut", `${label} ${JSON.stringify(json)}`);
    assert.equal(inspect.actions.filter((a) => a.button === 1).length, 1, `opened at the first click: ${label}`);
    const demolish = simulatedGame({ ...options, demolishable: (x, y) => inside(picked(x, y, demolish.state.camera)) });
    const { json: gone } = await demolish.run("demolish_building", { tile_x: 100, tile_y: 100 });
    assert.equal(gone.status, "demolished", `${label} ${JSON.stringify(gone)}`);
  }
});

test("demolish_building clicks only where the game's tile under the pointer is the building's, never one drawn over it", async () => {
  // A fletcher in front of a hovel's corner kept the game's tile on itself and took a demolish
  // meant for the hovel (live 2026-10-14). Here a building in front (instance 16, on 102..103) is
  // drawn over the target's (instance 15, on 100..101) tiles at x 101, or over all of them.
  for (const allCovered of [false, true]) {
    const label = allCovered ? "all covered" : "front column covered";
    const ground = (px: number, py: number, camera: number) => {
      const u = (px - 960) / 32, v = (py - 540) / (1080 / 68) + 8 / 8.7;
      return { x: 99 + camera + Math.round((u + v) / 2), y: 100 + Math.round((v - u) / 2) };
    };
    const target = (t: { x: number; y: number }) => t.x >= 100 && t.x <= 101 && t.y >= 100 && t.y <= 101;
    // The game's pick: the building in front wherever it is drawn over the target.
    const picked = (px: number, py: number, camera: number) => {
      const g = ground(px, py, camera);
      return target(g) && (allCovered || g.x === 101) ? { x: 102, y: g.y } : g;
    };
    const demolished: string[] = [];
    const game = simulatedGame({
      tiles: (set) => {
        for (let x = 100; x <= 101; x++) for (let y = 100; y <= 101; y++) set("structure", x, y, 15);
        for (let x = 102; x <= 103; x++) for (let y = 100; y <= 103; y++) set("structure", x, y, 16);
      },
      cursor: (px, py, state) => picked(px, py, state.camera),
      runtime: timedRuntime().runtime,
      demolishable: (x, y) => {
        const t = picked(x, y, game.state.camera);
        demolished.push(target(t) ? "target" : "front");
        return true;
      },
    });
    const before = game.state.structures;
    const { json } = await game.run("demolish_building", { tile_x: 101, tile_y: 101 });
    if (allCovered) {
      assert.equal(json.status, "covered", `${label} ${JSON.stringify(json)}`);
      assert.match(json.remedy, /nothing was clicked/);
      assert.deepEqual(demolished, [], `${label}: the building in front was left alone`);
      assert.equal(game.state.structures, before);
      assert.equal(game.state.action, 0, "demolish mode left");
    } else {
      assert.equal(json.status, "demolished", `${label} ${JSON.stringify(json)}`);
      assert.deepEqual(demolished, ["target"], label);
    }
  }
});

test("demolish_building reads the view's tile map afresh once input has gone to the game since the observation", async () => {
  // A demolish right after building, with no observation between, read the observation's map from
  // before the hovel and the fletcher beside it stood, knew no building on the tile, and refused it
  // as covered (live 2026-10-14). Here the build puts the target (instance 15, on 100..101) behind a
  // building in front (instance 16, on 102..103) drawn over its tiles at x 101.
  const standing = [{ x1: 102, y1: 100, x2: 103, y2: 103, id: 16 }];
  const ground = (px: number, py: number, camera: number) => {
    const u = (px - 960) / 32, v = (py - 540) / (1080 / 68) + 8 / 8.7;
    return { x: 99 + camera + Math.round((u + v) / 2), y: 100 + Math.round((v - u) / 2) };
  };
  const target = (t: { x: number; y: number }) => t.x >= 100 && t.x <= 101 && t.y >= 100 && t.y <= 101;
  const picked = (px: number, py: number, camera: number) => {
    const g = ground(px, py, camera);
    return target(g) && g.x === 101 && standing.length > 1 ? { x: 102, y: g.y } : g;
  };
  const demolished: string[] = [];
  const game = simulatedGame({
    tiles: (set) => standing.forEach((b) => { for (let x = b.x1; x <= b.x2; x++) for (let y = b.y1; y <= b.y2; y++) set("structure", x, y, b.id); }),
    cursor: (px, py, state) => picked(px, py, state.camera),
    runtime: timedRuntime().runtime,
    blocked: () => {
      standing.push({ x1: 100, y1: 100, x2: 101, y2: 101, id: 15 });
      return false;
    },
    demolishable: (x, y) => {
      demolished.push(target(picked(x, y, game.state.camera)) ? "target" : "front");
      return true;
    },
  });
  await game.observe();
  const built = await game.run("build_structure", { placements: [{ name: "Woodcutter", tile_x: 100, tile_y: 100 }] });
  assert.equal(built.json.placements[0].status, "placed", JSON.stringify(built.json));
  const { json } = await game.run("demolish_building", { tile_x: 101, tile_y: 101 });
  assert.equal(json.status, "demolished", JSON.stringify(json));
  assert.deepEqual(demolished, ["target"]);
});
