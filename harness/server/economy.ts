import type { Frame } from "../shared/protocol.js";
import type { GameHotkey } from "./device.js";
import { ackTime, dismiss, sampleAfter, type AnchorContext } from "./anchors.js";
import { SAMPLE_POLL_SECONDS, type Observation } from "./placement.js";
import { buyPrice, scoredPrice, sellPrice } from "./market-prices.js";
import { inventoryGroups } from "./inventory.js";
import { points } from "../shared/popularity.js";
import { storageOf } from "./status.js";

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

/**
 * Units one marketplace click trades (live 2026-10-11, wood, stone and apples): a purchase is always
 * 5; a sale is 20 while 100 or more of the good are in stock, 10 from 50, else 5 (or what is left).
 * Selling 20 lots of 225 wood as 5-unit clicks sold all 225 in a GLM run that day.
 */
export function unitsPerClick(action: "buy" | "sell", stock: number) {
  if (action === "buy") return 5;
  return Math.max(0, Math.min(stock, stock >= 100 ? 20 : stock >= 50 ? 10 : 5));
}

/**
 * Waits up to `seconds` for one trade to show in the reader after `after`: from one sample to the
 * next the stock moved by exactly `units` or the gold by exactly `gold`, or the gold did since `from`
 * (the state before the click). A trade changes both at once, while a delivery or the month's taxes
 * change one of them, so one of the two stays exact; the gold also counts with the month's taxes
 * (the keep's `tax_amount`) on top, for a trade that lands in the sample of the taxes. The stock is
 * not compared with `from`: a woodcutter unloads one plank a sample, which adds up to a purchase's 5
 * in about half a second (live 2026-10-11), while only trades and taxes move the gold. Three
 * purchases in short live checks that day landed with the taxes and a delivery in one sample and
 * were missed.
 */
async function tradeShown(
  ctx: AnchorContext,
  after: number,
  values: (o: Observation) => { stock: number; gold: number } | null,
  from: { stock: number; gold: number },
  units: number,
  gold: number,
  seconds: number,
) {
  let prev = from;
  for (let i = 0; i < seconds / SAMPLE_POLL_SECONDS; i++) {
    const stats = ctx.device.currentStats();
    const o = stats.status === "ok" ? (stats.observation as Observation | null) : null;
    const v = o && (stats.captured_unix_ms ?? 0) >= after ? values(o) : null;
    if (v) {
      const tax = (o?.settlement as { tax_amount?: unknown } | null | undefined)?.tax_amount;
      const paid = (delta: number) => delta === gold || (typeof tax === "number" && tax !== 0 && delta === gold + tax);
      // From one sample to the next: exact in the stock or the gold, or for a sale both moved its
      // way (a delivery and the taxes in the very sample of the sale). For a purchase both moving its
      // way counts too, unless bribes are taking gold: food being eaten and part of the month's taxes
      // in its very sample left 5 apples bought as +3 apples and -19 gold, and the purchase was not
      // counted (Claude Opus 5.5 and GPT-6 Luna, 2026-10-13). Since the click: the gold.
      const bribing = typeof tax === "number" && tax < 0;
      const step = v.stock - prev.stock === units || paid(v.gold - prev.gold) ||
        (units < 0 && v.stock < prev.stock && v.gold - prev.gold >= gold) ||
        (units > 0 && !bribing && v.stock > prev.stock && v.gold < prev.gold);
      if (step || paid(v.gold - from.gold)) return v;
      prev = v;
    }
    await ctx.pause(SAMPLE_POLL_SECONDS);
  }
  return null;
}

/**
 * How long one click's trade may take to show in the reader before the trade stops. Two of Kimi
 * K3's 47 trades (2026-10-12) stopped after 2 seconds with nothing bought.
 */
const TRADE_WAIT_SECONDS = 5;

/** Room for `units` more of a good in the reader's storage: its piles and the empty ones, the granaries, or the armories. */
function roomFor(o: Observation | null, good: string, units: number) {
  const storage = o ? storageOf(o as Parameters<typeof storageOf>[0]) : undefined;
  if (!storage) return true;
  if ((inventoryGroups.granary as readonly string[]).includes(good)) return storage.granary.room >= units;
  if ((inventoryGroups.armory as readonly string[]).includes(good)) return storage.armory ? storage.armory.room >= units : true;
  const own = storage.stockpile.goods[good];
  return own ? own.room >= units : storage.stockpile.empty_piles > 0;
}

