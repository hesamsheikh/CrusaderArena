import type { TileRegion } from "./device.js";
import { decorationNames } from "./decorations.js";
import { footprintOf } from "./footprints.js";

/**
 * Per-tile placement knowledge from the engine's native layers (live on Oasis by the
 * Sea-1, 2026-09-29), with the checks taken from the game's own placement code (static
 * analysis of Steam build 24816905):
 * - structure: building instance id, nonzero on every footprint tile (and the keep's
 *   7×7 campfire courtyard);
 * - organism: trees, palms, bushes and rock outcrops;
 * - logic: 0x8000 ordinary land, 0x2000 the ring around a tree, 0x20000 stone ground,
 *   0x80000 iron ore, bit 31 oil: all buildable. Blocking: 0x1, 0x4 farm field, 0x10/0x20
 *   mountain, 0x80 rock, 0x400 courtyard, 0x1000 trunk, 0x100000 water, 0x200000,
 *   0x0f000000 building marks, 0x10000000 keep, 0x20000000, 0x40000000; unknown bits are
 *   treated as blocking too;
 * - occupancy: units on the tile, positive for the player's own, negative for others; a
 *   herd of camels (-1) lying on an oasis silently refused an orchard (2026-09-30, the game
 *   code blocks some unit types), so negative occupancy blocks;
 * - logic2: ground type: 0 bare earth, 1 scrub, 2 gravel, 16 dense oasis grass,
 *   -128 oasis grass (8 and 64 occur but only matter to farms, which refuse them).
 * A building of side S clicked on tile c covers c - floor(S/2) .. c - floor(S/2) + S - 1
 * on both axes. Farms need oasis or scrub on every tile ("Farms must be placed on an
 * oasis.") and at least 50 oasis tiles ("This land is not fertile enough."): 62% of a 9×9,
 * 50% of a 10×10. A quarry needs 8 stone tiles, an iron mine 4 ore tiles, a pitch rig 1 oil
 * tile in its footprint. Each of these grounds is the only one its building can use, so the
 * spots chosen here keep every building off the others' ground (oasis grass, stone, ore,
 * oil), though the game allows most buildings there. Other buildings are refused ("Too close
 * to signpost to build.") when the footprint's top-left tile lies within signpost_radius + 5
 * tiles, straight-line, of a signpost tile. The static reading was an 8-connected flood of
 * radius + 4 steps; live on Oasis by the Sea (radius 7) spots 9-11.2 tiles away were refused
 * and 12.6-15 placed, including a diagonal 10 steps away, which fits a circle of 12 and not
 * the flood.
 */
const LAND = 0x8000;
const TREE_RING = 0x2000;
/**
 * A trunk tile: an organism on it with this bit. Trees and cacti both have it; only a tree has a ring
 * of TREE_RING tiles around it, within TREE_RING_REACH tiles of its trunk (live on Oasis by the Sea and
 * Large Barren Desert, 2026-10-11: every palm had one, no cactus did, and the desert has none at all).
 * The map summary's "T" is a trunk with a ring, its "c" one without.
 */
const TRUNK = 0x1000;
const TREE_RING_REACH = 3;
const STONE = 0x20000;
const ORE = 0x80000;
const OIL = 0x80000000;
const GROUND = LAND | STONE | ORE | OIL;
const BUILDABLE = GROUND | TREE_RING;
/** Deposit ground: stone, iron ore and oil, each the only ground of one building. */
const DEPOSITS = STONE | ORE | OIL;
const OASIS = new Set([16, -128]);
const FARM_GROUND = new Set([16, -128, 1]);
const FARM_MIN_OASIS_TILES = 50;
export const farmNames = new Set(["Wheat Farm", "Hops Farm", "Apple Orchard", "Dairy Farm"]);
/** Buildings that need a minimum number of tiles of one ground in their footprint. */
const resourceGround: Record<string, { bit: number; min: number; reason: string }> = {
  Quarry: { bit: STONE, min: 8, reason: "no_stone" },
  "Iron Mine": { bit: ORE, min: 4, reason: "no_ore" },
  "Pitch Rig": { bit: OIL, min: 1, reason: "no_oil" },
};
/** Buildings refused off their resource ground (e.g. "Iron mine must be built on Iron ore."),
 * retried nearby on matching ground the same way a farm is retried on oasis. */
export const resourceGroundNames = new Set(Object.keys(resourceGround));

