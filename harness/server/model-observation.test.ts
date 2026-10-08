import { test } from "node:test";
import assert from "node:assert/strict";
import { GameEvents } from "./game-events.js";
import { makeAgent, type AgentRuntime } from "./model.js";
import { menuClicks as trayClicks } from "./construction-ui.js";
import { tilePixel } from "./anchors.js";
import type { GameDevice, TileRegion } from "./device.js";
import { TileMap, footprintRect } from "./tile-map.js";

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
      resources_by_name: { wood_planks: 41, stone: 25, bread: 50 },
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

test("build_structure validates every target before sending input", async () => {
  const actions: unknown[] = [];
  const device = {
    events: new GameEvents(),
    capture: async () => ({
      id: "frame", image: "", mimeType: "image/jpeg", width: 1920, height: 1080, scope: "game-window",
    }),
    action: async (action: unknown) => { actions.push(action); },
    currentStats: () => ({ status: "unavailable", observation: null }),
  } as unknown as GameDevice;
  const agent = makeAgent(device, () => {}, () => {}, 1, {
    id: "test", name: "test", modelId: "test",
    baseUrl: "https://example.invalid", keyConfigured: false,
  }, "");
  await agent.state.tools.find((tool) => tool.name === "observe")!.execute("observe", {});
  await assert.rejects(
    agent.state.tools.find((tool) => tool.name === "build_structure")!.execute("build", {
      placements: [{ name: "Hovel", x: 500, y: 400 }, { name: "Hovel", x: 500, y: 1000 }],
    }),
    /bottom HUD/,
  );
  assert.deepEqual(actions, []);
});

/** Simulated game and reader: placement mode, camera, wood and the map-wide structure count. */
type SimState = { action: number; sub: number; wood: number; structures: number; camera: number; worldClicks: number; sel: number | null; messages: { channel: string; text: string }[]; flat: boolean };
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
} = {}) {
  const events = new GameEvents();
  const actions: any[] = [];
  const state: SimState = { action: 0, sub: 52, wood: 100, structures: 18, camera: 1, worldClicks: 0, sel: null, messages: [], flat: false };
  const buttonIds: Record<string, number> = { "866,978": 54, "872,934": 52, "880,992": 57 };
  for (const [name, id] of [["Stockpile", 52], ["Granary", 80], ["Woodcutter", 57], ["Dairy Farm", 73]] as const) {
    const [, button] = trayClicks({ width: 1920, height: 1080 }, name) as { x: number; y: number }[];
    buttonIds[`${button.x},${button.y}`] = id;
  }
  const hotkeys: string[] = [];
  let tileReads = 0;
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
      map_name: "m", visible_messages: state.messages, gold: 600, population: 2, popularity: 90,
      resources_by_name: { wood_planks: state.wood },
      structures: { count: state.structures, limit: 3999 },
      placement: { action: state.action, sub_action: state.sub },
      camera: options.tiles
        ? { centre_tile_x: 99 + state.camera, centre_tile_y: 100, tiles_wide: 30, tiles_high: 68, pixels_per_unit_scale: 1 }
        : { centre_tile_x: state.camera, centre_tile_y: 1, tiles_wide: 30, tiles_high: 68, pixels_per_unit_scale: 1 },
      selected_building: state.sel === null ? null : {
        id: 15, type: state.sel, have_stats: state.sel === 3 ? 1 : 0, workers_have: 0, job_vacancies: 1, workers_needed: 1,
        working: 0, turned_off: 0, keep_access: 1, hp: 0, max_hp: 0, no_resources: 0,
      },
    },
  });
  const device = {
    events,
    capture: async () => ({ id: "frame", image: state.flat ? "flat" : "", mimeType: "image/jpeg", width: 1920, height: 1080, scope: "game-window" }),
    action: async (action: any) => {
      actions.push(action);
      const id = buttonIds[`${action.x},${action.y}`];
      if (action.button === 3) { state.action = 0; state.sel = null; }
      else if (id && !options.ignoreButtons) { state.action = 5; state.sub = id; }
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
        const layers = Object.fromEntries(["structure", "organism", "logic", "logic2", "height", "occupancy", "walk", "gfx"]
          .map((n) => [n, Array(w * h).fill(n === "logic" ? 0x8000 : 0)])) as TileRegion["layers"];
        options.tiles!((layer, x, y, v) => {
          if (x >= x0 && y >= y0 && x < x0 + w && y < y0 + h) layers[layer][(y - y0) * w + (x - x0)] = v;
        }, { x: 99 + state.camera, y: 100 });
        return { x0, y0, w, h, stable: true, layers };
      },
    } : {}),
    hotkey: async (name: string) => {
      hotkeys.push(name);
      if (name === "FlattenLandscape" && !options.flatIgnored) state.flat = !state.flat;
      const anchor = options.anchors?.[name];
      if (anchor) {
        if (state.sel === anchor.type) state.camera = anchor.camera;
        else state.sel = anchor.type;
      } else if (name.startsWith("SetBookmark")) bookmarks.set(name.slice(11), state.camera);
      else if (name.startsWith("GotoBookmark") && bookmarks.has(name.slice(12))) state.camera = bookmarks.get(name.slice(12))!;
      return { at: Date.now() };
    },
    // A live stream's unavailable sample still carries its capture time.
    currentStats: () => (options.unavailableReads?.includes(++reads) ? { status: "unavailable", captured_unix_ms: Date.now(), observation: null } : stats()),
  } as unknown as GameDevice;
  let reads = 0;
  const agent = makeAgent(device, () => {}, () => {}, 1, {
    id: "test", name: "test", modelId: "test", baseUrl: "https://example.invalid", keyConfigured: false,
  }, "");
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
  return { actions, state, build, hotkeys, run, tileReads: () => tileReads, observe: () => tool("observe").execute("observe", {}) };
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
  const report = await game.build([
    { name: "Hovel", x: 400, y: 300 }, { name: "Hovel", x: 1200, y: 300 }, { name: "Hovel", x: 800, y: 700 },
  ]);
  assert.deepEqual(report.placements.map((p: any) => p.retries), [6, 6, undefined]);
  assert.equal(worldClicks(game.actions).length, 15);
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
});

