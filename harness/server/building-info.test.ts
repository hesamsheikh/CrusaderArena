import { test } from "node:test";
import assert from "node:assert/strict";
import { buildingInfo, listBuildings } from "./building-info.js";
import { buildableNames } from "./construction-ui.js";
import { GameEvents } from "./game-events.js";
import { makeAgent } from "./model.js";
import type { GameDevice } from "./device.js";
import { gameMechanics, gameMechanicsPrompt, mechanicsPrompt } from "./preparation.js";

test("all named build actions have a building description", () => {
  for (const name of buildableNames) {
    const info = buildingInfo(name);
    assert.equal(info.found, true, name);
    if (info.found) assert.ok(info.whatItDoes, name);
  }
});

test("building lookup returns cost, labor, function and placement cautions", () => {
  const orchard = buildingInfo("Apple Orchard");
  assert.equal(orchard.found, true);
  if (!orchard.found) return;
  assert.equal(orchard.name, "Apple Orchard");
  assert.equal(orchard.buildCost, "5 W");
  assert.equal(orchard.workers, "1");
  assert.match(orchard.whatItDoes, /apples.*granary.*grassland/i);
  assert.match(orchard.note, /current game tooltip/);
  assert.equal(buildingInfo("apple farm").found, true);
});

test("manual-only and military aliases retain their specific requirements", () => {
  const hunter = buildingInfo("Hunter's post");
  assert.equal(hunter.found, true);
  if (hunter.found) assert.match(hunter.whatItDoes, /deer.*meat.*granary/i);
  const fletcher = buildingInfo("Fletchers' Workshop");
  assert.equal(fletcher.found, true);
  if (fletcher.found) {
    assert.equal(fletcher.buildCost, "20 W + 100 G");
    assert.match(fletcher.whatItDoes, /bows.*crossbows/);
  }
  const tower = buildingInfo("Lookout Tower");
  assert.equal(tower.found, true);
  if (tower.found) {
    assert.equal(tower.buildCost, "10 S");
    assert.equal(tower.category, "Castle Towers");
    assert.match(tower.atlasDescription || "", /height advantage/i);
  }
});

test("unknown building returns suggestions without inventing mechanics", () => {
  const info = buildingInfo("Apple");
  assert.equal(info.found, false);
  if (!info.found) assert.ok(info.suggestions.some((row) => row.name === "Apple Orchard"));
  assert.ok(listBuildings("Farm Buildings").some((row) => row.name === "Wheat Farm"));
  assert.ok(listBuildings("farm").some((row) => row.name === "Wheat Farm"));
});

test("agent building reference tools are read-only and work without an observation", async () => {
  const device = {
    events: new GameEvents(),
    capture: async () => { throw new Error("Reference lookup must not capture the game"); },
    action: async () => { throw new Error("Reference lookup must not act in the game"); },
  } as unknown as GameDevice;
  const agent = makeAgent(device, () => {}, () => {}, 1, {
    id: "test", name: "test", modelId: "test", baseUrl: "https://example.invalid", keyConfigured: false,
  }, "");
  const info = await agent.state.tools.find((tool) => tool.name === "building_info")!
    .execute("building", { name: "Apple Orchard" });
  const text = info.content.find((part) => part.type === "text");
  assert.ok(text && text.type === "text");
  if (text?.type === "text") assert.equal(JSON.parse(text.text).buildCost, "5 W");
  const names = await agent.state.tools.find((tool) => tool.name === "list_buildings")!
    .execute("list", { category: "Farm Buildings" });
  const listed = names.content.find((part) => part.type === "text");
  assert.ok(listed && listed.type === "text");
  if (listed?.type === "text") assert.ok(JSON.parse(listed.text).some((row: any) => row.name === "Apple Orchard"));
});

test("startup guidance keeps mechanics while building tables move to lookup", () => {
  assert.ok(gameMechanicsPrompt.length < gameMechanics.length - 2500);
  assert.doesNotMatch(gameMechanicsPrompt, /\| Apple orchard \|/);
  assert.doesNotMatch(gameMechanicsPrompt, /\| Fletcher \|/);
  assert.doesNotMatch(gameMechanicsPrompt, /\| Stone walls and stairs \|/);
  assert.match(gameMechanicsPrompt, /### Production chains/);
  assert.match(gameMechanicsPrompt, /\| Archer \|/);
  assert.match(gameMechanicsPrompt, /building_info\(name\)/);
  // Economy-only benchmarks leave out troops and siege.
  assert.doesNotMatch(mechanicsPrompt(false), /\| Archer \||Siege engine|Victory/);
  assert.match(mechanicsPrompt(false), /### Production chains/);
});
