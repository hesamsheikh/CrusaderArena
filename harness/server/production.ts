/**
 * Goods delivered to storage, by the building types that make them: what each observation's stats
 * and `status` report as `production`. Models asked for it after their games ("production rates
 * are invisible until you compare inventory snapshots over minutes", GLM 5.3 Flash; Claude Haiku
 * 5.5 twice, 2026-10-14): the game shows none. Every reader sample's rise in a good is a delivery,
 * as the stockpile, granary or armory takes it in, except while a harness action that changes that
 * good holds it (a trade, a demolition's refund). A fall is a building taking the good to use, or a
 * cost. A rise counts for the type that makes the good only if one of them stood before it, and not
 * while the good's starting goods are still coming in.
 */
import { TICKS_PER_GAME_SECOND } from "../shared/protocol.js";
import { namedBuildings } from "./building-types.js";

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
/** The building type that makes each good. */
const MAKER: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PRODUCERS).flatMap(([name, goods]) => goods.map((good) => [good, name])),
);

/** Game time production is reported over: the last 3 game minutes. */
export const PRODUCTION_WINDOW_TICKS = 3 * 60 * TICKS_PER_GAME_SECOND;
const TICKS_PER_GAME_MINUTE = 60 * TICKS_PER_GAME_SECOND;

type Sample = { game_time?: unknown; map_name?: unknown; resources_by_name?: unknown; buildings?: unknown; starting_goods_to_come?: unknown };
type Counts = Record<string, number>;

const minutesText = (ticks: number) => {
  const seconds = Math.round(ticks / TICKS_PER_GAME_SECOND);
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return m && s ? `${m} min ${s} s` : m ? `${m} min` : `${s} s`;
};
const tenths = (value: number) => Math.round(value * 10) / 10;
/** The producing types among the player's buildings by name, with how many of each stand. */
const producing = (named: Counts): Counts => Object.fromEntries(Object.entries(named).filter(([name, n]) => name in PRODUCERS && n > 0));
const sameCounts = (a: Counts, b: Counts) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([name, n]) => b[name] === n);

