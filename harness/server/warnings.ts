import type { Stats } from "../shared/protocol.js";

type Observation = NonNullable<Stats["observation"]>;
type Kind = "popularity" | "food" | "gold";

/** Popularity points below the agent's last observation at which a warning ends its wait. */
export const POPULARITY_WARNING_DROP = 10;
/** Gold below which a warning ends the agent's wait. */
export const GOLD_WARNING = 500;
/** Game months of food, for the people at their rations, below which a warning ends the agent's wait. */
export const FOOD_WARNING_MONTHS = 2;
/**
 * Food one person eats in a game month (about 29 game seconds), by the reader's `rationing`: none,
 * half, full, extra, double. Measured 2026-10-14 in about 1,300 stretches of 30 game seconds of
 * recorded runs in which no food arrived (0.086 at half rations from 125 of them, 0.174 full from
 * 1,092, 0.26 extra from 67, 0.344 double from 24). Only the host uses them, to decide when food is
 * low; the agent is not told them.
 */
export const FOOD_PER_PERSON_MONTH = [0, 0.086, 0.174, 0.26, 0.344];
const RATIONS = ["none", "half", "full", "extra", "double"];

const foodLow = (o: Observation) => {
  const s = o.settlement;
  const eaten = s ? o.population * (FOOD_PER_PERSON_MONTH[s.rationing] ?? 0) : 0;
  return eaten > 0 && s!.total_food < eaten * FOOD_WARNING_MONTHS;
};
const goldLow = (o: Observation) => o.gold < GOLD_WARNING;

/**
 * Warnings that end the agent's waits early (Session.waitGame's `interrupt`) and lead its next
 * observation: popularity POPULARITY_WARNING_DROP points below its last observation, gold below
 * GOLD_WARNING, food below FOOD_WARNING_MONTHS of what the people eat at their rations. Each comes
 * up when its condition turns true after the agent's last observation, never for what that
 * observation showed already; the next observation reports it, and the watch starts again from
 * what that observation shows. Plain facts only: what fell, and to what.
 */
export class Warnings {
  /** What the agent's last observation showed: popularity and gold, and whether food and gold were low. */
  private seen?: { popularity: number; gold: number; food: boolean; goldLow: boolean };
  /** Warnings due, each with its text and the popularity or gold it came up with. */
  private due = new Map<Kind, { text: string; value: number }>();
  /** A warning's text in the values `o` shows, or null when `o` does not show its condition. */
  private describe(kind: Kind, o: Observation) {
    const seen = this.seen!;
    if (kind === "popularity")
      return o.popularity <= seen.popularity - POPULARITY_WARNING_DROP
        ? `Popularity fell from ${seen.popularity} to ${o.popularity} since your last observation.`
        : null;
    if (kind === "food") {
      if (!foodLow(o)) return null;
      const s = o.settlement!;
      return `Food is low: ${s.total_food} in the granaries for ${o.population} people on ${RATIONS[s.rationing] ?? s.rationing} rations.`;
    }
    return goldLow(o) ? `Gold is low: ${o.gold} left, down from ${seen.gold} at your last observation.` : null;
  }
  /** Note what `o` brings up since the last observation; true while a warning is due. */
  check(o: Observation | null | undefined) {
    if (o && this.seen)
      for (const kind of ["popularity", "food", "gold"] as const) {
        // Food or gold the last observation already showed low comes up only once one shows it recovered.
        if (this.due.has(kind) || (kind === "food" && this.seen.food) || (kind === "gold" && this.seen.goldLow)) continue;
        const text = this.describe(kind, o);
        if (text) this.due.set(kind, { text, value: kind === "gold" ? o.gold : o.popularity });
      }
    return this.due.size > 0;
  }
  /**
   * The warnings an observation showing `o` (null when the reader has no game values) reports:
   * those due and any `o` brings up, in the values `o` shows while it still shows them. A wait slows
   * down from its fast speed after a warning comes up, and the game plays on meanwhile: a popularity
   * warning worded when it came up said 81 beside stats showing 68 (live, 2026-10-14). A condition
   * `o` no longer shows is reported as it came up. That observation is the agent's last from now on.
   */
  observe(o: Observation | null | undefined): string[] {
    this.check(o);
    const texts = [...this.due].map(([kind, warning]) => (o && this.seen ? this.describe(kind, o) : null) ?? warning.text);
    if (o) this.seen = { popularity: o.popularity, gold: o.gold, food: foodLow(o), goldLow: goldLow(o) };
    else if (this.seen)
      // Without game values to start again from, what was reported counts as seen.
      this.seen = {
        popularity: this.due.get("popularity")?.value ?? this.seen.popularity,
        gold: this.due.get("gold")?.value ?? this.seen.gold,
        food: this.seen.food || this.due.has("food"),
        goldLow: this.seen.goldLow || this.due.has("gold"),
      };
    this.due.clear();
    return texts;
  }
}
