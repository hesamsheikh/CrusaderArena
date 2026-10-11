import { test } from "node:test";
import assert from "node:assert/strict";
import type { AnchorContext } from "./anchors.js";
import { marketTrade, setRations, setTax, taxLevels } from "./economy.js";

/** The ration plates, none to double, as clicked on a 1920 × 1080 window. */
const plates = ["1235,1050", "1220,978", "1298,938", "1385,978", "1355,1050"];

/** A game with one granary: its hotkey opens the panel, a plate click sets the rations, a right-click closes it. */
function fakeGame(rationing: number, { granary = true } = {}) {
  const game = { rationing, panel: null as { id: number; type: number } | null };
  const clicks: string[] = [];
  const stats = () => ({
    status: "ok",
    captured_unix_ms: Date.now(),
    observation: {
      selected_building: game.panel,
      placement: { action: 0, sub_action: 0 },
      settlement: { rationing: game.rationing, popularity_factors: { rationing: (game.rationing - 2) * 100 } },
    },
  });
  const frame = { id: "f", width: 1920, height: 1080, receivedAt: Date.now() };
  const ctx = {
    device: { currentStats: stats },
    capture: async () => frame,
    frame: async () => frame,
    send: async (_frame: unknown, action: { x: number; y: number; button: number }) => {
      clicks.push(`${action.x},${action.y}`);
      if (action.button === 3) game.panel = null;
      else if (game.panel && plates.includes(`${action.x},${action.y}`)) game.rationing = plates.indexOf(`${action.x},${action.y}`);
      return { at: Date.now() };
    },
    hotkey: async (name: string) => {
      if (name === "Granary" && granary) game.panel = { id: 7, type: 19 };
      return { at: Date.now() };
    },
    pause: async () => {},
    state: {},
  } as unknown as AnchorContext;
  return { ctx, game, clicks };
}

test("set_rations clicks the plate for the rations asked, checks them in the reader and closes the panel", async () => {
  const { ctx, game, clicks } = fakeGame(2);
  assert.deepEqual(await setRations(ctx, "extra"), { status: "set", from: "full", rations: "extra", popularityFactor: 4 });
  assert.equal(game.rationing, 3);
  assert.equal(clicks[0], "1385,978");
  assert.equal(game.panel, null, "the panel is closed afterwards");
});

test("set_rations clicks no plate when the rations are already set", async () => {
  const { ctx, clicks } = fakeGame(0);
  assert.deepEqual(await setRations(ctx, "none"), { status: "set", from: "none", rations: "none", popularityFactor: -8 });
  assert.equal(clicks.filter((c) => plates.includes(c)).length, 0);
});

test("set_rations fails without a granary, and says to build one", async () => {
  const { ctx } = fakeGame(2, { granary: false });
  const result = await setRations(ctx, "half");
  assert.equal(result.status, "failed");
  assert.match((result as { remedy?: string }).remedy ?? "", /build_structure places one \(name Granary\)/);
});

test("market_trade without a marketplace says to build one with build_structure", async () => {
  // The fake game's market hotkey selects nothing: there is no marketplace.
  const { ctx } = fakeGame(2);
  const result = await marketTrade(ctx, "wood_planks", "buy", 10);
  assert.equal(result.status, "no_market");
  assert.match((result as { remedy?: string }).remedy ?? "", /build_structure \(name Marketplace\), then call market_trade again/);
});

/**
 * A game with a marketplace: its hotkey opens the panel, the category and good buttons choose a
 * good, and Buy and Sell trade the way the game was seen to on 2026-10-11: a purchase is 5 units, a
 * sale 20 while 100 or more are in stock, 10 from 50, else 5. `meanwhile` runs after each trade
 * click, before the reader is read: deliveries and tax payments landing at the same moment.
 */
