import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "./session.js";

/** A session whose game clock advances 30 ticks (one game second) every 20 ms. */
function running() {
  let tick = 1000;
  const clock = setInterval(() => (tick += 30), 20);
  const session = new Session(60, () => {}, undefined, { budgetTicks: 1_000_000, clock: () => ({ tick, map: "m" }) });
  session.start();
  return { session, tick: () => tick, done: () => { clearInterval(clock); session.close(); } };
}

test("a game wait ends early when its condition holds", async () => {
  const run = running();
  try {
    const start = run.tick();
    const met = await run.session.waitGame(120, () => run.tick() - start >= 5 * 30);
    assert.equal(met, true);
    assert.ok(run.tick() - start < 30 * 30, "stopped long before the 120 s limit");
  } finally {
    run.done();
  }
});

test("a game wait without a condition, or one never met, runs its full time", async () => {
  const run = running();
  try {
    assert.equal(await run.session.waitGame(0.5), false);
    assert.equal(await run.session.waitGame(0.5, () => false), false);
  } finally {
    run.done();
  }
});