test("inspect_building reads the opened panel and closes it", async () => {
  const game = simulatedGame({ buildingAt: (x, y) => (x === 700 && y === 500 ? 3 : undefined) });
  await game.observe();
  const { json } = await game.run("inspect_building", { x: 700, y: 500 });
  assert.equal(json.building.name, "Woodcutter's Hut");
  assert.deepEqual(json.building.workers, { have: 0, needed: 1, vacancies: 1 });
  assert.equal(game.state.sel, null);
  const empty = await game.run("inspect_building", { x: 300, y: 300 });
  assert.equal(empty.json.building, null);
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

test("find_sites lists non-overlapping fitting spots with the farm's oasis share", async () => {
  const game = simulatedGame({
    tiles: (set) => { for (let x = 100; x <= 121; x++) for (let y = 95; y <= 106; y++) set("logic2", x, y, -128); },
  });
  await game.observe();
  const { json, images } = await game.run("find_sites", { building: "Dairy Farm", count: 2 });
  assert.equal(images, 0);
  assert.equal(json.sites.length, 2, JSON.stringify(json));
  assert.ok(json.sites.every((s: any) => s.oasisShare === 1));
  const view = tileView();
  const [a, b] = json.sites.map((s: any) => footprintRect(view.tileAt(s), 10));
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
});

test("a free target that fails is retried elsewhere when affordable, and reported when short of wood", async () => {
  const target = tileView().pixel({ x: 100, y: 100 });
  // The ground is free, but the click places nothing: an unmodelled rule (e.g. near the signpost).
  const game = simulatedGame({ tiles: () => {}, blocked: (x, y) => x === target.x && y === target.y });
  const p = (await game.build([{ name: "Hovel", ...target }])).placements[0];
  assert.equal(p.status, "placed", JSON.stringify(p));
  assert.equal(p.retryMethod, "tile_map");
  assert.notDeepEqual(p.at, { x: target.x, y: target.y });
  // With too little wood (a hovel costs 6) the harness stops and says what is missing.
  const poor = simulatedGame({ tiles: () => {}, blocked: (x, y) => x === target.x && y === target.y });
  poor.state.wood = 2;
  const q = (await poor.build([{ name: "Hovel", ...target }])).placements[0];
  assert.equal(q.status, "not_placed");
  assert.equal(q.retrySkipped, "not_enough_resources");
  assert.deepEqual(q.missing, { wood: 4 });
  assert.equal(worldClicks(poor.actions).length, 1);
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
