import type { Frame, GameAction } from "../shared/protocol.js";
import type { GameDevice, GameHotkey } from "./device.js";
import { cameraKey, cameraSpanOf, minimapClick, placementOf, visiblePlacementFeedback } from "./construction-ui.js";
import { Placer, SAMPLE_POLL_SECONDS, type Ack, type Observation } from "./placement.js";
import { anchorFootprintTiles, footprintOf } from "./footprints.js";
import { footprintRect, isStorageKind, onScreen, STRUCTURE_TYPES, tilePixel as projectTile, type Rect, type StorageKind, type TileMap } from "./tile-map.js";
import { shortfall } from "./building-info.js";
import { VIEW_JUMPERS } from "./building-types.js";

/**
 * Buildings the game can centre on with its own hotkeys (settings.cfg ||KEYS||).
 * With the default "press to select" centring, the first press opens the
 * building's panel and the second centres the camera (live 2026-09-28).
 */
export const hotkeyAnchors = {
  keep: "HomeKeep",
  granary: "Granary",
  market: "Market",
  barracks: "Barracks",
  armoury: "Armoury",
  engineers_guild: "EngineersGuild",
  mercenary_post: "MercPost",
  signpost: "Signpost",
} as const satisfies Record<string, GameHotkey>;
export type Anchor = keyof typeof hotkeyAnchors | "stockpile";
export const anchorNames = [...Object.keys(hotkeyAnchors), "stockpile"] as Anchor[];
/** Game bookmark slot the harness keeps for the located stockpile; agent views use 1–8. */
export const STOCKPILE_BOOKMARK = 0;
/**
 * Game bookmark slot build_structure keeps for a tile target's view while choosing a building that
 * moves the view (VIEW_JUMPERS): going to a bookmark works in placement mode, the minimap does not
 * (live 2026-10-12).
 */
export const PLACEMENT_BOOKMARK = 9;

/** PlayState.in_structure_type values checked against the open panel (live 2026-09-28). */
export const buildingTypeNames: Record<number, string> = { 3: "Woodcutter's Hut", 19: "Granary", 41: "Keep" };

/** Sides of an isometric footprint, named by screen direction; each is one world axis. */
export type Side = "down-right" | "down-left" | "up-right" | "up-left";
export const sides: Side[] = ["down-right", "down-left", "up-right", "up-left"];
const sideAxes: Record<Side, { along: [number, number]; across: [number, number] }> = {
  "down-right": { along: [1, 0], across: [0, 1] },
  "up-left": { along: [-1, 0], across: [0, 1] },
  "down-left": { along: [0, 1], across: [1, 0] },
  "up-right": { along: [0, -1], across: [1, 0] },
};

type Span = { tiles_wide: number; tiles_high: number };

/**
 * Pixel of world-tile offset (a, b) from the camera-centre tile, taken as the
 * window centre (a centred stockpile sat within ~30 px of it, live 2026-09-28).
 * One step along a world axis moves half a tile width and one row.
 */
export function tilePixel(frame: Pick<Frame, "width" | "height">, span: Span, a: number, b: number) {
  const half = frame.width / span.tiles_wide / 2;
  const row = frame.height / span.tiles_high;
  return { x: Math.round(frame.width / 2 + (a - b) * half), y: Math.round(frame.height / 2 + (a + b) * row) };
}

const MAX_MAP_ATTEMPTS = 6;

/** Engine types of the anchors whose type is known (STRUCTURE_TYPES). */
const anchorTypes: Partial<Record<Anchor, number>> = {
  keep: STRUCTURE_TYPES.keep, granary: STRUCTURE_TYPES.granary, market: STRUCTURE_TYPES.market, signpost: STRUCTURE_TYPES.signpost,
  armoury: STRUCTURE_TYPES.armory,
};
/**
 * The anchor's footprint in the map: the stockpile or the nearest building of the anchor's type,
 * else the building nearest the camera centre (the keep's courtyard and campfire are separate
 * buildings, so the nearest one is not always the anchor).
 */
export function anchorRectOf(map: TileMap, anchor: Anchor): Rect | null {
  if (anchor === "stockpile") return map.nearestToCentre(map.storageRects("Stockpile"));
  const type = anchorTypes[anchor];
  return (type !== undefined ? map.nearestToCentre(map.rectsOfType(type)) : null) ?? map.structureRect(map.structureNearCentre());
}
/** Tiles around a spot refused as "Too close to …" that are skipped afterwards. */
export const TOO_CLOSE_MARGIN = 3;

