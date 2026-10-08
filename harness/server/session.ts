import { TICKS_PER_GAME_SECOND } from "../shared/protocol.js";

/**
 * One reader game-clock sample: ticks, the map they belong to and when it was taken (ms).
 * The stream's generation is not used: it also advances after every transient unavailable sample.
 */
export type GameClockSample = { tick: number; map: string; at: number } | null;

/** Play time over which the game speed is estimated. */
const SPEED_WINDOW_MS = 3000;

/**
 * One owner for inference, tools and waits. The benchmark budget is play time: real time
 * while the game runs, measured as the time between reader samples in which the game clock
 * advanced. Paused time (model thinking, reading tools, menus) does not count, and a faster
 * game speed fits more game time into it. A separate wall-clock limit bounds all real time.
 */
export class Session {
  readonly abort = new AbortController();
  private startedAt?: number;
  reason: "deadline" | "stopped" | "error" | null = null;
  /** Which limit ended the session when reason is "deadline". */
  deadlineKind?: "play_time" | "wall_limit";
  errorDetail?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private gameTimer?: ReturnType<typeof setInterval>;
  private startTick?: number;
  private lastTick?: number;
  private lastAt?: number;
  private playMs = 0;
  /** Recent running intervals, for the speed estimate. */
  private recent: { ticks: number; ms: number }[] = [];
  private map?: string;
  constructor(
    /** Wall-clock limit in seconds. */
    readonly seconds: number,
    private cancel: () => void,
    readonly now: () => number = () => performance.now(),
    private game?: { budgetMs: number; clock: () => GameClockSample },
  ) {}
  start() {
    if (this.startedAt !== undefined) throw new Error("Session already started.");
    if (this.reason) throw new Error(`Session ${this.reason}`);
    if (this.game) {
      const sample = this.game.clock();
      if (!sample) throw new Error("Game clock unavailable; cannot start a play-time budget.");
      this.startTick = this.lastTick = sample.tick;
      this.lastAt = sample.at;
      this.map = sample.map;
      this.gameTimer = setInterval(() => this.gameCheck(), 100);
    }
    this.startedAt = this.now();
    this.timer = setTimeout(() => this.stopAt("wall_limit"), this.seconds * 1000);
  }
  private stopAt(kind: "play_time" | "wall_limit") {
    if (this.reason) return;
    this.deadlineKind = kind;
    this.stop("deadline");
  }
  /**
   * Advance the clocks from the reader; a reset or new map ends the run. The real time from the
   * previous sample counts as play when the game clock advanced since it (a reader gap the game
   * ran through counts too), so each pause or unpause adds at most one sample interval.
   */
  private gameCheck() {
    if (!this.game || this.startTick === undefined || this.reason) return;
    const sample = this.game.clock();
    if (!sample) return; // Transient reader gap: keep the last known tick.
    if (sample.map !== this.map || sample.tick < this.lastTick!) {
      this.errorDetail = "The game clock reset (reload or map change) during the run.";
      this.stop("error");
      return;
    }
    if (sample.at > this.lastAt!) {
      const ticks = sample.tick - this.lastTick!;
      const ms = sample.at - this.lastAt!;
      if (ticks > 0) {
        this.playMs += ms;
        this.recent.push({ ticks, ms });
        let window = this.recent.reduce((sum, r) => sum + r.ms, 0);
        while (this.recent.length > 1 && window - this.recent[0].ms >= SPEED_WINDOW_MS) window -= this.recent.shift()!.ms;
      }
      this.lastAt = sample.at;
    }
    this.lastTick = sample.tick;
    if (this.playMs >= this.game.budgetMs) this.stopAt("play_time");
  }
  gameUsedTicks() {
    return this.startTick === undefined ? 0 : this.lastTick! - this.startTick;
  }
  playUsedSeconds() {
    return this.game ? this.playMs / 1000 : this.wallUsedSeconds();
  }
  playRemainingSeconds() {
    return this.game ? Math.max(0, this.game.budgetMs - this.playMs) / 1000 : this.remaining() / 1000;
  }
  get playBudgetSeconds() {
    return this.game ? this.game.budgetMs / 1000 : this.seconds;
  }
  /**
   * Game ticks per second of recent play: the game speed setting (30 is normal; the reader runs
   * 30.3 ticks/s at 30 and 45.5 at 45), or null before the game has run.
   */
  gameSpeed() {
    const ms = this.recent.reduce((sum, r) => sum + r.ms, 0);
    return ms > 0 ? (this.recent.reduce((sum, r) => sum + r.ticks, 0) * 1000) / ms : null;
  }
  /** Wall-clock milliseconds left (request timeouts and the safety limit). */
  remaining() {
    return this.startedAt === undefined
      ? this.seconds * 1000
      : Math.max(0, this.seconds * 1000 - (this.now() - this.startedAt));
  }
  wallUsedSeconds() {
    return this.startedAt === undefined ? 0 : (this.now() - this.startedAt) / 1000;
  }
  check() {
    if (this.startedAt === undefined && !this.reason)
      throw new Error("Session has not started.");
    this.gameCheck();
    if (!this.reason && this.remaining() <= 0) this.stopAt("wall_limit");
    if (this.reason) throw new Error(`Session ${this.reason}`);
  }
  stop(reason: NonNullable<Session["reason"]>) {
    if (this.reason) return;
    this.reason = reason;
    this.abort.abort();
    this.cancel();
  }
  close() {
    clearTimeout(this.timer);
    clearInterval(this.gameTimer);
  }
  /** Real-time wait (short harness delays). */
  async wait(seconds: number) {
    this.check();
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 300)
      throw new Error("Wait must be 0–300 seconds.");
    if (!seconds) return;
    await this.sleep(Math.min(seconds * 1000, this.remaining()));
    this.check();
  }
  /**
   * Let the game run for N game seconds (N × 30 ticks), ending early at the
   * budget. A stalled reader or very slow game speed ends the wait after three
   * real seconds per game second (the slowest speed runs about 10 ticks/s).
   * `until`, checked every 50 ms, ends it early; returns true when it did.
   */
  async waitGame(gameSeconds: number, until?: () => boolean) {
    if (!this.game) {
      await this.wait(gameSeconds);
      return false;
    }
    this.check();
    if (!Number.isFinite(gameSeconds) || gameSeconds < 0 || gameSeconds > 300)
      throw new Error("Wait must be 0–300 game seconds.");
    if (!gameSeconds) return false;
    const target = this.lastTick! + gameSeconds * TICKS_PER_GAME_SECOND;
    const wallCap = Math.min(this.remaining(), gameSeconds * 3000 + 2000);
    const started = this.now();
    while (this.lastTick! < target && this.now() - started < wallCap) {
      if (until?.()) return true;
      await this.sleep(50);
      this.check();
    }
    return false;
  }
  private sleep(ms: number) {
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener("abort", stopped);
        resolve();
      };
      const stopped = () => {
        clearTimeout(timer);
        reject(new Error("Session stopped while waiting"));
      };
      if (this.abort.signal.aborted) return stopped();
      const timer = setTimeout(done, ms);
      this.abort.signal.addEventListener("abort", stopped, { once: true });
    });
  }
}

