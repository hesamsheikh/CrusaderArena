import test from "node:test";
import assert from "node:assert/strict";
import { KEEP_CLEARANCE, STRUCTURE_TYPES, TileMap, footprintRect } from "./tile-map.js";
import { anchorRectOf } from "./anchors.js";
import type { TileRegion } from "./device.js";

const camera = { centre_tile_x: 100, centre_tile_y: 100, tiles_wide: 30, tiles_high: 68 };
const frame = { width: 1920, height: 1080 };

/** A region of ordinary land (logic 0x8000, bare earth, height 8 as by Oasis by the Sea's keep) around the camera centre. */
function region(edit?: (set: (layer: keyof TileRegion["layers"], x: number, y: number, v: number) => void) => void): TileRegion {
  const { x0, y0, w, h } = TileMap.regionFor(camera);
  const layers = Object.fromEntries(
    ["structure", "organism", "logic", "logic2", "height", "occupancy", "walk", "gfx"].map((n) => [n, Array(w * h).fill(n === "logic" ? 0x8000 : n === "height" ? 8 : 0)]),
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
  // The centre tile at height 8 is clicked about one row (1080 / 68 ≈ 16 px) above the screen centre.
  assert.deepEqual(map.pixel({ x: 100, y: 100 }), { x: 960, y: 525 });
  // One tile along +x moves half a tile right and one row down.
  assert.deepEqual(map.pixel({ x: 101, y: 100 }), { x: 992, y: 541 });
  for (const t of [{ x: 90, y: 104 }, { x: 110, y: 95 }]) assert.deepEqual(map.tileAt(map.pixel(t)), t);
});

test("raised ground is drawn higher: a plateau tile's pixel is above its flat position, and that pixel maps back to it", () => {
  // Live on Oasis by the Sea (2026-10-12): a hovel aimed at a plateau tile of height 130 by its flat
  // position hit the cliff below; the click 15 rows higher placed it on the tile.
  const map = new TileMap(region((set) => fill(set, "height", 104, 104, 112, 112, 130)), camera, frame);
  const plateau = { x: 108, y: 108 };
  const flat = new TileMap(region(), camera, frame).pixel(plateau);
  const raised = map.pixel(plateau);
  assert.equal(raised.x, flat.x);
  assert.equal(Math.round((flat.y - raised.y) / (1080 / 68)), 14, "about 14 rows higher than at height 8");
  assert.deepEqual(map.tileAt(raised), plateau);
  // The flat position shows the ground in front of the plateau, not the plateau tile.
  assert.notDeepEqual(map.tileAt(flat), plateau);
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
  // Oasis grass is kept for farms: other buildings' spots stay off it; scrub is fine for them.
  assert.deepEqual(map.fits("Hovel", { x: 95, y: 105 }), { ok: false, reason: "farmland" });
  assert.deepEqual(map.fits("Hovel", { x: 92, y: 105 }), { ok: true });
});

test("spots found for buildings other than farms keep off oasis grass", () => {
  // Oasis grass all around the view centre, plain ground from x 108 on.
  const map = new TileMap(region((set) => fill(set, "logic2", 85, 85, 107, 115, -128)), camera, frame);
  const hovels = map.sitesNear("Hovel", undefined, 3);
  assert.equal(hovels.length, 3);
  for (const site of hovels) assert.ok(footprintRect(site.tile, 4).x1 >= 108, `hovel at ${JSON.stringify(site.tile)} touches grass`);
  for (const site of map.woodcutterSites(undefined, 2)) assert.ok(footprintRect(site.tile, 3).x1 >= 108, `woodcutter at ${JSON.stringify(site.tile)}`);
  // A farm still finds its ground there.
  assert.ok(map.sitesNear("Apple Orchard", undefined, 1).length === 1);
});