/**
 * The reader's tiles of one kind of storage: each stockpile pile's, granary's or armory's first
 * (top-left) tile. A granary on Oasis by the Sea standing on 439..442 × 360..363 reads 439,360
 * (live 2026-10-14).
 */
function storageTiles(kind: StorageKind, observation: Observation | null | undefined) {
  type Tiles = { tile: [number, number] }[] | undefined;
  const stored = (observation?.storage ?? undefined) as { piles?: Tiles; granaries?: Tiles; armories?: Tiles } | undefined;
  const list = kind === "Stockpile" ? stored?.piles : kind === "Granary" ? stored?.granaries : stored?.armories;
  return (list ?? []).map(({ tile: [x, y] }) => `${x},${y}`);
}

/**
 * The footprint of the storage building a click just placed, from the reader's tiles: a new
 * stockpile's four piles (its square starts at the first), or a new granary's or armory's first
 * tile. Null when the reader does not show exactly one within a second.
 */
async function placedStorage(ctx: AnchorContext, kind: StorageKind, before: string[]): Promise<Rect | null> {
  const known = new Set(before);
  const fresh = (o: Observation) => storageTiles(kind, o).filter((t) => !known.has(t)).map((t) => t.split(",").map(Number));
  const wanted = kind === "Stockpile" ? 4 : 1;
  const seen = await sampleAfter(ctx, 0, (o) => fresh(o).length === wanted, 1);
  const tiles = seen ? fresh(seen) : [];
  if (tiles.length !== wanted) return null;
  const x = Math.min(...tiles.map(([tx]) => tx)), y = Math.min(...tiles.map(([, ty]) => ty));
  const size = footprintOf(kind);
  return { x1: x, y1: y, x2: x + size - 1, y2: y + size - 1 };
}

/** Furthest a click is moved to make up for a view's drift, in tiles along each axis. */
const MAX_DRIFT = 2;

/**
 * Place up to `count` buildings at computed flush spots beside the anchor (storage may also
 * touch the ones just placed; other buildings may leave a gap of up to 3 tiles when the flush
 * band is full). Returns null when the anchor is not found in the tile map, so the caller
 * falls back to probing.
 */