/** A fallback wait applies once after the whole model/tool turn, never per note. */
export class ObservationCycle {
  observed = false;
  acted = false;
  /** The game was unpaused for a tool this turn (reading tools leave it paused). */
  ran = false;
  tools = 0;
  actions = 0;
  begin() {
    this.observed = false;
    this.acted = false;
    this.ran = false;
    this.tools = 0;
    this.actions = 0;
  }
  action() {
    this.acted = true;
    this.observed = false;
    if (++this.actions > 8)
      throw new Error("At most 8 actions per turn; observe before continuing.");
  }
  observe() {
    this.observed = true;
  }
  needsFallback() {
    return !this.observed && (this.acted || this.tools === 0);
  }
  /**
   * Game seconds the host lets pass after the turn before sending a screenshot, or null for none.
   * A turn that acted without looking, or called no tools, gets the default wait; one that ran the
   * game is also topped up to the minimum turn length. Reading-only turns stay free.
   */
  hostWait(ranSeconds: number, defaultWait: number, minTurn: number): number | null {
    const shortfall = this.ran || this.tools === 0
      ? Math.round(Math.max(0, minTurn - ranSeconds) * 10) / 10
      : 0;
    if (this.needsFallback()) return Math.max(defaultWait, shortfall);
    return shortfall > 0 ? shortfall : null;
  }
}

/** SDK timeout values must be positive integers even with a fractional monotonic clock. */
export function requestTimeout(remainingMs: number) {
  return Math.max(1, Math.floor(Math.min(90000, remainingMs)));
}
