/**
 * What doing nothing scores: net worth after `npm run episodes -- --idle`, by save and game
 * minutes at the fixed game speed. Growth is measured from it, so it shows what a run did beyond
 * leaving the game alone. The budget matters: the game places the granary by itself after some
 * game minutes, which stores the bread and starts the calendar. A run whose save and budget have
 * no measurement has no growth.
 */
export const idleBaselines: Record<string, Record<number, number>> = {
  // 2026-10-08, speed 40: the game placed the granary (5 wood) and 21 of the 50 bread were left.
  "Oasis by the Sea-1": { 25: 1304 },
};

export function idleBaseline(save: unknown, gameMinutes: unknown): number | undefined {
  return typeof save === "string" && typeof gameMinutes === "number"
    ? idleBaselines[save]?.[gameMinutes]
    : undefined;
}
