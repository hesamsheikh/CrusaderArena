import { costOf } from "./building-info.js";

/**
 * What a failed or partial tool result tells the model to do about it: the tool call that
 * addresses the failure, never a strategy. Each result that did not fully succeed carries one as
 * `remedy` (docs/tools.md, "Failures").
 */

/** The goods a building's cost can lack (building-info.ts shortfall) and the names tools use for them. */
const goodNames: Record<string, string> = { wood: "wood_planks", stone: "stone", gold: "gold" };

/** For `building`'s cost the stock cannot pay (`missing`, as shortfall reports it). */
export function missingRemedy(building: string, missing: Record<string, number>) {
  const goods = Object.keys(missing);
  const cost = costOf(building);
  const wait = goods
    .map((good) => `{amount: "${goodNames[good] ?? good}", at_least: ${cost?.[good as keyof typeof cost] ?? missing[good]}}`)
    .join(" or ");
  const buyable = goods.filter((good) => good !== "gold").map((good) => goodNames[good] ?? good);
  return [
    `Not enough ${goods.join(" and ")}: wait_and_observe with until ${wait} lets it come in`,
    buyable.length ? `, or market_trade buys ${buyable.join(" and ")} (it needs a Marketplace)` : "",
    goods.includes("gold") ? "; gold comes from taxes (set_tax) and from selling goods (market_trade)" : "",
    ". Then place it again.",
  ].join("");
}

/** For a placement the game refused with `feedback` text. */
export function feedbackRemedy(building: string, feedback: readonly string[]) {
  const text = feedback.join(" ");
  if (/adjacent to the stockpile/i.test(text))
    return "A stockpile must touch an existing one: expand_storage (kind stockpile) places it flush.";
  if (/adjacent to the granary/i.test(text))
    return "A granary must touch an existing one: expand_storage (kind granary) places it flush.";
  if (/adjacent to the armou?ry/i.test(text))
    return "An armory must touch an existing one: expand_storage (kind armory) places it flush.";
  if (/must be built on/i.test(text))
    return `find_sites (building "${building}") lists spots on its ground in this view; map_overview shows the deposits and go_to_tile moves there.`;
  if (/oasis|fertile/i.test(text))
    return `find_sites (building "${building}") lists spots on oasis grass in this view; map_overview shows the farmland and go_to_tile moves there.`;
  if (/too close/i.test(text))
    return `Choose a spot further from what it names: find_sites (building "${building}") lists spots that fit.`;
  if (/needed|not enough|need more/i.test(text))
    return "Get what the message names first (wait_and_observe with until, or market_trade), then place it again.";
  return `Do what the game's message asks, or choose another spot (find_sites lists spots where "${building}" fits); placing the same target again is refused again.`;
}

/** For a one-only building the player already has (building-types.ts alreadyBuilt). */
export function alreadyBuiltRemedy(building: string) {
  return building === "Marketplace"
    ? "You already have a Marketplace, and the game allows one: market_trade uses it, and center_on (target market) shows it."
    : `You already have a ${building}, and the game allows one.`;
}