test("stone, ore and oil are kept for their own buildings, and each keeps off the others'", () => {
  const map = new TileMap(region((set) => {
    fill(set, "logic", 90, 90, 93, 93, 0x28000); // stone
    fill(set, "logic", 110, 90, 113, 93, 0x88000); // ore
  }), camera, frame);
  assert.deepEqual(map.fits("Hovel", { x: 92, y: 92 }), { ok: false, reason: "deposit" });
  assert.deepEqual(map.fits("Hovel", { x: 112, y: 92 }), { ok: false, reason: "deposit" });
  assert.equal(map.fits("Quarry", { x: 92, y: 92 }).ok, true);
  assert.equal(map.fits("Iron Mine", { x: 112, y: 92 }).ok, true);
  assert.deepEqual(map.fits("Quarry", { x: 112, y: 92 }), { ok: false, reason: "deposit" }, "a quarry stays off ore");
  assert.deepEqual(map.fits("Hovel", { x: 100, y: 100 }), { ok: true });
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
  assert.deepEqual(map.fits("Hovel", { x: 91, y: 92 }, false), { ok: true }, "the game allows other buildings on stone");
  assert.equal(map.fits("Hovel", { x: 91, y: 92 }).reason, "deposit", "spots the harness picks keep it for quarries");
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

test("woodcutter sites come closest to trees first, with the trees within reach", () => {
  // Ten trees (organism on a trunk tile, with the ring of 0x2000 tiles a tree has) 15 tiles
  // down-right of the centre, and ten cacti (the same marks, no ring) 15 tiles up-left; open land
  // elsewhere.
  const trees = (set: Parameters<Parameters<typeof region>[0] & {}>[0]) => {
    for (let i = 0; i < 10; i++) {
      set("organism", 115 + (i % 5), 100 + Math.floor(i / 5), 300);
      set("logic", 115 + (i % 5), 100 + Math.floor(i / 5), 0x8000 | 0x1000);
      set("organism", 81 + (i % 5), 100 + Math.floor(i / 5), 400);
      set("logic", 81 + (i % 5), 100 + Math.floor(i / 5), 0x8000 | 0x1000);
    }
    for (let x = 115; x < 120; x++) set("logic", x, 102, 0x8000 | 0x2000);
  };
  const map = new TileMap(region(trees), camera, frame);
  // Ranked by distance alone the centre comes first, 15 tiles from any tree.
  assert.deepEqual(map.sitesNear("Woodcutter", undefined, 1)[0].tile, { x: 100, y: 100 });
  const [first, ...rest] = map.woodcutterSites(undefined, 3);
  assert.ok(Math.max(Math.abs(first.tile.x - 115), Math.abs(first.tile.y - 100)) <= 3, JSON.stringify(first));
  assert.equal(first.trees, 10, "the cacti do not count");
  assert.ok(rest.every((s) => (s.trees ?? 0) > 0));
  // Next to the cacti alone, a spot has no trees.
  assert.equal(map.woodcutterSites({ x: 80, y: 103 }, 1, 2)[0]?.trees ?? 0, 0);
  // Without trees in view, the nearest spots come back with no trees counted.
  const bare = new TileMap(region(), camera, frame).woodcutterSites(undefined, 2);
  assert.deepEqual(bare.map((s) => s.trees), [0, 0]);
  assert.deepEqual(bare[0].tile, { x: 100, y: 100 });
});

/** A stockpile as the game stores it: four 2×2 piles at the corners of a 5×5 square. */
const stockpile = (set: Parameters<Parameters<typeof region>[0] & {}>[0], x: number, y: number, firstId: number) =>
  [[0, 0], [3, 0], [0, 3], [3, 3]].forEach(([dx, dy], i) => fill(set, "structure", x + dx, y + dy, x + dx + 1, y + dy + 1, firstId + i));
const piles = (...firstIds: number[]) =>
  Object.fromEntries(firstIds.flatMap((id) => [0, 1, 2, 3].map((i) => [String(id + i), STRUCTURE_TYPES.pile])));

test("a stockpile's four piles make one 5×5 square, and touching stockpiles one cluster", () => {
  const r = region((set) => {
    stockpile(set, 100, 100, 1);
    stockpile(set, 105, 100, 5); // touching the first
    stockpile(set, 110, 100, 9); // touching the second only
    stockpile(set, 120, 100, 13); // elsewhere
    fill(set, "structure", 100, 105, 103, 108, 17); // a granary touching the first
  });
  const map = new TileMap({ ...r, structure_types: { ...piles(1, 5, 9, 13), "17": STRUCTURE_TYPES.granary } }, camera, frame);
  const squares = map.storageRects("Stockpile");
  assert.equal(squares.length, 4);
  const first = map.nearestToCentre(squares)!;
  assert.deepEqual(first, { x1: 100, y1: 100, x2: 104, y2: 104 });
  assert.deepEqual(map.cluster(first, squares), [
    { x1: 100, y1: 100, x2: 104, y2: 104 },
    { x1: 105, y1: 100, x2: 109, y2: 104 },
    { x1: 110, y1: 100, x2: 114, y2: 104 },
  ]);
  assert.deepEqual(map.storageRects("Granary"), [{ x1: 100, y1: 105, x2: 103, y2: 108 }]);
  // Without structure types there is no storage to anchor on (the caller probes instead).
  assert.deepEqual(new TileMap(r, camera, frame).storageRects("Stockpile"), []);
});

test("storage anchors on the stockpile, not the keep beside it at the camera centre (every run to 2026-10-09)", () => {
  // As on Oasis by the Sea: the keep (7×7) ends on the camera's centre tile, the stockpile's
  // square starts one tile further along +x, and its walkway tiles hold no building.
  const r = region((set) => {
    fill(set, "structure", 94, 97, 100, 103, 20);
    stockpile(set, 101, 98, 1);
  });
  const map = new TileMap({ ...r, structure_types: { ...piles(1), "20": STRUCTURE_TYPES.keep } }, camera, frame);
  assert.equal(map.structureAt({ x: 100, y: 100 }), 20, "the building at the centre is the keep");
  const square = anchorRectOf(map, "stockpile")!;
  assert.deepEqual(square, { x1: 101, y1: 98, x2: 105, y2: 102 });
  assert.deepEqual(anchorRectOf(map, "keep"), { x1: 94, y1: 97, x2: 100, y2: 103 });
  // Every side but the keep's offers a spot whose footprint touches the stockpile.
  for (const side of ["down-right", "down-left", "up-right"]) {
    const [site] = map.sitesBeside("Stockpile", square, 1, side);
    assert.equal(site.side, side);
    const f = footprintRect(site.tile, 5);
    const touches = f.x1 <= square.x2 + 1 && square.x1 <= f.x2 + 1 && f.y1 <= square.y2 + 1 && square.y1 <= f.y2 + 1;
    assert.ok(touches && !(f.x1 <= square.x2 && square.x1 <= f.x2 && f.y1 <= square.y2 && square.y1 <= f.y2), `${side} touches without overlapping`);
  }
});

test("spots the harness picks for buildings nobody walks to keep clear of the keep and its courtyard; others and anchors do not", () => {
  // Nearest the view centre, which a game starts on the keep, find_sites packed hovels around the
  // campfire, in the way of the peasants coming from it (2026-10-15).
  const keep = { x1: 94, y1: 97, x2: 100, y2: 103 }, courtyard = { x1: 101, y1: 97, x2: 107, y2: 103 };
  const map = new TileMap({
    ...region((set) => { fill(set, "structure", keep.x1, keep.y1, keep.x2, keep.y2, 20); fill(set, "structure", courtyard.x1, courtyard.y1, courtyard.x2, courtyard.y2, 21); }),
    structure_types: { "20": STRUCTURE_TYPES.keep, "21": STRUCTURE_TYPES.courtyard },
  }, camera, frame);
  // Tiles between a footprint and a rect, along the farther axis (0 when they touch or overlap).
  const gap = (f: { x1: number; y1: number; x2: number; y2: number }, r: typeof keep) =>
    Math.max(r.x1 - f.x2 - 1, f.x1 - r.x2 - 1, r.y1 - f.y2 - 1, f.y1 - r.y2 - 1, 0);
  const hovels = map.sitesNear("Hovel", { x: 100, y: 100 }, 4);
  assert.equal(hovels.length, 4);
  for (const s of hovels) {
    const f = footprintRect(s.tile, 4);
    assert.ok(gap(f, keep) >= KEEP_CLEARANCE && gap(f, courtyard) >= KEEP_CLEARANCE, `hovel at ${JSON.stringify(s.tile)}`);
  }
  assert.ok(Object.values(map.sitesByGround("Marketplace", { x: 100, y: 100 }, 2)).flat()
    .every((s) => gap(footprintRect(s.tile, 5), keep) >= KEEP_CLEARANCE && gap(footprintRect(s.tile, 5), courtyard) >= KEEP_CLEARANCE));
  // A workshop's workers walk there anyway: it may stand close.
  const [bakery] = map.sitesNear("Bakery", { x: 100, y: 100 }, 1);
  assert.ok(gap(footprintRect(bakery.tile, 4), keep) < KEEP_CLEARANCE || gap(footprintRect(bakery.tile, 4), courtyard) < KEEP_CLEARANCE);
  // Beside an anchor the model names (place_near), a hovel still goes flush against the keep.
  const [beside] = map.sitesBeside("Hovel", keep, 1, "up-left");
  assert.equal(gap(footprintRect(beside.tile, 4), keep), 0);
});

test("spots a search picks make blocks of up to four, two across each way, with a walkway around each", () => {
  // The user's layout rule (2026-10-15): buildings in 2×2 blocks, with room between blocks for routes.
  const rects = (sites: { tile: { x: number; y: number } }[], size: number) => sites.map((s) => footprintRect(s.tile, size));
  const touch = (a: ReturnType<typeof footprintRect>, b: ReturnType<typeof footprintRect>) =>
    a.x1 <= b.x2 + 1 && b.x1 <= a.x2 + 1 && a.y1 <= b.y2 + 1 && b.y1 <= a.y2 + 1;
  const blocks = (rs: ReturnType<typeof footprintRect>[]) => {
    const groups: (typeof rs)[] = [];
    for (const r of rs) {
      const joined = groups.filter((g) => g.some((o) => touch(o, r)));
      const merged = [r, ...joined.flat()];
      for (const g of joined) groups.splice(groups.indexOf(g), 1);
      groups.push(merged);
    }
    return groups;
  };
  for (const [building, size] of [["Hovel", 4], ["Bakery", 4], ["Woodcutter", 3]] as const) {
    const sites = new TileMap(region(), camera, frame).sitesNear(building, { x: 100, y: 100 }, 5);
    assert.equal(sites.length, 5, building);
    const groups = blocks(rects(sites, size));
    for (const g of groups) {
      assert.ok(g.length <= 4, `${building}: a block of ${g.length}`);
      const wide = Math.max(...g.map((r) => r.x2)) - Math.min(...g.map((r) => r.x1)) + 1;
      const high = Math.max(...g.map((r) => r.y2)) - Math.min(...g.map((r) => r.y1)) + 1;
      assert.ok(wide <= 2 * size && high <= 2 * size, `${building}: a block ${wide}×${high}`);
    }
    assert.deepEqual(groups.map((g) => g.length).sort(), [1, 4], `${building}: the nearest four in one 2×2 block, the fifth a tile or more off`);
  }
  // A row of three hovels standing already: no spot touches it, which would make a block of four in a row.
  const row = [{ x1: 96, y1: 92, x2: 99, y2: 95 }, { x1: 100, y1: 92, x2: 103, y2: 95 }, { x1: 104, y1: 92, x2: 107, y2: 95 }];
  const built = new TileMap({
    ...region((set) => row.forEach((r, i) => fill(set, "structure", r.x1, r.y1, r.x2, r.y2, 30 + i))),
    structure_types: { "30": STRUCTURE_TYPES.hovel, "31": STRUCTURE_TYPES.hovel, "32": STRUCTURE_TYPES.hovel },
  }, camera, frame);
  const near = built.sitesNear("Hovel", { x: 101, y: 98 }, 5);
  assert.ok(near.length > 0);
  for (const r of rects(near, 4)) assert.ok(row.every((o) => !touch(o, r)), `hovel at ${JSON.stringify(r)} touches the row`);
});

test("a building with workers keeps one whole side of open ground; houses need none", () => {
  // A bakery (4×4) on tile 100 covers 98..101; trees close its up-left, down-right and up-right sides.
  const closeSides = (set: Parameters<Parameters<typeof region>[0] & {}>[0], sides: string[]) => {
    if (sides.includes("up-left")) fill(set, "organism", 97, 98, 97, 101, 1);
    if (sides.includes("down-right")) fill(set, "organism", 102, 98, 102, 101, 1);
    if (sides.includes("up-right")) fill(set, "organism", 98, 97, 101, 97, 1);
    if (sides.includes("down-left")) fill(set, "organism", 98, 102, 101, 102, 1);
  };
  const three = new TileMap(region((set) => closeSides(set, ["up-left", "down-right", "up-right"])), camera, frame);
  assert.equal(three.openSides(footprintRect({ x: 100, y: 100 }, 4)), 1);
  assert.deepEqual(three.access("Bakery", { x: 100, y: 100 }), { ok: true });
  const four = new TileMap(region((set) => closeSides(set, ["up-left", "down-right", "up-right", "down-left"])), camera, frame);
  assert.deepEqual(four.access("Bakery", { x: 100, y: 100 }), { ok: false, reason: "no_open_side" });
  assert.deepEqual(four.access("Iron Mine", { x: 100, y: 100 }), { ok: false, reason: "no_open_side" });
  assert.deepEqual(four.access("Hovel", { x: 100, y: 100 }), { ok: true }, "no workers go in and out of a house");
  // One tree on a side closes the whole side; a planned footprint closes it too.
  const one = new TileMap(region((set) => { closeSides(set, ["up-left", "down-right", "up-right"]); set("organism", 99, 102, 1); }), camera, frame);
  assert.equal(one.access("Bakery", { x: 100, y: 100 }).reason, "no_open_side");
  assert.equal(three.access("Bakery", { x: 100, y: 100 }, [{ x1: 98, y1: 102, x2: 101, y2: 105 }]).reason, "no_open_side");
  assert.equal(four.sitesNear("Bakery", { x: 100, y: 100 }, 1, 0).length, 0, "find_sites does not offer it");
  assert.equal(three.sitesNear("Bakery", { x: 100, y: 100 }, 1, 0).length, 1);
});

test("a new building may not take a neighbour's last open side; storage, the keep and its courtyard need none", () => {
  // Building 30 (4×4, 104..107 × 98..101) with only its up-left side (x = 103) open.
  const neighbour = (set: Parameters<Parameters<typeof region>[0] & {}>[0]) => {
    fill(set, "structure", 104, 98, 107, 101, 30);
    fill(set, "organism", 108, 98, 108, 101, 1);
    fill(set, "organism", 104, 97, 107, 97, 1);
    fill(set, "organism", 104, 102, 107, 102, 1);
  };
  // A hovel on tile 102 covers 100..103 and so takes x = 103.
  const unknown = new TileMap(region(neighbour), camera, frame);
  assert.deepEqual(unknown.access("Hovel", { x: 102, y: 100 }), { ok: false, reason: "closes_neighbour" }, "a building the harness cannot name is kept open");
  assert.deepEqual(unknown.access("Hovel", { x: 101, y: 100 }), { ok: true }, "one tile back leaves the side open");
  // A pile needs no open side (spaced off: the tile of open ground around storage is its own rule).
  const pile = new TileMap({ ...region(neighbour), structure_types: { "30": STRUCTURE_TYPES.pile } }, camera, frame);
  assert.deepEqual(pile.access("Hovel", { x: 102, y: 100 }, [], false), { ok: true });
  const hovel = new TileMap({ ...region(neighbour), structure_types: { "30": STRUCTURE_TYPES.hovel } }, camera, frame);
  assert.deepEqual(hovel.access("Bakery", { x: 102, y: 100 }), { ok: true }, "a house needs no open side");
  const workshop = new TileMap({ ...region(neighbour), structure_types: { "30": 3 } }, camera, frame);
  assert.equal(workshop.access("Hovel", { x: 102, y: 100 }).reason, "closes_neighbour", "a woodcutter (type 3) is kept open");
  // Already closed in: placing next to it does not make it worse, so it is allowed.
  const closed = new TileMap(region((set) => { neighbour(set); fill(set, "organism", 103, 98, 103, 98, 1); }), camera, frame);
  assert.deepEqual(closed.access("Hovel", { x: 101, y: 102 }), { ok: true });
  // The keep's courtyard is open ground for a side.
  const courtyard = new TileMap({
    ...region((set) => { fill(set, "organism", 97, 98, 97, 101, 1); fill(set, "organism", 102, 98, 102, 101, 1); fill(set, "organism", 98, 102, 101, 102, 1); fill(set, "structure", 95, 90, 104, 97, 55); }),
    structure_types: { "55": STRUCTURE_TYPES.courtyard },
  }, camera, frame);
  assert.deepEqual(courtyard.access("Bakery", { x: 100, y: 100 }), { ok: true });
  // A building placed during this call is kept open like a built one.
  const map = new TileMap(region((set) => { fill(set, "organism", 97, 98, 97, 101, 1); fill(set, "organism", 98, 97, 101, 97, 1); fill(set, "organism", 98, 102, 101, 102, 1); }), camera, frame);
  map.claim("Bakery", { x: 100, y: 100 }, 0, true);
  assert.equal(map.access("Hovel", { x: 104, y: 100 }).reason, "closes_neighbour");
  map.claim("Bakery", { x: 100, y: 110 });
  assert.deepEqual(map.access("Hovel", { x: 104, y: 110 }), { ok: true }, "a refused spot is not a building");
});

/** A ring of `layer` = `v` tiles around x1..x2 × y1..y2 (a wall of building tiles, water, trees), but for the tiles in `gaps`. */
const ring = (set: Parameters<Parameters<typeof region>[0] & {}>[0], x1: number, y1: number, x2: number, y2: number, layer: keyof TileRegion["layers"], v: number, gaps: [number, number][] = []) => {
  for (let x = x1; x <= x2; x++)
    for (let y = y1; y <= y2; y++)
      if ((x === x1 || x === x2 || y === y1 || y === y2) && !gaps.some(([gx, gy]) => gx === x && gy === y)) set(layer, x, y, v);
};
/** Building 40, a row of houses walling in 93..107 × 93..107; building 31, a woodcutter (type 3). */
const types = { "40": STRUCTURE_TYPES.hovel, "31": 3, "55": STRUCTURE_TYPES.courtyard };

test("a building walled off from the keep has no route; a gap, the courtyard inside or the region's edge gives one", () => {
  const walled = new TileMap({ ...region((set) => ring(set, 92, 92, 108, 108, "structure", 40)), structure_types: types }, camera, frame);
  // Open ground on every side, but no way out to the keep.
  assert.equal(walled.openSides(footprintRect({ x: 100, y: 100 }, 4)), 4);
  assert.deepEqual(walled.access("Bakery", { x: 100, y: 100 }), { ok: false, reason: "no_route" });
  assert.deepEqual(walled.access("Granary", { x: 100, y: 100 }, [], false), { ok: false, reason: "no_route" }, "goods are carried to storage");
  assert.deepEqual(walled.access("Hovel", { x: 100, y: 100 }), { ok: true }, "nobody needs to walk to a house");
  assert.deepEqual(walled.access("Bakery", { x: 115, y: 100 }), { ok: true }, "outside the wall");
  assert.equal(walled.sitesNear("Bakery", { x: 100, y: 100 }, 1, 5).length, 0, "find_sites offers no spot inside");
  const gap = new TileMap({ ...region((set) => ring(set, 92, 92, 108, 108, "structure", 40, [[100, 92]])), structure_types: types }, camera, frame);
  assert.deepEqual(gap.access("Bakery", { x: 100, y: 100 }), { ok: true });
  const keep = new TileMap({
    ...region((set) => { ring(set, 92, 92, 108, 108, "structure", 40); fill(set, "structure", 94, 94, 96, 96, 55); }),
    structure_types: types,
  }, camera, frame);
  assert.deepEqual(keep.access("Bakery", { x: 101, y: 101 }), { ok: true }, "the keep's courtyard is inside");
  // Walled on three sides, open to the edge of the read region: the ground beyond is unknown and
  // taken to lead to the keep.
  const { x0 } = TileMap.regionFor(camera);
  const edge = new TileMap({
    ...region((set) => { fill(set, "structure", x0, 92, x0 + 12, 92, 40); fill(set, "structure", x0, 108, x0 + 12, 108, 40); fill(set, "structure", x0 + 12, 92, x0 + 12, 108, 40); }),
    structure_types: types,
  }, camera, frame);
  assert.deepEqual(edge.access("Bakery", { x: x0 + 6, y: 100 }), { ok: true });
});

test("a building that would close another's last route to the keep is refused; one that leaves a way is not", () => {
  // A woodcutter inside the wall, whose only way out is the gap at x = 100..101 on its up-right side.
  const yard = (set: Parameters<Parameters<typeof region>[0] & {}>[0]) => {
    ring(set, 92, 92, 108, 108, "structure", 40, [[100, 92], [101, 92]]);
    fill(set, "structure", 103, 103, 105, 105, 31);
  };
  const map = new TileMap({ ...region(yard), structure_types: types }, camera, frame);
  // A house on tile 101, 90 covers 99..102 × 88..91, right outside the gap.
  assert.deepEqual(map.access("Hovel", { x: 101, y: 90 }), { ok: false, reason: "cuts_route" });
  assert.deepEqual(map.access("Hovel", { x: 101, y: 88 }), { ok: true }, "a tile back leaves the way along the wall");
  assert.deepEqual(map.access("Hovel", { x: 115, y: 115 }), { ok: true });
  // A woodcutter placed during this call counts as a built one; a house inside needs no route itself.
  const placed = new TileMap({ ...region((set) => ring(set, 92, 92, 108, 108, "structure", 40, [[100, 92], [101, 92]])), structure_types: types }, camera, frame);
  placed.claim("Woodcutter", { x: 104, y: 104 }, 0, true);
  assert.deepEqual(placed.access("Hovel", { x: 101, y: 90 }), { ok: false, reason: "cuts_route" });
  // So does one about to be placed later in the call.
  const planned = new TileMap({ ...region((set) => ring(set, 92, 92, 108, 108, "structure", 40, [[100, 92], [101, 92]])), structure_types: types }, camera, frame);
  assert.deepEqual(planned.access("Hovel", { x: 101, y: 90 }, [{ ...footprintRect({ x: 104, y: 104 }, 3), building: "Woodcutter" }]), { ok: false, reason: "cuts_route" });
  // A building already cut off sets no limit.
  const walled = new TileMap({ ...region((set) => { ring(set, 92, 92, 108, 108, "structure", 40); fill(set, "structure", 103, 103, 105, 105, 31); }), structure_types: types }, camera, frame);
  assert.deepEqual(walled.access("Hovel", { x: 101, y: 90 }), { ok: true });
});

test("water and buildings close routes; trees, bushes and farm fields do not", () => {
  const walledBy = (layer: keyof TileRegion["layers"], v: number) =>
    new TileMap({ ...region((set) => ring(set, 92, 92, 108, 108, layer, v)), structure_types: types }, camera, frame);
  assert.equal(walledBy("logic", 0x100000).access("Bakery", { x: 100, y: 100 }).reason, "no_route", "water");
  assert.equal(walledBy("logic", 0x8000 | 0x10).access("Bakery", { x: 100, y: 100 }).reason, "no_route", "a mountain");
  assert.deepEqual(walledBy("organism", 1).access("Bakery", { x: 100, y: 100 }), { ok: true }, "trees");
  assert.deepEqual(walledBy("logic", 0x8000 | 0x4).access("Bakery", { x: 100, y: 100 }), { ok: true }, "a farm field");
});

test("route checks agree with a search of the whole region on random towns", () => {
  // Rooms walled by houses (which need no route), with no way in or one or two gaps of a tile or
  // two, granaries in some (people need a way to a tile beside one), and water; a house or a
  // granary tried on free ground, anywhere or by a gap, is checked against a plain search.
  let seed = 7;
  // The generator's high bits: its low ones repeat every few draws, so `% n` of them never picked some cases.
  const random = (n: number) => Math.floor(((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * n);
  const { x0, y0, w, h } = TileMap.regionFor(camera);
  const outcomes: Record<string, number> = {};
  for (let town = 0; town < 12; town++) {
    const typesOf: Record<string, number> = {};
    const gaps: [number, number][] = [];
    const mouths: [number, number][] = [];
    const layout = region((set) => {
      for (let k = 0; k < 8; k++) {
        const size = 8 + random(9);
        const x1 = x0 + 1 + random(w - size - 2), y1 = y0 + 1 + random(h - size - 2), x2 = x1 + size, y2 = y1 + size;
        const openings: [number, number][] = [];
        for (let g = random(3); g > 0; g--) {
          const side = random(4), at = 2 + random(size - 4), width = 1 + random(2);
          for (let d = 0; d < width; d++)
            openings.push(side === 0 ? [x1 + at + d, y1] : side === 1 ? [x1 + at + d, y2] : side === 2 ? [x1, y1 + at + d] : [x2, y1 + at + d]);
        }
        gaps.push(...openings);
        ring(set, x1, y1, x2, y2, "structure", 40 + k, openings);
        typesOf[String(40 + k)] = STRUCTURE_TYPES.hovel;
        if (random(3)) {
          const gx = x1 + 2 + random(size - 5), gy = y1 + 2 + random(size - 5);
          fill(set, "structure", gx, gy, gx + 2, gy + 2, 1000 + k);
          typesOf[String(1000 + k)] = STRUCTURE_TYPES.granary;
        }
      }
      // Granaries in nooks: walls on three sides, open on one, the case a footprint on the
      // nook's mouth cuts without changing anyone else's way.
      for (let k = 0; k < 6; k++) {
        const gx = x0 + 6 + random(w - 14), gy = y0 + 6 + random(h - 14), open = random(4), wall = 3000 + k;
        fill(set, "structure", gx, gy, gx + 3, gy + 3, 2000 + k);
        typesOf[String(2000 + k)] = STRUCTURE_TYPES.granary;
        typesOf[String(wall)] = STRUCTURE_TYPES.hovel;
        if (open !== 0) fill(set, "structure", gx - 1, gy - 1, gx + 4, gy - 1, wall);
        if (open !== 1) fill(set, "structure", gx - 1, gy + 4, gx + 4, gy + 4, wall);
        if (open !== 2) fill(set, "structure", gx - 1, gy - 1, gx - 1, gy + 4, wall);
        if (open !== 3) fill(set, "structure", gx + 4, gy - 1, gx + 4, gy + 4, wall);
        // The footprint that covers the whole mouth, centred by the game's rule (c - 2 .. c + 1).
        mouths.push(open === 0 ? [gx + 2, gy - 2] : open === 1 ? [gx + 2, gy + 6] : open === 2 ? [gx - 2, gy + 2] : [gx + 6, gy + 2]);
      }
      for (let k = 0; k < 4; k++) {
        const x = x0 + random(w - 8), y = y0 + random(h - 8);
        fill(set, "logic", x, y, x + 1 + random(6), y + 1 + random(6), 0x100000);
      }
    });
    const map = new TileMap({ ...layout, structure_types: typesOf }, camera, frame);
    const walkable = (x: number, y: number, shut?: { x1: number; y1: number; x2: number; y2: number }) => {
      const i = (y - y0) * w + (x - x0);
      return x >= x0 && y >= y0 && x < x0 + w && y < y0 + h && !layout.layers.structure[i] && !(layout.layers.logic[i] & 0x100000)
        && !(shut && x >= shut.x1 && x <= shut.x2 && y >= shut.y1 && y <= shut.y2);
    };
    const reachable = (shut?: { x1: number; y1: number; x2: number; y2: number }) => {
      const seen = new Set<string>();
      const queue: [number, number][] = [];
      for (let x = x0; x < x0 + w; x++) for (const y of [y0, y0 + h - 1]) queue.push([x, y]);
      for (let y = y0; y < y0 + h; y++) for (const x of [x0, x0 + w - 1]) queue.push([x, y]);
      for (const [x, y] of queue.splice(0)) if (walkable(x, y, shut) && !seen.has(`${x},${y}`)) { seen.add(`${x},${y}`); queue.push([x, y]); }
      while (queue.length) {
        const [x, y] = queue.shift()!;
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]])
          if (walkable(nx, ny, shut) && !seen.has(`${nx},${ny}`)) { seen.add(`${nx},${ny}`); queue.push([nx, ny]); }
      }
      return seen;
    };
    const beside = (r: { x1: number; y1: number; x2: number; y2: number }, seen: Set<string>) => {
      for (let x = r.x1; x <= r.x2; x++) if (seen.has(`${x},${r.y1 - 1}`) || seen.has(`${x},${r.y2 + 1}`)) return true;
      for (let y = r.y1; y <= r.y2; y++) if (seen.has(`${r.x1 - 1},${y}`) || seen.has(`${r.x2 + 1},${y}`)) return true;
      return false;
    };
    const granaries = map.storageRects("Granary");
    const before = reachable();
    let checked = 0;
    for (let k = 0; k < 600; k++) {
      const building = random(2) ? "Hovel" : "Granary";
      const pick = random(4);
      const gap = gaps.length && pick < 2 ? gaps[random(gaps.length)] : null;
      const t = pick === 3 && mouths.length
        ? (([x, y]) => ({ x, y }))(mouths[random(mouths.length)])
        : gap
          ? { x: Math.min(Math.max(gap[0] - 3 + random(7), x0 + 3), x0 + w - 4), y: Math.min(Math.max(gap[1] - 3 + random(7), y0 + 3), y0 + h - 4) }
          : { x: x0 + 3 + random(w - 7), y: y0 + 3 + random(h - 7) };
      const rect = footprintRect(t, 4);
      let free = true;
      for (let x = rect.x1; x <= rect.x2; x++) for (let y = rect.y1; y <= rect.y2; y++) if (!walkable(x, y)) free = false;
      if (!free) continue;
      const after = reachable(rect);
      const expected = building === "Granary" && !beside(rect, after) ? "no_route"
        : granaries.some((g) => beside(g, before) && !beside(g, after)) ? "cuts_route" : undefined;
      assert.equal(map.access(building, t, [], false).reason, expected, `town ${town}: ${building} at ${t.x},${t.y}`);
      outcomes[expected ?? "ok"] = (outcomes[expected ?? "ok"] ?? 0) + 1;
      checked++;
    }
    assert.ok(checked > 40, `${checked} spots checked`);
  }
  // The towns hold every case, not only open ground.
  assert.ok(outcomes.ok > 100 && outcomes.no_route >= 5 && outcomes.cuts_route >= 5, JSON.stringify(outcomes));
});

test("a footprint on a building's only way in cuts its route, though nothing else changes", () => {
  // A granary in a nook walled by houses on three sides, open only along y = 99 (review, 2026-10-14).
  const nook = new TileMap({
    ...region((set) => {
      fill(set, "structure", 100, 100, 103, 103, 5);
      fill(set, "structure", 99, 99, 99, 104, 40);
      fill(set, "structure", 104, 99, 104, 104, 40);
      fill(set, "structure", 99, 104, 104, 104, 40);
    }),
    structure_types: { "5": STRUCTURE_TYPES.granary, "40": STRUCTURE_TYPES.hovel },
  }, camera, frame);
  // Another granary or a house right on that row (100..103 × 96..99) used to pass.
  assert.deepEqual(nook.access("Granary", { x: 102, y: 98 }, [], false), { ok: false, reason: "cuts_route" });
  assert.deepEqual(nook.access("Hovel", { x: 102, y: 98 }, [], false), { ok: false, reason: "cuts_route" });
  assert.deepEqual(nook.access("Hovel", { x: 102, y: 97 }, [], false), { ok: false, reason: "cuts_route" }, "a tile further out");
  assert.deepEqual(nook.access("Hovel", { x: 108, y: 95 }, [], false), { ok: true });
});

test("churches need neither an open side nor a route: they have no peasant job", () => {
  const walled = new TileMap({ ...region((set) => ring(set, 92, 92, 108, 108, "structure", 40)), structure_types: types }, camera, frame);
  for (const building of ["Chapel", "Church", "Cathedral"]) assert.deepEqual(walled.access(building, { x: 100, y: 100 }), { ok: true }, building);
  // A chapel (type 36) behind the only gap sets no route limit either.
  const yard = new TileMap({
    ...region((set) => { ring(set, 92, 92, 108, 108, "structure", 40, [[100, 92], [101, 92]]); fill(set, "structure", 99, 99, 104, 104, 36); }),
    structure_types: { ...types, "36": 36 },
  }, camera, frame);
  assert.deepEqual(yard.access("Hovel", { x: 101, y: 90 }), { ok: true });
});

test("storage may touch the keep, as it touches the keep's courtyard", () => {
  const map = new TileMap({
    ...region((set) => fill(set, "structure", 92, 98, 99, 105, 41)),
    structure_types: { "41": STRUCTURE_TYPES.keep },
  }, camera, frame);
  // A granary on tile 102, 100 covers 100..103: flush against the keep at x = 99.
  assert.deepEqual(map.access("Granary", { x: 102, y: 100 }), { ok: true });
  assert.deepEqual(map.access("Stockpile", { x: 102, y: 100 }), { ok: true });
});

/** A stockpile at 100..104 with room for one more only down-right, in 105..109 × 100..104 (trees close the rest). */
function lastRoom() {
  return new TileMap({
    ...region((set) => {
      stockpile(set, 100, 100, 1);
      fill(set, "organism", 90, 90, 99, 115, 1);
      fill(set, "organism", 90, 90, 115, 99, 1);
      fill(set, "organism", 90, 105, 104, 115, 1);
      set("organism", 105, 99, 1);
      set("organism", 105, 105, 1);
    }),
    structure_types: piles(1),
  }, camera, frame);
}

test("a spot refused during the call does not count as room taken beside the stockpile", () => {
  // A house on tile 108, 102 covers the last room; build_structure refuses it without a click.
  // Claimed as refused, it emptied the room, and the guard let the next spot take it (review).
  const map = lastRoom();
  assert.deepEqual(map.access("Hovel", { x: 108, y: 102 }), { ok: false, reason: "blocks_stockpile" });
  map.claim("Hovel", { x: 108, y: 102 });
  assert.deepEqual(map.access("Hovel", { x: 108, y: 106 }), { ok: false, reason: "blocks_stockpile" }, "covers the room's row 104");
  // Also when the room is first worked out after such a claim.
  const late = lastRoom();
  late.claim("Hovel", { x: 108, y: 102 }, 1);
  assert.deepEqual(late.access("Hovel", { x: 108, y: 106 }), { ok: false, reason: "blocks_stockpile" });
  // A building placed there does take the room, and then the stockpile has none left to keep.
  const placed = lastRoom();
  placed.claim("Hovel", { x: 108, y: 102 }, 0, true);
  assert.deepEqual(placed.access("Hovel", { x: 108, y: 108 }), { ok: true });
});

test("another stockpile is retried only flush with the stockpile, keeping open ground first", () => {
  // A stockpile at 100..104 with a house against its down-right side (105..108 × 100..103).
  const map = new TileMap({
    ...region((set) => { stockpile(set, 100, 100, 1); fill(set, "structure", 105, 100, 108, 103, 40); }),
    structure_types: { ...piles(1), "40": STRUCTURE_TYPES.hovel },
  }, camera, frame);
  const flush = (t: { x: number; y: number }) => {
    const r = footprintRect(t, 5);
    const touches = r.x1 <= 105 && 100 <= r.x2 + 1 && r.y1 <= 105 && 100 <= r.y2 + 1;
    return touches && !(r.x1 <= 104 && 100 <= r.x2 && r.y1 <= 104 && 100 <= r.y2);
  };
  const [site] = map.storageSitesNear("Stockpile", { x: 108, y: 106 });
  assert.ok(site && flush(site.tile), JSON.stringify(site));
  assert.deepEqual(map.access("Stockpile", site.tile), { ok: true }, "the nearest that keeps a tile from the house");
  // Trees close three sides and a house stands past the fourth: the one flush spot touches it,
  // and is taken rather than none.
  const crowded = new TileMap({
    ...region((set) => {
      stockpile(set, 100, 100, 1);
      fill(set, "organism", 95, 95, 109, 99, 1);
      fill(set, "organism", 95, 105, 109, 109, 1);
      fill(set, "organism", 95, 100, 99, 104, 1);
      fill(set, "structure", 110, 100, 113, 103, 40);
    }),
    structure_types: { ...piles(1), "40": STRUCTURE_TYPES.hovel },
  }, camera, frame);
  const [tight] = crowded.storageSitesNear("Stockpile", { x: 107, y: 102 });
  assert.ok(tight && flush(tight.tile), JSON.stringify(tight));
  assert.equal(crowded.access("Stockpile", tight.tile).reason, "touches_storage");
});

test("another granary or armory is offered only flush with one of its kind", () => {
  // A granary at 100..103 and an armory at 120..123: the game takes a new one only touching its
  // kind ("Needs to be placed adjacent to the granary."), so the spots touch it, nearest the asked
  // tile first, wherever that tile is.
  const map = new TileMap({
    ...region((set) => { fill(set, "structure", 100, 100, 103, 103, 5); fill(set, "structure", 120, 100, 123, 103, 6); }),
    structure_types: { "5": STRUCTURE_TYPES.granary, "6": STRUCTURE_TYPES.armory },
  }, camera, frame);
  const touches = (t: { x: number; y: number }, r: { x1: number; y1: number; x2: number; y2: number }) => {
    const f = footprintRect(t, 4);
    return f.x1 <= r.x2 + 1 && r.x1 <= f.x2 + 1 && f.y1 <= r.y2 + 1 && r.y1 <= f.y2 + 1 && !(f.x1 <= r.x2 && r.x1 <= f.x2 && f.y1 <= r.y2 && r.y1 <= f.y2);
  };
  const granaries = map.storageSitesNear("Granary", { x: 90, y: 115 }, 3);
  assert.equal(granaries.length, 3);
  assert.ok(granaries.every((s) => touches(s.tile, { x1: 100, y1: 100, x2: 103, y2: 103 })), JSON.stringify(granaries));
  const [armory] = map.storageSitesNear("Armory", { x: 130, y: 101 });
  assert.ok(armory && touches(armory.tile, { x1: 120, y1: 100, x2: 123, y2: 103 }), JSON.stringify(armory));
  // None of a kind in the area: no spots.
  assert.deepEqual(new TileMap(region(() => {}), camera, frame).storageSitesNear("Granary", { x: 100, y: 100 }), []);
});

test("spots beside a building chosen without the open-ground rule are all offered", () => {
  // Houses flush against a granary: with spaced off, three of them, not one (review: distinct
  // checked later spots with the rule on).
  const map = new TileMap({ ...region((set) => fill(set, "structure", 100, 100, 103, 103, 5)), structure_types: { "5": STRUCTURE_TYPES.granary } }, camera, frame);
  assert.equal(map.sitesBeside("Hovel", { x1: 100, y1: 100, x2: 103, y2: 103 }, 3, undefined, 0, { spaced: false }).length, 3);
  assert.equal(map.sitesBeside("Hovel", { x1: 100, y1: 100, x2: 103, y2: 103 }, 3, undefined, 0).length, 0, "with it on, none touch the granary");
});

test("route checks keep a find_sites search over a busy view quick", () => {
  // A town of houses on a grid, with six tiles of free ground between them.
  const town = new TileMap({
    ...region((set) => { for (let x = 72; x < 126; x += 10) for (let y = 72; y < 126; y += 10) fill(set, "structure", x, y, x + 3, y + 3, 40); }),
    structure_types: types,
  }, camera, frame);
  const started = performance.now();
  const sites = town.sitesNear("Bakery", { x: 100, y: 100 }, 3, 20);
  const ms = performance.now() - started;
  assert.equal(sites.length, 3);
  assert.ok(ms < 3000, `${Math.round(ms)} ms`);
});

test("sites in a one-building strip leave each other an open side; two rows back to back each keep one", () => {
  // Open land only in the strip y = 98..101, x = 80..120: bakeries fit in one row there.
  const strip = new TileMap(region((set) => {
    const { x0, y0, w, h } = TileMap.regionFor(camera);
    fill(set, "organism", x0, y0, x0 + w - 1, y0 + h - 1, 1);
    fill(set, "organism", 80, 98, 120, 101, 0);
  }), camera, frame);
  const sites = strip.sitesNear("Bakery", { x: 100, y: 100 }, 5, 20);
  const rects = sites.map((s) => footprintRect(s.tile, 4));
  assert.ok(sites.length >= 2, JSON.stringify(sites));
  for (const [i, r] of rects.entries())
    assert.ok(strip.openSides(r, rects.filter((_, j) => j !== i)) >= 1, `site ${i} keeps an open side`);
  // Two rows back to back on open land: the second row's bakery leaves the first its outer side.
  const open = new TileMap(region(), camera, frame);
  open.claim("Bakery", { x: 100, y: 100 }, 0, true);
  open.claim("Bakery", { x: 104, y: 100 }, 0, true);
  assert.deepEqual(open.access("Bakery", { x: 100, y: 104 }), { ok: true });
  assert.deepEqual(open.access("Bakery", { x: 104, y: 104 }), { ok: true });
});

test("spots keep one tile of open ground around a granary or an armory, except for another of the same kind", () => {
  // The user's rule (2026-10-12): workers keep walking to granaries and armories.
  const map = () => new TileMap({
    ...region((set) => fill(set, "structure", 100, 100, 103, 103, 9)),
    structure_types: { 9: STRUCTURE_TYPES.granary },
  }, camera, frame);
  const granary = { x1: 100, y1: 100, x2: 103, y2: 103 };
  // A hovel flush against it is refused; one tile away it fits.
  assert.equal(map().access("Hovel", { x: 106, y: 102 }).reason, "touches_storage");
  assert.ok(map().access("Hovel", { x: 107, y: 102 }).ok);
  // A second granary may touch it, as the game wants.
  assert.ok(map().access("Granary", { x: 106, y: 102 }).ok);
  // The same holds for an armory placed during this call, and for one about to be placed.
  const placed = new TileMap(region(), camera, frame);
  placed.claim("Armory", { x: 102, y: 102 }, 0, true);
  assert.equal(placed.access("Woodcutter", { x: 105, y: 102 }).reason, "touches_storage");
  assert.ok(placed.access("Armory", { x: 106, y: 102 }).ok);
  assert.equal(new TileMap(region(), camera, frame).access("Hovel", { x: 106, y: 102 }, [{ ...granary, building: "Granary" }]).reason, "touches_storage");
  // Spots offered beside it leave the gap.
  const beside = map().sitesBeside("Hovel", granary, 1, "down-right", 3)[0];
  assert.equal(beside.gap, 1, JSON.stringify(beside));
});

test("spots keep one tile of open ground around a stockpile too, and a new stockpile may still touch it", () => {
  // The user's rule (2026-10-14): workers carry every good to the stockpile.
  const map = () => new TileMap({ ...region((set) => stockpile(set, 100, 100, 1)), structure_types: piles(1) }, camera, frame);
  const square = { x1: 100, y1: 100, x2: 104, y2: 104 };
  // A hovel (side 4: tile 107 covers 105..108) flush against the square is refused on any side;
  // one tile away it fits.
  assert.equal(map().access("Hovel", { x: 107, y: 102 }).reason, "touches_storage");
  assert.equal(map().access("Hovel", { x: 102, y: 107 }).reason, "touches_storage");
  assert.ok(map().access("Hovel", { x: 108, y: 102 }).ok);
  // A second stockpile may touch it, as the game wants, and spots beside it for one are flush.
  assert.ok(map().access("Stockpile", { x: 107, y: 102 }).ok);
  const flush = map().sitesBeside("Stockpile", square, 1, "down-right", 0)[0];
  assert.equal(flush.gap, 0, JSON.stringify(flush));
  // Other buildings offered beside it leave the gap; one planned in the same call counts too.
  const beside = map().sitesBeside("Hovel", square, 1, "down-right", 3)[0];
  assert.equal(beside.gap, 1, JSON.stringify(beside));
  assert.equal(new TileMap(region(), camera, frame).access("Hovel", { x: 107, y: 102 }, [{ ...square, building: "Stockpile" }]).reason, "touches_storage");
  // A new stockpile touching another building is refused while spaced (expand_storage then falls
  // back to a flush spot: anchors.ts).
  const crowded = new TileMap({
    ...region((set) => { stockpile(set, 100, 100, 1); fill(set, "structure", 105, 106, 108, 109, 20); }),
    structure_types: { ...piles(1), "20": STRUCTURE_TYPES.hovel },
  }, camera, frame);
  assert.equal(crowded.access("Stockpile", { x: 102, y: 107 }).reason, "touches_storage");
  assert.ok(crowded.access("Stockpile", { x: 102, y: 107 }, [], false).ok);
});

test("no spot the harness picks takes the last room beside a stockpile for another one", () => {
  // The stockpile (100..104) with trees on its up-left and up-right sides and, along the
  // down-left side, as far as its own edge: another stockpile still fits down-right (+x) and
  // down-left (+y, slid towards +x).
  const blocked = (downLeft: boolean) => (set: Parameters<Parameters<typeof region>[0] & {}>[0]) => {
    stockpile(set, 100, 100, 1);
    fill(set, "organism", 90, 90, 99, 115, 1);
    fill(set, "organism", 90, 90, 115, 99, 1);
    if (downLeft) fill(set, "organism", 90, 105, 104, 115, 1);
  };
  const lastSide = () => new TileMap({ ...region(blocked(true)), structure_types: piles(1) }, camera, frame);
  // Down-right is its only room: a hovel there (106..109 × 102..105) would cover every spot left.
  assert.equal(lastSide().access("Hovel", { x: 108, y: 104 }).reason, "blocks_stockpile");
  assert.ok(lastSide().access("Hovel", { x: 115, y: 104 }).ok, "beyond the room it fits");
  assert.ok(lastSide().access("Stockpile", { x: 107, y: 102 }).ok, "a stockpile itself may take it");
  assert.ok(lastSide().access("Hovel", { x: 108, y: 104 }, [], false).ok, "only spots chosen with spacing keep it");
  assert.equal(lastSide().sitesNear("Hovel", { x: 108, y: 104 }, 1, 0).length, 0, "find_sites does not offer it");
  // With room down-left as well, one side may be built on, until the other is taken in the same call.
  const twoSides = new TileMap({ ...region(blocked(false)), structure_types: piles(1) }, camera, frame);
  assert.ok(twoSides.access("Hovel", { x: 108, y: 104 }).ok);
  twoSides.claim("Hovel", { x: 104, y: 107 }, 0, true);
  assert.equal(twoSides.access("Hovel", { x: 108, y: 104 }).reason, "blocks_stockpile");
  // A stockpile at the edge of the read region (which ends at x = 128) may have room beyond it:
  // its one spot in view, up-left, is not held for it.
  const edge = new TileMap({
    ...region((set) => {
      stockpile(set, 122, 100, 1);
      fill(set, "organism", 110, 90, 128, 99, 1);
      fill(set, "organism", 110, 105, 128, 115, 1);
    }),
    structure_types: piles(1),
  }, camera, frame);
  assert.ok(edge.access("Hovel", { x: 119, y: 102 }).ok);
});
