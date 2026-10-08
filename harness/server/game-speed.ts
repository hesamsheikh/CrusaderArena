import { GAME_SPEED, type GameSpeedSetting } from "../shared/protocol.js";

/** One reader game-clock reading: the tick and when the reader captured it (ms), or null. */
export type ClockReading = { tick: number; at: number } | null;

export type SpeedControl = {
  /** The latest valid reader reading, or null while the reader has none. */
  clock: () => ClockReading | Promise<ClockReading>;
  /** Press the game's speed key once: `+` faster, `-` slower. */
  press: (key: "+" | "-") => Promise<void>;
  sleep: (ms: number) => Promise<unknown>;
};

/** Real time over which one speed reading is taken. */
const MEASURE_MS = 1500;
/** Wait after a key press before measuring, so the reading starts at the new speed. */
const SETTLE_MS = 300;
/** Accepted distance from the target: the speed keys step by 5 and the reader runs about 1% fast. */
const TOLERANCE = 3;
/** Enough presses to cross the whole speed range. */
const MAX_PRESSES = 16;

const tenths = (value: number) => Math.round(value * 10) / 10;

/** A reading newer than `after` (any reading when null), waiting up to three seconds for one. */
async function nextReading(control: SpeedControl, after: number | null) {
  for (let i = 0; i < 30; i++) {
    const reading = await control.clock();
    if (reading && (after === null || reading.at > after)) return reading;
    await control.sleep(100);
  }
  throw new Error("No game-clock reading from the reader; cannot measure the game speed.");
}

/** Game ticks per real second over 1.5 s of running game, timed by the reader's capture times. */
export async function measureSpeed(control: SpeedControl) {
  const first = await nextReading(control, null);
  await control.sleep(MEASURE_MS);
  const last = await nextReading(control, first.at);
  const ticks = last.tick - first.tick;
  if (ticks <= 0) throw new Error("The game clock did not advance; the game must run to measure its speed.");
  return (ticks * 1000) / (last.at - first.at);
}

/**
 * Bring the running game to `target` speed with its speed keys: measure, press one key toward the
 * target, measure again, until a reading is within TOLERANCE. Fails when the keys stop changing
 * the speed or the target lies between two key steps.
 */
export async function setGameSpeed(control: SpeedControl, target = GAME_SPEED): Promise<GameSpeedSetting> {
  let speed = await measureSpeed(control);
  const before = speed;
  let presses = 0,
    unchanged = 0,
    turns = 0;
  let last: "+" | "-" | undefined;
  while (Math.abs(speed - target) > TOLERANCE) {
    if (presses >= MAX_PRESSES)
      throw new Error(`Could not set the game speed to ${target}: it ran at ${Math.round(speed)} after ${presses} key presses.`);
    const key = speed < target ? "+" : "-";
    if (last && key !== last && ++turns >= 2)
      throw new Error(`The game speed keys step past ${target}: the speed moves between about ${Math.round(speed)} and the next step.`);
    last = key;
    await control.press(key);
    presses++;
    await control.sleep(SETTLE_MS);
    const next = await measureSpeed(control);
    unchanged = Math.abs(next - speed) < 1 ? unchanged + 1 : 0;
    if (unchanged >= 2)
      throw new Error(`The game speed keys had no effect: the speed stayed at about ${Math.round(next)} after ${presses} presses.`);
    speed = next;
  }
  return { target, before: tenths(before), after: tenths(speed), presses };
}
