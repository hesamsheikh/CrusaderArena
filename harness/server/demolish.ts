/**
 * Demolishing one of the player's buildings with the game's own demolish tool: the X on the red
 * strip beside the construction tray (key, i, X, undo arrow, top to bottom; 1920 x 1080 layout,
 * read from a run's screenshot 2026-10-11). The reader reports the demolish mode as placement
 * action 6 and every structure on the map in its count, which falls when a building goes.
 */
export const DEMOLISH_BUTTON = { x: 1537, y: 1016 };
/** The reader's placement action while the demolish tool is selected (status.ts). */
export const DEMOLISHING = 6;

export type DemolishOutcome = "demolished" | "not_demolished";

/** What the map-wide structure count before and after the click says happened. */
export function demolishOutcome(before: number | undefined, after: number | undefined): DemolishOutcome | "unverified" {
  if (before === undefined || after === undefined) return "unverified";
  return after < before ? "demolished" : "not_demolished";
}