/**
 * Buy or sell up to `lots` × 5 units of one good at the marketplace, one click at a time in the
 * game's own steps (unitsPerClick), and never more than asked. A click counts once the reader shows
 * that trade (tradeShown), so a delivery or a tax payment at the same moment is not taken for one.
 */
export async function marketTrade(ctx: AnchorContext, good: string, action: "buy" | "sell", lots: number, { arms: armsScored = true } = {}) {
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
  const wanted = lots * 5;
  const price = (action === "buy" ? buyPrice : sellPrice)[good] ?? 0;
  // +1 when a purchase moves units in and gold out, -1 for a sale.
  const way = action === "buy" ? 1 : -1;
  const values = (o: Observation) => {
    const s = stock(o), g = gold(o);
    return s === null || g === null ? null : { stock: s, gold: g };
  };
  let traded = 0, clicks = 0, last = before, tooLarge = 0;
  let lastSeen: Observation | null = opened;
  while (traded < wanted && last.stock !== null && last.gold !== null) {
    const step = unitsPerClick(action, last.stock);
    if (step === 0) break;
    if (step > wanted - traded) { tooLarge = step; break; }
    // A purchase the reader shows no room for is refused by the game (a full armory, live
    // 2026-10-12): stop before clicking, and say why below.
    if (action === "buy" && !roomFor(lastSeen, good, step)) break;
    const ack = await click(ctx, action === "buy" ? BUY : SELL);
    const seen = await tradeShown(ctx, ackTime(ack), values, { stock: last.stock, gold: last.gold }, step * way, -step * price * way, TRADE_WAIT_SECONDS);
    if (!seen) break;
    traded += step;
    clicks++;
    last = seen;
    lastSeen = ctx.device.currentStats().observation as Observation | null ?? lastSeen;
  }
  await dismiss(ctx, await ctx.frame());
  const units = traded * way;
  // At the market's fixed price, not gold after minus gold before: the month's taxes landing during
  // a trade hid most of its cost (25 cheese Kimi K3 bought showed as 37 gold, not 200, 2026-10-12).
  const goldChange = -units * price;
  // A purchase stops for gold or for storage room; it says which only when the reader shows it.
  const noGold = last.gold !== null && last.gold < (buyPrice[good] ?? Infinity) * 5;
  const roomOut = !noGold && !roomFor(lastSeen, good, 5);
  const food = (inventoryGroups.granary as readonly string[]).includes(good);
  const arms = (inventoryGroups.armory as readonly string[]).includes(good);
  const stopped = traded >= wanted
    ? {}
    : tooLarge
      ? {
          note: `The game sells ${tooLarge} a click with ${last.stock} in stock (20 from 100, 10 from 50, else 5), more than the ${wanted - traded} left to sell, so it stopped.`,
          remedy: `Ask for lots in steps of ${tooLarge / 5} (${tooLarge} units) to sell more now, or sell the rest once the stock is lower.`,
        }
      : action === "sell"
        ? last.stock === 0
          ? { note: "Stopped: no more of this good to sell.", remedy: "Sell only what get_inventory shows in stock." }
          : { note: `Stopped: a sale did not show in the reader within ${TRADE_WAIT_SECONDS} seconds.`, remedy: "Observe; if the stock did not fall, call market_trade again for the rest." }
        : roomOut
          ? {
              note: "Stopped: no storage room for this good (see storage in status).",
              remedy: food ? "Make room: expand_storage (kind granary) adds granaries."
                : arms ? "Make room: expand_storage (kind armory) adds an armory; one holds 50 weapons and armour."
                : "Make room: expand_storage (kind stockpile) adds stockpile piles.",
            }
          : noGold
            ? { note: "Stopped: not enough gold.", remedy: "Buy fewer lots; gold comes from taxes (set_tax) and from selling goods (market_trade)." }
            : { note: `Stopped: a purchase did not show in the reader within ${TRADE_WAIT_SECONDS} seconds.`, remedy: "Observe; if the stock did not rise, call market_trade again for the rest." };
  return {
    status: traded >= wanted ? "traded" as const : traded ? "partly_traded" as const : "not_traded" as const,
    good, action, lots: traded / 5, units, clicks,
    ...(traded < wanted ? { asked: wanted } : {}),
    goldChange,
    // Stored goods count at the sell price, so a sale leaves net worth unchanged and a
    // purchase lowers it by the buy/sell difference; weapons and armour a benchmark leaves out
    // count nothing in store, so their sale adds its gold.
    netWorthChange: goldChange + units * scoredPrice(good, { arms: armsScored }),
    stock: last.stock, gold: last.gold,
    unitPrice: { buy: buyPrice[good], sell: sellPrice[good] },
    ...stopped,
  };
}
