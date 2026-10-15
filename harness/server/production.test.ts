import test from "node:test";
import assert from "node:assert/strict";
import { PRODUCTION_WINDOW_TICKS, ProductionLedger } from "./production.js";
import { observationStats, statusReport } from "./status.js";

const minute = 60 * 30;
// The reader's building counts by engine type: 1 Hovel, 3 Woodcutter, 5 Iron Mine, 12 Fletchers'
// Workshop, 17 Bakery, 20 Quarry, 32 Apple Orchard.
const sample = (tick: number, goods: Record<string, number>, buildings?: Record<string, number>, map = "Oasis") =>
  ({ game_time: tick, map_name: map, resources_by_name: goods, ...(buildings ? { buildings } : {}) });

test("rises in stock are deliveries, credited to the building types that make each good, per game minute and per building", () => {
  const ledger = new ProductionLedger();
  const standing = { "1": 5, "3": 3, "5": 2, "12": 1, "20": 1 };
  ledger.sample(sample(1000, { wood_planks: 40, iron: 0, stone: 10 }, standing));
  ledger.sample(sample(1000 + minute, { wood_planks: 52, iron: 2, stone: 10 }, standing));
  // A fletcher taking wood is a fall, not production; the next deliveries count again.
  ledger.sample(sample(1000 + 2 * minute, { wood_planks: 50, iron: 2, stone: 10, bows: 1 }, standing));
  ledger.sample(sample(1000 + 3 * minute, { wood_planks: 62, iron: 4, stone: 10, bows: 2 }, standing));
  const report = ledger.report({ Woodcutter: 3, "Iron Mine": 2, Quarry: 1, "Fletchers' Workshop": 1, Hovel: 5 })!;
  assert.equal(report.window, "the last 3 game minutes");
  assert.deepEqual(report.by_building.Woodcutter, { standing: 3, delivered: { wood_planks: 24 }, per_minute: 8, per_building_per_minute: 2.7 });
  assert.deepEqual(report.by_building["Iron Mine"], { standing: 2, delivered: { iron: 4 }, per_minute: 1.3, per_building_per_minute: 0.7 });
  // A quarry that delivered nothing shows as such: the hint to look at it.
  assert.deepEqual(report.by_building.Quarry, { standing: 1, delivered: { stone: 0 }, per_minute: 0, per_building_per_minute: 0 });
  assert.deepEqual(report.by_building["Fletchers' Workshop"].delivered, { bows: 2, crossbows: 0 });
  assert.ok(!("Hovel" in report.by_building), "only producing types");
  assert.ok(!("other_rises" in report));
});

test("per building counts the time each stood in the window, and says how many were built in it", () => {
  // Three orchards built beside an old one divided its apples by four, and GPT-6 Luna took the
  // orchards for poor ones (2026-10-14).
  const ledger = new ProductionLedger();
  ledger.sample(sample(0, { apples: 0 }, { "32": 1 }));
  ledger.sample(sample(minute, { apples: 3 }, { "32": 1 }));
  ledger.sample(sample(2 * minute, { apples: 6 }, { "32": 1 }));
  ledger.sample(sample(3 * minute - 20 * 30, { apples: 6 }, { "32": 4 }));
  ledger.sample(sample(3 * minute, { apples: 9 }, { "32": 4 }));
  // 9 apples over 2 min 40 s of one orchard and 20 s of four: 4 orchard-minutes.
  assert.deepEqual(ledger.report({ "Apple Orchard": 4 })!.by_building["Apple Orchard"],
    { standing: 4, built_in_window: 3, delivered: { apples: 9 }, per_minute: 3, per_building_per_minute: 2.3 });
  // Three minutes on, all four stood through the window.
  ledger.sample(sample(6 * minute, { apples: 45 }, { "32": 4 }));
  assert.deepEqual(ledger.report({ "Apple Orchard": 4 })!.by_building["Apple Orchard"],
    { standing: 4, delivered: { apples: 36 }, per_minute: 12, per_building_per_minute: 3 });
});

