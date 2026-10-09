import type { TileRegion } from "./device.js";
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
 * tile in its footprint. Other buildings are refused ("Too close to signpost to build.") when
 * the footprint's top-left tile lies within signpost_radius + 5 tiles, straight-line, of a
 * signpost tile. The static reading was an 8-connected flood of radius + 4 steps; live on
 * Oasis by the Sea (radius 7) spots 9-11.2 tiles away were refused and 12.6-15 placed,
 * including a diagonal 10 steps away, which fits a circle of 12 and not the flood.
 */
const LAND = 0x8000;
const TREE_RING = 0x2000;
/** A tree's own tile: an organism on a trunk tile (the map summary's "T"). */
const TRUNK = 0x1000;
const STONE = 0x20000;
const ORE = 0x80000;
const OIL = 0x80000000;
const GROUND = LAND | STONE | ORE | OIL;
const BUILDABLE = GROUND | TREE_RING;
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

/**
 * Engine building types, as the tile probe reports them per instance (structure_types; the open
 * panel's type uses the same numbers). A stockpile is not one building: it is four 2×2 piles
 * (type 10) at the corners of a 5×5 square with a one-tile walkway between them, each holding one
 * good (live on Oasis by the Sea, 2026-10-09).
 */
export const STRUCTURE_TYPES = { pile: 10, granary: 19, market: 26, keep: 41, signpost: 52 } as const;
const SIGNPOST_TYPE = STRUCTURE_TYPES.signpost;
/** Placement groups the game never runs the signpost check for. */
const signpostExempt = new Set(["Woodcutter", "Ox Tether", "Stockpile", "Granary", "Armoury", "Quarry", "Iron Mine", "Pitch Rig", ...farmNames]);

export type TileCamera = { centre_tile_x: number; centre_tile_y: number; tiles_wide: number; tiles_high: number };
type Camera = TileCamera;
type Size = { width: number; height: number };
export type Tile = { x: number; y: number };
export type Rect = { x1: number; y1: number; x2: number; y2: number };
export type Site = { tile: Tile; x: number; y: number; oasisShare?: number; side?: string; gap?: number; trees?: number };
/** Tiles around a woodcutter site in which find_sites counts trees. */
export const WOODCUTTER_REACH = 12;

export function footprintRect(centre: Tile, size: number): Rect {
  const a = Math.floor(size / 2);
  return { x1: centre.x - a, y1: centre.y - a, x2: centre.x - a + size - 1, y2: centre.y - a + size - 1 };
}
const overlaps = (a: Rect, b: Rect) => a.x1 <= b.x2 && b.x1 <= a.x2 && a.y1 <= b.y2 && b.y1 <= a.y2;

/**
 * The pixel a click must hit for the game to pick tile t. The camera formula gives the
 * tile's lower vertex; clicks there landed one tile further along +x and +y (a woodcutter
 * and hovels, 2026-09-30), so the target is one row higher, the tile's centre.
 */
export function tilePixel(camera: Camera, frame: Size, t: Tile) {
  const half = frame.width / camera.tiles_wide / 2;
  const row = frame.height / camera.tiles_high;
  const dx = t.x - camera.centre_tile_x, dy = t.y - camera.centre_tile_y;
  return { x: Math.round(frame.width / 2 + (dx - dy) * half), y: Math.round(frame.height / 2 + (dx + dy - 1) * row) };
}
/** On visible terrain above the HUD, away from the edges. */
export function onScreen(frame: Size, p: { x: number; y: number }) {
  return p.x >= 20 && p.y >= 20 && p.x < frame.width - 20 && p.y < frame.height * 0.8;
}

