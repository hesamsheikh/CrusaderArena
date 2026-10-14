import { FAST_GAME_SPEED, GAME_SPEED, type GameSpeedSetting } from "../shared/protocol.js";

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

/** Game ticks per real second over `ms` (1.5 s) of running game, timed by the reader's capture times. */
export async function measureSpeed(control: SpeedControl, ms = MEASURE_MS) {
  const first = await nextReading(control, null);
  await control.sleep(ms);
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

/** Real seconds a wait played fast must save over the benchmark speed; shorter waits keep that speed. */
export const FAST_WAIT_MIN_SAVING_SECONDS = 2;
/** After the last - press of a fast wait: the wait for the speed to change, then its measurement. */
const CHECK_SETTLE_MS = 300;
const CHECK_MS = 1000;
/**
 * Real seconds of lag a fast wait's plan keeps in hand: a reader sample is up to 100 ms old and is
 * polled every 50 ms, so the ticks seen trail the game's, by about 30 at the top speed.
 */
const LAG_SECONDS = 0.3;
const POLL_MS = 50;
/** Real time without a new tick after which a fast wait stops waiting at speed. */
const STALL_MS = 3000;
/** Wrong end speeds (each set again by setGameSpeed) after which fast waits stop for the run. */
const MAX_CORRECTIONS = 3;

export type FastWaitControl = SpeedControl & {
  /** Throws once the run has to stop (Session.check). */
  check: () => void;
  /** Whether the reader's latest sample shows the game paused, when it has one. */
  paused: () => boolean | undefined;
  /** Real milliseconds, monotonic. */
  now: () => number;
};

/** One wait played fast, as the run's events record it (controller.ts, "fast_wait"). */
export type FastWait = {
  /** Game ticks the wait had left when it began, and the + presses it played them with. */
  ticks: number;
  presses: number;
  /** Ticks per real second measured at the top (null when too short to measure), and back down. */
  fastRate: number | null;
  endRate: number;
  /** Real milliseconds it took, and how many it saved over the benchmark speed (estimated). */
  realMs: number;
  savedMs: number;
  /** Presses it took to set the benchmark speed again after a wrong end speed, when it did. */
  corrected?: number;
};

/**
 * Fast waits: the game time a run only waits for (Session.waitGame: the model's waits and the
 * host's) played at the game's top speed. A wait presses + up to it, waits, and presses - back
 * down early enough to measure the benchmark speed again before the wait's last tick, so nothing
 * the agent does, sees or loses time to happens at another speed. Every tick is the same game at
 * any speed; only the real time a wait takes changes. A wait too short to save
 * FAST_WAIT_MIN_SAVING_SECONDS after the key presses keeps the benchmark speed throughout.
 */
export class FastWaits {
  /** Real seconds one speed key press takes, as measured while they are sent. */
  private pressSeconds = 0.15;
  /** + presses to the top speed: (FAST_GAME_SPEED - GAME_SPEED) / 5, fewer once the game shows a lower top. */
  private steps: number;
  /** + presses not yet taken back: the game runs that many steps above the benchmark speed. */
  private raised = 0;
  /** Wrong end speeds so far. */
  corrections = 0;
  /** Whether the game runs at the benchmark speed: false from a wait's first + press until its end speed is measured. */
  normal = true;
  /** Why fast waits stopped for the rest of the run, once they have. */
  off?: string;
  constructor(
    private control: FastWaitControl,
    /** Ticks per real second at the benchmark speed, as measured (the reader runs about 1% fast). */
    private normalRate = GAME_SPEED * 1.01,
    private readonly speeds = { normal: GAME_SPEED, fast: FAST_GAME_SPEED, step: 5 },
  ) {
    this.steps = Math.round((speeds.fast - speeds.normal) / speeds.step);
  }
  /** Ticks per real second `k` presses above the benchmark speed. */
  private rate(k: number) {
    return (this.normalRate * (this.speeds.normal + this.speeds.step * k)) / this.speeds.normal;
  }
  /** Ticks that pass while presses take the speed from `k` steps up back to the benchmark speed. */
  private downTicks(k: number) {
    let ticks = 0;
    for (let j = k; j > 0; j--) ticks += this.pressSeconds * this.rate(j);
    return ticks;
  }
  /** Ticks a wait at `k` steps up keeps for its end: coming down, measuring the speed, the reader's lag. */
  private reserve(k: number) {
    return this.downTicks(k) + ((CHECK_SETTLE_MS + CHECK_MS) / 1000) * this.rate(0) + LAG_SECONDS * this.rate(k);
  }
  /**
   * The + presses that save the most real time over `ticks` of waiting, and the real seconds they
   * save; null when no number of presses saves FAST_WAIT_MIN_SAVING_SECONDS.
   */
  plan(ticks: number): { presses: number; saving: number } | null {
    let best: { presses: number; saving: number } | null = null;
    for (let k = 1; k <= this.steps; k++) {
      let up = 0;
      for (let j = 0; j < k; j++) up += this.pressSeconds * this.rate(j);
      const fast = ticks - up - this.reserve(k);
      if (fast < 0) break;
      const real = 2 * k * this.pressSeconds + fast / this.rate(k) + (this.reserve(k) - this.downTicks(k)) / this.rate(0);
      const saving = ticks / this.rate(0) - real;
      if (!best || saving > best.saving) best = { presses: k, saving };
    }
    return best && best.saving >= FAST_WAIT_MIN_SAVING_SECONDS ? best : null;
  }
  /**
   * Play the game toward `target` ticks, as much of the way as pays at the top speed, and return
   * with it measured back at the benchmark speed; the caller waits out the last ticks. Returns null,
   * having pressed nothing, when the wait would not pay, the game is paused or fast waits are off.
   * Throws when the run must stop or the benchmark speed cannot be set again: then `normal` stays
   * false, and the caller must not act in the game.
   */
  async run(target: number): Promise<FastWait | null> {
    const c = this.control;
    if (this.off || c.paused() !== false) return null;
    const start = await nextReading(c, null);
    const ticks = target - start.tick;
    const plan = this.plan(ticks);
    if (!plan) return null;
    const began = c.now();
    this.normal = false;
    // Up, stopping early if the wait turns out too short for more.
    for (let i = 0; i < plan.presses; i++) {
      c.check();
      await this.press("+");
      this.raised++;
      if (target - (await nextReading(c, null)).tick <= this.reserve(this.raised)) break;
    }
    // At speed until the way down must begin, measuring the top speed on the way.
    let from: { tick: number; at: number } | undefined;
    let fastRate: number | null = null;
    let progress = { tick: start.tick, at: c.now() };
    for (;;) {
      c.check();
      const now = await nextReading(c, null);
      if (from === undefined) from = now;
      else if (now.at - from.at >= 1000) fastRate = ((now.tick - from.tick) * 1000) / (now.at - from.at);
      if (target - now.tick <= this.reserve(this.raised)) break;
      if (now.tick !== progress.tick) progress = { tick: now.tick, at: c.now() };
      else if (c.now() - progress.at > STALL_MS) break;
      await c.sleep(POLL_MS);
    }
    const presses = this.raised;
    while (this.raised > 0) {
      c.check();
      await this.press("-");
      this.raised--;
    }
    // Back down: measure the speed, and set it again if a press went astray.
    await c.sleep(CHECK_SETTLE_MS);
    let endRate = await measureSpeed(c, CHECK_MS);
    let corrected: number | undefined;
    if (Math.abs(endRate - this.speeds.normal) > TOLERANCE) {
      // Ending m steps below means the game tops out m steps lower than assumed: fewer + presses next time.
      const below = Math.round((this.speeds.normal - (endRate * this.speeds.normal) / this.normalRate) / this.speeds.step);
      if (below > 0) this.steps = Math.max(0, Math.min(this.steps, presses - below));
      const setting = await setGameSpeed(c, this.speeds.normal);
      corrected = setting.presses;
      endRate = setting.after;
      if (++this.corrections >= MAX_CORRECTIONS) this.off = `the game came back from ${MAX_CORRECTIONS} fast waits at the wrong speed`;
      else if (this.steps === 0) this.off = "the + key did not speed the game up";
    }
    this.normal = true;
    if (fastRate !== null && fastRate < this.rate(1) - TOLERANCE)
      this.off ??= `the + key did not speed the game up (${Math.round(fastRate)} ticks a second at the top)`;
    const realMs = c.now() - began;
    return {
      ticks, presses, fastRate: fastRate === null ? null : tenths(fastRate), endRate: tenths(endRate),
      realMs: Math.round(realMs), savedMs: Math.round((ticks / this.rate(0)) * 1000 - realMs),
      ...(corrected !== undefined ? { corrected } : {}),
    };
  }
  private async press(key: "+" | "-") {
    const began = this.control.now();
    await this.control.press(key);
    this.pressSeconds = 0.7 * this.pressSeconds + 0.3 * Math.min(1, (this.control.now() - began) / 1000);
  }
  /**
   * After a run stopped during a fast wait, with the game paused for the final reading: press -
   * once for each + not taken back. Unconfirmed, since a paused game's speed cannot be measured;
   * the next run's setGameSpeed measures it anyway. Returns the presses.
   */
  async restore(press: (key: "-") => Promise<unknown>) {
    const presses = this.raised;
    for (; this.raised > 0; this.raised--) await press("-");
    this.normal = true;
    return presses;
  }
}
