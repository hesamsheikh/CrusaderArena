import type { Frame } from "../shared/protocol.js";
import type { GameHotkey } from "./device.js";
import { ackTime, dismiss, sampleAfter, type AnchorContext } from "./anchors.js";
import type { Observation } from "./placement.js";
import { buyPrice, sellPrice } from "./market-prices.js";
import { inventoryGroups } from "./inventory.js";
import { points } from "../shared/popularity.js";

/**
 * Tax and marketplace panels, driven by clicks at positions measured on the 1920×1080
 * game window (Oasis by the Sea-1, 2026-09-30) and confirmed through the reader: the keep
 * panel's tax arrows step tax_index by one; the marketplace opens on its category page
 * when selected, and each Buy/Sell click trades one lot (5 units; food sells 10).
 */
export const taxLevels = [
  { label: "Generous bribe", popularity: 7 },
  { label: "Large bribe", popularity: 5 },
  { label: "Small bribe", popularity: 3 },
  { label: "No taxes", popularity: 1 },
  { label: "Low taxes", popularity: -2 },
  { label: "Average taxes", popularity: -4 },
  { label: "High taxes", popularity: -6 },
  { label: "Mean taxes", popularity: -8 },
  { label: "Extortionate taxes", popularity: -12 },
  { label: "Downright cruel taxes", popularity: -16 },
  { label: "Even crueler taxes", popularity: -20 },
  { label: "Crueler than cruel taxes", popularity: -24 },
];

const TAX_DOWN = { x: 1056, y: 985 };
const TAX_UP = { x: 1517, y: 985 };
const categoryButtons = { food: { x: 980, y: 980 }, raw: { x: 1095, y: 980 }, weapons: { x: 1215, y: 980 } };
const BUY = { x: 1235, y: 932 };
const SELL = { x: 1235, y: 998 };
const row = (y: number, names: string[], xs: number[]) => Object.fromEntries(names.map((n, i) => [n, { x: xs[i], y }]));
const goodsButtons: Record<string, { category: keyof typeof categoryButtons; at: { x: number; y: number } }> = Object.fromEntries([
  ...Object.entries(row(975, ["meat", "cheese", "apples", "hops", "ale", "wheat", "flour", "bread"], [940, 1012, 1085, 1155, 1230, 1300, 1372, 1445])).map(([n, at]) => [n, { category: "food" as const, at }]),
  ...Object.entries(row(970, ["wood_planks", "stone", "iron", "pitch"], [1040, 1135, 1225, 1322])).map(([n, at]) => [n, { category: "raw" as const, at }]),
  ...Object.entries(row(975, ["bows", "spears", "maces", "crossbows", "pikes", "swords", "leather_armour", "metal_armour"], [940, 1012, 1085, 1155, 1230, 1300, 1372, 1445])).map(([n, at]) => [n, { category: "weapons" as const, at }]),
]);
export const tradeGoods = Object.keys(goodsButtons);

const scaled = (frame: Frame, p: { x: number; y: number }) => {
  if (Math.abs(frame.width / frame.height - 16 / 9) > 0.02) throw new Error("Panel positions are calibrated only for a 16:9 game window. Use game_action on this layout.");
  return { type: "click" as const, x: Math.round((p.x * frame.width) / 1920), y: Math.round((p.y * frame.height) / 1080), button: 1 as const };
};
const selected = (o: Observation | null) => (o?.selected_building as { type?: number } | null | undefined)?.type ?? null;

/** Select a building with its hotkey (a second press if the first only centres). */
async function select(ctx: AnchorContext, hotkey: GameHotkey) {
  for (let press = 0; press < 2; press++) {
    const ack = await ctx.hotkey(hotkey);
    const seen = await sampleAfter(ctx, ackTime(ack), (o) => selected(o) !== null, 1);
    if (seen) return seen;
  }
  return null;
}

async function click(ctx: AnchorContext, p: { x: number; y: number }) {
  const frame = await ctx.frame();
  return ctx.send(frame, scaled(frame, p));
}

/** Set the keep's tax level (0-11) with its panel arrows, checking each step in the reader. */
export async function setTax(ctx: AnchorContext, level: number) {
  const tax = (o: Observation | null) => (typeof o?.tax_index === "number" ? o.tax_index : null);
  const opened = await select(ctx, "HomeKeep");
  if (!opened)
    return {
      status: "failed" as const,
      note: "The keep hotkey selected nothing.",
      remedy: "If the game still asks you to site your granary, place it first with build_structure (name Granary); otherwise observe and call set_tax again.",
    };
  const from = tax(opened);
  let current = from;
  let last: Observation = opened;
  for (let step = 0; step < 12 && current !== null && current !== level; step++) {
    const ack = await click(ctx, current < level ? TAX_UP : TAX_DOWN);
    const seen = await sampleAfter(ctx, ackTime(ack), (o) => tax(o) !== current, 1);
    if (!seen) break;
    current = tax(seen);
    last = seen;
  }
  await dismiss(ctx, await ctx.frame());
  const info = current !== null ? taxLevels[current] : undefined;
  // The keep panel's own tax figure, which updates with each step (live 2026-10-10).
  const settlement = last.settlement as { tax_amount?: unknown; popularity_factors?: Record<string, number> } | null | undefined;
  const gold = settlement?.tax_amount;
  // The reader's own tax factor from the sample taken after the last step, in points; the static
  // table (built from one observed level each) is used only when the reader has no value.
  const liveFactor = settlement?.popularity_factors?.tax;
  return {
    status: current === level ? "set" as const : "not_set" as const,
    from, level: current, label: info?.label,
    popularityFactor: typeof liveFactor === "number" ? points(liveFactor) : info?.popularity,
    ...(typeof gold === "number" ? { goldPerMonth: gold } : {}),
    ...(current === level ? {} : { remedy: "The panel did not reach that level: observe, then call set_tax again." }),
  };
}

