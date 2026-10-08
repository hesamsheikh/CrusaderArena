import type { Frame, GameAction } from "../shared/protocol.js";
import { atlasPages } from "./visual-atlas.js";
import { buildingInfo } from "./building-info.js";

// The tested atlas is a 1920 × 1080 game-window capture. These categories use
// one building-button click followed by one world click; subpages and walls need
// separate interaction rules.
const singleClickPages = ["industry", "farm", "town", "weapons", "food-processing"] as const;
const categoryNames: Record<(typeof singleClickPages)[number], string> = {
  industry: "Industry Buildings",
  farm: "Farm Buildings",
  town: "Town Buildings",
  weapons: "Weapons Buildings",
  "food-processing": "Food Processing Buildings",
};
const nonBuildings = new Set(["Fear-factor page", "Good-factor page"]);
const overview = atlasPages.find((page) => page.id === "construction-overview")!;
export const buildableNames = singleClickPages.flatMap((id) =>
  atlasPages.find((page) => page.id === id)!.labels
    .filter((label) => !nonBuildings.has(label.name))
    .map((label) => label.name),
);

function checkedScale(frame: Pick<Frame, "width" | "height">) {
  const ratio = frame.width / frame.height;
  if (Math.abs(ratio - 16 / 9) > 0.02)
    throw new Error("UI positions are calibrated only for a 16:9 game window. Use game_action on this layout.");
  return { x: frame.width / 1920, y: frame.height / 1080 };
}

export function constructionClicks(frame: Frame, name: string, target: { x: number; y: number }): GameAction[] {
  if (!Number.isInteger(target.x) || !Number.isInteger(target.y) ||
      target.x < 0 || target.y < 0 || target.x >= frame.width || target.y >= frame.height)
    throw new Error("Placement target must be inside the current game image.");
  // Keep scripted placement out of the construction tray and bottom reports.
  if (target.y >= frame.height * 0.82)
    throw new Error("Placement target overlaps the bottom HUD; choose visible world terrain.");
  return [...menuClicks(frame, name), { type: "click", ...target, button: 1 }];
}

/** Category-tab click, then the named building's tray button. */
export function menuClicks(frame: Pick<Frame, "width" | "height">, name: string): [GameAction, GameAction] {
  const scale = checkedScale(frame);
  const page = singleClickPages.map((id) => atlasPages.find((entry) => entry.id === id)!)
    .find((entry) => entry.labels.some((label) => label.name === name));
  const button = page?.labels.find((label) => label.name === name);
  const category = overview.labels.find((label) => label.name === categoryNames[page?.id as keyof typeof categoryNames]);
  if (!button || !category) throw new Error(`Unsupported click-to-place building: ${name}`);
  const center = (box: readonly [number, number, number, number]): GameAction => ({
    type: "click",
    x: Math.round((box[0] + box[2] / 2) * scale.x),
    y: Math.round((box[1] + box[3] / 2) * scale.y),
    button: 1,
  });
  return [center(category.box), center(button.box)];
}

/** Fractional position inside the minimap's tested inner area. */
export function minimapClick(frame: Frame, x: number, y: number): GameAction {
  const scale = checkedScale(frame);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1)
    throw new Error("Minimap position must use fractions from 0 to 1.");
  return {
    type: "click",
    x: Math.round((1605 + 165 * x) * scale.x),
    y: Math.round((892 + 164 * y) * scale.y),
    button: 1,
  };
}

/**
 * Placement refusals arrive on Panel_Feedback ("Too close to signpost to build."), and a
 * missing resource on Feedback_1 ("  Wood needed  ", run 10: 20 of them went unreported),
 * which also carries general warnings such as "Food is low".
 */
const isFeedback = (channel: unknown, text: string) =>
  channel === "Panel_Feedback" || (typeof channel === "string" && /^Feedback_\d+$/.test(channel) && /\bneeded\b/i.test(text));

export function placementFeedback(events: { events: Record<string, unknown>[] }) {
  return events.events
    .filter((event) => event.kind === "visible_message_observed" && typeof event.text === "string" && isFeedback(event.channel, event.text))
    .map((event) => (event.text as string).trim());
}

