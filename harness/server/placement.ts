import type { GameAction } from "../shared/protocol.js";
import type { GameDevice } from "./device.js";
import {
  buildingCost,
  cameraKey,
  confirmPlacement,
  menuClicks,
  placementFeedback,
  placementOf,
  placementStatus,
  selectionConfirmed,
  snapshotOf,
  visiblePlacementFeedback,
  type Snapshot,
} from "./construction-ui.js";

// A terrain click's cost, new structure or rejection text was in the first reader sample after the
// click acknowledgement (+0 to +70 ms at 10 Hz sampling, live 2026-09-28); 120 ms leaves a margin.
export const SETTLE_MS = 120;
// How often tools look for a new reader sample (the reader samples every 100 ms by default).
export const SAMPLE_POLL_SECONDS = 0.025;

export type Ack = { at?: number } | undefined;
export type Observation = Record<string, unknown>;

/** Pointer moves a click aimed at a tile makes to put the cursor on it before clicking. */
export const AIM_MOVES = 3;
/** Time after a pointer move for the game to show the tile under it (it reads its input every frame). */
const AIM_SETTLE_MS = 50;
/**
 * Furthest, in tiles along each axis, a view's offset is kept for its next targets, and is followed
 * sideways (across the screen); up or down it is followed as far as the screen goes, since raised
 * ground drawn higher than the height read for it puts the game's tile further down the map.
 */
const MAX_AIM_OFFSET = 3;
/**
 * How far the game's tile under the pointer lay from the projected tile in one view (the camera's
 * key), kept across calls so the next target in that view starts from it.
 */
export type ViewOffset = { camera: string; x: number; y: number };

/** The map tile the game shows under the mouse pointer (observation.mouse_tile), or null. */
export function mouseTileOf(observation: Observation | null | undefined) {
  const t = observation?.mouse_tile as { x?: unknown; y?: unknown } | null | undefined;
  return t && typeof t.x === "number" && typeof t.y === "number" ? { x: t.x, y: t.y } : null;
}

/** What aimAtTile works with: reader samples, pointer moves, waits, the image's size, the run's view offsets. */
export type AimIo = {
  device: Pick<GameDevice, "currentStats">;
  move: (point: { x: number; y: number }) => Promise<Ack>;
  pause: (seconds: number) => Promise<unknown>;
  frame: { width: number; height: number };
  offsets?: { view?: ViewOffset };
};

type Tile = { x: number; y: number };

/**
 * The point to click for map tile `tile`, from `point`, its projection: the pointer goes there
 * first, the reader shows the tile the game picks under it (mouse_tile), and while that is not
 * `accept`ed (by default, `tile` itself) the pointer moves by the difference, up to AIM_MOVES
 * times. The reader's camera is a whole tile, and the view can lie part of a tile from it, so a
 * projected click could pick a neighbour: every building placed by tile on Large Barren Desert's
 * start went one tile off (live 2026-10-14). A building drawn over the spot keeps the game's tile
 * on itself however the pointer moves (a fletcher in front of a hovel's corner took a demolish
 * meant for the hovel, live 2026-10-14), so the moves stop when the tile does not follow them.
 * `matched` says the game's tile was accepted at `point`; otherwise `point` is where its tile came
 * closest to `tile`, and `shown` that tile (null without any reading). An exact match keeps the
 * view's offset (io.offsets) when it is small, so the next target there starts from it.
 */