test("only the last 3 game minutes count, and a shorter game so far says how long", () => {
  const ledger = new ProductionLedger();
  ledger.sample(sample(0, { wood_planks: 0 }, { "3": 1 }));
  ledger.sample(sample(minute / 2, { wood_planks: 8 }, { "3": 1 }));
  assert.equal(ledger.report({ Woodcutter: 1 })!.window, "the 30 s of game time so far");
  assert.equal(ledger.report({ Woodcutter: 1 })!.by_building.Woodcutter.per_minute, 16);
  assert.equal(ledger.report({ Woodcutter: 1 })!.by_building.Woodcutter.per_building_per_minute, 16);
  // Four minutes later, with no more wood, the early delivery has left the window.
  ledger.sample(sample(minute / 2 + PRODUCTION_WINDOW_TICKS + 1, { wood_planks: 8 }, { "3": 1 }));
  assert.deepEqual(ledger.report({ Woodcutter: 1 })!.by_building.Woodcutter.delivered, { wood_planks: 0 });
});

test("a held good's rises are not deliveries: a purchase or a demolition's refund", () => {
  const ledger = new ProductionLedger();
  const standing = { "3": 1, "20": 1 };
  ledger.sample(sample(0, { wood_planks: 10, stone: 5 }, standing));
  const release = ledger.hold(["wood_planks"]);
  ledger.sample(sample(100, { wood_planks: 110, stone: 9 }, standing));
  release();
  release();
  ledger.sample(sample(200, { wood_planks: 114, stone: 9 }, standing));
  const report = ledger.report({ Woodcutter: 1, Quarry: 1 })!;
  assert.deepEqual(report.by_building.Woodcutter.delivered, { wood_planks: 4 }, "the 100 bought left out, the 4 after counted");
  assert.deepEqual(report.by_building.Quarry.delivered, { stone: 4 }, "other goods still count meanwhile");
});

test("a rise while none of its good's makers stood is an other rise, even once one stands", () => {
  const ledger = new ProductionLedger();
  // The starting bread arrives before the first bakery; the bakery's own bread counts for it.
  ledger.sample(sample(0, { bread: 0 }, { "3": 1 }));
  ledger.sample(sample(300, { bread: 29 }, { "3": 1 }));
  ledger.sample(sample(600, { bread: 29 }, { "3": 1, "17": 1 }));
  ledger.sample(sample(900, { bread: 33 }, { "3": 1, "17": 1 }));
  const report = ledger.report({ Woodcutter: 1, Bakery: 1 })!;
  assert.deepEqual(report.other_rises, { bread: 29 });
  assert.deepEqual(report.by_building.Bakery, { standing: 1, built_in_window: 1, delivered: { bread: 4 }, per_minute: 8, per_building_per_minute: 24 });
  // A sample without building counts keeps the last ones.
  ledger.sample(sample(1200, { bread: 37 }));
  assert.deepEqual(ledger.report({ Woodcutter: 1, Bakery: 1 })!.by_building.Bakery.delivered, { bread: 8 });
});

