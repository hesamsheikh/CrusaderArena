// Marketplace prices per SINGLE unit of each good, keyed by the harness goods names
// (the names in inventory.ts / resources_by_name).
//
// Source: static analysis of the engine, CrusaderDE.dll (Steam build 24816905, 2026-09-30).
// The engine stores one fixed (buy, sell) pair per good, priced for a LOT OF 5 units;
// the marketplace UI trades 5 units at a time ("Buy 5 units of ... for N gold") and its
// hover text divides by 5. The values below are those lot prices divided by 5 (every lot
// price is an exact multiple of 5, so nothing is rounded). Lot prices are:
//   buy:  wood 20, hops 75, stone 70, iron 225, pitch 100, wheat 115, bread/cheese/meat/apples 40,
//         ale 100, flour 160, bows 155, crossbows 290, spears 100, pikes 180, maces 290,
//         swords 290, leather armour 125, metal armour 290
//   sell: wood 5, hops 40, stone 35, iron 115, pitch 50, wheat 40, bread/cheese/meat/apples 20,
//         ale 50, flour 50, bows 75, crossbows 150, spears 50, pikes 90, maces 150,
//         swords 150, leather armour 60, metal armour 150
// The table is a compile-time constant in the engine: no difficulty, mode or supply/demand
// modifier was found. Confirmed live 2026-09-30: stone Buy 5 for 70, Sell 5 for 35; bread Buy 5 for 40, Sell 10 for 40.

/** Gold received for selling one unit (sell lot price / 5). Use this to value stored goods. */
export const sellPrice: Record<string, number> = {
  wood_planks: 1,
  hops: 8,
  stone: 7,
  iron: 23,
  pitch: 10,
  wheat: 8,
  bread: 4,
  cheese: 4,
  meat: 4,
  apples: 4,
  ale: 10,
  flour: 10,
  bows: 15,
  crossbows: 30,
  spears: 10,
  pikes: 18,
  maces: 30,
  swords: 30,
  leather_armour: 12,
  metal_armour: 30,
};

/** Gold paid for buying one unit (buy lot price / 5). */
export const buyPrice: Record<string, number> = {
  wood_planks: 4,
  hops: 15,
  stone: 14,
  iron: 45,
  pitch: 20,
  wheat: 23,
  bread: 8,
  cheese: 8,
  meat: 8,
  apples: 8,
  ale: 20,
  flour: 32,
  bows: 31,
  crossbows: 58,
  spears: 20,
  pikes: 36,
  maces: 58,
  swords: 58,
  leather_armour: 25,
  metal_armour: 58,
};

/**
 * Net worth: gold plus every stored good at the marketplace sell price, i.e. the gold a
 * player would hold after selling everything. The benchmark's economy score.
 */
export function netWorth(gold: number | null | undefined, goods: Record<string, number> | null | undefined) {
  const goodsValue = Object.entries(goods ?? {}).reduce((sum, [name, n]) => sum + (sellPrice[name] ?? 0) * (n || 0), 0);
  return { netWorth: (gold ?? 0) + goodsValue, goodsValue };
}