export async function aimAtTile(io: AimIo, point: Tile, tile: Tile, accept: (shown: Tile) => boolean = (t) => t.x === tile.x && t.y === tile.y) {
  const unaimed = { point, shown: null as Tile | null, matched: false, moves: 0 };
  const sampleAfter = async (after: number, done: (o: Observation) => boolean, seconds: number) => {
    for (let i = 0; i < seconds / SAMPLE_POLL_SECONDS; i++) {
      const stats = io.device.currentStats();
      if (stats.status === "ok" && stats.observation && (stats.captured_unix_ms ?? 0) >= after && done(stats.observation as Observation))
        return stats.observation as Observation;
      await io.pause(SAMPLE_POLL_SECONDS);
    }
    return null;
  };
  const latest = await sampleAfter(0, () => true, 0.3);
  // A reader without the field (before 1.7.0) gives nothing to aim by.
  if (!latest || !("mouse_tile" in latest)) return unaimed;
  const camera = cameraKey(latest);
  const span = latest.camera as { tiles_wide?: number; tiles_high?: number } | null | undefined;
  if (!camera || !span?.tiles_wide || !span?.tiles_high) return unaimed;
  const { width, height } = io.frame;
  // One tile along x moves the drawing half a tile right and a row down; along y, left and down.
  const half = width / span.tiles_wide / 2, row = height / span.tiles_high;
  const at = (d: Tile) => ({ x: Math.round(point.x - (d.x - d.y) * half), y: Math.round(point.y - (d.x + d.y) * row) });
  const distance = (t: Tile) => Math.max(Math.abs(t.x - tile.x), Math.abs(t.y - tile.y));
  const kept = io.offsets?.view;
  let offset = kept && kept.camera === camera ? { x: kept.x, y: kept.y } : { x: 0, y: 0 };
  const first = at(offset);
  let best: { point: Tile; shown: Tile } | null = null;
  let last: Tile | null = null;
  let moves = 0;
  for (let i = 0; i < AIM_MOVES; i++) {
    const p = at(offset);
    if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height * 0.8) break;
    const ack = await io.move(p);
    moves++;
    const sent = typeof ack?.at === "number" ? ack.at : Date.now();
    const seen = await sampleAfter(sent + AIM_SETTLE_MS, (o) => cameraKey(o) === camera && !!mouseTileOf(o), 1);
    const shown = seen ? mouseTileOf(seen) : null;
    if (!shown) break;
    if (accept(shown)) {
      // A view's offset is the camera's part tile, kept for its next targets; a larger one is this tile's height.
      const small = Math.abs(offset.x) <= MAX_AIM_OFFSET && Math.abs(offset.y) <= MAX_AIM_OFFSET;
      if (shown.x === tile.x && shown.y === tile.y && small && io.offsets) io.offsets.view = { camera, ...offset };
      return { point: p, shown, matched: true, moves };
    }
    if (!best || distance(shown) < distance(best.shown)) best = { point: p, shown };
    // The game's tile stayed put although the pointer moved: something is drawn over the spot.
    if (last && last.x === shown.x && last.y === shown.y) break;
    last = shown;
    const next = { x: offset.x + shown.x - tile.x, y: offset.y + shown.y - tile.y };
    // Sideways is x - y (half tiles across the screen); x + y runs down it (rows).
    if (Math.abs(next.x - next.y) > 2 * MAX_AIM_OFFSET) break;
    offset = next;
  }
  return best ? { ...best, matched: false, moves } : { ...unaimed, point: first, moves };
}

/**
 * Construction-menu selection and terrain clicks for one targeting image,
 * confirmed from reader samples. Shared by build_structure and the anchor tools.
 */
