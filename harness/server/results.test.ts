import { test } from "node:test";
import assert from "node:assert/strict";
import type { Stats } from "../shared/protocol.js";
import { namedBuildings } from "./building-types.js";
import { resultsMarkdown, runResults, type ResultsContext } from "./results.js";

type Observation = NonNullable<Stats["observation"]>;

/** The reference game on Oasis by the Sea as the reader saw it at its end (live 2026-10-10), with its building counts. */
const oasis = (): Observation => ({
  map_name: "Oasis by the Sea",
  game_time: 60273,
  gold: 18304,
  population: 202,
  popularity: 100,
  tax_index: 3,
  wood_planks: 84,
  resources_by_name: { wood_planks: 84, stone: 12, iron: 3, wheat: 24, bread: 100, flour: 38, hops: 0, ale: 0 },
  own_troops: { total: 0 },
  structures: { count: 256, limit: 3999 },
  settlement: {
    month: 7, year: 1200, housing_cap: 202, peasants_available: 13, total_food: 100, months_of_food: 0,
    rationing: 2, food_types_eaten: 1, food_types_available: 1, efficiency: 140, upcoming_popularity: 0,
    church_bonus: 3, tax_amount: 0,
    popularity_factors: { food: 0, food_variety: 0, rationing: 0, tax: 25, fear_factor: -100, religion: 0, inn: 0 },
  },
  storage: {
    piles: [
      { tile: [1, 1], good: "wood_planks", amount: 84, capacity: 100 },
      { tile: [2, 1], good: null, amount: 0, capacity: 0 },
    ],
    granaries: [{ tile: [3, 3], amount: 100, capacity: 250 }],
    truncated: false,
  },
  buildings: { "1": 24, "10": 16, "17": 57, "21": 10, "34": 7, "37": 1, "38": 1, "41": 1, "52": 3, "55": 1, "62": 14, "71": 1, "93": 23 },
});
const context: ResultsContext = { kind: "human", player: "A person", save: "Oasis by the Sea benchmark start", source: "final", readAt: Date.UTC(2026, 9, 10, 13, 22), playedSeconds: 1998, budgetSeconds: 2000 };

test("the results record the whole state at the end: worth, goods, people, popularity, economy and buildings", () => {
  const r = runResults(oasis(), context);
  assert.equal(r.net_worth, 19513);
  assert.equal(r.goods_value, 1209);
  // Every good in store with its value, most valuable first; empty ones are left out.
  assert.deepEqual(Object.keys(r.goods), ["bread", "flour", "wheat", "stone", "wood_planks", "iron"]);
  assert.deepEqual(r.goods.flour, { units: 38, value: 380 });
  assert.deepEqual([r.population, r.housing, r.idle_peasants, r.popularity], [202, 202, 13, 100]);
  assert.deepEqual(r.popularity_factors, { tax: 1, fear_factor: -4, religion: 3 });
  assert.equal(r.popularity_change, 0);
  assert.deepEqual(r.taxes, { level: 3, name: "No taxes", gold_per_month: 0 });
  assert.deepEqual(r.food, { stored: 100, rations: "full", foods_eaten: 1, foods_available: 1, ration_points: 0, variety_points: 0 });
  assert.equal(r.worker_efficiency_percent, 140);
  assert.deepEqual(r.storage, { stockpile_piles: 2, empty_piles: 1, granaries: 1, granary_food: 100 });
  assert.deepEqual(r.game, { date: "August 1200", ticks: 60273, played_seconds: 1998, budget_seconds: 2000 });
  // Buildings by name; the reader's counts by type stay as read.
  assert.deepEqual(r.buildings, { Bakery: 57, Hovel: 24, Gibbet: 23, Gallows: 14, Mill: 7, Stockpile: 4, Cathedral: 1, Church: 1, Keep: 1 });
  assert.equal(r.buildings_by_type?.["21"], 10);
  assert.equal(r.read_at, "2026-10-10T13:22:00.000Z");
  assert.equal(r.reading.map_name, "Oasis by the Sea");
});

test("what the reader did not give stays null, never zero", () => {
  const bare = { ...oasis(), settlement: null, storage: null, buildings: undefined, tax_index: undefined };
  const r = runResults(bare, { ...context, playedSeconds: undefined });
  assert.equal(r.housing, null);
  assert.equal(r.popularity_factors, null);
  assert.equal(r.taxes, null);
  assert.equal(r.food, null);
  assert.equal(r.storage, null);
  assert.equal(r.buildings, null);
  assert.equal(r.game.played_seconds, null);
  // No efficiency before the game's first reckoning.
  const early = oasis();
  early.settlement!.efficiency = 0;
  assert.equal(runResults(early, context).worker_efficiency_percent, null);
});

test("building counts by type are named: piles make stockpiles, parts and the map's own are left out", () => {
  assert.deepEqual(namedBuildings({ "10": 8, "21": 3, "3": 2, "20": 3, "71": 1, "52": 3, "55": 1, "200": 2, "45": 1, "47": 1 }),
    { Quarry: 3, Gate: 2, Stockpile: 2, "type 200": 2, Woodcutter: 2 });
  // A pile count that is not whole stockpiles is kept as piles.
  assert.deepEqual(namedBuildings({ "10": 6 }), { "Stockpile pile": 6 });
});

test("results.md puts the state in tables", () => {
  const markdown = resultsMarkdown(runResults(oasis(), context));
  assert.match(markdown, /^# Results: A person on Oasis by the Sea\n/);
  assert.match(markdown, /A reference game played by a person, from the save "Oasis by the Sea benchmark start"\. Read from the paused game at the end, 2026-10-10 13:22 UTC\./);
  assert.match(markdown, /\| Game time played \| 33 min 18 s of 33 min 20 s \|/);
  assert.match(markdown, /\| Net worth \| 19,513 \|/);
  assert.match(markdown, /\| Popularity \| 100 \(no change next month\) \|/);
  assert.match(markdown, /\| Taxes \| No taxes, 0 gold a month \|/);
  assert.match(markdown, /\| Worker efficiency \| 140% \|/);
  assert.match(markdown, /\| fear factor \| −4 \|\n\| religion \| \+3 \|/);
  assert.match(markdown, /\| flour \| 38 \| 380 \|[\s\S]*\| wood \| 84 \| 84 \|[\s\S]*\| \*\*Total\*\* \| \| \*\*1,209\*\* \|/);
  assert.match(markdown, /\| Bakery \| 57 \|/);
  const unread = resultsMarkdown(runResults({ ...oasis(), buildings: null }, { ...context, kind: "idle", player: "Nobody", source: "last_observed" }));
  assert.match(unread, /The do-nothing baseline: the game left alone/);
  assert.match(unread, /The game was lost before the end; these are the last readings seen/);
  assert.match(unread, /## Buildings\n\nNot read: the game reader had no building counts\./);
});
