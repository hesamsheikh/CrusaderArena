import test from "node:test";
import assert from "node:assert/strict";
import { adjacentRemedy, anchorRemedy, feedbackRemedy, missingRemedy, placementRemedy } from "./remedies.js";
import { costOf } from "./building-info.js";

test("a cost the stock cannot pay names the wait that covers it, and what can be bought", () => {
  const wood = costOf("Hovel")!.wood;
  const remedy = missingRemedy("Hovel", { wood: 3 });
  assert.match(remedy, new RegExp(`wait_and_observe with until \\{amount: "wood_planks", at_least: ${wood}\\}`));
  assert.match(remedy, /market_trade buys wood_planks \(it needs a Marketplace\)/);
  const gold = missingRemedy("Marketplace", { gold: 50 });
  assert.match(gold, /amount: "gold"/);
  assert.doesNotMatch(gold, /market_trade buys/);
  assert.match(gold, /gold comes from taxes \(set_tax\) and from selling goods/);
});

test("the game's refusals map to the tool that addresses them", () => {
  assert.match(feedbackRemedy("Iron Mine", ["Iron mine must be built on Iron ore."]), /find_sites \(building "Iron Mine"\).*map_overview shows the deposits/);
  assert.match(feedbackRemedy("Stockpile", ["Needs to be placed adjacent to the stockpile."]), /expand_storage \(kind stockpile\)/);
  assert.match(feedbackRemedy("Wheat Farm", ["Must be placed on an oasis."]), /oasis grass/);
  assert.match(feedbackRemedy("Hovel", ["Too close to signpost to build."]), /further from what it names/);
  assert.match(feedbackRemedy("Hovel", ["Something new."]), /Do what the game's message asks, or choose another spot/);
});

test("every failed placement status has a remedy, and a placed one has none", () => {
  for (const status of ["not_on_screen", "not_selected", "camera_moved", "invalid_target", "rejected", "possibly_rejected", "unverified", "not_placed", "already_built"])
    assert.ok(placementRemedy({ building: "Hovel", status, feedback: [] }), status);
  assert.equal(placementRemedy({ building: "Hovel", status: "placed" }), undefined);
  // build_structure already moved the camera, so go_to_tile would fail the same way.
  assert.match(placementRemedy({ building: "Hovel", status: "not_on_screen", tile_x: 5, tile_y: 7, reason: "The camera could not bring the tile into view." })!, /further in/);
  assert.match(placementRemedy({ building: "Granary", status: "not_on_screen", tile_x: 5, tile_y: 7, reason: "Choosing the building moved the view, and moving back ended placement mode." })!, /expand_storage \(kind granary\)/);
  assert.match(placementRemedy({ building: "Hovel", status: "not_placed", missing: { wood: 2 } })!, /wait_and_observe/);
  assert.match(placementRemedy({ building: "Hovel", status: "not_placed", retries: 3 })!, /find_sites \(building "Hovel"\)/);
  assert.match(placementRemedy({ building: "Hovel", status: "not_placed", retryStopped: "image_too_old" })!, /tile_x\/tile_y/);
  assert.equal(placementRemedy({ building: "Hovel", status: "placed", retryStopped: "image_too_old" }), undefined);
});

test("a missing anchor names the building that makes one", () => {
  assert.match(anchorRemedy("market"), /build_structure places a Marketplace/);
  assert.match(anchorRemedy("granary"), /build_structure places a Granary/);
  assert.match(anchorRemedy("stockpile"), /go_to_tile/);
  assert.match(adjacentRemedy({ stopped: "no_free_spot_in_view", anchor: "keep" }, "Hovel"), /flush against the keep/);
  assert.match(placementRemedy({ building: "Marketplace", status: "already_built" })!, /market_trade uses it/);
  assert.match(adjacentRemedy({ stopped: "already_built", anchor: "stockpile" }, "Marketplace"), /allows one/);
  assert.match(adjacentRemedy({ missing: { wood: 4 } }, "Hovel"), /wait_and_observe/);
});
