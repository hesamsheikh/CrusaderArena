import type { Stats } from "../shared/protocol.js";

// The reader's named slots were checked against nonzero in-game inventory.
// Storage groups follow the game's documented stockpile, granary and armory.
export const inventoryGroups = {
  stockpile: ["wood_planks", "stone", "iron", "pitch", "wheat", "flour", "hops", "ale"],
  granary: ["bread", "cheese", "meat", "apples"],
  armory: ["bows", "crossbows", "spears", "pikes", "maces", "swords", "leather_armour", "metal_armour"],
} as const;
export type InventorySection = keyof typeof inventoryGroups | "all";
const allNames = Object.values(inventoryGroups).flat();

type Sample = {
  session: string;
  generation: number;
  map: string;
  player: number;
  gameTime: number;
  capturedAtUnixMs: number;
  amounts: Record<string, number>;
};

export class InventoryTracker {
  private previous?: Sample;

  read(stats: Stats, section: InventorySection = "all", now = Date.now()) {
    const observation = stats.observation;
    const named = observation?.resources_by_name;
    const capturedAt = stats.captured_unix_ms;
    const validUntil = stats.valid_until_unix_ms;
    const valid = stats.status === "ok" && observation && named &&
      typeof capturedAt === "number" && typeof validUntil === "number" &&
      capturedAt <= now && now < validUntil && now - capturedAt <= 1500 &&
      typeof stats.session === "string" && Number.isInteger(stats.generation) &&
      typeof observation.map_name === "string" &&
      Number.isInteger(observation.local_player_id) &&
      Number.isInteger(observation.game_time) &&
      allNames.every((name) => Number.isInteger(named[name]) && named[name] >= 0);
    if (!valid) {
      this.previous = undefined;
      return {
        status: "unavailable" as const,
        section,
        readerStatus: stats.status,
        reason: "No complete fresh named-inventory sample. Recheck after the reader resumes; missing amounts are not zero.",
      };
    }

    const sample: Sample = {
      session: stats.session!,
      generation: stats.generation!,
      map: observation.map_name,
      player: observation.local_player_id!,
      gameTime: observation.game_time!,
      capturedAtUnixMs: capturedAt,
      amounts: Object.fromEntries(allNames.map((name) => [name, named[name]])),
    };
    const previous = this.previous;
    const comparable = previous && previous.session === sample.session &&
      previous.generation === sample.generation && previous.map === sample.map &&
      previous.player === sample.player && sample.gameTime >= previous.gameTime &&
      sample.capturedAtUnixMs > previous.capturedAtUnixMs;
    this.previous = sample;

    const names = section === "all" ? allNames : inventoryGroups[section];
    const amounts = Object.fromEntries(names.map((name) => [name, sample.amounts[name]]));
    return {
      status: "ok" as const,
      source: "read_only_game_reader" as const,
      section,
      map: sample.map,
      localPlayerId: sample.player,
      gameTime: sample.gameTime,
      capturedAtUnixMs: sample.capturedAtUnixMs,
      ageMs: now - sample.capturedAtUnixMs,
      validUntilUnixMs: validUntil,
      session: sample.session,
      generation: sample.generation,
      gold: observation.gold,
      amounts,
      ...(comparable ? {
        changeSincePrevious: {
          previousCapturedAtUnixMs: previous.capturedAtUnixMs,
          elapsedGameTime: sample.gameTime - previous.gameTime,
          amounts: Object.fromEntries(names.map((name) =>
            [name, sample.amounts[name] - previous.amounts[name]])),
        },
      } : {}),
      note: "These are inventory totals, not production rates. Starting goods, trading, construction and consumption can change them.",
    };
  }
}