function fakeMarket(goods: Record<string, number>, gold: number, meanwhile: (game: { goods: Record<string, number>; gold: number }, click: number) => void = () => {}) {
  const game = { goods: { ...goods }, gold, panel: null as { id: number; type: number } | null, good: null as string | null };
  const prices: Record<string, { buy: number; sell: number }> = { wood_planks: { buy: 4, sell: 1 }, apples: { buy: 8, sell: 4 } };
  const buttons: Record<string, string> = { "1040,970": "wood_planks", "1085,975": "apples" };
  let trades = 0;
  const stats = () => ({
    status: "ok",
    captured_unix_ms: Date.now(),
    observation: { selected_building: game.panel, placement: { action: 0, sub_action: 0 }, gold: game.gold, resources_by_name: { ...game.goods } },
  });
  const frame = { id: "f", width: 1920, height: 1080, receivedAt: Date.now() };
  const ctx = {
    device: { currentStats: stats },
    capture: async () => frame,
    frame: async () => frame,
    send: async (_frame: unknown, action: { x: number; y: number; button: number }) => {
      const at = `${action.x},${action.y}`;
      if (action.button === 3) game.panel = null;
      else if (game.panel && buttons[at]) game.good = buttons[at];
      else if (game.panel && game.good && (at === "1235,932" || at === "1235,998")) {
        const good = game.good, stock = game.goods[good] ?? 0;
        if (at === "1235,932") {
          game.goods[good] = stock + 5;
          game.gold -= 5 * prices[good].buy;
        } else {
          const units = Math.min(stock, stock >= 100 ? 20 : stock >= 50 ? 10 : 5);
          game.goods[good] = stock - units;
          game.gold += units * prices[good].sell;
        }
        meanwhile(game, ++trades);
      }
      return { at: Date.now() };
    },
    hotkey: async (name: string) => {
      if (name === "Market") game.panel = { id: 20, type: 26 };
      return { at: Date.now() };
    },
    pause: async () => {},
    state: {},
  } as unknown as AnchorContext;
  return { ctx, game };
}

test("market_trade sells in the game's steps and never more than asked", async () => {
  // GLM on 2026-10-11 asked to sell 20 lots of 225 wood and lost all 225: the game sells 20 a
  // click from 100 in stock. Now 20 lots sell exactly 100.
  const { ctx, game } = fakeMarket({ wood_planks: 225 }, 1000);
  const result = await marketTrade(ctx, "wood_planks", "sell", 20);
  assert.equal(result.status, "traded");
  assert.equal(game.goods.wood_planks, 125);
  assert.deepEqual({ units: (result as any).units, clicks: (result as any).clicks, lots: (result as any).lots, gold: (result as any).goldChange }, { units: -100, clicks: 5, lots: 20, gold: 100 });

  // 25 units from 120: one click sells 20, the next would sell 20 more than the 5 left, so it stops.
  const short = fakeMarket({ wood_planks: 120 }, 1000);
  const partial = await marketTrade(short.ctx, "wood_planks", "sell", 5) as any;
  assert.equal(partial.status, "partly_traded");
  assert.equal(short.game.goods.wood_planks, 100);
  assert.deepEqual([partial.units, partial.asked], [-20, 25]);
  assert.match(partial.note, /sells 20 a click with 100 in stock/);
  assert.match(partial.remedy, /steps of 4 \(20 units\)/);

  // Below 50 a click sells 5, down to the last units.
  const low = fakeMarket({ wood_planks: 12 }, 1000);
  const rest = await marketTrade(low.ctx, "wood_planks", "sell", 5) as any;
  assert.deepEqual([rest.status, rest.units, low.game.goods.wood_planks], ["partly_traded", -12, 0]);
  assert.match(rest.note, /no more of this good/);
});

