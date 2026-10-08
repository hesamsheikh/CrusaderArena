import test from "node:test";
import assert from "node:assert/strict";
import { TileMap, footprintRect } from "./tile-map.js";
import type { TileRegion } from "./device.js";

const camera = { centre_tile_x: 100, centre_tile_y: 100, tiles_wide: 30, tiles_high: 68 };
const frame = { width: 1920, height: 1080 };

/** A region of ordinary land (logic 0x8000, bare earth) around the camera centre. */
function region(edit?: (set: (layer: keyof TileRegion["layers"], x: number, y: number, v: number) => void) => void): TileRegion {
  const { x0, y0, w, h } = TileMap.regionFor(camera);
  const layers = Object.fromEntries(
    ["structure", "organism", "logic", "logic2", "height", "occupancy", "walk", "gfx"].map((n) => [n, Array(w * h).fill(n === "logic" ? 0x8000 : 0)]),
  ) as TileRegion["layers"];
  edit?.((layer, x, y, v) => { layers[layer][(y - y0) * w + (x - x0)] = v; });
  return { x0, y0, w, h, stable: true, layers };
}
const fill = (set: Parameters<Parameters<typeof region>[0] & {}>[0], layer: keyof TileRegion["layers"], x1: number, y1: number, x2: number, y2: number, v: number) => {
  for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) set(layer, x, y, v);
};

test("a building of side S clicked on tile c covers c - floor(S/2) for S tiles (live rule)", () => {
  assert.deepEqual(footprintRect({ x: 412, y: 372 }, 4), { x1: 410, y1: 370, x2: 413, y2: 373 });
  assert.deepEqual(footprintRect({ x: 408, y: 369 }, 3), { x1: 407, y1: 368, x2: 409, y2: 370 });
});

test("pixels and tiles map through the camera centre", () => {
  const map = new TileMap(region(), camera, frame);
  // The centre tile is clicked one row (1080 / 68 ≈ 16 px) above the screen centre.
  assert.deepEqual(map.pixel({ x: 100, y: 100 }), { x: 960, y: 524 });
  // One tile along +x moves half a tile right and one row down.
  assert.deepEqual(map.pixel({ x: 101, y: 100 }), { x: 992, y: 540 });
  for (const t of [{ x: 90, y: 104 }, { x: 110, y: 95 }]) assert.deepEqual(map.tileAt(map.pixel(t)), t);
});

test("buildings, organisms, water and other logic bits block; the tree ring does not", () => {
  const map = new TileMap(region((set) => {
    set("structure", 101, 100, 7);
    set("organism", 102, 100, 300);
    set("logic", 103, 100, 0x100000);
    set("logic", 104, 100, 0x8000 | 0x2000);
    set("logic", 105, 100, 0x8000 | 0x400);
    set("occupancy", 106, 100, -1); // an animal (camels refused an orchard live)
    set("occupancy", 107, 100, 1); // the player's own worker
  }), camera, frame);
  assert.deepEqual([100, 101, 102, 103, 104, 105, 106, 107].map((x) => map.free({ x, y: 100 })), [true, false, false, false, true, false, false, true]);
  assert.equal(map.free({ x: 1, y: 1 }), false, "outside the read region");
  assert.equal(map.structureRect(0), null);
  assert.deepEqual(map.structureRect(7), { x1: 101, y1: 100, x2: 101, y2: 100 });
});

test("farms need oasis or scrub everywhere and at least 50 oasis tiles (game code)", () => {
  const map = new TileMap(region((set) => {
    fill(set, "logic2", 90, 90, 99, 99, 16); // pure oasis
    fill(set, "logic2", 100, 90, 109, 99, -128);
    fill(set, "logic2", 100, 90, 101, 99, 1); // 20% scrub → 80% oasis
    fill(set, "logic2", 110, 90, 119, 99, 16);
    set("logic2", 115, 95, 2); // one gravel tile
    fill(set, "logic2", 90, 100, 99, 109, 16);
    fill(set, "logic2", 90, 100, 94, 109, 1); // 50 scrub tiles
  }), camera, frame);
  assert.deepEqual(map.fits("Dairy Farm", { x: 95, y: 95 }), { ok: true, oasisShare: 1 });
  assert.deepEqual(map.fits("Dairy Farm", { x: 105, y: 95 }), { ok: true, oasisShare: 0.8 });
  assert.equal(map.fits("Dairy Farm", { x: 115, y: 95 }).reason, "not_oasis");
  // 10×10 with exactly 50 oasis tiles: accepted; a 9×9 there has 45 and is refused.
  assert.deepEqual(map.fits("Dairy Farm", { x: 95, y: 105 }), { ok: true, oasisShare: 0.5 });
  assert.equal(map.fits("Wheat Farm", { x: 95, y: 105 }).reason, "not_fertile");
  assert.deepEqual(map.fits("Hovel", { x: 95, y: 105 }), { ok: true });
});