export class Placer {
  private openCategory?: string;
  private selected?: string;
  /** Whether reader samples confirm selections and placements; see init(). */
  readerReady: boolean;
  constructor(
    private device: GameDevice,
    private io: {
      send: (action: GameAction) => Promise<Ack>;
      pause: (seconds: number) => Promise<unknown>;
      frame: { width: number; height: number };
      /** Moves the pointer without a click (GameDevice.move); without it, clicks are not aimed. */
      move?: (point: { x: number; y: number }) => Promise<Ack>;
      /** Where each view's offset is kept between calls (aim). */
      offsets?: { view?: ViewOffset };
    },
    /** A category already known open in the game (e.g. left open by an earlier call); see select(). */
    openCategory?: string,
  ) {
    this.readerReady = device.currentStats().status === "ok";
    this.openCategory = openCategory;
  }
  /** The construction tray's category left open by the calls so far, for a later call to reuse. */
  get category() {
    return this.openCategory;
  }
  /** A live stream has brief unavailable samples: wait up to 1 s for a valid one before deciding. */
  async init() {
    for (let i = 0; !this.readerReady && i < 1 / SAMPLE_POLL_SECONDS; i++) {
      await this.io.pause(SAMPLE_POLL_SECONDS);
      this.readerReady = this.device.currentStats().status === "ok";
    }
    return this;
  }
  ackTime(ack: Ack) {
    return typeof ack?.at === "number" ? ack.at : Date.now();
  }
  /** Wait for a reader sample captured at or after `after` (same Ubuntu clock as the ack) that satisfies `done`. */
  async sampleAfter(after: number, done: (o: Observation) => boolean, seconds: number) {
    for (let i = 0; i < seconds / SAMPLE_POLL_SECONDS; i++) {
      const stats = this.device.currentStats();
      if (stats.status === "ok" && stats.observation && (stats.captured_unix_ms ?? 0) >= after && done(stats.observation))
        return stats.observation as Observation;
      await this.io.pause(SAMPLE_POLL_SECONDS);
    }
    return null;
  }
  /**
   * The latest valid reader sample, waiting up to 0.3 s past an unavailable one (about 5% of live
   * samples): a missing "before" sample left a real placement `unverified` and a blocked one
   * unretried, and a missing selection state skipped the selection check.
   */
  private current() {
    return this.sampleAfter(0, () => true, 0.3);
  }
  /**
   * The settle sample for a terrain click is the first captured SETTLE_MS after the ack, or an
   * earlier post-click one that already confirms the placement (one more of `name`, a new
   * structure or the exact cost).
   */
  private async settle(ack: Ack, cost: ReturnType<typeof buildingCost>, before: Snapshot | null, name: string) {
    const at = this.ackTime(ack);
    for (let i = 0; i < 2 / SAMPLE_POLL_SECONDS; i++) {
      const stats = this.device.currentStats();
      const captured = stats.captured_unix_ms ?? 0;
      if (stats.status === "ok" && stats.observation && captured >= at &&
          (captured >= at + SETTLE_MS || confirmPlacement("unverified", cost, before, snapshotOf(stats.observation), name).status === "placed"))
        return stats.observation as Observation;
      await this.io.pause(SAMPLE_POLL_SECONDS);
    }
    return null;
  }
  /** Select the building; with a reader, confirm placement mode switched to it, retrying once. */
  async select(name: string): Promise<"confirmed" | "unchecked" | "failed"> {
    const [category, ...rest] = menuClicks(this.io.frame, name);
    const button = rest.pop()!;
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = this.readerReady ? placementOf(await this.current()) : null;
      await this.io.send(category);
      // A newly opened tray page fades in for ~0.5–0.7 s and ignores building clicks meanwhile (live 2026-09-25).
      const categoryKey = JSON.stringify(category);
      if (categoryKey !== this.openCategory || attempt > 0) await this.io.pause(0.8);
      this.openCategory = categoryKey;
      // A good or bad thing sits on a subpage of the Town page, which fades in the same way. The tray
      // stays on it, so the next selection opens its category page afresh.
      for (const page of rest) {
        await this.io.send(page);
        await this.io.pause(0.8);
        this.openCategory = undefined;
      }
      const ack = await this.io.send(button);
      if (!before) return "unchecked";
      const now = await this.sampleAfter(this.ackTime(ack), (o) => {
        const p = placementOf(o);
        return !!p && selectionConfirmed(before, p, this.selected === name);
      }, 1.5);
      if (now) {
        this.selected = name;
        return "confirmed";
      }
      this.openCategory = undefined;
    }
    this.selected = undefined;
    return "failed";
  }
  /** aimAtTile with this Placer's reader, pointer moves and view offsets; unaimed without a reader or moves. */
  async aim(point: { x: number; y: number }, tile: { x: number; y: number }) {
    if (!this.io.move || !this.readerReady) return { point, shown: null, matched: false, moves: 0 };
    return aimAtTile({ device: this.device, move: this.io.move, pause: this.io.pause, frame: this.io.frame, offsets: this.io.offsets }, point, tile);
  }
  /**
   * One terrain click in the active placement mode, classified from feedback events since
   * `eventStart`. With `tile`, the map tile `point` was projected from, the click is aimed first.
   */
  async click(name: string, point: { x: number; y: number }, carried: string[], eventStart: number, tile?: { x: number; y: number }) {
    const cost = buildingCost(name);
    const aimed = tile ? await this.aim(point, tile) : null;
    if (aimed) point = aimed.point;
    const before = this.readerReady ? snapshotOf(await this.current()) : null;
    const ack = await this.io.send({ type: "click", x: point.x, y: point.y, button: 1 });
    const after = this.readerReady ? await this.settle(ack, cost, before, name) : await this.io.pause(0.3).then(() => null);
    const feedback = placementFeedback(this.device.events.since(eventStart));
    const visible = visiblePlacementFeedback(this.device.currentStats().observation);
    const outcome = confirmPlacement(placementStatus(feedback, visible, carried), cost, before, snapshotOf(after), name);
    return { outcome, feedback, visible, after, point, ...(aimed ? { aimed } : {}) };
  }
}
