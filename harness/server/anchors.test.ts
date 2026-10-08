import { test } from "node:test";
import assert from "node:assert/strict";
import { adjacentRays, cameraShift, sideOrder, tilePixel } from "./anchors.js";
import { describeBuilding, statusReport } from "./status.js";

const frame = { width: 1920, height: 1080 };
const span = { tiles_wide: 30, tiles_high: 68 };

test("tile offsets map to isometric screen steps around the window centre", () => {
  assert.deepEqual(tilePixel(frame, span, 0, 0), { x: 960, y: 540 });
  // One tile along each world axis: half a 64 px diamond sideways and one ~15.9 px row down.
  assert.deepEqual(tilePixel(frame, span, 1, 0), { x: 992, y: 556 });
  assert.deepEqual(tilePixel(frame, span, 0, 1), { x: 928, y: 556 });
  assert.deepEqual(tilePixel(frame, span, 2, -2), { x: 1088, y: 540 });
});

test("adjacent probe lines march outward per side and lateral shift, stopping at the HUD", () => {
  const rays = adjacentRays(frame, span);
  assert.equal(rays[0].side, "down-right");
  assert.equal(rays[0].lateral, 0);
  assert.deepEqual(rays[0].points.slice(0, 2).map(({ x, y }) => [x, y]), [[1024, 572], [1056, 588]]);
  assert.deepEqual(rays[0].points.map((p) => p.d), [2, 3, 4, 5, 6, 7]);
  // All sides straight out first, then the lateral shifts.
  assert.deepEqual(rays.slice(0, 4).map((r) => r.side), ["down-right", "down-left", "up-right", "up-left"]);
  assert.deepEqual(rays.slice(0, 5).map((r) => r.lateral), [0, 0, 0, 0, 2]);
  // Near the bottom HUD the downward lines are cut short.
  const low = adjacentRays({ width: 1920, height: 1080 }, { tiles_wide: 30, tiles_high: 14 });
  assert.ok(low.every((r) => r.points.every((p) => p.y < 1080 * 0.82)));
  assert.deepEqual(sideOrder("up-left"), ["up-left", "down-right", "down-left", "up-right"]);
});

test("camera shift is measured in centre tiles and requires the same span and zoom", () => {
  assert.equal(cameraShift("372,438,30,68,1", "373,437,30,68,1"), 1);
  assert.equal(cameraShift("372,438,30,68,1", "372,438,30,68,1"), 0);
  assert.equal(cameraShift("372,438,30,68,1", "372,438,42,97,0.7"), Infinity);
  assert.equal(cameraShift(null, "372,438,30,68,1"), Infinity);
});

const sample = (observation: Record<string, unknown>) => ({ status: "ok", observation: observation as never });

test("status report converts popularity factors to UI points and names the date", () => {
  const report = statusReport(sample({
    gold: 600, population: 3, popularity: 95, map_name: "m", wood_planks: 0,
    resources_by_name: { wood_planks: 40, bread: 52 },
    placement: { action: 5, sub_action: 54 },
    camera: { centre_tile_x: 372, centre_tile_y: 438, tiles_wide: 30, tiles_high: 68, pixels_per_unit_scale: 1 },
    visible_messages: [],
    settlement: {
      month: 4, year: 1081, housing_cap: 10, peasants_available: 1, total_food: 51, months_of_food: 318,
      rationing: 2, food_types_eaten: 1, food_types_available: 1, efficiency: 100, upcoming_popularity: -175,
      popularity_factors: { food: -200, tax: 25, religion: 0 },
    },
  }), { views: ["farms"] });
  assert.equal(report.status, "ok");
  if (report.status !== "ok") return;
  assert.equal(report.date, "May 1081");
  assert.deepEqual(report.population, { current: 3, housing: 10, idle_peasants: 1 });
  assert.equal(report.popularity.upcoming_change, -7);
  assert.deepEqual(report.popularity.factors, { food: -8, tax: 1 });
  assert.equal(report.food.rationing, "full");
  assert.equal(report.stockpile.wood_planks, 40);
  assert.equal(report.placement_mode, "placing");
  assert.deepEqual(report.saved_views, ["farms"]);
  assert.equal(statusReport({ status: "unavailable", observation: null }).status, "unavailable");
});

test("building description separates staffed buildings from storage", () => {
  const base = { hp: 0, max_hp: 0, no_resources: 0, turned_off: 0 };
  assert.deepEqual(describeBuilding({ ...base, id: 15, type: 3, have_stats: 1, workers_have: 1, job_vacancies: 0, workers_needed: 1, working: 1, keep_access: 1 }), {
    id: 15, type: 3, name: "Woodcutter's Hut",
    workers: { have: 1, needed: 1, vacancies: 0 }, working: true, keep_access: true, missing_inputs: false, turned_off: false,
  });
  assert.deepEqual(describeBuilding({ ...base, id: 13, type: 19, have_stats: 0, workers_have: 0, job_vacancies: 0, workers_needed: 0, working: 0, keep_access: 0 }), {
    id: 13, type: 19, name: "Granary", turned_off: false,
  });
});