async function placeFromMap(
  ctx: AnchorContext,
  map: TileMap,
  placer: Placer,
  building: string,
  anchor: Anchor,
  count: number,
  preferred: Side | undefined,
  placed: { x: number; y: number; side?: Side; lateral?: number; tilesOut?: number }[],
  anchorCamera: string,
  back: (camera: string | null) => Promise<string | null>,
) {
  // Storage must touch storage of its kind: a new armory too ("Needs to be placed adjacent to the
  // armory.", live 2026-10-12). The first of its kind goes anywhere, so it is placed against the
  // anchor like any other building (Claude Haiku 5.5's first Armory against the keep found no
  // armory to touch and fell back to probing, 2026-10-13).
  const storage = (building === "Stockpile" || building === "Granary" || building === "Armory") &&
    map.storageRects(building).length > 0;
  // Storage goes against the stockpile (or granary) nearest the camera centre or any joined to it:
  // centring always returns to the first one, so with its sides alone expand_storage ran out of
  // spots after 4 to 6. A stockpile is four piles, not one building, so the building nearest the
  // centre was the keep beside it and every spot against the keep was refused (all runs to 2026-10-09).
  const anchorRect = storage ? map.nearestToCentre(map.storageRects(building)) : anchorRectOf(map, anchor);
  if (!anchorRect) return null;
  const size = footprintOf(building);
  const touching: Rect[] = storage ? map.cluster(anchorRect, map.storageRects(building)) : [anchorRect];
  // The game can put a building a tile from the spot a click aims at: the reader's camera is a
  // whole tile, and the view can lie part of a tile from it. On Large Barren Desert's start every
  // stockpile went one tile further along +x than aimed, so each flush spot on that side was
  // refused as not adjacent (live 2026-10-14; 240 refused probes in 180 earlier expand_storage
  // calls). Where the reader shows a placed storage building sets the drift the clicks after it
  // make up for, kept for the view; a flush storage spot refused as not adjacent (the building fell
  // a tile beyond the side) or, before any drift is measured, without a message (a tile into the
  // storage) is tried once more a tile the other way.
  const kind = storage && isStorageKind(building) ? building : null;
  const kept = ctx.state.drift;
  let drift = kept && kept.camera === anchorCamera ? { x: kept.x, y: kept.y } : { x: 0, y: 0 };
  let measured = false;
  let retried: { site: string; drift: { x: number; y: number } } | undefined;
  let attempts = 0;
  // Refusals with no message and nothing spent: the spot was blocked where the click landed.
  let silent = 0;
  let stopped: string | undefined;
  let feedback: string[] = [];
  let missing: Record<string, number> | undefined;
  while (placed.length < count) {
    if (attempts >= MAX_MAP_ATTEMPTS) { stopped = "attempt_limit"; break; }
    missing = shortfall(building, ctx.device.currentStats().observation) ?? undefined;
    if (missing) { stopped = "not_enough_resources"; break; }
    // Storage must touch its kind, so when no spot beside it keeps the tile of open ground around
    // granaries, armories and stockpiles, one that does not is taken rather than none (a full
    // armory in a crowded town had two flush spots, both touching other buildings, live 2026-10-12).
    const site = touching.flatMap((r) => map.sitesBeside(building, r, 1, preferred, storage ? 0 : 3))[0]
      ?? (storage ? touching.flatMap((r) => map.sitesBeside(building, r, 1, preferred, 0, { spaced: false }))[0] : undefined);
    if (!site) { stopped = attempts ? "no_more_free_spots" : "no_free_spot_in_view"; break; }
    let sample = await sampleAfter(ctx, 0, () => true, 1);
    if (cameraShift(cameraKey(sample), anchorCamera) > 1) {
      if (!(await back(cameraKey(sample)))) { stopped = "camera_moved"; break; }
      sample = await sampleAfter(ctx, 0, () => true, 1);
    }
    // The spot's tile through the camera as it is now: the map's camera can be a tile off from
    // the view the click lands in, and a tile pushes a flush spot into the anchor (both of a
    // stockpile's flush spots refused after a bookmark return, Kimi K3, 2026-10-12).
    const live = sample?.camera as Parameters<typeof projectTile>[0] | undefined;
    const aim = { x: site.tile.x - drift.x, y: site.tile.y - drift.y };
    const at = live ? projectTile(live, map.frame, aim, map.heightAt(aim)) : map.pixel(aim);
    if (!onScreen(map.frame, at)) { stopped = "camera_moved"; break; }
    attempts++;
    const carried = visiblePlacementFeedback(ctx.device.currentStats().observation);
    const before = kind ? storageTiles(kind, ctx.device.currentStats().observation) : [];
    const result = await placer.click(building, at, carried, ctx.device.events.cursor());
    const spot = `${site.tile.x},${site.tile.y}`;
    if (result.outcome.status === "placed") {
      const landed = kind ? await placedStorage(ctx, kind, before) : null;
      if (landed) {
        const aimed = footprintRect(aim, size);
        const seen = { x: landed.x1 - aimed.x1, y: landed.y1 - aimed.y1 };
        if (Math.abs(seen.x) <= MAX_DRIFT && Math.abs(seen.y) <= MAX_DRIFT) {
          drift = seen;
          measured = true;
          ctx.state.drift = { camera: anchorCamera, ...drift };
        }
      }
      const rect = landed ?? footprintRect(site.tile, size);
      map.claim(building, { x: rect.x1 + Math.floor(size / 2), y: rect.y1 + Math.floor(size / 2) }, 0, true);
      placed.push({ x: at.x, y: at.y, side: site.side as Side, tilesOut: site.gap });
      if (storage) touching.push(rect);
      retried = undefined;
      continue;
    }
    const outward = site.side ? sideAxes[site.side as Side]?.along : undefined;
    const notAdjacent = result.feedback.some((f) => /adjacent/i.test(f));
    if (kind && site.gap === 0 && outward && retried?.site !== spot && (notAdjacent || (!result.feedback.length && !measured))) {
      const next = notAdjacent
        ? { x: drift.x + outward[0], y: drift.y + outward[1] }
        : { x: drift.x - outward[0], y: drift.y - outward[1] };
      if (Math.abs(next.x) <= MAX_DRIFT && Math.abs(next.y) <= MAX_DRIFT) {
        retried = { site: spot, drift };
        drift = next;
        if (!result.feedback.length) silent++;
        else feedback = result.feedback;
        continue;
      }
    }
    // Refused again after a correction: the drift was not why, so the correction goes.
    if (retried?.site === spot) {
      drift = retried.drift;
      retried = undefined;
    }
    // The spot is used up for this call; a "Too close to …" refusal also rules out its surroundings.
    map.claim(building, site.tile, result.feedback.some((f) => /too close/i.test(f)) ? TOO_CLOSE_MARGIN : 0, false);
    if (!result.feedback.length) silent++;
    // The map showed this footprint free. Short of resources, stop; otherwise a rule the map does
    // not model refused it ("Too close to signpost to build.", run 7), so the next spot may work.
    feedback = result.feedback.length ? result.feedback : feedback;
    missing = shortfall(building, ctx.device.currentStats().observation) ?? undefined;
    if (missing) { stopped = "not_enough_resources"; break; }
  }
  return {
    status: placed.length >= count ? "placed" as const : placed.length ? "partly_placed" as const : "not_placed" as const,
    anchor,
    placed,
    probes: attempts,
    method: "tile_map" as const,
    silent,
    ...(stopped && placed.length < count ? { stopped } : {}),
    ...(feedback.length ? { feedback } : {}),
    ...(missing ? { missing } : {}),
  };
}

