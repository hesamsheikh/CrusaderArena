import { TICKS_PER_GAME_SECOND } from "../shared/protocol.js";

/**
 * One reader game-clock sample: ticks and the map they belong to. The stream's
 * generation is not used: it also advances after every transient unavailable sample.
 */
export type GameClockSample = { tick: number; map: string } | null;

/**
 * One owner for inference, tools and waits. The benchmark budget is game time
 * (reader ticks), which only advances while the game runs; a separate wall-clock
 * limit bounds real time, including model thinking while the host pauses the game.
 */
export class Session {
  readonly abort = new AbortController();
  private startedAt?: number;
  reason: "deadline" | "stopped" | "error" | null = null;
  /** Which limit ended the session when reason is "deadline". */
  deadlineKind?: "game_time" | "wall_limit";
  errorDetail?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private gameTimer?: ReturnType<typeof setInterval>;
  private startTick?: number;
  private lastTick?: number;
  private map?: string;
  constructor(
    /** Wall-clock limit in seconds. */
    readonly seconds: number,
    private cancel: () => void,
    readonly now: () => number = () => performance.now(),
    private game?: { budgetTicks: number; clock: () => GameClockSample },
  ) {}
  start() {
    if (this.startedAt !== undefined) throw new Error("Session already started.");
    if (this.reason) throw new Error(`Session ${this.reason}`);
    if (this.game) {
      const sample = this.game.clock();
      if (!sample) throw new Error("Game clock unavailable; cannot start a game-time budget.");
      this.startTick = this.lastTick = sample.tick;
      this.map = sample.map;
      this.gameTimer = setInterval(() => this.gameCheck(), 100);
    }
    this.startedAt = this.now();
    this.timer = setTimeout(() => this.stopAt("wall_limit"), this.seconds * 1000);
  }
  private stopAt(kind: "game_time" | "wall_limit") {
    if (this.reason) return;
    this.deadlineKind = kind;
    this.stop("deadline");
  }
  /** Advance the game clock from the reader; a reset or new map ends the run. */
  private gameCheck() {
    if (!this.game || this.startTick === undefined || this.reason) return;
    const sample = this.game.clock();
    if (!sample) return; // Transient reader gap: keep the last known tick.
    if (sample.map !== this.map || sample.tick < this.lastTick!) {
      this.errorDetail = "The game clock reset (reload or map change) during the run.";
      this.stop("error");
      return;
    }
    this.lastTick = sample.tick;
    if (this.lastTick - this.startTick >= this.game.budgetTicks) this.stopAt("game_time");
  }
  gameUsedTicks() {
    return this.startTick === undefined ? 0 : this.lastTick! - this.startTick;
  }
  gameRemainingSeconds() {
    return this.game
      ? Math.max(0, this.game.budgetTicks - this.gameUsedTicks()) / TICKS_PER_GAME_SECOND
      : this.remaining() / 1000;
  }
  get gameBudgetSeconds() {
    return this.game ? this.game.budgetTicks / TICKS_PER_GAME_SECOND : this.seconds;
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
}

/** SDK timeout values must be positive integers even with a fractional monotonic clock. */
export function requestTimeout(remainingMs: number) {
  return Math.max(1, Math.floor(Math.min(90000, remainingMs)));
}
