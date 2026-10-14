import test from "node:test";
import assert from "node:assert/strict";
import { FastWaits, measureSpeed, setGameSpeed, type FastWaitControl, type SpeedControl } from "./game-speed.js";

/**
 * A simulated game on a virtual clock: the reader samples every 100 ms, the clock runs `speed`
 * ticks per second (1% fast, like the reader), and each key press moves the speed by `step`
 * within 10 to 90 unless the keys are dead.
 */
function game(speed: number, options: { step?: number; dead?: boolean; paused?: boolean } = {}) {
  const step = options.step ?? 5;
  let now = 0,
    ticks = 0;
  const pressed: string[] = [];
  const control: SpeedControl = {
    clock: () => ({ tick: Math.floor(ticks), at: Math.floor(now / 100) * 100 }),
    press: async (key) => {
      pressed.push(key);
      if (!options.dead) speed = Math.min(90, Math.max(10, speed + (key === "+" ? step : -step)));
    },
    sleep: async (ms) => {
      now += ms;
      if (!options.paused) ticks += (speed * 1.01 * ms) / 1000;
    },
  };
  return { control, pressed, speed: () => speed };
}

test("measures ticks per real second from the reader's capture times", async () => {
  const g = game(30);
  const speed = await measureSpeed(g.control);
  assert.ok(Math.abs(speed - 30.3) < 0.5, `measured ${speed}`);
});

test("refuses to measure a paused game", async () => {
  await assert.rejects(measureSpeed(game(40, { paused: true }).control), /did not advance/);
});

test("presses + until the game runs at 40", async () => {
  const g = game(20);
  const result = await setGameSpeed(g.control, 40);
  assert.deepEqual(g.pressed, ["+", "+", "+", "+"]);
  assert.equal(g.speed(), 40);
  assert.equal(result.presses, 4);
  assert.ok(Math.abs(result.before - 20.2) < 0.5 && Math.abs(result.after - 40.4) < 0.5, JSON.stringify(result));
});

test("presses - from a faster speed and nothing when already at 40", async () => {
  const fast = game(55);
  await setGameSpeed(fast.control, 40);
  assert.deepEqual(fast.pressed, ["-", "-", "-"]);
  const right = game(40);
  assert.equal((await setGameSpeed(right.control, 40)).presses, 0);
  assert.deepEqual(right.pressed, []);
});

test("fails when the speed keys do nothing", async () => {
  const g = game(20, { dead: true });
  await assert.rejects(setGameSpeed(g.control, 40), /no effect/);
  assert.equal(g.pressed.length, 2);
});

test("fails when the key steps skip over the target", async () => {
  await assert.rejects(setGameSpeed(game(25, { step: 10 }).control, 40), /step past 40/);
});

/**
 * A running game on a virtual clock for fast waits: ticks run at `speed` × 1.01 a real second
 * (the reader runs about 1% fast) while time passes, in sleeps and in each key press's own
 * duration; a press lands at its end and moves the speed by 5 within 10 to `top`, unless `lost`
 * drops it. The reader samples every 100 ms. `stopAfter` makes the run stop at that check.
 */
function running(options: { top?: number; pressMs?: number; lost?: (key: string, n: number) => boolean; paused?: boolean; stopAfter?: number } = {}) {
  let speed = 40,
    now = 0,
    ticks = 3000,
    checks = 0;
  const top = options.top ?? 90;
  const pressed: string[] = [];
  let sample = { tick: ticks, at: 0 };
  const advance = (ms: number) => {
    for (let left = ms; left > 0; left -= 10) {
      const step = Math.min(10, left);
      now += step;
      ticks += (speed * 1.01 * step) / 1000;
      if (now % 100 === 0) sample = { tick: Math.floor(ticks), at: now };
    }
  };
  const control: FastWaitControl = {
    clock: () => sample,
    press: async (key) => {
      pressed.push(key);
      advance(options.pressMs ?? 120);
      if (!options.lost?.(key, pressed.filter((k) => k === key).length))
        speed = Math.min(top, Math.max(10, speed + (key === "+" ? 5 : -5)));
    },
    sleep: async (ms) => advance(ms),
    check: () => {
      if (options.stopAfter !== undefined && ++checks >= options.stopAfter) throw new Error("Session stopped");
    },
    paused: () => !!options.paused,
    now: () => now,
  };
  return { control, pressed, speed: () => speed, ticks: () => Math.floor(ticks), now: () => now };
}

test("a long wait goes up to the top speed and is back at 40, measured, before its last tick", async () => {
  const g = running();
  const fast = new FastWaits(g.control, 40.4);
  const target = g.ticks() + 60 * 30;
  const wait = await fast.run(target);
  assert.ok(wait);
  assert.equal(wait.presses, 10);
  assert.deepEqual(g.pressed, [...Array(10).fill("+"), ...Array(10).fill("-")]);
  assert.equal(g.speed(), 40);
  assert.equal(fast.normal, true);
  assert.ok(Math.abs(wait.endRate - 40.4) <= 1, JSON.stringify(wait));
  assert.ok(wait.fastRate !== null && Math.abs(wait.fastRate - 90.9) <= 2, JSON.stringify(wait));
  // It returns before the wait's last tick, with no more than a few game seconds left to wait.
  assert.ok(g.ticks() < target && target - g.ticks() < 5 * 30, `${target - g.ticks()} ticks left`);
  // 60 game seconds take about 44.6 real seconds at 40; fast, under 25 with the presses and check.
  assert.ok(g.now() < 25_000 && wait.savedMs > 18_000, JSON.stringify(wait));
});