export class ProductionLedger {
  private last: Record<string, number> | null = null;
  private lastTick: number | null = null;
  private map: unknown = null;
  private start: number | null = null;
  /** Each rise, with the type it is credited to: null when none of its good's makers stood before it. */
  private deliveries: { tick: number; good: string; amount: number; maker: string | null }[] = [];
  /** The producing buildings standing from each change on, by type: their time standing in the window. */
  private standing: { tick: number; counts: Counts }[] = [];
  /**
   * The starting goods, by good: the most the list at the top left showed still to come, and how
   * much of it has come in since. On Large Barren Desert's start the 15 iron arrived while GPT-6
   * Luna's first iron mine stood, and the readout gave the mine 5.9 a minute; when its real rate
   * showed, Luna took the ore for running out (2026-10-15).
   */
  private starting: Record<string, { listed: number; arrived: number }> = {};
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
      this.standing = [];
      this.starting = {};
    }
    const toCome = observation!.starting_goods_to_come;
    if (toCome && typeof toCome === "object")
      for (const [good, n] of Object.entries(toCome as Counts))
        if (typeof n === "number" && n > 0) {
          const listed = (this.starting[good] ??= { listed: 0, arrived: 0 });
          listed.listed = Math.max(listed.listed, n);
        }
    const before = this.standing.at(-1)?.counts ?? {};
    // A sample without building counts keeps the last ones.
    const byType = observation!.buildings;
    const counts = byType && typeof byType === "object" ? producing(namedBuildings(byType as Counts)) : before;
    if (this.last)
      for (const [good, amount] of Object.entries(goods)) {
        const rise = (typeof amount === "number" ? amount : 0) - (this.last[good] ?? 0);
        if (!(rise > 0) || this.held.get(good)) continue;
        // The good's starting goods come in first, as far as the list showed them.
        const listed = this.starting[good];
        const arriving = listed ? Math.min(rise, listed.listed - listed.arrived) : 0;
        if (arriving > 0) {
          listed!.arrived += arriving;
          this.deliveries.push({ tick, good, amount: arriving, maker: null });
        }
        const maker = MAKER[good];
        if (rise > arriving) this.deliveries.push({ tick, good, amount: rise - arriving, maker: maker && before[maker] ? maker : null });
      }
    this.last = { ...goods };
    this.lastTick = tick;
    this.start ??= tick;
    if (!this.standing.length || !sameCounts(counts, before)) this.standing.push({ tick, counts });
    const from = tick - PRODUCTION_WINDOW_TICKS;
    while (this.deliveries.length && this.deliveries[0].tick <= from) this.deliveries.shift();
    // The last change at or before the window's start still covers its beginning.
    while (this.standing.length > 1 && this.standing[1].tick <= from) this.standing.shift();
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
   * goods, per game minute in all, and per building over the time each stood in the window (three
   * orchards built beside an old one divided its apples by four, and GPT-6 Luna took the orchards
   * for poor ones, 2026-10-14), with how many more stand than at the window's start. The starting
   * goods coming in, and a rise with none of its good's makers standing, are under `other_rises`.
   * Null before any sample.
   */
  report(buildings: Readonly<Record<string, number>>) {
    if (this.lastTick === null || this.start === null) return null;
    const end = this.lastTick;
    const span = Math.min(end - this.start, PRODUCTION_WINDOW_TICKS);
    const from = end - span;
    const made: Record<string, Counts> = {};
    const other: Counts = {};
    for (const d of this.deliveries) {
      if (d.tick <= from) continue;
      const into = d.maker ? (made[d.maker] ??= {}) : other;
      into[d.good] = (into[d.good] ?? 0) + d.amount;
    }
    // Ticks each type's buildings stood in the window, and how many stood at its start.
    const stood: Counts = {};
    let atStart: Counts = this.standing[0]?.counts ?? {};
    for (const [i, change] of this.standing.entries()) {
      if (change.tick <= from) atStart = change.counts;
      const overlap = Math.min(this.standing[i + 1]?.tick ?? end, end) - Math.max(change.tick, from);
      if (overlap > 0) for (const [name, n] of Object.entries(change.counts)) stood[name] = (stood[name] ?? 0) + n * overlap;
    }
    const minutes = span / TICKS_PER_GAME_MINUTE;
    const byBuilding: Record<string, {
      standing: number; built_in_window?: number; delivered: Counts; per_minute: number; per_building_per_minute: number;
    }> = {};
    for (const [name, goods] of Object.entries(PRODUCERS)) {
      const standing = buildings[name] ?? 0;
      if (!(standing > 0)) continue;
      const delivered = Object.fromEntries(goods.map((good) => [good, made[name]?.[good] ?? 0]));
      const total = Object.values(delivered).reduce((a, b) => a + b, 0);
      const buildingMinutes = (stood[name] ?? 0) / TICKS_PER_GAME_MINUTE;
      const built = standing - (atStart[name] ?? 0);
      byBuilding[name] = {
        standing,
        ...(built > 0 ? { built_in_window: built } : {}),
        delivered,
        per_minute: tenths(minutes > 0 ? total / minutes : 0),
        per_building_per_minute: tenths(buildingMinutes > 0 ? total / buildingMinutes : 0),
      };
    }
    return {
      window: span >= PRODUCTION_WINDOW_TICKS ? "the last 3 game minutes" : `the ${minutesText(span)} of game time so far`,
      by_building: byBuilding,
      ...(Object.keys(other).length ? { other_rises: other } : {}),
    };
  }
}

/**
 * The `production` entry of an observation's stats or a status, from the run's ledger and the
 * reader's building counts by type: none before any sample, nor while no producing building stands
 * and nothing rose.
 */
export function productionEntry(ledger: Pick<ProductionLedger, "report"> | undefined, buildings: Record<string, number> | null | undefined) {
  const report = ledger && buildings ? ledger.report(namedBuildings(buildings)) : null;
  return report && (Object.keys(report.by_building).length || report.other_rises) ? { production: report } : {};
}
