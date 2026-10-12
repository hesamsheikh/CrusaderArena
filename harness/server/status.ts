import type { Stats } from "../shared/protocol.js";
import { FACTOR_UNITS_PER_POINT, foodPopularity, popularityFactors } from "../shared/popularity.js";
import { buildingTypeNames } from "./anchors.js";
import { inventoryGroups } from "./inventory.js";

const months = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];
// Granary ration levels in the game's order; 2 = "Full rations" was checked against the panel.
const rations = ["none", "half", "full", "extra", "double"];
const points = (value?: number) =>
  typeof value === "number" ? Math.round((value / FACTOR_UNITS_PER_POINT) * 100) / 100 : undefined;

type Observation = NonNullable<Stats["observation"]>;
type Settlement = NonNullable<Observation["settlement"]>;

/** The game's date, as "September 1200" (month 0 is January). */
export const dateOf = (s: Pick<Settlement, "month" | "year">) => `${months[s.month] ?? `month ${s.month}`} ${s.year}`;
const populationOf = (o: Observation) => ({
  current: o.population,
  ...(o.settlement ? { housing: o.settlement.housing_cap, idle_peasants: o.settlement.peasants_available } : {}),
});
const popularityOf = (o: Observation) => {
  const s = o.settlement;
  return {
    current: o.popularity,
    ...(s
      ? {
          upcoming_change: points(s.upcoming_popularity),
          factors: popularityFactors(s),
        }
      : {}),
  };
};
/** The rations' and food variety's shares of the food factor, when either has one. */
const foodShareOf = (s: Settlement): { popularity?: ReturnType<typeof foodPopularity> } => {
  const share = foodPopularity(s);
  return share.rations || share.variety ? { popularity: share } : {};
};
/** Worker efficiency in percent from the fear factor; the game has none (0) before its first reckoning. */
const efficiencyOf = (s: Settlement | null | undefined) =>
  s && s.efficiency > 0 ? { worker_efficiency_percent: s.efficiency } : {};
const placementOf = (o: Observation) =>
  o.placement?.action === 5 ? "placing" : o.placement?.action === 6 ? "demolishing" : "none";
const cameraOf = (o: Observation) =>
  o.camera
    ? { centre_tile: [o.camera.centre_tile_x, o.camera.centre_tile_y], zoom: o.camera.pixels_per_unit_scale }
    : null;

/** What a granary holds, of all foods together (live 2026-10-09); an empty one reads capacity 0. */
const GRANARY_CAPACITY = 250;

/**
 * Stockpile and granary room. Each stockpile has four piles and each pile holds one good, so a
 * good can be delivered only while one of its piles has room or a pile is empty; otherwise its
 * producers stop (live 2026-10-09). A good's room counts the empty piles too, at what one of its
 * piles holds: a lone figure for its own piles read as full while empty piles stood ready (a GLM
 * run on 2026-10-11 sold its wood at "room 1" with 13 empty piles). Empty piles are shared, so
 * the goods' rooms overlap. Absent when the reader has no storage reading.
 */
export function storageOf(o: Observation) {
  const st = o.storage;
  if (!st) return undefined;
  const own: Record<string, { stored: number; room: number; pile: number }> = {};
  let empty = 0;
  for (const pile of st.piles) {
    if (!pile.good || pile.amount <= 0) { empty++; continue; }
    const g = (own[pile.good] ??= { stored: 0, room: 0, pile: 0 });
    g.stored += pile.amount;
    g.room += Math.max(0, pile.capacity - pile.amount);
    g.pile = Math.max(g.pile, pile.capacity);
  }
  const goods = Object.fromEntries(Object.entries(own).map(([name, g]) => [name, { stored: g.stored, room: g.room + empty * g.pile }]));
  const blocked = empty ? [] : Object.entries(own).filter(([, g]) => g.room === 0).map(([name]) => name);
  // Granaries hold all foods together; like a pile, an empty one reads capacity 0 until food arrives.
  const stocked = st.granaries.filter((g) => g.amount > 0);
  const food = stocked.reduce((n, g) => n + g.amount, 0);
  const emptyGranaries = st.granaries.length - stocked.length;
  const room = stocked.reduce((n, g) => n + Math.max(0, g.capacity - g.amount), 0) + emptyGranaries * GRANARY_CAPACITY;
  return {
    stockpile: {
      piles: st.piles.length,
      empty_piles: empty,
      goods,
      ...(empty === 0 && st.piles.length
        ? { full: `No empty pile: ${blocked.length ? `${blocked.join(", ")} and ` : ""}any good not stored yet cannot be delivered, so their producers stop, and goods still to come (such as the rest of a starting package, listed at the top left of the screen) wait outside. Sell surplus or expand_storage.` }
        : {}),
    },
    granary: {
      granaries: st.granaries.length,
      empty_granaries: emptyGranaries,
      food,
      room,
      ...(stocked.length && !emptyGranaries && !room ? { full: "Granaries full: food producers stop delivering. Add a granary (expand_storage) or sell food." } : {}),
    },
  };
}

