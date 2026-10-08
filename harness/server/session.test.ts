import test from "node:test";
import assert from "node:assert/strict";
import { ObservationCycle, Session } from "./session.js";

/** A session whose game clock advances 30 ticks (one game second) every 20 ms. */
function running() {
  let tick = 1000;
  const clock = setInterval(() => (tick += 30), 20);
  const session = new Session(60, () => {}, undefined, { budgetMs: 1e9, clock: () => ({ tick, map: "m", at: Date.now() }) });
  session.start();
  return { session, tick: () => tick, done: () => { clearInterval(clock); session.close(); } };
}

test("play time counts real time only while the game clock advances, and the budget ends the run", () => {
  let sample = { tick: 1000, map: "m", at: 0 };
  const session = new Session(600, () => {}, undefined, { budgetMs: 10_000, clock: () => sample });
  session.start();
  const step = (ms: number, ticks: number) => {
    sample = { ...sample, tick: sample.tick + ticks, at: sample.at + ms };
    session.check();
  };
  try {
    // 4 s at the normal speed (30 ticks/s), 5 s paused, then 3 s at speed 60.
    for (let i = 0; i < 40; i++) step(100, 3);
    for (let i = 0; i < 50; i++) step(100, 0);
    for (let i = 0; i < 30; i++) step(100, 6);
    assert.equal(session.playUsedSeconds(), 7);
    assert.equal(session.playRemainingSeconds(), 3);
    assert.equal(session.gameUsedTicks(), 120 + 180);
    assert.equal(session.gameSpeed(), 60);
    // A reader gap the game ran through counts as play; here it uses up the budget.
    sample = { ...sample, tick: sample.tick + 105, at: sample.at + 3500 };
    assert.throws(() => session.check(), /Session deadline/);
    assert.equal(session.deadlineKind, "play_time");
  } finally {
    session.close();
  }
});

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