export class TileMap {
  private claimed: Rect[] = [];
  private signposts?: Tile[];
  private trees?: Tile[];
  constructor(
    readonly region: TileRegion,
    readonly camera: Camera,
    readonly frame: Size,
  ) {}
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
  /** Buildable: inside the read region, no building, no organism, ordinary land. */
  free(t: Tile) {
    const logic = this.value("logic", t);
    if (logic === undefined) return false;
    if (this.value("structure", t) || this.value("organism", t)) return false;
    if ((this.value("occupancy", t) ?? 0) < 0) return false;
    if (!(logic & GROUND) || (logic >>> 0) & ~BUILDABLE) return false;
    return !this.claimed.some((r) => t.x >= r.x1 && t.x <= r.x2 && t.y >= r.y1 && t.y <= r.y2);
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
  storageRects(kind: "Stockpile" | "Granary"): Rect[] {
    if (kind === "Granary") return this.rectsOfType(STRUCTURE_TYPES.granary);
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
  /** The pixel a click must hit for the game to pick tile t (see tilePixel). */
  pixel(t: Tile) {
    return tilePixel(this.camera, this.frame, t);
  }
  /** The tile the game picks for a click at pixel p (inverse of pixel). */
  tileAt(p: { x: number; y: number }): Tile {
    const half = this.frame.width / this.camera.tiles_wide / 2;
    const row = this.frame.height / this.camera.tiles_high;
    const u = (p.x - this.frame.width / 2) / half, v = (p.y - this.frame.height / 2) / row + 1;
    return { x: Math.round(this.camera.centre_tile_x + (u + v) / 2), y: Math.round(this.camera.centre_tile_y + (v - u) / 2) };
  }
  /** Clickable: the centre pixel is on visible terrain above the HUD, away from the edges. */
  clickable(t: Tile) {
    return onScreen(this.frame, this.pixel(t));
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
  fits(building: string, centre: Tile): { ok: boolean; oasisShare?: number; reason?: string } {
    const rect = footprintRect(centre, footprintOf(building));
    const farm = farmNames.has(building);
    const resource = resourceGround[building];
    let oasis = 0, total = 0, ground = 0;
    for (let x = rect.x1; x <= rect.x2; x++)
      for (let y = rect.y1; y <= rect.y2; y++) {
        const t = { x, y };
        if (!this.free(t)) return { ok: false, reason: "blocked" };
        total++;
        if (resource && (this.value("logic", t)! >>> 0) & resource.bit) ground++;
        if (!farm) continue;
        const kind = this.value("logic2", t)!;
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
   * Mark a footprint as taken (a building just placed, or a spot the game refused), grown by
   * `margin` tiles: "Too close to signpost to build." refuses a zone the layers do not show, so
   * nearby spots would fail the same way (run 7, 2026-09-29).
   */
  claim(building: string, centre: Tile, margin = 0) {
    const r = footprintRect(centre, footprintOf(building));
    this.claimed.push({ x1: r.x1 - margin, y1: r.y1 - margin, x2: r.x2 + margin, y2: r.y2 + margin });
  }
  private site(building: string, t: Tile): Site | null {
    if (!this.clickable(t)) return null;
    const fit = this.fits(building, t);
    return fit.ok ? { tile: t, ...this.pixel(t), ...(fit.oasisShare !== undefined ? { oasisShare: fit.oasisShare } : {}) } : null;
  }
  /**
   * Valid sites nearest `near` (default: the camera centre), within `radius` tiles,
   * mutually non-overlapping. Farms prefer the most fertile squares among close ones.
   */
  sitesNear(building: string, near?: Tile, count = 3, radius = 20, avoid: Rect[] = []): Site[] {
    const found = this.candidates(building, near, radius, avoid);
    // Farms: nearest first but by 2-tile distance bands, most fertile within a band.
    found.sort((a, b) => farmNames.has(building)
      ? Math.floor(a.d / 2) - Math.floor(b.d / 2) || (b.oasisShare ?? 0) - (a.oasisShare ?? 0)
      : a.d - b.d);
    return this.distinct(building, found.map(({ d: _d, ...s }) => s), count);
  }
  /**
   * Woodcutter sites closest to trees (in 4-tile bands of the distance to the nearest tree), the
   * nearest to `near` within a band, each with the trees within WOODCUTTER_REACH tiles. Ranked by
   * distance alone, find_sites put woodcutters on bare ground and their wood stayed flat for 1.5 to
   * 2.5 game minutes (three GLM runs, 2026-10-08).
   */
  woodcutterSites(near?: Tile, count = 3, radius = 20): Site[] {
    const trees = this.treeTiles();
    const found = this.candidates("Woodcutter", near, radius).map((s) => {
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
  private candidates(building: string, near?: Tile, radius = 20, avoid: Rect[] = []) {
    const c = near ?? { x: this.camera.centre_tile_x, y: this.camera.centre_tile_y };
    const size = footprintOf(building);
    const found: (Site & { d: number })[] = [];
    for (let dx = -radius; dx <= radius; dx++)
      for (let dy = -radius; dy <= radius; dy++) {
        const t = { x: c.x + dx, y: c.y + dy };
        if (avoid.some((r) => overlaps(r, footprintRect(t, size)))) continue;
        const s = this.site(building, t);
        if (s) found.push({ ...s, d: Math.max(Math.abs(dx), Math.abs(dy)) });
      }
    return found;
  }
  /** Tree tiles in the read region. */
  private treeTiles() {
    if (this.trees) return this.trees;
    const { x0, y0, w, layers } = this.region;
    this.trees = [];
    layers.logic.forEach((logic, i) => {
      if (layers.organism[i] && logic & TRUNK) this.trees!.push({ x: x0 + (i % w), y: y0 + Math.floor(i / w) });
    });
    return this.trees;
  }
  /**
   * Sites whose footprint touches `anchor` along a side (flush), then with a growing gap
   * up to `maxGap` tiles. Sides are named by screen direction: +x is down-right, +y is
   * down-left. The preferred side comes first; within a side, the smallest sideways shift.
   */
  sitesBeside(building: string, anchor: Rect, count: number, preferred?: string, maxGap = 0): Site[] {
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
          const s = this.site(building, t);
          if (s) found.push({ ...s, side, gap });
        }
      }
    return this.distinct(building, found, count);
  }
  private distinct(building: string, sites: Site[], count: number) {
    const size = footprintOf(building);
    const chosen: Site[] = [];
    for (const s of sites) {
      if (chosen.length >= count) break;
      const r = footprintRect(s.tile, size);
      if (chosen.some((c) => overlaps(r, footprintRect(c.tile, size)))) continue;
      chosen.push(s);
    }
    return chosen;
  }
}
