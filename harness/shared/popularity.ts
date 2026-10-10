/** Reader popularity factors are 25 per point the game shows (the keep's "No taxes +1" read 25, live 2026-09-28). */
export const FACTOR_UNITS_PER_POINT = 25;

/**
 * Parts of the game's food line that the reader also gives on their own: the food factor is the
 * rations and food-variety factors added up (seen in every reading of 2026-10-10: rations none,
 * half, extra and double, and two to three foods eaten).
 */
const foodParts = new Set(["rationing", "food_variety"]);

const points = (units: number) => Math.round((units / FACTOR_UNITS_PER_POINT) * 100) / 100;

type Settlement = { popularity_factors: Record<string, number>; church_bonus?: number | null };

/**
 * The monthly popularity factors as the game's Popularity report lists them, in points, zeros left
 * out: food once (its parts are in `foodPopularity`), and religion with the church and cathedral
 * bonus, which the reader gives apart from the blessing and in the same units (75 for a church and
 * a cathedral, which the game showed as +3; live 2026-10-10). They add up to the game's coming change.
 */
export function popularityFactors(s: Settlement) {
  const factors: Record<string, number> = {};
  for (const [name, units] of Object.entries(s.popularity_factors))
    if (!foodParts.has(name)) factors[name] = points(units);
  if (s.church_bonus) factors.religion = (factors.religion ?? 0) + points(s.church_bonus);
  return Object.fromEntries(Object.entries(factors).filter(([, value]) => value !== 0));
}

/** What the rations and the number of foods eaten each add to the food factor, in points. */
export function foodPopularity(s: Settlement) {
  return { rations: points(s.popularity_factors.rationing ?? 0), variety: points(s.popularity_factors.food_variety ?? 0) };
}
