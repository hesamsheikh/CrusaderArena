import test from "node:test";
import assert from "node:assert/strict";
import { ObservationCycle, Session } from "./session.js";

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

test("the host wait gives the default wait to unobserved actions and tops up short turns", () => {
  const turn = (tools: number, { ran = false, acted = false, observed = false } = {}) => {
    const cycle = new ObservationCycle();
    cycle.begin();
    Object.assign(cycle, { tools, ran, acted, observed });
    return cycle;
  };
  // Reading only: the game never ran, so nothing to top up.
  assert.equal(turn(2).hostWait(0, 5, 8), null);
  // No tools at all: the longer of the default wait and the minimum.
  assert.equal(turn(0).hostWait(0, 5, 8), 8);
  // Acted without looking: the default wait, or more to reach the minimum.
  assert.equal(turn(1, { ran: true, acted: true }).hostWait(2, 5, 8), 6);
  assert.equal(turn(1, { ran: true, acted: true }).hostWait(10, 5, 8), 5);
  // Acted and looked: only the shortfall, if any.
  assert.equal(turn(2, { ran: true, acted: true, observed: true }).hostWait(3, 5, 8), 5);
  assert.equal(turn(2, { ran: true, acted: true, observed: true }).hostWait(7.96, 5, 8), null);
  assert.equal(turn(1, { ran: true, observed: true }).hostWait(12, 5, 8), null);
  // A minimum of 0 keeps the default-wait rule alone.
  assert.equal(turn(2, { ran: true, acted: true, observed: true }).hostWait(1, 5, 0), null);
  assert.equal(turn(1, { ran: true, acted: true }).hostWait(1, 5, 0), 5);
});
