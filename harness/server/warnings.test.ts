import test from "node:test";
import assert from "node:assert/strict";
import type { Stats } from "../shared/protocol.js";
import { FOOD_PER_PERSON_MONTH, Warnings } from "./warnings.js";

type Observation = NonNullable<Stats["observation"]>;
const RATIONS = { none: 0, half: 1, full: 2, extra: 3, double: 4 };

/** A reader sample with only what the warnings read; full rations, plenty of food and gold. */
function reading(values: { popularity?: number; gold?: number; population?: number; food?: number; rations?: keyof typeof RATIONS } = {}) {
  return {
    popularity: values.popularity ?? 60,
    gold: values.gold ?? 2000,
    population: values.population ?? 100,
    settlement: { total_food: values.food ?? 200, rationing: RATIONS[values.rations ?? "full"] },
  } as unknown as Observation;
}

test("popularity warns 10 points below the last observation, and again 10 below the next", () => {
  const w = new Warnings();
  assert.deepEqual(w.observe(reading({ popularity: 52 })), []);
  assert.equal(w.check(reading({ popularity: 43 })), false);
  assert.equal(w.check(reading({ popularity: 42 })), true);
  // Reported in the values of the observation that carries it (the game plays on while a fast wait
  // slows down: live, a warning that came up at 81 went out beside stats showing 68), then that
  // observation is the new start.
  assert.deepEqual(w.observe(reading({ popularity: 39 })), ["Popularity fell from 52 to 39 since your last observation."]);
  assert.equal(w.check(reading({ popularity: 30 })), false);
  assert.equal(w.check(reading({ popularity: 29 })), true);
  // Recovered by the time of the observation: reported as it came up.
  assert.deepEqual(w.observe(reading({ popularity: 33 })), ["Popularity fell from 39 to 29 since your last observation."]);
});

test("food warns below two game months of what the people eat at their rations", () => {
  // Opus 5.5 on Large Barren Desert (2026-10-14): 95 people on half rations ate about 8 food a month.
  const halfLimit = 95 * FOOD_PER_PERSON_MONTH[RATIONS.half] * 2;
  assert.ok(halfLimit > 16 && halfLimit < 17);
  const w = new Warnings();
  w.observe(reading({ population: 95, rations: "half", food: 54 }));
  assert.equal(w.check(reading({ population: 95, rations: "half", food: 17 })), false);
  assert.equal(w.check(reading({ population: 95, rations: "half", food: 16 })), true);
  assert.deepEqual(w.observe(reading({ population: 95, rations: "half", food: 16 })),
    ["Food is low: 16 in the granaries for 95 people on half rations."]);
  // The same food lasts 100 people on full rations under two months; nobody eats on none.
  const full = new Warnings();
  full.observe(reading({ food: 60 }));
  assert.equal(full.check(reading({ food: 35 })), false);
  assert.equal(full.check(reading({ food: 34 })), true);
  const none = new Warnings();
  none.observe(reading({ food: 60, rations: "none" }));
  assert.equal(none.check(reading({ food: 0, rations: "none" })), false);
});

test("food or gold the last observation already showed low brings no warning until one shows it recovered", () => {
  const w = new Warnings();
  w.observe(reading({ food: 20, gold: 400 }));
  assert.equal(w.check(reading({ food: 5, gold: 100 })), false);
  w.observe(reading({ food: 120, gold: 800 }));
  assert.equal(w.check(reading({ food: 120, gold: 499 })), true);
  assert.equal(w.check(reading({ food: 30, gold: 450 })), true);
  assert.deepEqual(w.observe(reading({ food: 30, gold: 450 })), [
    "Gold is low: 450 left, down from 800 at your last observation.",
    "Food is low: 30 in the granaries for 100 people on full rations.",
  ]);
  assert.deepEqual(w.observe(reading({ food: 20, gold: 300 })), [], "reported once");
  // Gold back above 500 by the observation: reported as it came up.
  w.observe(reading({ gold: 900 }));
  assert.equal(w.check(reading({ gold: 50 })), true);
  assert.deepEqual(w.observe(reading({ gold: 650 })), ["Gold is low: 50 left, down from 900 at your last observation."]);
});

test("nothing warns before the first observation, and one without game values counts what it reported as seen", () => {
  const w = new Warnings();
  assert.equal(w.check(reading({ popularity: 0, gold: 0, food: 0 })), false);
  w.observe(reading({ popularity: 60 }));
  assert.equal(w.check(reading({ popularity: 50, gold: 400 })), true);
  assert.deepEqual(w.observe(null), ["Popularity fell from 60 to 50 since your last observation.", "Gold is low: 400 left, down from 2000 at your last observation."]);
  // Not again for what was reported; popularity counts down from 50 now.
  assert.equal(w.check(reading({ popularity: 41, gold: 300 })), false);
  assert.equal(w.check(reading({ popularity: 40, gold: 300 })), true);
});