/** For one build_structure placement result; undefined when it needs nothing. */
export function placementRemedy(result: Record<string, unknown>) {
  const building = String(result.building);
  const status = result.status;
  if (status === "placed") return undefined;
  if (result.retryStopped === "camera_moved")
    return "The view moved during retries: observe, then target again by pixel from the new screenshot, or by tile_x/tile_y.";
  if (result.retryStopped === "image_too_old")
    return "The screenshot got too old for more retries: target it by tile_x/tile_y (no screenshot needed), or observe and target again.";
  if (result.retryStopped === "placement_mode_ended")
    return "Placement mode ended before the retries finished: place it again.";
  switch (status) {
    case "not_on_screen": {
      if (typeof result.tile_x !== "number") return "The reader had no camera: observe, then place it again.";
      // The harness already moved the camera and failed, so go_to_tile would fail the same way.
      const storage = building === "Stockpile" ? "stockpile" : building === "Granary" ? "granary" : undefined;
      if (/ended placement mode/.test(String(result.reason ?? "")) && storage)
        return `expand_storage (kind ${storage}) places it flush against the existing ones.`;
      return /could not bring/.test(String(result.reason ?? ""))
        ? "The camera cannot centre near that tile (map edge?): choose a tile a little further in, such as one find_sites lists."
        : "Place it again by tile; the camera is moved there.";
    }
    case "not_selected":
      return "The construction menu did not select it: right-click open ground with game_action to close any open panel, observe, then place it again.";
    case "camera_moved":
      return "Observe, then target it by pixel from the new screenshot, or by tile_x/tile_y.";
    case "already_built":
      return alreadyBuiltRemedy(building);
    case "invalid_target":
      return "Give a pixel inside the latest screenshot and above the bottom HUD, or a tile as tile_x/tile_y (one pair, not both).";
    case "rejected":
    case "possibly_rejected":
      return feedbackRemedy(building, (result.feedback as string[] | undefined) ?? []);
    case "unverified":
      return "Check the next observation or status before placing it again.";
    case "not_placed": {
      const missing = result.missing as Record<string, number> | undefined;
      if (missing) return missingRemedy(building, missing);
      if (result.retrySkipped === "no_reader_camera") return "The reader had no camera for nearby retries: observe, then place it again.";
      return `Nothing fits at or near that spot: find_sites (building "${building}") lists spots where it fits in this view, or go_to_tile moves to open ground (map_overview).`;
    }
    default:
      return undefined;
  }
}

/** Buildings whose hotkey center_on uses, by the build_structure name that makes one. */
const anchorBuildings: Record<string, string> = {
  granary: "Granary", market: "Marketplace", stockpile: "Stockpile",
};

/** For center_on, place_near and expand_storage when their anchor building is not found. */
export function anchorRemedy(anchor: string) {
  const name = anchorBuildings[anchor];
  if (anchor === "stockpile")
    return "Find the stockpile in a screenshot or on map_overview and go_to_tile there; if there is none, build_structure places a Stockpile.";
  return name
    ? `There is no ${anchor}: build_structure places a ${name}; then try again.`
    : `There is no ${anchor} to centre on.`;
}

/** For a result whose reader or camera reading was unavailable: transient, so look and retry. */
export const READER_RETRY = "The game reader had no reading just then: observe, then try again.";

/** For place_near and expand_storage, by why they stopped short of the count asked. */
export function adjacentRemedy(result: { stopped?: string; missing?: Record<string, number>; anchor?: string }, building: string) {
  if (result.missing) return missingRemedy(building, result.missing);
  switch (result.stopped) {
    case "already_built":
      return alreadyBuiltRemedy(building);
    case "camera_moved":
      return "The view moved while placing: call it again.";
    case "view_jumps":
      return `Choosing a ${building} centres the view on your first one, and a new one must touch the existing ones: expand_storage (kind ${building.toLowerCase()}) places it.`;
    case "no_free_spot_in_view":
    case "no_more_free_spots":
    case "probe_limit":
    case "attempt_limit":
      // Storage must touch its own kind, so another anchor is no way out.
      if (building === "Stockpile" || building === "Granary" || building === "Armory") {
        const held = building === "Stockpile" ? "goods" : building === "Granary" ? "food" : "weapons and armour";
        return `No room around your ${building.toLowerCase()}: no free ground touches it on any side. Make room either by selling some of the ${held} it holds (market_trade) or by demolishing buildings beside it (demolish_building), then expand it.`;
      }
      return `No more room flush against the ${result.anchor ?? "anchor"} here: another side (side), another anchor, or find_sites (building "${building}") for free spots elsewhere.`;
    default:
      return `Nothing more could be placed there: find_sites (building "${building}") lists free spots in this view.`;
  }
}