test("stone, ore and oil ground are buildable and count toward quarry, iron mine and pitch rig", () => {
  const map = new TileMap(region((set) => {
    fill(set, "logic", 90, 90, 91, 93, 0x28000); // 8 stone tiles
    fill(set, "logic", 110, 90, 110, 92, 0x88000); // 3 ore tiles
    fill(set, "logic", 110, 100, 111, 101, 0x88000); // 4 ore tiles
    set("logic", 90, 110, 0x80000000 | 0x8000); // oil
  }), camera, frame);
  assert.deepEqual(map.fits("Quarry", { x: 92, y: 92 }), { ok: true }); // 89..94 × 89..94
  assert.deepEqual(map.fits("Quarry", { x: 93, y: 92 }), { ok: true }); // 90..95: still 8
  assert.equal(map.fits("Quarry", { x: 94, y: 92 }).reason, "no_stone"); // 91..96: 4
  assert.deepEqual(map.fits("Hovel", { x: 91, y: 92 }), { ok: true }, "stone does not block other buildings");
  assert.equal(map.fits("Iron Mine", { x: 110, y: 91 }).reason, "no_ore");
  assert.deepEqual(map.fits("Iron Mine", { x: 111, y: 101 }), { ok: true });
  assert.deepEqual(map.fits("Pitch Rig", { x: 91, y: 111 }), { ok: true });
  assert.equal(map.fits("Pitch Rig", { x: 95, y: 111 }).reason, "no_oil");
  const [mine] = map.sitesNear("Iron Mine", { x: 100, y: 100 }, 1, 15);
  assert.ok(mine && map.fits("Iron Mine", mine.tile).ok, "a site covering the 4 ore tiles");
});

test("sitesNear returns the nearest non-overlapping fits and honours avoid rects and claims", () => {
  const map = new TileMap(region((set) => fill(set, "organism", 98, 98, 102, 102, 1)), camera, frame);
  const sites = map.sitesNear("Hovel", { x: 100, y: 100 }, 3, 8);
  assert.equal(sites.length, 3);
  for (const s of sites) assert.ok(map.fits("Hovel", s.tile).ok);
  const rects = sites.map((s) => footprintRect(s.tile, 4));
  for (const [i, a] of rects.entries())
    for (const b of rects.slice(i + 1)) assert.ok(a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1, "no overlap");
  const avoided = map.sitesNear("Hovel", { x: 100, y: 100 }, 1, 8, [footprintRect(sites[0].tile, 4)])[0];
  assert.notDeepEqual(avoided.tile, sites[0].tile);
  map.claim("Hovel", sites[0].tile);
  assert.notDeepEqual(map.sitesNear("Hovel", { x: 100, y: 100 }, 1, 8)[0].tile, sites[0].tile);
  assert.deepEqual(map.sitesNear("Quarry", undefined, 3), [], "no stone ground in this region");
});

test("sitesBeside finds flush spots on the preferred side, sliding along it", () => {
  // A 4×4 granary at 100..103; a stockpile (5) flush on the down-right (+x) side has its
  // footprint from x = 104.
  const map = new TileMap(region((set) => fill(set, "structure", 100, 100, 103, 103, 9)), camera, frame);
  const anchor = map.structureRect(map.structureNearCentre())!;
  assert.deepEqual(anchor, { x1: 100, y1: 100, x2: 103, y2: 103 });
  const [site] = map.sitesBeside("Stockpile", anchor, 1, "down-right");
  const r = footprintRect(site.tile, 5);
  assert.equal(r.x1, 104);
  assert.ok(r.y1 <= 103 && r.y2 >= 100, "overlaps the anchor's side");
  assert.equal(site.side, "down-right");
  // Blocked flush band on that side: the next side is used.
  const blocked = new TileMap(region((set) => {
    fill(set, "structure", 100, 100, 103, 103, 9);
    fill(set, "organism", 104, 90, 104, 115, 1);
  }), camera, frame);
  assert.equal(blocked.sitesBeside("Stockpile", anchor, 1, "down-right")[0].side, "down-left");
});

test("the signpost zone refuses generic buildings by the footprint's top-left tile; exempt ones pass", () => {
  const r = region((set) => fill(set, "structure", 100, 100, 101, 101, 5));
  const map = new TileMap({ ...r, structure_types: { "5": 52 }, signpost_radius: 7 }, camera, frame);
  // Hovel (4) clicked at c covers c-2..c+1. Top-left (88,100) is 12 tiles from x = 100: refused; (87,100) is 13.
  assert.deepEqual(map.fits("Hovel", { x: 90, y: 102 }), { ok: false, reason: "near_signpost" });
  assert.deepEqual(map.fits("Hovel", { x: 89, y: 102 }), { ok: true });
  // Diagonally 10 steps away (14.1 tiles straight-line): allowed, as live.
  assert.deepEqual(map.fits("Hovel", { x: 92, y: 92 }), { ok: true });
  // Approaching from +x the far (top-left) corner counts: top-left (114,100) is 13 from x = 101.
  assert.deepEqual(map.fits("Hovel", { x: 116, y: 102 }), { ok: true });
  assert.deepEqual(map.fits("Woodcutter", { x: 104, y: 104 }), { ok: true }, "woodcutters are exempt");
  assert.deepEqual(map.fits("Stockpile", { x: 105, y: 100 }), { ok: true }, "stockpiles are exempt");
  assert.equal(new TileMap(region((set) => fill(set, "structure", 100, 100, 101, 101, 5)), camera, frame).fits("Hovel", { x: 90, y: 102 }).ok, true, "no probe data: no zone");
});
