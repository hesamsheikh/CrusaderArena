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
  // 2026-10-10, speed 40, 2,000 game seconds: 1,000 gold, 45 wood and 25 stone; the bread was eaten.
  "Oasis by the Sea benchmark start": { 33.3333333: 1220 },
  // 2026-10-10, speed 40, 2,000 game seconds: 5,000 gold and 192 wood.
  "Large Barren Desert benchmark start": { 33.3333333: 5192 },
};

export function idleBaseline(save: unknown, gameMinutes: unknown): number | undefined {
  return typeof save === "string" && typeof gameMinutes === "number"
    ? idleBaselines[save]?.[gameMinutes]
    : undefined;
}

/** A reference game's scorecard, read when its game-time budget ran out. */
export type ReferenceGame = {
  /** Game seconds played, as the player timed them (25 real minutes at speed 40 is 2,000). */
  gameSeconds: number;
  netWorth: number;
  gold: number;
  /** Stored goods at the marketplace sell price. */
  goodsValue: number;
  population: number;
  housing: number;
  popularity: number;
};

/**
 * Reference games played by a person (docs/benchmark.md#reference-games), by map: 25 real
 * minutes at the benchmark's game speed, timed by the player. The interview after an episode
 * (interview.ts) shows the agent its result beside the one for its map, then how the person
 * played, from prompt/reference-games/<map>.md.
 */
export const referenceGames: Record<string, ReferenceGame> = {
  // 2026-10-10: tick 343 to 60,273.
  "Oasis by the Sea": { gameSeconds: 1998, netWorth: 19513, gold: 18304, goodsValue: 1209, population: 202, housing: 202, popularity: 100 },
  // 2026-10-10: tick 17 to 60,402.
  "Large Barren Desert": { gameSeconds: 2013, netWorth: 9984, gold: 8574, goodsValue: 1410, population: 250, housing: 250, popularity: 100 },
};

export function referenceGame(map: unknown): ReferenceGame | undefined {
  return typeof map === "string" && Object.hasOwn(referenceGames, map) ? referenceGames[map] : undefined;
}