/** Placement feedback text in the current reader sample, whether or not it is new. */
export function visiblePlacementFeedback(observation: Record<string, unknown> | null | undefined) {
  const messages = observation?.visible_messages;
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => typeof m?.text === "string" && isFeedback(m.channel, m.text))
    .map((m) => (m.text as string).trim());
}

export const isPlacementRejection = (text: string) =>
  /cannot|can't|must|need|not enough|requires|no room|too close|too far|blocked|unavailable|only .* on/i.test(text);

export type PlacementStatus = "rejected" | "possibly_rejected" | "feedback" | "unverified";

/**
 * New feedback events are attributed to the placement that preceded them. A
 * rejection text that stays visible without a new event may belong to an
 * earlier placement, so it is reported as possibly rejected, never as success.
 * The same holds for a "fresh" event whose text was already visible before the
 * placement (`carried`): hovering the menu hides panel feedback, so the old
 * message reappears as a new event. A repeated identical rejection is
 * indistinguishable from it and is also reported as possibly rejected.
 */
export function placementStatus(fresh: string[], visible: string[], carried: string[] = []): PlacementStatus {
  const isNew = (text: string) => !carried.includes(text.trim());
  if (fresh.some((text) => isNew(text) && isPlacementRejection(text))) return "rejected";
  if (fresh.some(isPlacementRejection)) return "possibly_rejected";
  if (fresh.length) return "feedback";
  if (visible.some(isPlacementRejection)) return "possibly_rejected";
  return "unverified";
}

type Observation = Record<string, unknown> | null | undefined;
type Placement = { action: number; sub_action: number };
export type Snapshot = { wood?: number; gold?: number; structures?: number };

/** Manual default cost; null when unknown or ambiguous. Current game tooltips may differ. */
export function buildingCost(name: string): { wood: number; gold: number } | null {
  const info = buildingInfo(name) as { found?: boolean; buildCost?: string };
  const text = info.found ? info.buildCost?.trim() : undefined;
  if (!text || text.includes("/")) return null;
  if (text === "Free") return { wood: 0, gold: 0 };
  const cost = { wood: 0, gold: 0 };
  const parts = [...text.matchAll(/([\d,]+)\s*([WG])\b/g)];
  if (!parts.length) return null;
  for (const [, amount, unit] of parts) cost[unit === "W" ? "wood" : "gold"] += Number(amount.replaceAll(",", ""));
  return cost;
}

export function placementOf(observation: Observation): Placement | null {
  const p = observation?.placement as Placement | null | undefined;
  return p && Number.isInteger(p.action) && Number.isInteger(p.sub_action) ? p : null;
}

/**
 * The building button took effect: placement mode (5) with a different item,
 * or entered from another mode, or the same building already selected.
 */
export function selectionConfirmed(before: Placement, now: Placement, alreadySelected: boolean) {
  return now.action === 5 && (before.action !== 5 || now.sub_action !== before.sub_action || alreadySelected);
}

/** Camera tuple identity; null when the reader has no camera. */
export function cameraKey(observation: Observation) {
  const c = observation?.camera as Record<string, number> | null | undefined;
  return c ? [c.centre_tile_x, c.centre_tile_y, c.tiles_wide, c.tiles_high, c.pixels_per_unit_scale].join(",") : null;
}

/** Visible map span in tiles; null when the reader has no valid camera. */
export function cameraSpanOf(observation: Observation) {
  const c = observation?.camera as Record<string, number> | null | undefined;
  return c && c.tiles_wide > 0 && c.tiles_high > 0 ? { tiles_wide: c.tiles_wide, tiles_high: c.tiles_high } : null;
}

type Point = { x: number; y: number };

type Sized = Point & { size?: number };

/**
 * World-tile offsets tried around a silently blocked target of footprint `size`,
 * nearest first: half a footprint along each diamond axis (clears an obstacle
 * under one edge), then a whole footprint (the building moves fully off the
 * blocked spot). Opposite directions alternate so a blocker on any side is
 * cleared early.
 */
