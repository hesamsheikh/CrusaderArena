/**
 * The results of a run: the game's state when it ended, in one format for every kind of run (an
 * agent's episode, a person's reference game, the do-nothing baseline, a dry run). npm run
 * episodes writes it beside the scorecard as results.json, and as tables in results.md. Missing
 * readings stay null, never zero.
 */
import type { Stats } from "../shared/protocol.js";
import { FACTOR_UNITS_PER_POINT, foodPopularity, popularityFactors } from "../shared/popularity.js";
import { namedBuildings } from "./building-types.js";
import { rationLevels, taxLevels } from "./economy.js";
import { netWorth, sellPrice } from "./market-prices.js";
import { minutesSeconds } from "./session.js";
import { dateOf } from "./status.js";

type Observation = NonNullable<Stats["observation"]>;

export type RunKind = "agent" | "human" | "idle" | "dry-run";

/** results.json */
export type Results = {
  format: 1;
  kind: RunKind;
  /** Who played: the model's name for an agent. */
  player: string;
  map: string | null;
  save: string;
  benchmark?: string;
  run?: { id: string; folder: string };
  /** "final": read once the game was paused at the end; "last_observed": the last reading before the game was lost. */
  source: "final" | "last_observed";
  /** When the game was read. */
  read_at: string;
  game: { date: string | null; ticks: number | null; played_seconds: number | null; budget_seconds: number };
  /** Gold plus every stored good at the marketplace sell price (market-prices.ts). */
  net_worth: number;
  gold: number | null;
  goods_value: number;
  /** Every good in store, most valuable first. */
  goods: Record<string, { units: number; value: number }>;
  population: number | null;
  housing: number | null;
  idle_peasants: number | null;
  popularity: number | null;
  /** The coming month's change and the factors behind it, in the game's points (status.ts). */
  popularity_change: number | null;
  popularity_factors: Record<string, number> | null;
  taxes: { level: number; name: string; gold_per_month: number | null } | null;
  food: { stored: number; rations: string; foods_eaten: number; foods_available: number; ration_points: number; variety_points: number } | null;
  worker_efficiency_percent: number | null;
  storage: { stockpile_piles: number; empty_piles: number; granaries: number; granary_food: number } | null;
  /** Buildings by name (building-types.ts); null when the reader had no counts. */
  buildings: Record<string, number> | null;
  /** The reader's counts by engine type, parts included. */
  buildings_by_type: Record<string, number> | null;
  troops: number | null;
  /** The engine's structure count, every player's and the map's own. */
  structures_map_wide: number | null;
  /** The whole reading the results come from. */
  reading: Observation;
  /** Where values came from when not all from `reading`. */
  notes?: string[];
};

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export type ResultsContext = {
  kind: RunKind;
  player: string;
  save: string;
  benchmark?: string;
  run?: { id: string; folder: string };
  source: "final" | "last_observed";
  /** The reading's capture time in ms, when the reader gave one. */
  readAt?: number;
  playedSeconds?: number | null;
  budgetSeconds: number;
};

export function runResults(o: Observation, context: ResultsContext): Results {
  const s = o.settlement ?? null;
  const stored = o.resources_by_name ?? {};
  const worth = netWorth(o.gold, stored);
  const goods = Object.fromEntries(
    Object.entries(stored)
      .filter(([, units]) => units > 0)
      .map(([good, units]) => [good, { units, value: (sellPrice[good] ?? 0) * units }] as const)
      .sort(([a, x], [b, y]) => y.value - x.value || a.localeCompare(b)),
  );
  const level = number(o.tax_index);
  const share = s ? foodPopularity(s) : null;
  const byType = o.buildings && typeof o.buildings === "object" ? o.buildings : null;
  return {
    format: 1,
    kind: context.kind,
    player: context.player,
    map: typeof o.map_name === "string" ? o.map_name : null,
    save: context.save,
    ...(context.benchmark ? { benchmark: context.benchmark } : {}),
    ...(context.run ? { run: context.run } : {}),
    source: context.source,
    read_at: new Date(context.readAt ?? Date.now()).toISOString(),
    game: {
      date: s ? dateOf(s) : null,
      ticks: number(o.game_time),
      played_seconds: number(context.playedSeconds),
      budget_seconds: context.budgetSeconds,
    },
    net_worth: worth.netWorth,
    gold: number(o.gold),
    goods_value: worth.goodsValue,
    goods,
    population: number(o.population),
    housing: number(s?.housing_cap),
    idle_peasants: number(s?.peasants_available),
    popularity: number(o.popularity),
    popularity_change: s ? Math.round((s.upcoming_popularity / FACTOR_UNITS_PER_POINT) * 100) / 100 : null,
    popularity_factors: s ? popularityFactors(s, byType) : null,
    taxes: level !== null && taxLevels[level]
      ? { level, name: taxLevels[level].label, gold_per_month: number(s?.tax_amount) }
      : null,
    food: s && share
      ? {
          stored: s.total_food,
          rations: rationLevels[s.rationing] ?? String(s.rationing),
          foods_eaten: s.food_types_eaten,
          foods_available: s.food_types_available,
          ration_points: share.rations,
          variety_points: share.variety,
        }
      : null,
    // The game has no efficiency (0) before its first reckoning.
    worker_efficiency_percent: s && s.efficiency > 0 ? s.efficiency : null,
    storage: o.storage
      ? {
          stockpile_piles: o.storage.piles.length,
          empty_piles: o.storage.piles.filter((pile) => !pile.good || pile.amount <= 0).length,
          granaries: o.storage.granaries.length,
          granary_food: o.storage.granaries.reduce((sum, granary) => sum + granary.amount, 0),
        }
      : null,
    buildings: byType ? namedBuildings(byType) : null,
    buildings_by_type: byType,
    troops: number(o.own_troops?.total),
    structures_map_wide: number(o.structures?.count),
    reading: o,
  };
}

