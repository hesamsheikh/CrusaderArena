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
  /** What the agent's last observation showed: popularity, and whether food and gold were low. */
  private seen?: { popularity: number; food: boolean; gold: boolean };
  private due = new Map<Kind, { text: string; popularity?: number }>();
  /** Note what `o` brings up since the last observation; true while a warning is due. */
  check(o: Observation | null | undefined) {
    if (o && this.seen) {
      if (!this.due.has("popularity") && o.popularity <= this.seen.popularity - POPULARITY_WARNING_DROP)
        this.due.set("popularity", {
          text: `Popularity fell from ${this.seen.popularity} to ${o.popularity} since your last observation.`,
          popularity: o.popularity,
        });
      if (!this.due.has("food") && !this.seen.food && foodLow(o)) {
        const s = o.settlement!;
        this.due.set("food", { text: `Food is low: ${s.total_food} in the granaries for ${o.population} people on ${RATIONS[s.rationing] ?? s.rationing} rations.` });
      }
      if (!this.due.has("gold") && !this.seen.gold && goldLow(o))
        this.due.set("gold", { text: `Gold fell below ${GOLD_WARNING}: ${o.gold}.` });
    }
    return this.due.size > 0;
  }
  /**
   * The warnings an observation showing `o` (null when the reader has no game values) reports:
   * those due and any `o` brings up. That observation is the agent's last from now on.
   */
  observe(o: Observation | null | undefined): string[] {
    this.check(o);
    const texts = [...this.due.values()].map((warning) => warning.text);
    if (o) this.seen = { popularity: o.popularity, food: foodLow(o), gold: goldLow(o) };
    else if (this.seen)
      // Without game values to start again from, what was reported counts as seen.
      this.seen = {
        popularity: this.due.get("popularity")?.popularity ?? this.seen.popularity,
        food: this.seen.food || this.due.has("food"),
        gold: this.seen.gold || this.due.has("gold"),
      };
    this.due.clear();
    return texts;
  }
}
