import test from "node:test";
import assert from "node:assert/strict";
import { measureSpeed, setGameSpeed, type SpeedControl } from "./game-speed.js";

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