/**
 * Probe lines for a building flush against the centred anchor. For each lateral
 * shift (none first) and each side (preferred first), points march outward one
 * tile at a time. The first placeable point on a line touches the
 * anchor (or whatever blocks it); lines stop at the visible terrain edge.
 */
export function adjacentRays(
  frame: Pick<Frame, "width" | "height">,
  span: Span,
  order: Side[] = sides,
  laterals = [0, 2, -2, 4, -4],
  dMin = 2,
  dMax = 7,
) {
  const rays: { side: Side; lateral: number; points: { x: number; y: number; d: number; tile: [number, number] }[] }[] = [];
  // All four sides straight out first, then each lateral shift: the likeliest flush spots come early.
  for (const lateral of laterals)
    for (const side of order) {
      const { along, across } = sideAxes[side];
      const points: { x: number; y: number; d: number; tile: [number, number] }[] = [];
      for (let d = dMin; d <= dMax; d++) {
        const tile: [number, number] = [along[0] * d + across[0] * lateral, along[1] * d + across[1] * lateral];
        const p = tilePixel(frame, span, ...tile);
        if (p.x < 0 || p.y < 0 || p.x >= frame.width || p.y >= frame.height * 0.82) break;
        points.push({ ...p, d, tile });
      }
      if (points.length) rays.push({ side, lateral, points });
    }
  return rays;
}

/** Side order with an optional preferred side first. */
export function sideOrder(preferred?: Side) {
  return preferred ? [preferred, ...sides.filter((s) => s !== preferred)] : sides;
}

