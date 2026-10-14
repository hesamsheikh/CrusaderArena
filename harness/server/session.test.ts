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

test("fast waits get a wait's last tick, by the budget's end at the latest, and never a wait with a condition", async () => {
  let tick = 1000;
  const session = new Session(60, () => {}, undefined, { budgetTicks: 600, clock: () => ({ tick, map: "m" }) });
  session.start();
  const targets: number[] = [];
  // The fast part takes the clock nearly there; the session then waits out the last ticks itself.
  session.setFastWait(async (target) => {
    targets.push(target);
    tick = target - 15;
  });
  const clock = setInterval(() => (tick += 30), 20);
  try {
    await session.waitGame(10);
    assert.deepEqual(targets, [1300]);
    assert.ok(tick >= 1300);
    await session.waitGame(5, () => tick >= 0);
    assert.equal(targets.length, 1, "a wait with `until` keeps the benchmark speed");
    // 1,000 + 600 is the budget's end: a longer wait is played fast only that far.
    await assert.rejects(session.waitGame(60), /stopped|deadline/);
    assert.equal(session.deadlineKind, "game_time");
    assert.equal(targets.at(-1), 1600);
  } finally {
    clearInterval(clock);
    session.close();
  }
});

test("a warning ends a wait once its first seconds have passed; `until` still reports itself", async () => {
  const run = running();
  try {
    const start = run.tick();
    // Due from the start, it waits out the 3 s the turn still owes first.
    const ended = await run.session.waitGame(60, undefined, { check: () => true, afterSeconds: 3 });
    assert.equal(ended, "interrupted");
    assert.ok(run.tick() - start >= 3 * 30 && run.tick() - start < 20 * 30, `${(run.tick() - start) / 30} game s`);
    assert.equal(await run.session.waitGame(5, () => true, { check: () => true, afterSeconds: 0 }), true);
    assert.equal(await run.session.waitGame(0.5, undefined, { check: () => false, afterSeconds: 0 }), false);
  } finally {
    run.done();
  }
});

test("a fast wait gets the warning check as its stop, live only after the wait's first seconds", async () => {
  let tick = 1000;
  const session = new Session(60, () => {}, undefined, { budgetTicks: 100_000, clock: () => ({ tick, map: "m" }) });
  session.start();
  const stops: boolean[] = [];
  session.setFastWait(async (_target, stop) => {
    stops.push(stop!());
    tick += 5 * 30;
    // The session reads the clock every 100 ms.
    await new Promise((resolve) => setTimeout(resolve, 150));
    stops.push(stop!());
  });
  try {
    assert.equal(await session.waitGame(60, undefined, { check: () => true, afterSeconds: 3 }), "interrupted");
    assert.deepEqual(stops, [false, true]);
  } finally {
    session.close();
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
