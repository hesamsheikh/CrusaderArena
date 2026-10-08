import { test } from "node:test";
import assert from "node:assert/strict";
import { InventoryTracker, inventoryGroups } from "./inventory.js";
import { GameEvents } from "./game-events.js";
import { makeAgent } from "./model.js";
import type { GameDevice } from "./device.js";
import type { Stats } from "../shared/protocol.js";

const names = Object.values(inventoryGroups).flat();
const now = Date.now();
function sample(overrides: Partial<Stats> = {}, amounts: Record<string, number> = {}): Stats {
  return {
    status: "ok",
    session: "reader-a",
    generation: 1,
    captured_unix_ms: now - 200,
    valid_until_unix_ms: now + 1300,
    observation: {
      map_name: "Cactus Valley",
      local_player_id: 1,
      game_time: 100,
      paused: true,
      gold: 350,
      population: 5,
      popularity: 96,
      wood_planks: 12,
      resources_by_name: Object.fromEntries(names.map((name) => [name, amounts[name] ?? 0])),
    },
    ...overrides,
  };
}

test("inventory groups separate stockpile, granary and armory without losing zeroes", () => {
  const tracker = new InventoryTracker();
  const stats = sample({}, { wood_planks: 12, wheat: 3, bread: 5, apples: 2, bows: 4 });
  const stockpile = tracker.read(stats, "stockpile", now);
  assert.equal(stockpile.status, "ok");
  if (stockpile.status !== "ok") return;
  assert.deepEqual(Object.keys(stockpile.amounts), [...inventoryGroups.stockpile]);
  assert.equal(stockpile.amounts.wheat, 3);
  assert.equal(stockpile.amounts.flour, 0);
  assert.equal(stockpile.amounts.bread, undefined);
  const granary = tracker.read(stats, "granary", now);
  assert.equal(granary.status, "ok");
  if (granary.status !== "ok") return;
  assert.deepEqual(granary.amounts, { bread: 5, cheese: 0, meat: 0, apples: 2 });
  const armory = tracker.read(stats, "armory", now);
  assert.equal(armory.status, "ok");
  if (armory.status === "ok") assert.equal(armory.amounts.bows, 4);
});

test("inventory compares only fresh samples from the same reader generation and map", () => {
  const tracker = new InventoryTracker();
  tracker.read(sample({}, { wheat: 0 }), "stockpile", now);
  const later = sample({
    captured_unix_ms: now + 800,
    valid_until_unix_ms: now + 2300,
    observation: { ...sample().observation!, game_time: 120,
      resources_by_name: sample({}, { wheat: 6 }).observation!.resources_by_name },
  });
  const changed = tracker.read(later, "stockpile", now + 900);
  assert.equal(changed.status, "ok");
  if (changed.status !== "ok") return;
  assert.equal(changed.changeSincePrevious?.amounts.wheat, 6);
  assert.equal(changed.changeSincePrevious?.elapsedGameTime, 20);
  const newMap = tracker.read({ ...later, generation: 2,
    captured_unix_ms: now + 1200, valid_until_unix_ms: now + 2700 },
  "stockpile", now + 1300);
  assert.equal(newMap.status, "ok");
  if (newMap.status === "ok") assert.equal("changeSincePrevious" in newMap, false);
});

test("stale and incomplete inventory never become zero or reuse a prior baseline", () => {
  const tracker = new InventoryTracker();
  tracker.read(sample({}, { apples: 7 }), "granary", now);
  const stale = tracker.read(sample({ valid_until_unix_ms: now - 1 }), "granary", now);
  assert.equal(stale.status, "unavailable");
  assert.equal("amounts" in stale, false);
  const missing = tracker.read(sample({ observation: {
    ...sample().observation!, resources_by_name: { apples: 7 },
  } }), "granary", now);
  assert.equal(missing.status, "unavailable");
  const recovered = tracker.read(sample({
    captured_unix_ms: now + 500, valid_until_unix_ms: now + 2000,
  }, { apples: 10 }), "granary", now + 600);
  assert.equal(recovered.status, "ok");
  if (recovered.status === "ok") assert.equal("changeSincePrevious" in recovered, false);
});

test("get_inventory is read-only and returns a live timed snapshot", async () => {
  const capturedAt = Date.now() - 200;
  const stats = sample({
    captured_unix_ms: capturedAt,
    valid_until_unix_ms: capturedAt + 1500,
  }, { wood_planks: 12, wheat: 3 });
  const device = {
    events: new GameEvents(),
    currentStats: () => stats,
    capture: async () => { throw new Error("Inventory must not capture a screenshot"); },
    action: async () => { throw new Error("Inventory must not control the game"); },
  } as unknown as GameDevice;
  const agent = makeAgent(device, () => {}, () => {}, 1, {
    id: "test", name: "test", modelId: "test",
    baseUrl: "https://example.invalid", keyConfigured: false,
  }, "");
  const tool = agent.state.tools.find((entry) => entry.name === "get_inventory")!;
  const result = await tool.execute("inventory", { section: "stockpile" });
  const body = JSON.parse(result.content[0].type === "text" ? result.content[0].text : "{}");
  assert.equal(body.status, "ok");
  assert.equal(body.amounts.wheat, 3);
  assert.equal(body.capturedAtUnixMs, capturedAt);
  assert.equal(body.map, "Cactus Valley");
});