/**
 * The settlement beside every screenshot: game values only, in the game's own units. Reader
 * plumbing (session, generation, timestamps, coherence and heap diagnostics) stays in the tool
 * result's details, which are not sent to the model; troops only when the benchmark has military play.
 */
export function observationStats(stats: Stats, { military = true } = {}) {
  const o = stats.observation;
  if (stats.status !== "ok" || !o) return { status: "unavailable" as const, reader_status: stats.status };
  const s = o.settlement;
  const troops = o.own_troops as { total?: number; by_type?: Record<string, number> } | undefined;
  return {
    status: "ok" as const,
    ...(s ? { date: dateOf(s) } : {}),
    gold: o.gold,
    population: populationOf(o),
    popularity: popularityOf(o),
    ...efficiencyOf(s),
    ...(typeof o.tax_index === "number" ? { tax_level: o.tax_index } : {}),
    ...(s
      ? {
          food: {
            total: s.total_food,
            rationing: rations[s.rationing] ?? s.rationing,
            types_eaten: s.food_types_eaten,
            types_available: s.food_types_available,
            ...foodShareOf(s),
          },
        }
      : {}),
    // Only goods in stock: about 20 empty ones went out with every observation and stayed in the
    // conversation (the prompt says an unlisted good has none; status lists every good).
    goods: o.resources_by_name ? Object.fromEntries(Object.entries(o.resources_by_name).filter(([, n]) => n)) : null,
    ...(storageOf(o) ? { storage: storageOf(o) } : {}),
    ...(military && troops
      ? {
          troops: {
            total: troops.total,
            ...(troops.by_type
              ? { by_type: Object.fromEntries(Object.entries(troops.by_type).filter(([, n]) => n)) }
              : {}),
          },
        }
      : {}),
    placement_mode: placementOf(o),
    ...(o.selected_building ? { selected_building: describeBuilding(o.selected_building) } : {}),
    camera: cameraOf(o),
  };
}

/** Compact settlement status from one fresh reader sample; missing values stay absent, never zero. */
export function statusReport(
  stats: Stats,
  extra: { budget?: Record<string, number | string>; views?: string[] } = {},
) {
  const o = stats.observation;
  if (stats.status !== "ok" || !o)
    return {
      status: "unavailable" as const,
      readerStatus: stats.status,
      note: "No fresh reader sample; missing values are unknown, not zero. Try again shortly.",
    };
  const named = o.resources_by_name ?? {};
  const pick = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, named[name]]));
  const s = o.settlement;
  return {
    status: "ok" as const,
    ...(extra.budget ? { budget: extra.budget } : {}),
    ...(s ? { date: dateOf(s) } : {}),
    gold: o.gold,
    population: populationOf(o),
    popularity: popularityOf(o),
    ...efficiencyOf(s),
    food: {
      ...(s ? { total: s.total_food, rationing: rations[s.rationing] ?? s.rationing, types_eaten: s.food_types_eaten, ...foodShareOf(s) } : {}),
      granary: pick(inventoryGroups.granary),
    },
    stockpile: pick(inventoryGroups.stockpile),
    ...(storageOf(o) ? { storage: storageOf(o) } : {}),
    troops: o.own_troops?.total,
    structures_map_wide: o.structures?.count,
    placement_mode: placementOf(o),
    ...(o.selected_building ? { selected_building: describeBuilding(o.selected_building) } : {}),
    camera: cameraOf(o),
    ...(extra.views ? { saved_views: extra.views } : {}),
    visible_messages: o.visible_messages,
    notes: "Popularity values are the game's points; the factors are per month and add up to upcoming_change. Structure count includes every player's structures.",
  };
}

/** The open building panel as reported by the reader. */
export function describeBuilding(sel: NonNullable<Observation["selected_building"]>) {
  const staffed = sel.have_stats !== 0;
  return {
    id: sel.id,
    type: sel.type,
    name: buildingTypeNames[sel.type] ?? null,
    ...(staffed
      ? {
          workers: { have: sel.workers_have, needed: sel.workers_needed, vacancies: sel.job_vacancies },
          working: sel.working !== 0,
          keep_access: sel.keep_access !== 0,
          missing_inputs: sel.no_resources !== 0,
        }
      : {}),
    turned_off: sel.turned_off !== 0,
    ...(sel.max_hp > 0 ? { hp: sel.hp, max_hp: sel.max_hp } : {}),
  };
}
