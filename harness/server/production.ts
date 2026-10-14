/**
 * Goods delivered to storage, by the building types that make them: what `status` reports as
 * `production`. Models asked for it after their games ("production rates are invisible until you
 * compare inventory snapshots over minutes", GLM 5.3 Flash; Claude Haiku 5.5 twice, 2026-10-14):
 * the game shows none. Every reader sample's rise in a good is a delivery, as the stockpile,
 * granary or armory takes it in, except while a harness action that changes that good holds it
 * (a trade, a demolition's refund). A fall is a building taking the good to use, or a cost.
 */
import { TICKS_PER_GAME_SECOND } from "../shared/protocol.js";

/** The goods each producing building type delivers to storage, under the reader's names. */
export const PRODUCERS: Readonly<Record<string, readonly string[]>> = {
  Woodcutter: ["wood_planks"],
  Quarry: ["stone"],
  "Iron Mine": ["iron"],
  "Pitch Rig": ["pitch"],
  "Hunter's Post": ["meat"],
  "Apple Orchard": ["apples"],
  "Dairy Farm": ["cheese"],
  "Wheat Farm": ["wheat"],
  "Hops Farm": ["hops"],
  Mill: ["flour"],
  Bakery: ["bread"],
  Brewery: ["ale"],
  "Fletchers' Workshop": ["bows", "crossbows"],
  "Poleturner's Workshop": ["spears", "pikes"],
  "Blacksmith's Workshop": ["maces", "swords"],
  "Tanner's Workshop": ["leather_armour"],
  "Armorer's Workshop": ["metal_armour"],
};

/** Game time production is reported over: the last 3 game minutes. */
export const PRODUCTION_WINDOW_TICKS = 3 * 60 * TICKS_PER_GAME_SECOND;

type Sample = { game_time?: unknown; map_name?: unknown; resources_by_name?: unknown };

const minutesText = (ticks: number) => {
  const seconds = Math.round(ticks / TICKS_PER_GAME_SECOND);
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return m && s ? `${m} min ${s} s` : m ? `${m} min` : `${s} s`;
};
const tenths = (value: number) => Math.round(value * 10) / 10;

export class ProductionLedger {
  private last: Record<string, number> | null = null;
  private lastTick: number | null = null;
  private map: unknown = null;
  private start: number | null = null;
  private deliveries: { tick: number; good: string; amount: number }[] = [];
  private held = new Map<string, number>();

  /** One reader sample: each good's rise since the last sample is a delivery, unless held. */
  sample(observation: Sample | null | undefined) {
    const tick = observation?.game_time;
    const goods = observation?.resources_by_name as Record<string, number> | undefined;
    if (typeof tick !== "number" || !goods || typeof goods !== "object") return;
    // Another game, or the clock went back (a load): start over.
    if (observation!.map_name !== this.map || (this.lastTick !== null && tick < this.lastTick)) {
      this.map = observation!.map_name;
      this.last = null;
      this.start = null;
      this.deliveries = [];
    }
    if (this.last)
      for (const [good, amount] of Object.entries(goods)) {
        const rise = (typeof amount === "number" ? amount : 0) - (this.last[good] ?? 0);
        if (rise > 0 && !this.held.get(good)) this.deliveries.push({ tick, good, amount: rise });
      }
    this.last = { ...goods };
    this.lastTick = tick;
    this.start ??= tick;
    const from = tick - PRODUCTION_WINDOW_TICKS;
    while (this.deliveries.length && this.deliveries[0].tick <= from) this.deliveries.shift();
  }

  /** Rises in `goods` are not deliveries until the returned function is called. */
  hold(goods: readonly string[]) {
    for (const good of goods) this.held.set(good, (this.held.get(good) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const good of goods) this.held.set(good, Math.max(0, (this.held.get(good) ?? 1) - 1));
    };
  }

  /**
   * What reached storage in the last 3 game minutes (or the game time so far, when less), for each
   * producing type of `buildings` (the player's buildings by name, as status counts them): the
   * goods, per game minute in all and per building. A good that rose with none of its producers
   * standing (the starting goods still arriving, say) is under `other_rises`. Null before any sample.
   */
  report(buildings: Readonly<Record<string, number>>) {
    if (this.lastTick === null || this.start === null) return null;
    const span = Math.min(this.lastTick - this.start, PRODUCTION_WINDOW_TICKS);
    const sums: Record<string, number> = {};
    for (const d of this.deliveries) if (d.tick > this.lastTick - span) sums[d.good] = (sums[d.good] ?? 0) + d.amount;
    const minutes = span / (60 * TICKS_PER_GAME_SECOND);
    const byBuilding: Record<string, { standing: number; delivered: Record<string, number>; per_minute: number; per_building_per_minute: number }> = {};
    const made = new Set<string>();
    for (const [name, goods] of Object.entries(PRODUCERS)) {
      const standing = buildings[name] ?? 0;
      if (!(standing > 0)) continue;
      for (const good of goods) made.add(good);
      const delivered = Object.fromEntries(goods.map((good) => [good, sums[good] ?? 0]));
      const total = Object.values(delivered).reduce((a, b) => a + b, 0);
      const perMinute = minutes > 0 ? total / minutes : 0;
      byBuilding[name] = { standing, delivered, per_minute: tenths(perMinute), per_building_per_minute: tenths(perMinute / standing) };
    }
    const other = Object.fromEntries(Object.entries(sums).filter(([good, amount]) => amount > 0 && !made.has(good)));
    return {
      window: span >= PRODUCTION_WINDOW_TICKS ? "the last 3 game minutes" : `the ${minutesText(span)} of game time so far`,
      by_building: byBuilding,
      ...(Object.keys(other).length ? { other_rises: other } : {}),
    };
  }
}