/** Granary rations in the game's order (the reader's `rationing` index). */
export const rationLevels = ["none", "half", "full", "extra", "double"] as const;
export type RationLevel = (typeof rationLevels)[number];
/** The granary panel's ration plates, none to double, measured and checked through the reader (live 2026-10-10). */
const RATION_PLATES = [{ x: 1235, y: 1050 }, { x: 1220, y: 978 }, { x: 1298, y: 938 }, { x: 1385, y: 978 }, { x: 1355, y: 1050 }];
const GRANARY_TYPE = 19;

/** Set the rations on the granary panel (any granary: rations apply to all), checked in the reader. */
export async function setRations(ctx: AnchorContext, level: RationLevel) {
  const settlement = (o: Observation | null) =>
    o?.settlement as { rationing?: number; popularity_factors?: Record<string, number> } | null | undefined;
  const ration = (o: Observation | null) => settlement(o)?.rationing ?? null;
  const opened = await select(ctx, "Granary");
  if (!opened || selected(opened) !== GRANARY_TYPE) {
    if (opened) await dismiss(ctx, await ctx.frame());
    return {
      status: "failed" as const,
      note: "The granary hotkey selected no granary.",
      remedy: "There is no granary: build_structure places one (name Granary); then call set_rations again.",
    };
  }
  const target = rationLevels.indexOf(level);
  const from = ration(opened);
  let last: Observation = opened;
  if (from !== target) {
    const ack = await click(ctx, RATION_PLATES[target]);
    last = (await sampleAfter(ctx, ackTime(ack), (o) => ration(o) === target, 1)) ?? last;
  }
  await dismiss(ctx, await ctx.frame());
  const reached = ration(last);
  // The ration factor the panel shows beside the plates, in reader units.
  const factor = settlement(last)?.popularity_factors?.rationing;
  return {
    status: reached === target ? "set" as const : "not_set" as const,
    from: from === null ? null : rationLevels[from] ?? from,
    rations: reached === null ? null : rationLevels[reached] ?? reached,
    ...(typeof factor === "number" ? { popularityFactor: points(factor) } : {}),
    ...(reached === target ? {} : { remedy: "The panel did not reach those rations: observe, then call set_rations again." }),
  };
}

/** Buy or sell `lots` lots of one good at the marketplace, counting what the reader shows changed. */
export async function marketTrade(ctx: AnchorContext, good: string, action: "buy" | "sell", lots: number) {
  const button = goodsButtons[good];
  if (!button) return { status: "failed" as const, note: `Unknown good ${good}.`, remedy: `Use one of: ${tradeGoods.join(", ")}.` };
  const stock = (o: Observation | null) => ((o?.resources_by_name as Record<string, number> | undefined)?.[good] ?? null);
  const gold = (o: Observation | null) => (typeof o?.gold === "number" ? o.gold : null);
  const opened = await select(ctx, "Market");
  if (!opened || selected(opened) !== 26) {
    if (opened) await dismiss(ctx, await ctx.frame());
    return {
      status: "no_market" as const,
      note: "There is no marketplace: the market hotkey selected none.",
      remedy: "Build one with build_structure (name Marketplace), then call market_trade again.",
    };
  }
  const before = { stock: stock(opened), gold: gold(opened) };
  await click(ctx, categoryButtons[button.category]);
  await ctx.pause(0.3);
  await click(ctx, button.at);
  await ctx.pause(0.3);
  let done = 0, last = before;
  for (; done < lots; done++) {
    const ack = await click(ctx, action === "buy" ? BUY : SELL);
    const seen = await sampleAfter(ctx, ackTime(ack), (o) => stock(o) !== last.stock, 1);
    if (!seen) break;
    last = { stock: stock(seen), gold: gold(seen) };
  }
  await dismiss(ctx, await ctx.frame());
  const units = before.stock !== null && last.stock !== null ? last.stock - before.stock : null;
  const goldChange = before.gold !== null && last.gold !== null ? last.gold - before.gold : null;
  // A purchase stops for gold or for storage room; with gold left for another lot it was room.
  const lotUnits = done && units ? Math.abs(units) / done : (inventoryGroups.granary as readonly string[]).includes(good) ? 10 : 5;
  const roomOut = last.gold !== null && last.gold >= (buyPrice[good] ?? Infinity) * lotUnits;
  return {
    status: done === lots ? "traded" as const : done ? "partly_traded" as const : "not_traded" as const,
    good, action, lots: done,
    units, goldChange,
    // Stored goods count at the sell price, so a sale leaves net worth unchanged and a
    // purchase lowers it by the buy/sell difference.
    netWorthChange: units !== null && goldChange !== null ? goldChange + units * (sellPrice[good] ?? 0) : null,
    stock: last.stock, gold: last.gold,
    unitPrice: { buy: buyPrice[good], sell: sellPrice[good] },
    ...(done < lots
      ? action === "sell"
        ? { note: "Stopped: no more of this good to sell.", remedy: "Sell only what get_inventory shows in stock." }
        : roomOut
          ? {
              note: "Stopped: no storage room for this good (see storage in status).",
              remedy: (inventoryGroups.granary as readonly string[]).includes(good)
                ? "Make room: expand_storage (kind granary) adds granaries."
                : "Make room: expand_storage (kind stockpile) adds stockpile piles.",
            }
          : { note: "Stopped: not enough gold.", remedy: "Buy fewer lots; gold comes from taxes (set_tax) and from selling goods (market_trade)." }
      : {}),
  };
}