/**
 * Engine building types, as the tile probe reports them per instance (structure_types; the open
 * panel's type uses the same numbers). A stockpile is not one building: it is four 2×2 piles
 * (type 10) at the corners of a 5×5 square with a one-tile walkway between them, each holding one
 * good (live on Oasis by the Sea, 2026-10-09). The keep's campfire courtyard is its own building;
 * hovels are type 1 (live, 2026-10-09).
 */
export const STRUCTURE_TYPES = { hovel: 1, pile: 10, armory: 11, granary: 19, market: 26, keep: 41, signpost: 52, courtyard: 55 } as const;
const SIGNPOST_TYPE = STRUCTURE_TYPES.signpost;
/**
 * Buildings without workers walking in and out. Every other building needs one whole side of open
 * ground: its workers go in and out there, and one closed in on all four sides stays empty (live,
 * 2026-10-09: a woodcutter boxed in by four hovels showed the no-entry sign and "no access to keep"
 * and got no worker while 19 peasants stood idle; one beside it with an open side was staffed). Two
 * rows back to back, or blocks of four, leave each an outer side.
 */
const noWorkers = new Set(["Hovel", "Marketplace", "Stockpile", "Granary", "Armory", ...decorationNames]);
export const needsOpenSide = (building: string) => !noWorkers.has(building);
/**
 * Engine types that need no open side. Buildings of other types in the map, including ones the
 * harness cannot name, are kept with an open side too.
 */
const noOpenSideTypes = new Set<number>([STRUCTURE_TYPES.hovel, STRUCTURE_TYPES.pile, STRUCTURE_TYPES.armory, STRUCTURE_TYPES.granary,
  STRUCTURE_TYPES.market, STRUCTURE_TYPES.keep, STRUCTURE_TYPES.courtyard, SIGNPOST_TYPE,
  // Good and bad things (the game's eStructs: gallows to garden, cesspit to dunking stool, statue to pond).
  ...[62, 63, 64, 65, 66, 91, 92, 93, 94, 95, 96, 97, 98, 100, 101, 102, 103, 104]]);
/** Placement groups the game never runs the signpost check for. */
const signpostExempt = new Set(["Woodcutter", "Ox Tether", "Stockpile", "Granary", "Armory", "Quarry", "Iron Mine", "Pitch Rig", ...farmNames]);

export type TileCamera = { centre_tile_x: number; centre_tile_y: number; tiles_wide: number; tiles_high: number };
type Camera = TileCamera;
type Size = { width: number; height: number };
export type Tile = { x: number; y: number };
export type Rect = { x1: number; y1: number; x2: number; y2: number };
/** A building's footprint, whether its workers need an open side (see needsOpenSide), and its name when known. */
export type Footprint = Rect & { needsOpenSide?: boolean; building?: string };
/**
 * Storage that spots chosen by the harness keep one tile of open ground around, by engine type:
 * granaries and armories, which workers keep walking to (the user's rule, 2026-10-12). One may
 * touch another of its own kind: the game wants a new granary against the granary.
 */
const SPACED_STORAGE: Record<string, number> = { Granary: 19, Armory: 11 };
export type Site = { tile: Tile; x: number; y: number; oasisShare?: number; side?: string; gap?: number; trees?: number; ground?: string };
/**
 * How a spot is chosen. `reserve` (the default): keep off every other building's ground, for
 * spots the harness picks itself. Without it, as find_sites offers spots for the model to choose
 * among, anything the game allows, and `ground` keeps only spots on that ground (groundOf).
 */
export type SiteOptions = { reserve?: boolean; ground?: string; spaced?: boolean };
/** Tiles around a woodcutter site in which find_sites counts trees. */
export const WOODCUTTER_REACH = 12;

export function footprintRect(centre: Tile, size: number): Rect {
  const a = Math.floor(size / 2);
  return { x1: centre.x - a, y1: centre.y - a, x2: centre.x - a + size - 1, y2: centre.y - a + size - 1 };
}
const overlaps = (a: Rect, b: Rect) => a.x1 <= b.x2 && b.x1 <= a.x2 && a.y1 <= b.y2 && b.y1 <= a.y2;
const inside = (t: Tile, r: Rect) => t.x >= r.x1 && t.x <= r.x2 && t.y >= r.y1 && t.y <= r.y2;
const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/**
 * Screen rows one unit of terrain height (the tile layers' `height`) raises a tile. The game draws
 * raised ground higher: on Oasis by the Sea a hovel aimed at a plateau tile of height 130 by its
 * flat position was refused five times, and the click that placed it there was 15 rows higher
 * (live 2026-10-12); on the low ground of height 8 by the keep, clicks one row higher than the
 * flat position had landed on their tiles (2026-09-30). One row per 8.7 units fits both.
 */