test("market_trade counts a click only when the reader shows that trade", async () => {
  // A woodcutter's delivery and the month's taxes land with the clicks: neither hides a sale or
  // passes for one, and the count stays at what was sold.
  const { ctx, game } = fakeMarket({ wood_planks: 60 }, 500, (g, click) => {
    if (click === 1) g.goods.wood_planks += 1;
    if (click === 2) g.gold += 37;
    if (click === 3) { g.goods.wood_planks += 1; g.gold += 37; }
  });
  const result = await marketTrade(ctx, "wood_planks", "sell", 6) as any;
  assert.equal(result.status, "traded");
  // 10 at 60, 10 at 51 (with the delivery), then 5 and 5 below 50.
  assert.deepEqual([result.units, result.clicks], [-30, 4]);
  assert.equal(game.goods.wood_planks, 60 - 30 + 2);
  assert.equal(result.goldChange, 30 + 74, "taxes are in the gold change");

  // Food is bought 5 units a click too (not lots of 10).
  const food = fakeMarket({ apples: 40 }, 500);
  const bought = await marketTrade(food.ctx, "apples", "buy", 3) as any;
  assert.deepEqual([bought.status, bought.units, bought.clicks, food.game.goods.apples, food.game.gold], ["traded", 15, 3, 55, 500 - 15 * 8]);
});

const TAX_UP = "1517,985";
const TAX_DOWN = "1056,985";

/** A game with a keep: its hotkey opens the tax panel, the arrows step tax_index, a right-click closes it. */
function fakeKeep(taxIndex: number, { liveFactor = true } = {}) {
  const game = { tax: taxIndex, panel: null as { id: number; type: number } | null };
  const clicks: string[] = [];
  const stats = () => ({
    status: "ok",
    captured_unix_ms: Date.now(),
    observation: {
      selected_building: game.panel,
      placement: { action: 0, sub_action: 0 },
      tax_index: game.tax,
      settlement: {
        tax_amount: 100 + game.tax * 20,
        ...(liveFactor ? { popularity_factors: { tax: (game.tax - 3) * 25 } } : {}),
      },
    },
  });
  const ctx = {
    device: { currentStats: stats },
    capture: async () => ({ id: "f", width: 1920, height: 1080 }),
    frame: async () => ({ id: "f", width: 1920, height: 1080 }),
    send: async (_frame: unknown, action: { x: number; y: number; button: number }) => {
      clicks.push(`${action.x},${action.y}`);
      if (action.button === 3) game.panel = null;
      else if (game.panel && `${action.x},${action.y}` === TAX_UP) game.tax = Math.min(11, game.tax + 1);
      else if (game.panel && `${action.x},${action.y}` === TAX_DOWN) game.tax = Math.max(0, game.tax - 1);
      return { at: Date.now() };
    },
    hotkey: async (name: string) => {
      if (name === "HomeKeep") game.panel = { id: 3, type: 41 };
      return { at: Date.now() };
    },
    pause: async () => {},
    state: {},
  } as unknown as AnchorContext;
  return { ctx, game, clicks };
}

test("set_tax steps the arrows to the level asked and reports the live tax popularity factor", async () => {
  const { ctx, game, clicks } = fakeKeep(3);
  const result = await setTax(ctx, 5);
  assert.equal(game.tax, 5);
  assert.deepEqual(clicks.filter((c) => c === TAX_UP || c === TAX_DOWN), [TAX_UP, TAX_UP]);
  assert.equal(result.status, "set");
  assert.equal(result.from, 3);
  assert.equal(result.level, 5);
  // The reader's own factor ((5-3)*25 = 50 units = 2 points), not the static table's -4 for "Average taxes".
  assert.equal(result.popularityFactor, 2);
  assert.notEqual(result.popularityFactor, taxLevels[5].popularity);
  assert.equal(result.goldPerMonth, 200);
});

test("set_tax falls back to the static table when the reader has no live tax factor", async () => {
  const { ctx } = fakeKeep(3, { liveFactor: false });
  const result = await setTax(ctx, 5);
  assert.equal(result.status, "set");
  assert.equal(result.popularityFactor, taxLevels[5].popularity);
});

test("set_tax fails without a keep", async () => {
  const ctx = {
    device: { currentStats: () => ({ status: "unavailable", observation: null }) },
    capture: async () => ({ id: "f", width: 1920, height: 1080 }),
    frame: async () => ({ id: "f", width: 1920, height: 1080 }),
    send: async () => ({ at: Date.now() }),
    hotkey: async () => ({ at: Date.now() }),
    pause: async () => {},
    state: {},
  } as unknown as AnchorContext;
  assert.equal((await setTax(ctx, 5)).status, "failed");
});
