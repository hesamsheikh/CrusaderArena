import { test } from "node:test";
import assert from "node:assert/strict";
import { armsCounted } from "./benchmark-rules.js";
import { netWorth, scoredPrice } from "./market-prices.js";
import { benchmarkSpec } from "./preparation.js";

test("each map's no-arms benchmark reads its map's rules, with weapons and armour left out of net worth", () => {
  for (const map of ["Oasis by the Sea", "Large Barren Desert", "The Sinkhole"]) {
    const counted = benchmarkSpec(`${map} construction`)!, left = benchmarkSpec(`${map} construction (no arms)`)!;
    assert.deepEqual([counted.arms, counted.military, left.arms, left.military], [true, false, false, false], map);
    assert.equal(left.text.split("\n")[0], counted.text.split("\n")[0]);
    assert.match(counted.text, /in the armory,\nbows 15, crossbows 30/);
    assert.doesNotMatch(counted.text, /count(s)? nothing/);
    assert.doesNotMatch(left.text, /bows 15/);
    assert.match(left.text, /flour 10\), except weapons and armour, which count\nnothing in the armory;/);
    assert.match(left.text, /where it\n {2}counts nothing; sold at a marketplace, it brings its gold\./);
    for (const { text } of [counted, left]) assert.doesNotMatch(text, /<!--|-->/);
  }
  assert.equal(armsCounted("Oasis by the Sea construction (no arms)"), false);
  assert.equal(armsCounted("Oasis by the Sea construction"), true);
  // No rules file (a Custom run, a person's game): everything counts.
  assert.equal(armsCounted("Custom"), true);
  assert.equal(armsCounted(undefined), true);
});

test("net worth leaves weapons and armour out only when the benchmark says so", () => {
  assert.deepEqual(netWorth(100, { swords: 2, stone: 1 }), { netWorth: 167, goodsValue: 67 });
  assert.deepEqual(netWorth(100, { swords: 2, stone: 1 }, { arms: false }), { netWorth: 107, goodsValue: 7 });
  assert.deepEqual([scoredPrice("swords"), scoredPrice("swords", { arms: false }), scoredPrice("stone", { arms: false })], [30, 0, 7]);
});