const ROWS_PER_HEIGHT = 1 / 8.7;
/** Terrain height assumed where none is read: the low ground the flat formula was calibrated on. */
export const DEFAULT_HEIGHT = 8;

/** The pixel a click must hit for the game to pick tile t, at terrain height `height`: the tile's centre as drawn. */
export function tilePixel(camera: Camera, frame: Size, t: Tile, height = DEFAULT_HEIGHT) {
  const half = frame.width / camera.tiles_wide / 2;
  const row = frame.height / camera.tiles_high;
  const dx = t.x - camera.centre_tile_x, dy = t.y - camera.centre_tile_y;
  return { x: Math.round(frame.width / 2 + (dx - dy) * half), y: Math.round(frame.height / 2 + (dx + dy - height * ROWS_PER_HEIGHT) * row) };
}
/** On visible terrain above the HUD, away from the edges. */
export function onScreen(frame: Size, p: { x: number; y: number }) {
  return p.x >= 20 && p.y >= 20 && p.x < frame.width - 20 && p.y < frame.height * 0.8;
}

export class TileMap {
  private claimed: Footprint[] = [];
  private signposts?: Tile[];
  private trees?: Tile[];
  private buildings?: Footprint[];
  constructor(
    readonly region: TileRegion,
    readonly camera: Camera,
    readonly frame: Size,
    /**
     * Sites anywhere in the region, not only on screen: for find_sites around a tile of the
     * model's choice, whose spots build_structure reaches by moving the camera.
     */
    readonly anywhere = false,
  ) {}
  /** A square region of `radius` tiles around `centre`, inside the map and the probe's 160 × 160 limit. */
  static regionAround(centre: Tile, radius: number) {
    const r = Math.min(radius, 79);
    const x0 = Math.max(1, centre.x - r);
    const y0 = Math.max(1, centre.y - r);
    return { x0, y0, w: Math.min(2 * r + 1, 799 - x0), h: Math.min(2 * r + 1, 799 - y0) };
  }
  /** The region covering the visible view (plus a margin) around the camera centre. */
  static regionFor(camera: Camera) {
    // The view is a diamond: |dx - dy| <= tiles_wide / 2 and |dx + dy| <= tiles_high / 2.
    const r = Math.ceil((camera.tiles_wide + camera.tiles_high) / 4) + 4;
    const x0 = Math.max(1, camera.centre_tile_x - r);
    const y0 = Math.max(1, camera.centre_tile_y - r);
    return { x0, y0, w: Math.min(2 * r, 799 - x0), h: Math.min(2 * r, 799 - y0) };
  }
  private value(layer: keyof TileRegion["layers"], t: Tile) {
    const { x0, y0, w, h } = this.region;
    if (t.x < x0 || t.y < y0 || t.x >= x0 + w || t.y >= y0 + h) return undefined;
    return this.region.layers[layer][(t.y - y0) * w + (t.x - x0)];
  }
  /** Buildable: inside the read region, no building, no organism, no animal, ordinary land. */
  free(t: Tile) {
    return (this.value("occupancy", t) ?? 0) >= 0 && this.ground(t);
  }
  /** Inside the read region, no building or organism, ordinary land, not claimed. */
  private ground(t: Tile) {
    const logic = this.value("logic", t);
    if (logic === undefined) return false;
    if (this.value("structure", t) || this.value("organism", t)) return false;
    if (!(logic & GROUND) || (logic >>> 0) & ~BUILDABLE) return false;
    return !this.claimed.some((r) => inside(t, r));
  }
  /**
   * Ground workers can cross that nothing stands on: buildable land (animals move away) or the
   * keep's courtyard, outside `closed`. Conservative: trees, bushes, rocks, water, cliffs and farm
   * fields count as closed.
   */
  private open(t: Tile, closed: readonly Rect[]) {
    if (closed.some((r) => inside(t, r))) return false;
    const id = this.value("structure", t);
    if (id) return this.region.structure_types?.[id] === STRUCTURE_TYPES.courtyard;
    return this.ground(t);
  }
  /** How many of a footprint's four sides have open ground along their whole length. */
  openSides(r: Rect, closed: readonly Rect[] = []) {
    const xs = span(r.x1, r.x2), ys = span(r.y1, r.y2);
    return [
      ys.map((y) => ({ x: r.x1 - 1, y })), ys.map((y) => ({ x: r.x2 + 1, y })),
      xs.map((x) => ({ x, y: r.y1 - 1 })), xs.map((x) => ({ x, y: r.y2 + 1 })),
    ].filter((side) => side.every((t) => this.open(t, closed))).length;
  }
  /** Footprints of the buildings in the region, each marked whether it needs an open side. */
  private existing(): Footprint[] {
    if (this.buildings) return this.buildings;
    const { x0, y0, w, layers, structure_types: types } = this.region;
    const rects = new Map<number, Rect>();
    layers.structure.forEach((id, i) => {
      if (!id) return;
      const x = x0 + (i % w), y = y0 + Math.floor(i / w);
      const r = rects.get(id);
      rects.set(id, r
        ? { x1: Math.min(r.x1, x), y1: Math.min(r.y1, y), x2: Math.max(r.x2, x), y2: Math.max(r.y2, y) }
        : { x1: x, y1: y, x2: x, y2: y });
    });
    this.buildings = [...rects].map(([id, r]) => ({ ...r, needsOpenSide: !noOpenSideTypes.has(types?.[id] ?? -1) }));
    return this.buildings;
  }
  /**
   * Whether a footprint for `building` would touch a granary or armory (or, for one of those, any
   * other building) with no tile between them: built, placed during this call, or `planned`.
   * Another of the same kind may touch it, and so may the keep's open courtyard.
   */
  touchesStorage(building: string, rect: Rect, planned: readonly Footprint[] = []) {
    const own = SPACED_STORAGE[building];
    const ring = { x1: rect.x1 - 1, y1: rect.y1 - 1, x2: rect.x2 + 1, y2: rect.y2 + 1 };
    const types = this.region.structure_types ?? {};
    for (let x = ring.x1; x <= ring.x2; x++)
      for (let y = ring.y1; y <= ring.y2; y++) {
        if (inside({ x, y }, rect)) continue;
        const id = this.value("structure", { x, y });
        if (!id) continue;
        const type = types[id];
        if (type === undefined || type === STRUCTURE_TYPES.courtyard || type === own) continue;
        if (own !== undefined || Object.values(SPACED_STORAGE).includes(type)) return true;
      }
    for (const n of [...this.claimed, ...planned]) {
      if (!n.building || !overlaps(n, ring) || overlaps(n, rect) || n.building === building && own !== undefined) continue;
      if (own !== undefined || SPACED_STORAGE[n.building] !== undefined) return true;
    }
    return false;
  }
  /**
   * Whether `building` at `centre` keeps an open side if it has workers, and leaves one to every
   * neighbour with workers that has one now: built, placed during this call, or `planned` (about to
   * be placed, not in the map yet).
   */
  access(building: string, centre: Tile, planned: readonly Footprint[] = [], spaced = true): { ok: boolean; reason?: "no_open_side" | "closes_neighbour" | "touches_storage" } {
    const rect = footprintRect(centre, footprintOf(building));
    if (needsOpenSide(building) && !this.openSides(rect, planned)) return { ok: false, reason: "no_open_side" };
    if (spaced && this.touchesStorage(building, rect, planned)) return { ok: false, reason: "touches_storage" };
    const ring = { x1: rect.x1 - 1, y1: rect.y1 - 1, x2: rect.x2 + 1, y2: rect.y2 + 1 };
    for (const n of [...this.existing(), ...this.claimed, ...planned]) {
      if (!n.needsOpenSide || !overlaps(n, ring) || overlaps(n, rect)) continue;
      if (this.openSides(n, planned) && !this.openSides(n, [...planned, rect])) return { ok: false, reason: "closes_neighbour" };
    }
    return { ok: true };
  }
  /** Raw layer values at one tile (diagnostics). */
  describe(t: Tile) {
    const v = (l: keyof TileRegion["layers"]) => this.value(l, t);
    return { structure: v("structure"), organism: v("organism"), logic: v("logic")?.toString(16), logic2: v("logic2"), height: v("height"), occupancy: v("occupancy") };
  }
  structureAt(t: Tile) {
    return this.value("structure", t) ?? 0;
  }
  /** Bounding rectangle of one building instance inside the region. */
  structureRect(id: number): Rect | null {
    if (!id) return null;
    const { x0, y0, w } = this.region;
    let rect: Rect | null = null;
    this.region.layers.structure.forEach((v, i) => {
      if (v !== id) return;
      const x = x0 + (i % w), y = y0 + Math.floor(i / w);
      rect = rect
        ? { x1: Math.min(rect.x1, x), y1: Math.min(rect.y1, y), x2: Math.max(rect.x2, x), y2: Math.max(rect.y2, y) }
        : { x1: x, y1: y, x2: x, y2: y };
    });
    return rect;
  }
  /** Footprints of every building of one type in the region. */
  rectsOfType(type: number): Rect[] {
    return Object.entries(this.region.structure_types ?? {})
      .filter(([, t]) => t === type)
      .map(([id]) => this.structureRect(Number(id)))
      .filter((r): r is Rect => r !== null);
  }
  /**
   * Stockpile or granary footprints in the region. A stockpile's square starts at a pile, or three
   * tiles before it when a pile of the same square lies there; a granary is one 4×4 building.
   */
  storageRects(kind: "Stockpile" | "Granary" | "Armory"): Rect[] {
    if (kind === "Granary") return this.rectsOfType(STRUCTURE_TYPES.granary);
    if (kind === "Armory") return this.rectsOfType(STRUCTURE_TYPES.armory);
    const piles = this.rectsOfType(STRUCTURE_TYPES.pile);
    const at = new Set(piles.map((r) => `${r.x1},${r.y1}`));
    const squares = new Map<string, Rect>();
    for (const r of piles) {
      const x = at.has(`${r.x1 - 3},${r.y1}`) ? r.x1 - 3 : r.x1;
      const y = at.has(`${r.x1},${r.y1 - 3}`) ? r.y1 - 3 : r.y1;
      squares.set(`${x},${y}`, { x1: x, y1: y, x2: x + 4, y2: y + 4 });
    }
    return [...squares.values()];
  }
  /** The footprint among `rects` nearest the camera centre (0 when the centre lies inside it). */
  nearestToCentre(rects: Rect[]): Rect | null {
    const c = { x: this.camera.centre_tile_x, y: this.camera.centre_tile_y };
    const distance = (r: Rect) => Math.max(r.x1 - c.x, c.x - r.x2, 0) + Math.max(r.y1 - c.y, c.y - r.y2, 0);
    return rects.reduce<Rect | null>((best, r) => (!best || distance(r) < distance(best) ? r : best), null);
  }
  /**
   * `start` and every footprint of `rects` joined to it through touching ones: the stockpiles or
   * granaries a new one may be placed against.
   */
  cluster(start: Rect, rects: Rect[]): Rect[] {
    const touch = (a: Rect, b: Rect) => a.x1 <= b.x2 + 1 && b.x1 <= a.x2 + 1 && a.y1 <= b.y2 + 1 && b.y1 <= a.y2 + 1;
    const others = rects.filter((r) => r.x1 !== start.x1 || r.y1 !== start.y1);
    const cluster = [start];
    for (let i = 0; i < cluster.length; i++)
      for (let j = 0; j < others.length; )
        if (touch(cluster[i], others[j])) cluster.push(...others.splice(j, 1));
        else j++;
    return cluster;
  }
  /** The building nearest the camera centre (the anchor after center_on). */
  structureNearCentre(radius = 6): number {
    const c = { x: this.camera.centre_tile_x, y: this.camera.centre_tile_y };
    let best = { id: 0, d: Infinity };
    for (let dx = -radius; dx <= radius; dx++)
      for (let dy = -radius; dy <= radius; dy++) {
        const id = this.structureAt({ x: c.x + dx, y: c.y + dy });
        const d = Math.abs(dx) + Math.abs(dy);
        if (id && d < best.d) best = { id, d };
      }
    return best.id;
  }
  /** Terrain height at tile t, or DEFAULT_HEIGHT outside the region. */
  heightAt(t: Tile) {
    return this.value("height", t) ?? DEFAULT_HEIGHT;
  }
  /** The pixel a click must hit for the game to pick tile t, at its own terrain height (see tilePixel). */
  pixel(t: Tile) {
    return tilePixel(this.camera, this.frame, t, this.heightAt(t));
  }
  /**
   * The tile the game picks for a click at pixel p (inverse of pixel): of the tiles drawn in p's
   * screen column, the frontmost whose drawn centre lies within a row of p. Raised ground is drawn
   * higher, so that tile can lie further down the map than the flat position says.
   */
  tileAt(p: { x: number; y: number }): Tile {
    const half = this.frame.width / this.camera.tiles_wide / 2;
    const row = this.frame.height / this.camera.tiles_high;
    const u = (p.x - this.frame.width / 2) / half, v = (p.y - this.frame.height / 2) / row + DEFAULT_HEIGHT * ROWS_PER_HEIGHT;
    const flat = { x: Math.round(this.camera.centre_tile_x + (u + v) / 2), y: Math.round(this.camera.centre_tile_y + (v - u) / 2) };
    let nearest = flat, distance = Infinity;
    for (let j = 32; j >= -4; j--) {
      const t = { x: flat.x + j, y: flat.y + j };
      if (this.value("height", t) === undefined) continue;
      const d = Math.abs(this.pixel(t).y - p.y);
      if (d < row) return t;
      if (d < distance) { distance = d; nearest = t; }
    }
    return nearest;
  }
  /** Clickable: the centre pixel is on visible terrain above the HUD, away from the edges. */
  clickable(t: Tile) {
    return this.anywhere || onScreen(this.frame, this.pixel(t));
  }
  /** Signpost tiles in the region (empty when the probe reported no types). */
  private signpostTiles() {
    if (this.signposts) return this.signposts;
    const { x0, y0, w, layers, structure_types: types } = this.region;
    const ids = new Set(Object.entries(types ?? {}).filter(([, t]) => t === SIGNPOST_TYPE).map(([id]) => Number(id)));
    this.signposts = [];
    layers.structure.forEach((v, i) => { if (ids.has(v)) this.signposts!.push({ x: x0 + (i % w), y: y0 + Math.floor(i / w) }); });
    return this.signposts;
  }
  /** Whether the game would refuse `building` at `centre` as too close to a signpost. */
  nearSignpost(building: string, centre: Tile) {
    const radius = this.region.signpost_radius;
    if (signpostExempt.has(building) || radius === undefined) return false;
    const r = footprintRect(centre, footprintOf(building));
    return this.signpostTiles().some((t) => Math.hypot(t.x - r.x1, t.y - r.y1) <= radius + 5);
  }
  /** Whether `building` fits with its footprint centred (by the game's rule) on `centre`. */
  fits(building: string, centre: Tile, reserve = true): { ok: boolean; oasisShare?: number; reason?: string } {
    const rect = footprintRect(centre, footprintOf(building));
    const farm = farmNames.has(building);
    const resource = resourceGround[building];
    let oasis = 0, total = 0, ground = 0;
    for (let x = rect.x1; x <= rect.x2; x++)
      for (let y = rect.y1; y <= rect.y2; y++) {
        const t = { x, y };
        if (!this.free(t)) return { ok: false, reason: "blocked" };
        total++;
        const logic = this.value("logic", t)! >>> 0;
        if (resource && logic & resource.bit) ground++;
        // Each kind of special ground is the only one some building can use: oasis grass for
        // farms, stone for quarries, ore for iron mines, oil for pitch rigs. A spot the harness
        // chooses keeps off every kind but the building's own (the agent's own targets are
        // clicked as given).
        if (reserve && logic & DEPOSITS & ~(resource?.bit ?? 0)) return { ok: false, reason: "deposit" };
        const kind = this.value("logic2", t)!;
        if (!farm) {
          if (reserve && OASIS.has(kind)) return { ok: false, reason: "farmland" };
          continue;
        }
        if (!FARM_GROUND.has(kind)) return { ok: false, reason: "not_oasis" };
        if (OASIS.has(kind)) oasis++;
      }
    if (this.nearSignpost(building, centre)) return { ok: false, reason: "near_signpost" };
    if (resource) return ground >= resource.min ? { ok: true } : { ok: false, reason: resource.reason };
    if (!farm) return { ok: true };
    const oasisShare = Math.round((oasis / total) * 100) / 100;
    return oasis >= FARM_MIN_OASIS_TILES ? { ok: true, oasisShare } : { ok: false, oasisShare, reason: "not_fertile" };
  }
  /**
   * Mark a footprint as taken (a building just `placed`, or a spot the game refused), grown by
   * `margin` tiles: "Too close to signpost to build." refuses a zone the layers do not show, so
   * nearby spots would fail the same way (run 7, 2026-09-29). A placed building with workers keeps
   * an open side as later placements are chosen.
   */
  claim(building: string, centre: Tile, margin = 0, placed = false) {
    const r = footprintRect(centre, footprintOf(building));
    this.claimed.push({
      x1: r.x1 - margin, y1: r.y1 - margin, x2: r.x2 + margin, y2: r.y2 + margin,
      ...(placed ? { needsOpenSide: needsOpenSide(building), building } : {}),
    });
  }
  /**
   * The special ground under a footprint: "oasis_grass", "stone", "iron_ore" or "oil" (joined
   * with "+" when it covers several), or "plain" for none of them. Each is the only ground of
   * some building: farms, quarries, iron mines and pitch rigs.
   */
  groundOf(building: string, centre: Tile) {
    const rect = footprintRect(centre, footprintOf(building));
    const kinds = new Set<string>();
    for (let x = rect.x1; x <= rect.x2; x++)
      for (let y = rect.y1; y <= rect.y2; y++) {
        const logic = (this.value("logic", { x, y }) ?? 0) >>> 0;
        if (OASIS.has(this.value("logic2", { x, y }) ?? 0)) kinds.add("oasis_grass");
        if (logic & STONE) kinds.add("stone");
        if (logic & ORE) kinds.add("iron_ore");
        if (logic & OIL) kinds.add("oil");
      }
    return kinds.size ? [...kinds].sort().join("+") : "plain";
  }
  private site(building: string, t: Tile, planned: readonly Footprint[] = [], options: SiteOptions = {}): Site | null {
    if (!this.clickable(t)) return null;
    const fit = this.fits(building, t, options.reserve ?? true);
    if (!fit.ok || !this.access(building, t, planned, options.spaced ?? true).ok) return null;
    if (options.ground !== undefined && this.groundOf(building, t) !== options.ground) return null;
    return { tile: t, ...this.pixel(t), ...(fit.oasisShare !== undefined ? { oasisShare: fit.oasisShare } : {}) };
  }
  /**
   * For find_sites: up to `count` spots per kind of ground under them (groundOf), each kind's
   * chosen as sitesNear or woodcutterSites would, without keeping off other buildings' ground,
   * so the model sees which spots would take farmland or a deposit and decides itself. The
   * building's own ground comes first, then plain ground, then the rest. Spots of different
   * kinds may overlap each other.
   */
  sitesByGround(building: string, near?: Tile, count = 3, radius = 20): Record<string, Site[]> {
    const own = farmNames.has(building) ? "oasis_grass"
      : building === "Quarry" ? "stone" : building === "Iron Mine" ? "iron_ore" : building === "Pitch Rig" ? "oil" : "plain";
    const kinds = new Set(this.candidates(building, near, radius, [], { reserve: false }).map((s) => this.groundOf(building, s.tile)));
    const order = [...kinds].sort((a, b) => Number(b === own) - Number(a === own) || Number(b === "plain") - Number(a === "plain") || a.localeCompare(b));
    const groups: Record<string, Site[]> = {};
    for (const ground of order) {
      const options = { reserve: false, ground };
      const sites = building === "Woodcutter"
        ? this.woodcutterSites(near, count, radius, options)
        : this.sitesNear(building, near, count, radius, [], options);
      if (sites.length) groups[ground] = sites;
    }
    return groups;
  }
  /**
   * Valid sites nearest `near` (default: the camera centre), within `radius` tiles, mutually
   * non-overlapping, each leaving the others an open side. Farms prefer the most fertile squares
   * among close ones. `avoid`: footprints about to be placed.
   */
  sitesNear(building: string, near?: Tile, count = 3, radius = 20, avoid: Footprint[] = [], options: SiteOptions = {}): Site[] {
    const found = this.candidates(building, near, radius, avoid, options);
    // Farms: nearest first but by 2-tile distance bands, most fertile within a band.
    found.sort((a, b) => farmNames.has(building)
      ? Math.floor(a.d / 2) - Math.floor(b.d / 2) || (b.oasisShare ?? 0) - (a.oasisShare ?? 0)
      : a.d - b.d);
    return this.distinct(building, found.map(({ d: _d, ...s }) => s), count, avoid);
  }
  /**
   * Woodcutter sites closest to trees (in 4-tile bands of the distance to the nearest tree), the
   * nearest to `near` within a band, each with the trees within WOODCUTTER_REACH tiles. Ranked by
   * distance alone, find_sites put woodcutters on bare ground and their wood stayed flat for 1.5 to
   * 2.5 game minutes (three GLM runs, 2026-10-08).
   */
  woodcutterSites(near?: Tile, count = 3, radius = 20, options: SiteOptions = {}): Site[] {
    const trees = this.treeTiles();
    const found = this.candidates("Woodcutter", near, radius, [], options).map((s) => {
      let nearest = Infinity, within = 0;
      for (const t of trees) {
        const d = Math.max(Math.abs(t.x - s.tile.x), Math.abs(t.y - s.tile.y));
        nearest = Math.min(nearest, d);
        if (d <= WOODCUTTER_REACH) within++;
      }
      return { ...s, trees: within, band: within ? Math.floor(nearest / 4) : Infinity };
    });
    found.sort((a, b) => a.band - b.band || a.d - b.d);
    return this.distinct("Woodcutter", found.map(({ d: _d, band: _b, ...s }) => s), count);
  }
  /** Every site within `radius` tiles of `near` (default: the camera centre), with its distance. */
  private candidates(building: string, near?: Tile, radius = 20, avoid: Footprint[] = [], options: SiteOptions = {}) {
    const c = near ?? { x: this.camera.centre_tile_x, y: this.camera.centre_tile_y };
    const size = footprintOf(building);
    const found: (Site & { d: number })[] = [];
    for (let dx = -radius; dx <= radius; dx++)
      for (let dy = -radius; dy <= radius; dy++) {
        const t = { x: c.x + dx, y: c.y + dy };
        if (avoid.some((r) => overlaps(r, footprintRect(t, size)))) continue;
        const s = this.site(building, t, avoid, options);
        if (s) found.push({ ...s, d: Math.max(Math.abs(dx), Math.abs(dy)) });
      }
    return found;
  }
  /** Tree tiles in the read region. */
  private treeTiles() {
    if (this.trees) return this.trees;
    const { x0, y0, w, h, layers } = this.region;
    const ringNear = (x: number, y: number) => {
      for (let dy = -TREE_RING_REACH; dy <= TREE_RING_REACH; dy++)
        for (let dx = -TREE_RING_REACH; dx <= TREE_RING_REACH; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && layers.logic[yy * w + xx] & TREE_RING) return true;
        }
      return false;
    };
    this.trees = [];
    layers.logic.forEach((logic, i) => {
      const x = i % w, y = Math.floor(i / w);
      if (layers.organism[i] && logic & TRUNK && ringNear(x, y)) this.trees!.push({ x: x0 + x, y: y0 + y });
    });
    return this.trees;
  }
  /**
   * Sites whose footprint touches `anchor` along a side (flush), then with a growing gap
   * up to `maxGap` tiles. Sides are named by screen direction: +x is down-right, +y is
   * down-left. The preferred side comes first; within a side, the smallest sideways shift.
   */
  sitesBeside(building: string, anchor: Rect, count: number, preferred?: string, maxGap = 0, options: SiteOptions = {}): Site[] {
    const size = footprintOf(building), a = Math.floor(size / 2);
    const sides = ["down-right", "down-left", "up-right", "up-left"];
    const order = preferred ? [preferred, ...sides.filter((s) => s !== preferred)] : sides;
    const found: Site[] = [];
    for (let gap = 0; gap <= maxGap; gap++)
      for (const side of order) {
        // Centre coordinate on the axis away from the anchor, and the sliding range on the other axis.
        const along = side === "down-right" || side === "up-left" ? "x" : "y";
        const fixed = side === "down-right" ? anchor.x2 + 1 + gap + a
          : side === "down-left" ? anchor.y2 + 1 + gap + a
          : side === "up-left" ? anchor.x1 - 1 - gap - (size - 1 - a)
          : anchor.y1 - 1 - gap - (size - 1 - a);
        const [lo, hi] = along === "x" ? [anchor.y1, anchor.y2] : [anchor.x1, anchor.x2];
        // Footprint rows [c - a, c - a + size - 1] must overlap [lo, hi] by at least one tile.
        const mid = Math.round((lo + hi) / 2);
        const shifts = [...Array(hi - lo + size).keys()].map((i) => lo - (size - 1 - a) + i)
          .sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid));
        for (const other of shifts) {
          const t = along === "x" ? { x: fixed, y: other } : { x: other, y: fixed };
          const s = this.site(building, t, [], options);
          if (s) found.push({ ...s, side, gap });
        }
      }
    return this.distinct(building, found, count);
  }
  /** Sites in order that neither overlap nor close each other's last open side. */
  private distinct(building: string, sites: Site[], count: number, planned: readonly Footprint[] = []) {
    const size = footprintOf(building);
    const chosen: Site[] = [];
    const taken: Footprint[] = [];
    for (const s of sites) {
      if (chosen.length >= count) break;
      const r = footprintRect(s.tile, size);
      if (taken.some((c) => overlaps(r, c))) continue;
      if (taken.length && !this.access(building, s.tile, [...planned, ...taken]).ok) continue;
      chosen.push(s);
      taken.push({ ...r, needsOpenSide: needsOpenSide(building), building });
    }
    return chosen;
  }
}
