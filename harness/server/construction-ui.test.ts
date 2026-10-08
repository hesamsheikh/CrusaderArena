import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildingCost,
  cameraKey,
  confirmPlacement,
  selectionConfirmed,
  constructionClicks,
  minimapClick,
  nearbyTargets,
  placementFeedback,
  placementStatus,
  visiblePlacementFeedback,
} from "./construction-ui.js";
import type { Frame } from "../shared/protocol.js";

const frame = (width: number, height: number) => ({ width, height }) as Frame;

test("named orchard uses farm category, orchard button and requested terrain", () => {
  assert.deepEqual(constructionClicks(frame(1920, 1080), "Apple Orchard", { x: 700, y: 440 }), [
    { type: "click", x: 949, y: 1055, button: 1 },
    { type: "click", x: 1166, y: 974, button: 1 },
    { type: "click", x: 700, y: 440, button: 1 },
  ]);
});

test("named construction scales with a resized 16:9 game window", () => {
  assert.deepEqual(constructionClicks(frame(1280, 720), "Hovel", { x: 450, y: 300 }), [
    { type: "click", x: 666, y: 703, button: 1 },
    { type: "click", x: 577, y: 652, button: 1 },
    { type: "click", x: 450, y: 300, button: 1 },
  ]);
});

test("named construction rejects uncalibrated layouts and HUD targets", () => {
  assert.throws(() => constructionClicks(frame(1600, 900), "Apple Orchard", { x: 500, y: 850 }), /bottom HUD/);
  assert.throws(() => constructionClicks(frame(1600, 900), "Unknown", { x: 500, y: 400 }), /Unsupported/);
  assert.throws(() => constructionClicks(frame(1600, 1000), "Hovel", { x: 500, y: 400 }), /16:9/);
});

test("minimap navigation maps fractions into the inner radar area", () => {
  assert.deepEqual(minimapClick(frame(1920, 1080), 0.5, 0.5),
    { type: "click", x: 1688, y: 974, button: 1 });
  assert.deepEqual(minimapClick(frame(1280, 720), 0, 0),
    { type: "click", x: 1070, y: 595, button: 1 });
  assert.throws(() => minimapClick(frame(1920, 1080), 1.1, 0), /fractions/);
});

test("only fresh panel feedback is treated as placement feedback", () => {
  assert.deepEqual(placementFeedback({ events: [
    { kind: "visible_message_observed", channel: "Panel_Feedback", text: "Farms must be placed on an oasis." },
    { kind: "visible_message_observed", channel: "Feedback_1", text: "Food is low" },
    // A missing resource arrives on Feedback_1 (run 10).
    { kind: "visible_message_observed", channel: "Feedback_1", text: "  Wood needed  " },
  ] }), ["Farms must be placed on an oasis.", "Wood needed"]);
});

test("visible rejection without a fresh event is only possibly rejected", () => {
  const rejection = "Needs to be placed adjacent to the stockpile.";
  assert.equal(placementStatus([rejection], [rejection]), "rejected");
  assert.equal(placementStatus([], [rejection]), "possibly_rejected");
  assert.equal(placementStatus(["Granary placed"], []), "feedback");
  assert.equal(placementStatus([], []), "unverified");
  assert.deepEqual(visiblePlacementFeedback({ visible_messages: [
    { channel: "Keep_Message", text: "  Site your granary  " },
    { channel: "Panel_Feedback", text: rejection },
  ] }), [rejection]);
  assert.deepEqual(visiblePlacementFeedback(null), []);
});

test("feedback that reappears after a menu rollover is not a new rejection", () => {
  const rejection = "Farms must be placed on an oasis.";
  assert.equal(placementStatus([rejection], [rejection], [rejection]), "possibly_rejected");
  assert.equal(placementStatus([rejection], [rejection], ["Needs to be placed adjacent to the stockpile."]), "rejected");
});

test("manual build costs parse into wood and gold", () => {
  assert.deepEqual(buildingCost("Hovel"), { wood: 6, gold: 0 });
  assert.deepEqual(buildingCost("Apothecary"), { wood: 20, gold: 150 });
  assert.deepEqual(buildingCost("Cathedral"), { wood: 0, gold: 1000 });
  assert.deepEqual(buildingCost("Stockpile"), { wood: 0, gold: 0 });
  assert.equal(buildingCost("Marketplace"), null, "ambiguous manual cost");
});

test("selection is confirmed only when placement mode switches to the building", () => {
  assert.ok(selectionConfirmed({ action: 0, sub_action: 52 }, { action: 5, sub_action: 52 }, false));
  assert.ok(selectionConfirmed({ action: 5, sub_action: 52 }, { action: 5, sub_action: 54 }, false));
  assert.ok(!selectionConfirmed({ action: 5, sub_action: 52 }, { action: 5, sub_action: 52 }, false));
  assert.ok(selectionConfirmed({ action: 5, sub_action: 54 }, { action: 5, sub_action: 54 }, true));
  assert.ok(!selectionConfirmed({ action: 0, sub_action: 52 }, { action: 0, sub_action: 52 }, false));
});

test("camera key changes with any camera field", () => {
  const camera = { centre_tile_x: 1, centre_tile_y: 2, tiles_wide: 30, tiles_high: 68, pixels_per_unit_scale: 1 };
  assert.equal(cameraKey({ camera }), cameraKey({ camera: { ...camera } }));
  assert.notEqual(cameraKey({ camera }), cameraKey({ camera: { ...camera, pixels_per_unit_scale: 0.7 } }));
  assert.equal(cameraKey({ camera: null }), null);
});