const amount = (value: number | null | undefined) =>
  typeof value === "number" ? Math.round(value).toLocaleString("en-US") : "unknown";
const signed = (value: number) => (value > 0 ? `+${value}` : value < 0 ? `−${-value}` : "0");
const words = (name: string) => name.replace(/_planks$/, "").replace(/_/g, " ");

const kinds: Record<RunKind, string> = {
  agent: "An agent's episode",
  human: "A reference game played by a person",
  idle: "The do-nothing baseline: the game left alone",
  "dry-run": "A dry run: the save as loaded, nothing played",
};

/** results.md: the results as tables. */
export function resultsMarkdown(r: Results) {
  const played = r.game.played_seconds;
  const rows: [string, string][] = [
    ["Game time played", `${played !== null ? minutesSeconds(played) : "unknown"} of ${minutesSeconds(r.game.budget_seconds)}`],
    ["Date in the game", r.game.date ?? "unknown"],
    ["Net worth", amount(r.net_worth)],
    ["Gold", amount(r.gold)],
    ["Stored goods, at the sell price", amount(r.goods_value)],
    ["Population", amount(r.population)],
    ["Housing", amount(r.housing)],
    ["Idle peasants", amount(r.idle_peasants)],
    ["Popularity", `${amount(r.popularity)}${r.popularity_change !== null ? ` (${r.popularity_change ? `${signed(r.popularity_change)} next month` : "no change next month"})` : ""}`],
    ["Taxes", r.taxes ? `${r.taxes.name}${r.taxes.gold_per_month !== null ? `, ${amount(r.taxes.gold_per_month)} gold a month` : ""}` : "unknown"],
    ["Rations", r.food ? `${r.food.rations}; ${r.food.foods_eaten} of ${r.food.foods_available} foods eaten; ${amount(r.food.stored)} food stored` : "unknown"],
    ["Worker efficiency", r.worker_efficiency_percent !== null ? `${r.worker_efficiency_percent}%` : "none yet"],
    ["Storage", r.storage ? `${r.storage.stockpile_piles} stockpile piles (${r.storage.empty_piles} empty); ${r.storage.granaries} ${r.storage.granaries === 1 ? "granary" : "granaries"} holding ${amount(r.storage.granary_food)} food` : "unknown"],
    ["Troops", amount(r.troops)],
    ["Structures on the map (every player's)", amount(r.structures_map_wide)],
  ];
  const lines = [
    `# Results: ${r.player} on ${r.map ?? "an unknown map"}`,
    "",
    `${kinds[r.kind]}, from the save "${r.save}"${r.benchmark ? ` (benchmark ${r.benchmark})` : ""}${r.run ? `, run ${r.run.id}` : ""}. ` +
      (r.source === "final"
        ? `Read from the paused game at the end, ${r.read_at.slice(0, 16).replace("T", " ")} UTC.`
        : `The game was lost before the end; these are the last readings seen, ${r.read_at.slice(0, 16).replace("T", " ")} UTC.`),
    "",
    ...(r.notes?.length ? [...r.notes.map((note) => `- ${note}`), ""] : []),
    "| | |",
    "| --- | ---: |",
    ...rows.map(([label, value]) => `| ${label} | ${value} |`),
    "",
    "## Popularity factors",
    "",
  ];
  const factors = Object.entries(r.popularity_factors ?? {});
  if (!r.popularity_factors) lines.push("Not read.", "");
  else if (!factors.length) lines.push("None: every factor was 0.", "");
  else
    lines.push(
      "Points a month, as the game's report lists them; they add up to the coming change.",
      "",
      "| Factor | Points |",
      "| --- | ---: |",
      ...factors.map(([name, points]) => `| ${words(name)} | ${signed(points)} |`),
      "",
    );
  lines.push("## Stored goods", "");
  const goods = Object.entries(r.goods);
  if (!goods.length) lines.push("Nothing in store.", "");
  else
    lines.push(
      "| Good | Units | Value |",
      "| --- | ---: | ---: |",
      ...goods.map(([good, { units, value }]) => `| ${words(good)} | ${amount(units)} | ${amount(value)} |`),
      `| **Total** | | **${amount(r.goods_value)}** |`,
      "",
    );
  lines.push("## Buildings", "");
  const buildings = Object.entries(r.buildings ?? {});
  if (!r.buildings) lines.push("Not read: the game reader had no building counts.", "");
  else if (!buildings.length) lines.push("None.", "");
  else
    lines.push(
      "| Building | Count |",
      "| --- | ---: |",
      ...buildings.map(([name, count]) => `| ${name} | ${count} |`),
      "",
    );
  return lines.join("\n");
}
