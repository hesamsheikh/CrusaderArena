import { test } from "node:test";
import assert from "node:assert/strict";
import type { AnchorContext } from "./anchors.js";
import { setRations } from "./economy.js";

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
  const ctx = {
    device: { currentStats: stats },
    capture: async () => ({ id: "f", width: 1920, height: 1080 }),
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

test("set_rations fails without a granary", async () => {
  const { ctx } = fakeGame(2, { granary: false });
  assert.equal((await setRations(ctx, "half")).status, "failed");
});