test("the starting goods still to come are other rises, though one of their makers stands", () => {
  // On Large Barren Desert's start the 15 iron arrived while GPT-6 Luna's first iron mine stood, and
  // the readout gave the mine 5.9 a minute (2026-10-15). The list leaves a good once it has come in.
  const ledger = new ProductionLedger();
  const desert = (tick: number, iron: number, toCome: Record<string, number>) =>
    ({ ...sample(tick, { iron, stone: 0 }, { "5": 1 }, "Desert"), starting_goods_to_come: toCome });
  ledger.sample(desert(0, 0, { iron: 15, stone: 50 }));
  ledger.sample(desert(300, 15, { stone: 50 }));
  ledger.sample(desert(600, 16, { stone: 50 }));
  let report = ledger.report({ "Iron Mine": 1 })!;
  assert.deepEqual(report.by_building["Iron Mine"].delivered, { iron: 1 }, "only the mine's own iron");
  assert.deepEqual(report.other_rises, { iron: 15 });
  // A rise past what the list showed is the makers' again; another game forgets the list.
  const again = new ProductionLedger();
  again.sample(desert(0, 0, { iron: 15 }));
  again.sample(desert(300, 20, {}));
  report = again.report({ "Iron Mine": 1 })!;
  assert.deepEqual(report.by_building["Iron Mine"].delivered, { iron: 5 });
  assert.deepEqual(report.other_rises, { iron: 15 });
  again.sample({ ...sample(100, { iron: 0 }, { "5": 1 }, "Oasis"), starting_goods_to_come: null });
  again.sample({ ...sample(400, { iron: 4 }, { "5": 1 }, "Oasis"), starting_goods_to_come: null });
  assert.deepEqual(again.report({ "Iron Mine": 1 })!.by_building["Iron Mine"].delivered, { iron: 4 });
});

test("another game starts over, and there is nothing to report before the first sample", () => {
  const ledger = new ProductionLedger();
  ledger.sample(sample(0, { stone: 0, wood_planks: 0 }, { "3": 1 }, "Desert"));
  ledger.sample(sample(300, { stone: 50, wood_planks: 0 }, { "3": 1 }, "Desert"));
  assert.deepEqual(ledger.report({ Woodcutter: 1 })!.other_rises, { stone: 50 });
  // A load of another map (or the clock going back) forgets the old game.
  ledger.sample(sample(100, { stone: 0, wood_planks: 5 }, { "3": 1 }, "Oasis"));
  ledger.sample(sample(200, { stone: 0, wood_planks: 9 }, { "3": 1 }, "Oasis"));
  const report = ledger.report({ Woodcutter: 1 })!;
  assert.deepEqual(report.by_building.Woodcutter.delivered, { wood_planks: 4 });
  assert.ok(!("other_rises" in report));
  assert.equal(new ProductionLedger().report({ Woodcutter: 1 }), null, "nothing before the first sample");
});

test("every observation's stats and status report production beside the building counts, given the run's ledger", () => {
  const ledger = new ProductionLedger();
  ledger.sample(sample(0, { wood_planks: 10 }, { "3": 2 }));
  ledger.sample(sample(minute, { wood_planks: 14 }, { "3": 2 }));
  const stats = {
    status: "ok",
    observation: { gold: 100, buildings: { "3": 2 }, resources_by_name: { wood_planks: 14 }, visible_messages: [] },
  } as never;
  const woodcutters = { standing: 2, delivered: { wood_planks: 4 }, per_minute: 4, per_building_per_minute: 2 };
  const report = statusReport(stats, { production: ledger }) as Record<string, any>;
  assert.deepEqual(report.buildings, { Woodcutter: 2 });
  assert.deepEqual(report.production.by_building.Woodcutter, woodcutters);
  assert.deepEqual((observationStats(stats, { production: ledger }) as Record<string, any>).production.by_building.Woodcutter, woodcutters);
  assert.ok(!("production" in (statusReport(stats) as object)), "none without a ledger");
  assert.ok(!("production" in (observationStats(stats) as object)), "none without a ledger");
  // Nothing to say while no producing building stands and nothing rose.
  const hovels = new ProductionLedger();
  hovels.sample(sample(0, { wood_planks: 10 }, { "1": 2 }));
  hovels.sample(sample(minute, { wood_planks: 10 }, { "1": 2 }));
  const quiet = { status: "ok", observation: { gold: 100, buildings: { "1": 2 }, resources_by_name: { wood_planks: 10 }, visible_messages: [] } } as never;
  assert.ok(!("production" in (observationStats(quiet, { production: hovels }) as object)));
  assert.ok(!("production" in (statusReport(quiet, { production: hovels }) as object)));
});
