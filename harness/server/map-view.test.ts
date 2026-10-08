import test from "node:test";
import assert from "node:assert/strict";
import { decodeRows, MapView, type MapSummary } from "./map-view.js";
import { minimapFraction } from "./anchors.js";

/** A 40×40 map at 100..139 with a stone patch, an ore patch, farmland and a keep. */
function summary(): MapSummary {
  const rows: string[] = [];
  for (let y = 0; y < 150; y++) {
    let row = "";
    for (let x = 0; x < 150; x++) {
      const inside = x >= 100 && x < 140 && y >= 100 && y < 140;
      row += !inside ? "_"
        : x >= 102 && x < 106 && y >= 102 && y < 106 ? "S"
        : x >= 130 && x < 132 && y >= 110 && y < 113 ? "I"
        : x >= 110 && x < 125 && y >= 120 && y < 135 ? (x === 110 ? "s" : "O")
        : x >= 118 && x < 121 && y >= 104 && y < 107 ? "K"
        : ".";
    }
    rows.push(row.replace(/(.)\1*/g, (run) => `${run[0]}${run.length}`));
  }
  return { size: 150, rows, bounds: { x0: 100, y0: 100, x1: 139, y1: 139 } };
}

test("rows decode from letter-count runs", () => {
  assert.deepEqual(decodeRows(["_3O2.1", "S12"]), ["___OO.", "SSSSSSSSSSSS"]);
});

test("areas, keep and extent come from the tile letters", () => {
  const view = new MapView(summary());
  assert.deepEqual(view.keep(), { x: 119, y: 105 });
  const [stone] = view.areas("S");
  assert.equal(stone.tiles, 16);
  assert.deepEqual(stone.box, { x0: 102, y0: 102, x1: 105, y1: 105 });
  assert.equal(view.areas("I", 4)[0].tiles, 6);
  assert.equal(view.areas("Os", 60)[0].tiles, 225);
  assert.deepEqual(view.extent(), { umin: -39, umax: 39, vmin: 200, vmax: 278 });
  const text = view.describe();
  assert.match(text, /Keep: \(119, 105\)/);
  assert.match(text, /Stone deposits[^\n]*\n- centre \(104, 104\), 16 tiles/);
});

test("the overview is a valid PNG", () => {
  const png = new MapView(summary()).png({ centre_tile_x: 120, centre_tile_y: 120, tiles_wide: 30, tiles_high: 68 });
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
});

test("minimap clicks follow the edge-clamped window (live moves on Oasis by the Sea)", () => {
  const extent = { umin: -98, umax: 98, vmin: 702, vmax: 898 };
  // Camera (421, 363) near the north-east edge sits at about 0.68 across the minimap, not 0.5.
  const f = minimapFraction({ x: 421, y: 363 }, { x: 421, y: 363 }, extent);
  assert.ok(Math.abs(f.x - 0.68) < 0.01 && Math.abs(f.y - 0.5) < 0.01);
  // Live: from (363, 383) a click at (0.292, 0.5) went to (359, 405).
  const g = minimapFraction({ x: 363, y: 383 }, { x: 359, y: 405 }, extent);
  assert.ok(Math.abs(g.x - 0.292) < 0.01 && Math.abs(g.y - 0.5) < 0.01);
});
