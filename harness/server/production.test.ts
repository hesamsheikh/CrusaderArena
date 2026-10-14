import test from "node:test";
import assert from "node:assert/strict";
import { PRODUCTION_WINDOW_TICKS, ProductionLedger } from "./production.js";
import { statusReport } from "./status.js";

const minute = 60 * 30;
const sample = (tick: number, goods: Record<string, number>, map = "Oasis") => ({ game_time: tick, map_name: map, resources_by_name: goods });

test("rises in stock are deliveries, credited to the building types that make each good, per game minute and per building", () => {
  const ledger = new ProductionLedger();
  ledger.sample(sample(1000, { wood_planks: 40, iron: 0, stone: 10 }));
  ledger.sample(sample(1000 + minute, { wood_planks: 52, iron: 2, stone: 10 }));
  // A fletcher taking wood is a fall, not production; the next deliveries count again.
  ledger.sample(sample(1000 + 2 * minute, { wood_planks: 50, iron: 2, stone: 10, bows: 1 }));
  ledger.sample(sample(1000 + 3 * minute, { wood_planks: 62, iron: 4, stone: 10, bows: 2 }));
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

test("only the last 3 game minutes count, and a shorter game so far says how long", () => {
  const ledger = new ProductionLedger();
  ledger.sample(sample(0, { wood_planks: 0 }));
  ledger.sample(sample(minute / 2, { wood_planks: 8 }));
  assert.equal(ledger.report({ Woodcutter: 1 })!.window, "the 30 s of game time so far");
  assert.equal(ledger.report({ Woodcutter: 1 })!.by_building.Woodcutter.per_minute, 16);
  // Four minutes later, with no more wood, the early delivery has left the window.
  ledger.sample(sample(minute / 2 + PRODUCTION_WINDOW_TICKS + 1, { wood_planks: 8 }));
  assert.deepEqual(ledger.report({ Woodcutter: 1 })!.by_building.Woodcutter.delivered, { wood_planks: 0 });
});

test("a held good's rises are not deliveries: a purchase or a demolition's refund", () => {
  const ledger = new ProductionLedger();
  ledger.sample(sample(0, { wood_planks: 10, stone: 5 }));
  const release = ledger.hold(["wood_planks"]);
  ledger.sample(sample(100, { wood_planks: 110, stone: 9 }));
  release();
  release();
  ledger.sample(sample(200, { wood_planks: 114, stone: 9 }));
  const report = ledger.report({ Woodcutter: 1, Quarry: 1 })!;
  assert.deepEqual(report.by_building.Woodcutter.delivered, { wood_planks: 4 }, "the 100 bought left out, the 4 after counted");
  assert.deepEqual(report.by_building.Quarry.delivered, { stone: 4 }, "other goods still count meanwhile");
});

test("a good that rises with none of its producers standing is an other rise, and another game starts over", () => {
  const ledger = new ProductionLedger();
  ledger.sample(sample(0, { stone: 0, wood_planks: 0 }, "Desert"));
  ledger.sample(sample(300, { stone: 50, wood_planks: 0 }, "Desert"));
  assert.deepEqual(ledger.report({ Woodcutter: 1 })!.other_rises, { stone: 50 });
  // A load of another map (or the clock going back) forgets the old game.
  ledger.sample(sample(100, { stone: 0, wood_planks: 5 }, "Oasis"));
  ledger.sample(sample(200, { stone: 0, wood_planks: 9 }, "Oasis"));
  const report = ledger.report({ Woodcutter: 1 })!;
  assert.deepEqual(report.by_building.Woodcutter.delivered, { wood_planks: 4 });
  assert.ok(!("other_rises" in report));
  assert.equal(new ProductionLedger().report({ Woodcutter: 1 }), null, "nothing before the first sample");
});

test("status reports production beside the building counts when it is given the run's ledger", () => {
  const ledger = new ProductionLedger();
  ledger.sample(sample(0, { wood_planks: 10 }));
  ledger.sample(sample(minute, { wood_planks: 14 }));
  const stats = {
    status: "ok",
    observation: { gold: 100, buildings: { "3": 2 }, resources_by_name: { wood_planks: 14 }, visible_messages: [] },
  } as never;
  const report = statusReport(stats, { production: ledger }) as Record<string, any>;
  assert.deepEqual(report.buildings, { Woodcutter: 2 });
  assert.deepEqual(report.production.by_building.Woodcutter, { standing: 2, delivered: { wood_planks: 4 }, per_minute: 4, per_building_per_minute: 2 });
  assert.ok(!("production" in (statusReport(stats) as object)), "none without a ledger");
});