export function retryOffsets(size: number): [number, number][] {
  const half = Math.max(1, Math.ceil(size / 2));
  const steps = size > half ? [half, size] : [half];
  return steps.flatMap((d) => [[d, 0], [-d, 0], [0, d], [0, -d]] as [number, number][]);
}

/**
 * Screen targets near `target` for a placement retry. Tiles are isometric
 * diamonds tiles_wide across and tiles_high rows down the game window, so one
 * step along a world axis moves half a tile width and one row. Candidates must
 * stay on visible world terrain and must not overlap anything in `avoid` (other
 * targets in the batch and buildings just placed, each with its footprint), so a
 * retry neither takes a spot the agent planned nor probes on top of a new building.
 */
export function nearbyTargets(
  frame: Pick<Frame, "width" | "height">,
  target: Point,
  span: { tiles_wide: number; tiles_high: number },
  avoid: Sized[] = [],
  limit = Infinity,
  size = 3,
) {
  const half = frame.width / span.tiles_wide / 2;
  const row = frame.height / span.tiles_high;
  // Inverse of the screen mapping below, in tiles along each world axis.
  const tilesApart = (a: Point, b: Point) => {
    const u = (b.x - a.x) / half, v = (b.y - a.y) / row;
    return Math.max(Math.abs((u + v) / 2), Math.abs((v - u) / 2));
  };
  const result: { x: number; y: number; offsetTiles: [number, number] }[] = [];
  for (const [a, b] of retryOffsets(size)) {
    if (result.length >= limit) break;
    const x = Math.round(target.x + (a - b) * half);
    const y = Math.round(target.y + (a + b) * row);
    if (x < 0 || y < 0 || x >= frame.width || y >= frame.height * 0.82) continue;
    // Two square footprints overlap when their centres are closer than half their summed sides
    // along either world axis; a quarter tile absorbs pixel rounding.
    if (avoid.some((p) => tilesApart(p, { x, y }) < (size + (p.size ?? size)) / 2 - 0.25)) continue;
    result.push({ x, y, offsetTiles: [a, b] });
  }
  return result;
}

export function snapshotOf(observation: Observation): Snapshot | null {
  if (!observation) return null;
  const resources = observation.resources_by_name as Record<string, number> | undefined;
  const structures = observation.structures as { count?: number } | undefined;
  return { wood: resources?.wood_planks, gold: observation.gold as number | undefined, structures: structures?.count };
}

const delta = (before?: number, after?: number) =>
  typeof before === "number" && typeof after === "number" ? after - before : undefined;

/**
 * Refine a feedback status with reader evidence from just before and after the
 * terrain click. The manual cost (±2) is the strong signal. The structure count
 * also confirms, but it is map-wide, so other players can move it; `evidence`
 * says which one was used. No cost, no new structure and no message means
 * nothing was placed. Starting-goods deliveries can mask the cost; the count
 * still works then.
 */
export function confirmPlacement(
  status: PlacementStatus,
  cost: { wood: number; gold: number } | null,
  before: Snapshot | null,
  after: Snapshot | null,
): {
  status: PlacementStatus | "placed" | "not_placed";
  evidence?: "cost" | "structure_count";
  change?: Record<string, number | undefined>;
} {
  if (!before || !after) return { status };
  const change = {
    wood: delta(before.wood, after.wood),
    gold: delta(before.gold, after.gold),
    structures: delta(before.structures, after.structures),
  };
  if (status === "rejected" || status === "feedback") return { status, change };
  const paid = (amount: number, d?: number) => amount === 0 || (d !== undefined && Math.abs(-d - amount) <= 2);
  if (cost && cost.wood + cost.gold > 0 && paid(cost.wood, change.wood) && paid(cost.gold, change.gold))
    return { status: "placed", evidence: "cost", change };
  const added = (change.structures ?? 0) >= 1;
  if (added) return { status: "placed", evidence: "structure_count", change };
  const spent = (change.wood ?? 0) < 0 || (change.gold ?? 0) < 0;
  if (status === "unverified" && change.structures !== undefined && !spent)
    return { status: "not_placed", change };
  return { status, change };
}