test("waits of any length end at 40 before their last tick, and short ones press nothing", async () => {
  for (const seconds of [3, 5, 8, 10, 15, 20, 30, 45, 90, 180, 300]) {
    const g = running();
    const fast = new FastWaits(g.control, 40.4);
    const target = g.ticks() + seconds * 30;
    const wait = await fast.run(target);
    assert.equal(g.speed(), 40, `${seconds} s`);
    assert.ok(g.ticks() <= target, `${seconds} s: ${g.ticks() - target} ticks past its end`);
    if (!wait) assert.deepEqual(g.pressed, [], `${seconds} s`);
    else assert.ok(wait.savedMs >= 1500, `${seconds} s: ${JSON.stringify(wait)}`);
  }
  // At about 0.12 s a press, a host wait of 5 to 8 game seconds would not save 2 real seconds.
  const g = running();
  assert.equal(await new FastWaits(g.control, 40.4).run(g.ticks() + 8 * 30), null);
  assert.ok(new FastWaits(running().control, 40.4).plan(30 * 30));
});

test("a wait's stop brings it back to 40 early, and its record counts only the ticks it played", async () => {
  const g = running();
  const fast = new FastWaits(g.control, 40.4);
  const start = g.ticks();
  // A warning 30 game seconds into a 120-second wait.
  const wait = await fast.run(start + 120 * 30, () => g.ticks() - start >= 30 * 30);
  assert.ok(wait?.interrupted, JSON.stringify(wait));
  assert.equal(g.speed(), 40);
  assert.equal(fast.normal, true);
  const played = g.ticks() - start;
  assert.ok(played >= 30 * 30 && played < 40 * 30, `${played / 30} game s played`);
  assert.ok(Math.abs(wait.ticks - played) <= 10, JSON.stringify(wait));
  assert.ok(wait.savedMs > 0 && wait.savedMs < (played / 40.4) * 1000, JSON.stringify(wait));
  // A stop that holds already presses nothing.
  const h = running();
  assert.equal(await new FastWaits(h.control, 40.4).run(h.ticks() + 60 * 30, () => true), null);
  assert.deepEqual(h.pressed, []);
});

test("a game that tops out lower comes back to 40 with a correction, then presses fewer", async () => {
  const g = running({ top: 70 });
  const fast = new FastWaits(g.control, 40.4);
  const first = await fast.run(g.ticks() + 90 * 30);
  assert.ok(first && first.corrected !== undefined && first.corrected > 0, JSON.stringify(first));
  assert.equal(g.speed(), 40);
  assert.equal(fast.normal, true);
  const second = await fast.run(g.ticks() + 90 * 30);
  assert.equal(second?.presses, 6);
  assert.equal(second?.corrected, undefined);
  assert.equal(g.speed(), 40);
});

test("a lost - press is caught by the end measurement and set right", async () => {
  const g = running({ lost: (key, n) => key === "-" && n === 3 });
  const fast = new FastWaits(g.control, 40.4);
  const wait = await fast.run(g.ticks() + 60 * 30);
  assert.equal(wait?.corrected, 1);
  assert.equal(g.speed(), 40);
  assert.equal(fast.off, undefined, "one correction does not turn fast waits off");
});

test("speed keys that do nothing turn fast waits off for the run", async () => {
  const g = running({ lost: () => true });
  const fast = new FastWaits(g.control, 40.4);
  await fast.run(g.ticks() + 60 * 30);
  assert.match(fast.off ?? "", /did not speed the game up/);
  assert.equal(g.speed(), 40);
  const presses = g.pressed.length;
  assert.equal(await fast.run(g.ticks() + 60 * 30), null);
  assert.equal(g.pressed.length, presses, "nothing pressed once off");
});

test("a paused game is not played fast", async () => {
  const g = running({ paused: true });
  assert.equal(await new FastWaits(g.control, 40.4).run(g.ticks() + 60 * 30), null);
  assert.deepEqual(g.pressed, []);
});

test("a run that stops during a fast wait leaves the speed unconfirmed until restore presses it back down", async () => {
  const g = running({ stopAfter: 40 });
  const fast = new FastWaits(g.control, 40.4);
  await assert.rejects(fast.run(g.ticks() + 120 * 30), /stopped/);
  assert.equal(fast.normal, false);
  assert.equal(g.speed(), 90);
  const presses = await fast.restore((key) => g.control.press(key));
  assert.equal(presses, 10);
  assert.equal(g.speed(), 40);
  assert.equal(fast.normal, true);
});