/** Centre-tile distance between two camera keys (tiles); Infinity when either is missing. */
export function cameraShift(a: string | null, b: string | null) {
  if (!a || !b) return Infinity;
  const [ax, ay, ...ar] = a.split(",").map(Number);
  const [bx, by, ...br] = b.split(",").map(Number);
  if (ar.join() !== br.join()) return Infinity; // span or zoom changed
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

export type AnchorContext = {
  device: GameDevice;
  /** Fresh game-window capture registered for actions. */
  capture: () => Promise<Frame>;
  /**
   * A game-window capture for sending input only: the call's own last frame (to begin with the
   * device's latest capture), reused while it is comfortably younger than the device's input age
   * limit (FRAME_MAX_AGE_GAME_SECONDS, shared/protocol.ts), else a fresh one. Only the window's
   * size and id matter for a click or a minimap fraction, not its pixels, so an unseen frame a few
   * seconds old is as good as a new one.
   * Do not use this where pixels are inspected or a screenshot is returned to the model.
   */
  frame: () => Promise<Frame>;
  send: (frame: Frame, action: GameAction) => Promise<Ack>;
  hotkey: (name: GameHotkey) => Promise<Ack>;
  pause: (seconds: number) => Promise<unknown>;
  /** Native tile layers for the current view of `frame`; null when unavailable. */
  tiles?: (frame: Frame) => Promise<TileMap | null>;
  /** Per-run memory: the located stockpile's camera tile (bookmarked). */
  state: {
    stockpile?: string;
    /** The tiles the game put storage beyond where clicks aimed, in the view of `camera` (placeFromMap). */
    drift?: { camera: string; x: number; y: number };
  };
};

/**
 * Game seconds of play a cached frame may be to be reused (AnchorContext.frame): about 20 real
 * seconds at the benchmark speed, which leaves a call 13 game seconds of the input age limit
 * (FRAME_MAX_AGE_GAME_SECONDS) to send its input.
 */
export const FRAME_REUSE_GAME_SECONDS = 27;

/**
 * Wraps a capture function with a per-call cache: repeated calls return the same frame while
 * `age` (seconds of play, GameDevice.frameAge) stays under FRAME_REUSE_GAME_SECONDS, otherwise
 * `capture` runs again and its result is kept. Build one fresh per tool call (e.g. inside
 * model.ts's `anchorContext`) so the cache never outlives the call it was made for. `seed`, the
 * device's latest capture, serves the same way while young enough, so a call need not capture at
 * all (a capture took about 0.4 s of play in a 2026-10-11 run's records).
 */
export function frameCache(capture: () => Promise<Frame>, age: (frame: Frame) => number, seed: Frame | null = null) {
  let cached: Frame | null = seed;
  return async () => {
    if (cached && age(cached) < FRAME_REUSE_GAME_SECONDS) return cached;
    cached = await capture();
    return cached;
  };
}

const selectedId = (o: Observation | null | undefined) =>
  (o?.selected_building as { id?: number } | null | undefined)?.id ?? null;
export const ackTime = (ack: Ack) => (typeof ack?.at === "number" ? ack.at : Date.now());

/** Wait for a valid reader sample captured at or after `after` satisfying `done`. */
export async function sampleAfter(ctx: AnchorContext, after: number, done: (o: Observation) => boolean, seconds: number) {
  for (let i = 0; i < seconds / SAMPLE_POLL_SECONDS; i++) {
    const stats = ctx.device.currentStats();
    if (stats.status === "ok" && stats.observation && (stats.captured_unix_ms ?? 0) >= after && done(stats.observation))
      return stats.observation as Observation;
    await ctx.pause(SAMPLE_POLL_SECONDS);
  }
  return null;
}

/** Right-click open terrain near the top of the view: closes a building panel or placement mode. */
export async function dismiss(ctx: AnchorContext, frame: Frame) {
  const ack = await ctx.send(frame, { type: "click", x: Math.round(frame.width / 2), y: Math.round(frame.height * 0.12), button: 3 });
  await sampleAfter(ctx, ackTime(ack), (o) => selectedId(o) === null && placementOf(o)?.action !== 5, 0.8);
}

export type CentreResult = {
  status: "centred" | "already_centred" | "not_found" | "failed";
  anchor: Anchor;
  camera?: string | null;
  note?: string;
  /** Stockpiles the locating click placed because it happened to touch one. */
  placedWhileLocating?: { x: number; y: number }[];
};

/** Centre the camera on an anchor building and close any panel the hotkey opened. */
export async function centerOn(ctx: AnchorContext, anchor: Anchor): Promise<CentreResult> {
  if (anchor === "stockpile") return centerOnStockpile(ctx);
  const frame = await ctx.frame();
  const before = await sampleAfter(ctx, 0, () => true, 1);
  if (!before) return { status: "failed", anchor, note: "Reader unavailable; the camera cannot be confirmed." };
  const beforeCamera = cameraKey(before);
  const beforeSelected = selectedId(before);
  const hotkey = hotkeyAnchors[anchor];
  let ack = await ctx.hotkey(hotkey);
  let seen = await sampleAfter(ctx, ackTime(ack), (o) =>
    cameraKey(o) !== beforeCamera || (selectedId(o) !== null && selectedId(o) !== beforeSelected), 0.8);
  let moved = !!seen && cameraKey(seen) !== beforeCamera;
  if (!moved) {
    if (!seen)
      return {
        status: "not_found",
        anchor,
        camera: beforeCamera,
        note: `Its hotkey selected nothing: no ${anchor} is built (or it was already selected and centred).`,
      };
    // "Press to select" centring: the second press centres the camera on the selected building.
    ack = await ctx.hotkey(hotkey);
    seen = await sampleAfter(ctx, ackTime(ack), (o) => cameraKey(o) !== beforeCamera, 0.8);
    moved = !!seen;
  }
  await dismiss(ctx, frame);
  const camera = cameraKey(await sampleAfter(ctx, 0, () => true, 1));
  return { status: moved ? "centred" : "already_centred", anchor, camera };
}

/**
 * The stockpile has no centring hotkey. A stockpile placement away from every
 * stockpile is rejected ("Needs to be placed adjacent to the stockpile.") and
 * the game moves the camera onto the existing stockpile (live 2026-09-25 and
 * 2026-09-28). The located view is bookmarked for later calls.
 */
async function centerOnStockpile(ctx: AnchorContext): Promise<CentreResult> {
  const anchor = "stockpile";
  if (ctx.state.stockpile) {
    const before = cameraKey(await sampleAfter(ctx, 0, () => true, 1));
    const ack = await ctx.hotkey(`GotoBookmark${STOCKPILE_BOOKMARK}`);
    const seen = await sampleAfter(ctx, ackTime(ack), (o) => cameraKey(o) !== before, 0.8);
    const camera = cameraKey(seen ?? await sampleAfter(ctx, 0, () => true, 1));
    if (cameraShift(camera, ctx.state.stockpile) <= 1)
      return { status: seen ? "centred" : "already_centred", anchor, camera };
    // The bookmark no longer matches (e.g. overwritten); locate again.
    delete ctx.state.stockpile;
  }
  const frame = await ctx.frame();
  // Input goes through the call's reusable frame, captured afresh when it grows old: one frame
  // reused for a whole probe outlived the input age limit (three place_near Armory calls threw
  // "Game image expired" and left the game in placement mode, 2026-10-13).
  const placer = await new Placer(ctx.device, { send: async (a) => ctx.send(await ctx.frame(), a), pause: ctx.pause, frame }).init();
  if (!placer.readerReady) return { status: "failed", anchor, note: "Reader unavailable; the stockpile cannot be located." };
  if ((await placer.select("Stockpile")) === "failed")
    return { status: "failed", anchor, note: "The Stockpile button did not select; is the construction bar visible?" };
  const placedWhileLocating: { x: number; y: number }[] = [];
  let camera: string | null = null;
  // Far corners of the visible terrain: at least one is normally away from every stockpile.
  const corners = [[0.15, 0.2], [0.85, 0.2], [0.15, 0.7], [0.85, 0.62]].map(([fx, fy]) =>
    ({ x: Math.round(frame.width * fx), y: Math.round(frame.height * fy) }));
  for (const point of corners) {
    const start = cameraKey(ctx.device.currentStats().observation);
    const carried = visiblePlacementFeedback(ctx.device.currentStats().observation);
    const result = await placer.click("Stockpile", point, carried, ctx.device.events.cursor());
    if (result.outcome.status === "placed") placedWhileLocating.push(point);
    const moved = await sampleAfter(ctx, 0, (o) => cameraKey(o) !== start && cameraKey(o) !== null, 0.6);
    // The adjacency rejection shows the stockpile; when the view is already there the camera does not move.
    const adjacency = [...result.feedback, ...result.visible].some((text) => /adjacent to the stockpile/i.test(text));
    if (moved || adjacency) {
      camera = cameraKey(moved ?? await sampleAfter(ctx, 0, () => true, 1));
      break;
    }
  }
  await dismiss(ctx, frame);
  if (!camera)
    return { status: "not_found", anchor, placedWhileLocating, note: "No locating click moved the camera to a stockpile." };
  await ctx.hotkey(`SetBookmark${STOCKPILE_BOOKMARK}`);
  ctx.state.stockpile = camera;
  return { status: "centred", anchor, camera, ...(placedWhileLocating.length ? { placedWhileLocating } : {}) };
}

/**
 * Upper bound on terrain probes per call. Each costs ~0.7 s of play (game time runs while
 * probing); a live count-2 call spent all 30 after placing one, so the bound is 20.
 */
export const MAX_ADJACENT_PROBES = 20;

/**
 * Place `count` buildings flush against a centred anchor: probe lines march
 * outward from it; a silent block moves one tile further, a placement is
 * recorded (the next continues on the same line), and a game rejection ends
 * the line (for stockpiles and granaries, the adjacency band was passed).
 */
export async function placeAdjacent(
  ctx: AnchorContext,
  building: string,
  anchor: Anchor,
  count: number,
  preferred?: Side,
) {
  const centre = await centerOn(ctx, anchor);
  const placed: { x: number; y: number; side?: Side; lateral?: number; tilesOut?: number }[] =
    building === "Stockpile" ? [...(centre.placedWhileLocating ?? [])] : [];
  // Centres of flush neighbours sit half the two footprints apart; start a tile inside that (the
  // centred anchor can be off by a tile) and reach far enough to chain the requested count.
  const size = footprintOf(building);
  const flush = (anchorFootprintTiles[anchor] + size) / 2;
  const dMin = Math.max(1, Math.floor(flush) - 1);
  const dMax = Math.ceil(flush) + 2 + size * (count - 1);
  const placedTiles: [number, number][] = [];
  if (centre.status === "not_found" || centre.status === "failed")
    return { status: centre.status, anchor, placed, probes: 0, note: centre.note };
  const frame = await ctx.frame();
  const first = await sampleAfter(ctx, 0, () => true, 1);
  const span = cameraSpanOf(first);
  let anchorCamera = cameraKey(first);
  if (!span || !anchorCamera) return { status: "failed" as const, anchor, placed, probes: 0, note: "Reader camera unavailable." };
  // Input goes through the call's reusable frame, captured afresh when it grows old: one frame
  // reused for a whole probe outlived the input age limit (three place_near Armory calls threw
  // "Game image expired" and left the game in placement mode, 2026-10-13).
  const placer = await new Placer(ctx.device, { send: async (a) => ctx.send(await ctx.frame(), a), pause: ctx.pause, frame }).init();
  // With the native tile layers the flush spots are computed, not probed: the anchor is the
  // building nearest the camera centre, and each candidate's whole footprint is free. The read
  // (about 3 s on the game machine in a 2026-10-11 run's records) runs while the building is
  // selected, which leaves the camera where it is; a failed read falls back to probing.
  const reading = ctx.tiles?.(frame).catch(() => null);
  // Choosing a Stockpile, Granary or Armory centres the view on the first one of its kind, which can
  // be another view than the anchor's, and a refused stockpile jumps it to the stockpile: either
  // stopped GPT-6.1 Sol's expand_storage with camera_moved, in 4 of 5 calls on Large Barren Desert,
  // two before any spot was tried (1.6.3). As build_structure does, bookmark the anchor's view first
  // and go back to it, which keeps the building selected (a bookmark works in placement mode, live
  // 2026-10-12).
  const jumps = VIEW_JUMPERS.has(building);
  if (jumps) await ctx.hotkey(`SetBookmark${PLACEMENT_BOOKMARK}`);
  /** The camera once back within a tile of the anchor's view with the building still selected, or null. */
  const back = async (camera: string | null) => {
    if (cameraShift(camera, anchorCamera) <= 1) return camera;
    if (!jumps) return null;
    const ack = await ctx.hotkey(`GotoBookmark${PLACEMENT_BOOKMARK}`);
    const seen = await sampleAfter(ctx, ackTime(ack), (o) => cameraShift(cameraKey(o), anchorCamera) <= 1, 2);
    return seen && placementOf(seen)?.action === 5 ? cameraKey(seen) : null;
  };
  if ((await placer.select(building)) === "failed")
    return { status: "not_selected" as const, anchor, placed, probes: 0 };
  const map = await reading;
  let mapProbes = 0;
  if (map) {
    const viaMap = await placeFromMap(ctx, map, placer, building, anchor, count, preferred, placed, anchorCamera, back);
    // Every spot the map gave was refused without a word: the map and the game disagree about
    // where the click landed, so probe the view from the anchor outward instead of giving up.
    const probeOn = viaMap && viaMap.stopped === "no_more_free_spots" && viaMap.silent === viaMap.probes;
    if (viaMap && !probeOn) {
      await dismiss(ctx, await ctx.frame());
      const { silent: _silent, ...result } = viaMap;
      return result;
    }
    if (viaMap) mapProbes = viaMap.probes;
  }
  let probes = 0;
  let stopped: string | undefined;
  // The first line that reaches the anchor's edge (a placement or a rejection) shows how far out
  // the edge is; later lines start one tile inside it instead of probing from the anchor centre.
  let edge: number | undefined;
  outer: for (const ray of adjacentRays(frame, span, sideOrder(preferred), undefined, dMin, dMax)) {
    for (const point of ray.points) {
      if (edge !== undefined && point.d < edge - 1) continue;
      // A spot overlapping a building this call placed is certain to be blocked.
      if (placedTiles.some((t) => Math.max(Math.abs(t[0] - point.tile[0]), Math.abs(t[1] - point.tile[1])) < size)) continue;
      if (placed.length >= count) break outer;
      if (probes >= MAX_ADJACENT_PROBES) {
        stopped = "probe_limit";
        break outer;
      }
      // A stockpile rejection re-centres on the stockpile, which can differ by a tile from the bookmark.
      const camera = await back(cameraKey(await sampleAfter(ctx, 0, () => true, 1)));
      if (!camera) {
        stopped = "camera_moved";
        break outer;
      }
      anchorCamera = camera;
      probes++;
      const carried = visiblePlacementFeedback(ctx.device.currentStats().observation);
      const result = await placer.click(building, point, carried, ctx.device.events.cursor());
      const status = result.outcome.status;
      // A rejection text still showing from an earlier click (it lasts ~7 s, e.g. after locating the
      // stockpile) without a new message event or any cost/structure change is a silent block.
      const staleText = status === "possibly_rejected" && !result.feedback.length &&
        !result.outcome.change?.structures && !(result.outcome.change?.wood ?? 0) && !(result.outcome.change?.gold ?? 0);
      if (status === "placed") {
        placed.push({ x: point.x, y: point.y, side: ray.side, lateral: ray.lateral, tilesOut: point.d });
        placedTiles.push(point.tile);
        edge ??= point.d;
      } else if (status !== "not_placed" && !staleText) {
        edge ??= point.d;
        break; // a new rejection or ambiguity: this line is done
      }
    }
  }
  await dismiss(ctx, await ctx.frame());
  return {
    status: placed.length >= count ? "placed" as const : placed.length ? "partly_placed" as const : "not_placed" as const,
    anchor,
    placed,
    probes: mapProbes + probes,
    ...(mapProbes ? { method: "tile_map_then_probing" as const } : {}),
    ...(stopped ? { stopped } : {}),
  };
}

/**
 * The minimap shows a window about this many tile units across in screen axes (u = x - y
 * horizontally, v = x + y vertically), centred on the camera but kept inside the map, so
 * near an edge the camera sits off its centre (fits every live move, 2026-09-30).
 */
const MINIMAP_SPAN = 125;
const GO_TO_CLICKS = 4;
export type MapExtent = { umin: number; umax: number; vmin: number; vmax: number };

/** Minimap fractions that put the camera centre on `target`, given the current camera. */
export function minimapFraction(camera: { x: number; y: number }, target: { x: number; y: number }, extent: MapExtent) {
  const axis = (c: number, t: number, lo: number, hi: number) => {
    const start = hi - lo > MINIMAP_SPAN ? Math.min(Math.max(c - MINIMAP_SPAN / 2, lo), hi - MINIMAP_SPAN) : (lo + hi - MINIMAP_SPAN) / 2;
    return Math.min(0.99, Math.max(0.01, (t - start) / MINIMAP_SPAN));
  };
  return {
    x: axis(camera.x - camera.y, target.x - target.y, extent.umin, extent.umax),
    y: axis(camera.x + camera.y, target.x + target.y, extent.vmin, extent.vmax),
  };
}

/**
 * Move the camera centre to `target` with minimap clicks, reading the camera after each
 * until within 2 tiles, or until it stops moving (the camera cannot reach the map edge).
 */
export async function goToTile(ctx: AnchorContext, target: { x: number; y: number }, extent: MapExtent) {
  const cameraOf = (o: Observation | null) => {
    const c = o?.camera as { centre_tile_x?: number; centre_tile_y?: number } | undefined;
    return typeof c?.centre_tile_x === "number" && typeof c.centre_tile_y === "number" ? { x: c.centre_tile_x, y: c.centre_tile_y } : null;
  };
  let camera = cameraOf(await sampleAfter(ctx, 0, (o) => !!cameraOf(o), 2));
  if (!camera) return { status: "no_camera" as const, clicks: 0 };
  let clicks = 0, still = 0;
  while (clicks < GO_TO_CLICKS && Math.max(Math.abs(target.x - camera.x), Math.abs(target.y - camera.y)) > 2) {
    const f = minimapFraction(camera, target, extent);
    const frame = await ctx.frame();
    const ack = await ctx.send(frame, minimapClick(frame, f.x, f.y));
    clicks++;
    // Let the camera settle, then read it from a sample taken after the click.
    await ctx.pause(0.5);
    const next = cameraOf(await sampleAfter(ctx, ackTime(ack) + 400, (o) => !!cameraOf(o), 2));
    if (!next) return { status: "no_camera" as const, clicks };
    const moved = next.x !== camera.x || next.y !== camera.y;
    camera = next;
    // A click can be swallowed (an open panel, run 10); stop only after two that did nothing.
    if (moved) still = 0;
    else if (++still >= 2) break;
  }
  const off = Math.max(Math.abs(target.x - camera.x), Math.abs(target.y - camera.y));
  return { status: off <= 2 ? "arrived" as const : "stopped_short" as const, camera, tilesOff: off, clicks };
}
