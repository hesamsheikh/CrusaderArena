import { test } from "node:test";
import assert from "node:assert/strict";
import { alreadyBuilt, namedBuildings, typesOf } from "./building-types.js";

test("a placed building's records are found by engine type", () => {
  assert.deepEqual(typesOf("Marketplace"), [26]);
  assert.deepEqual(typesOf("Stockpile"), [10]);
  assert.deepEqual(typesOf("Hovel"), [1]);
  assert.deepEqual(typesOf("No Such Building"), []);
  assert.deepEqual(namedBuildings({ "10": 8, "26": 1 }), { Stockpile: 2, Marketplace: 1 });
});

test("a second Marketplace is refused only when the reader counts one", () => {
  assert.equal(alreadyBuilt("Marketplace", { buildings: { "26": 1 } }), true);
  assert.equal(alreadyBuilt("Marketplace", { buildings: { "1": 3 } }), false);
  assert.equal(alreadyBuilt("Marketplace", { buildings: undefined }), false, "unknown counts leave the click to the game");
  assert.equal(alreadyBuilt("Hovel", { buildings: { "1": 3 } }), false, "only one-only buildings");
});
