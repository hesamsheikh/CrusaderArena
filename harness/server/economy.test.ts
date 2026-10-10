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
