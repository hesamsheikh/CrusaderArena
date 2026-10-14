import test from "node:test";
import assert from "node:assert/strict";
import { aimAtTile, type AimIo, type ViewOffset } from "./placement.js";
import { tilePixel } from "./tile-map.js";

const frame = { width: 1920, height: 1080 };
const camera = { centre_tile_x: 100, centre_tile_y: 100, tiles_wide: 30, tiles_high: 68, pixels_per_unit_scale: 1 };
const row = frame.height / camera.tiles_high;

/** The tile drawn at a window pixel on low ground (tilePixel turned back), moved by `shift`: the game's pick. */
const picker = (shift: { x: number; y: number }) => (p: { x: number; y: number }) => {
  const u = (p.x - 960) / 32, v = (p.y - 540) / row + 8 / 8.7;
  return { x: 100 + Math.round((u + v) / 2) + shift.x, y: 100 + Math.round((v - u) / 2) + shift.y };
};

/** aimAtTile's reader and pointer: the game's tile under the pointer shows in the very next sample. */
function aimIo(pick: (p: { x: number; y: number }) => { x: number; y: number }) {
  let pointer: { x: number; y: number } | null = null;
  const offsets: { view?: ViewOffset } = {};
  const io: AimIo = {
    device: {
      currentStats: () => ({
        status: "ok", captured_unix_ms: Date.now(),
        observation: { camera, mouse_tile: pointer ? pick(pointer) : null },
      }),
    } as unknown as AimIo["device"],
    move: async (p) => {
      pointer = p;
      return { at: Date.now() - 1000 };
    },
    pause: async () => {},
    frame,
    offsets,
  };
  return { io, offsets };
}

test("aimAtTile follows raised ground's offset up the screen however far, and keeps only a small one for the view", async () => {
  // Raised ground drawn higher than its flat position put the game's tile 4 tiles down the map on
  // The Sinkhole's slope, past the 3 the aim had followed (GLM 5.3 Flash, live 2026-10-14).
  const target = { x: 110, y: 104 };
  const point = tilePixel(camera, frame, target);
  const raised = aimIo(picker({ x: 4, y: 4 }));
  const aimed = await aimAtTile(raised.io, point, target);
  assert.equal(aimed.matched, true, JSON.stringify(aimed));
  assert.deepEqual(aimed.shown, target);
  assert.deepEqual(aimed.point, { x: point.x, y: Math.round(point.y - 8 * row) }, "8 rows up the screen");
  assert.equal(aimed.moves, 2);
  assert.equal(raised.offsets.view, undefined, "a tile's height is not the view's offset");
  // The camera's part tile is: the next target in the view starts from it.
  const off = aimIo(picker({ x: 1, y: 0 }));
  assert.equal((await aimAtTile(off.io, point, target)).matched, true);
  assert.deepEqual(off.offsets.view, { camera: "100,100,30,68,1", x: 1, y: 0 });
  // Sideways the offset is still followed only a little way: there it is something drawn over the spot.
  const across = aimIo(picker({ x: 4, y: -4 }));
  const missed = await aimAtTile(across.io, point, target);
  assert.equal(missed.matched, false);
  assert.equal(missed.moves, 1);
  assert.deepEqual(missed.point, point);
});