test("reader evidence confirms or refutes a placement", () => {
  const hovel = { wood: 6, gold: 0 };
  const before = { wood: 172, gold: 600, structures: 18 };
  // Live case: a hovel reported possibly_rejected by reappearing text, yet its cost was paid.
  assert.equal(confirmPlacement("possibly_rejected", hovel, before, { wood: 166, gold: 600, structures: 19 }).evidence, "cost");
  assert.equal(confirmPlacement("unverified", hovel, before, { wood: 167, gold: 600, structures: 19 }).status, "placed", "delivery tolerance");
  assert.equal(confirmPlacement("unverified", hovel, before, { ...before }).status, "not_placed");
  assert.equal(confirmPlacement("rejected", hovel, before, { ...before }).status, "rejected");
  assert.equal(confirmPlacement("unverified", { wood: 0, gold: 0 }, before, { ...before, structures: 19 }).evidence, "structure_count");
  // Live case: starting goods delivered +3 wood while a free setup granary was placed.
  assert.deepEqual(confirmPlacement("unverified", { wood: 5, gold: 0 }, before, { wood: 175, gold: 680, structures: 19 }),
    { status: "placed", evidence: "structure_count", change: { wood: 3, gold: 80, structures: 1 } });
  assert.equal(confirmPlacement("possibly_rejected", hovel, before, { wood: 170, gold: 600, structures: 18 }).status, "possibly_rejected");
  assert.equal(confirmPlacement("unverified", hovel, before, { wood: 175, gold: 600, structures: 18 }).status, "not_placed", "deliveries alone");
  assert.equal(confirmPlacement("unverified", hovel, null, before).status, "unverified");
  assert.deepEqual(confirmPlacement("unverified", hovel, before, { wood: 166, gold: 600, structures: 19 }).change,
    { wood: -6, gold: 0, structures: 1 });
});

test("nearby retry targets step half, then a whole footprint along each isometric axis", () => {
  const frame = { width: 1920, height: 1080 };
  // 30 × 68 tiles at 1920 × 1080: a diamond is 64 px wide and one row is ~15.9 px.
  const span = { tiles_wide: 30, tiles_high: 68 };
  const targets = nearbyTargets(frame, { x: 960, y: 500 }, span);
  assert.deepEqual(targets.slice(0, 4).map((t) => [t.x, t.y]), [[1024, 532], [896, 468], [896, 532], [1024, 468]]);
  // Then a whole 3-tile footprint along each axis.
  assert.deepEqual(targets.slice(4).map((t) => t.offsetTiles), [[3, 0], [-3, 0], [0, 3], [0, -3]]);
  assert.deepEqual(targets[0].offsetTiles, [2, 0]);
  assert.equal(nearbyTargets(frame, { x: 960, y: 500 }, span, [], 3).length, 3);
  // Zoomed out, the same tile offsets are fewer pixels.
  assert.deepEqual(nearbyTargets(frame, { x: 960, y: 500 }, { tiles_wide: 60, tiles_high: 136 }, [], 1).map((t) => [t.x, t.y]), [[992, 516]]);
});

test("nearby retry targets stay on visible terrain and away from other targets", () => {
  const frame = { width: 1920, height: 1080 };
  const span = { tiles_wide: 30, tiles_high: 68 };
  // Near the bottom HUD only upward candidates remain; near the left edge, no leftward ones.
  assert.ok(nearbyTargets(frame, { x: 960, y: 880 }, span).every((t) => t.y < 1080 * 0.82));
  assert.ok(nearbyTargets(frame, { x: 10, y: 500 }, span).every((t) => t.x >= 0));
  // A planned target two tiles to the right-down rules out candidates within three tiles of it.
  const planned = { x: 1024, y: 532 };
  const kept = nearbyTargets(frame, { x: 960, y: 500 }, span, [planned]);
  assert.ok(!kept.some((t) => t.x === 1024 && t.y === 532));
  assert.ok(!kept.some((t) => t.x === 1088 && t.y === 500), "one tile from the planned target");
  assert.ok(kept.some((t) => t.x === 896 && t.y === 468), "the opposite side stays available");
});

test("retry offsets and clearance scale with the building footprint", () => {
  const frame = { width: 1920, height: 1080 };
  const span = { tiles_wide: 30, tiles_high: 68 };
  // A 9-tile wheat farm moves 5 tiles, then 9: a 2-tile nudge would keep most of it on the blocker.
  const farm = nearbyTargets(frame, { x: 960, y: 400 }, span, [], Infinity, 9);
  assert.deepEqual(farm.map((t) => t.offsetTiles), [[5, 0], [-5, 0], [0, 5], [0, -5], [9, 0], [-9, 0], [0, 9], [0, -9]]);
  // A planned 9-tile farm 6 tiles away rules out a 4-tile hovel retry that a fixed 3-tile gap allowed.
  const plannedFarm = { x: 960 + 6 * 32, y: 500 + Math.round(6 * 1080 / 68), size: 9 };
  const hovel = nearbyTargets(frame, { x: 960, y: 500 }, span, [plannedFarm], Infinity, 4);
  assert.ok(!hovel.some((t) => t.offsetTiles[0] === 2 && t.offsetTiles[1] === 0));
  assert.ok(hovel.some((t) => t.offsetTiles[0] === -2 && t.offsetTiles[1] === 0));
});
