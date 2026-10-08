import type { Stats } from "../shared/protocol.js";
import { buildingTypeNames } from "./anchors.js";
import { inventoryGroups } from "./inventory.js";

const months = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];
// Granary ration levels in the game's order; 2 = "Full rations" was checked against the panel.
const rations = ["none", "half", "full", "extra", "double"];
/** Reader popularity factors are 25 per UI point (the keep's "No taxes +1" read 25, live 2026-09-28). */
const points = (value?: number) => (typeof value === "number" ? Math.round((value / 25) * 100) / 100 : undefined);

type Observation = NonNullable<Stats["observation"]>;
type Settlement = NonNullable<Observation["settlement"]>;

const dateOf = (s: Settlement) => `${months[s.month] ?? `month ${s.month}`} ${s.year}`;
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
          factors: Object.fromEntries(
            Object.entries(s.popularity_factors).filter(([, v]) => v !== 0).map(([k, v]) => [k, points(v)]),
          ),
        }
      : {}),
  };
};
const placementOf = (o: Observation) =>
  o.placement?.action === 5 ? "placing" : o.placement?.action === 6 ? "demolishing" : "none";
const cameraOf = (o: Observation) =>
  o.camera
    ? { centre_tile: [o.camera.centre_tile_x, o.camera.centre_tile_y], zoom: o.camera.pixels_per_unit_scale }
    : null;

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
    ...(typeof o.tax_index === "number" ? { tax_level: o.tax_index } : {}),
    ...(s
      ? {
          food: {
            total: s.total_food,
            rationing: rations[s.rationing] ?? s.rationing,
            types_eaten: s.food_types_eaten,
            types_available: s.food_types_available,
          },
        }
      : {}),
    goods: o.resources_by_name ?? null,
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
    food: {
      ...(s ? { total: s.total_food, rationing: rations[s.rationing] ?? s.rationing, types_eaten: s.food_types_eaten } : {}),
      granary: pick(inventoryGroups.granary),
    },
    stockpile: pick(inventoryGroups.stockpile),
    troops: o.own_troops?.total,
    structures_map_wide: o.structures?.count,
    placement_mode: placementOf(o),
    ...(o.selected_building ? { selected_building: describeBuilding(o.selected_building) } : {}),
    camera: cameraOf(o),
    ...(extra.views ? { saved_views: extra.views } : {}),
    visible_messages: o.visible_messages,
    notes: "Popularity values are UI points. Structure count includes every player's structures.",
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
