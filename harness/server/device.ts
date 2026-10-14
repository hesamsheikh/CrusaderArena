import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { Frame, GameAction, Stats } from "../shared/protocol.js";
import { allowedKeys, frameAgeSeconds, validateFrameAction, windowAction } from "../shared/protocol.js";
import { GameEvents } from "./game-events.js";
import type { MapSummary } from "./map-view.js";
/** Single-quoted for the remote shell. */
export const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
/**
 * Reader sampling interval; placement checks wait for a sample after each click. 100 ms showed
 * no measurable game CPU, memory or game-speed cost against 500 ms (live 2026-09-28).
 */
export function readerIntervalMs(value = process.env.GAME_READER_INTERVAL_MS) {
  const ms = value === undefined || value === "" ? 100 : Number(value);
  if (!Number.isInteger(ms) || ms < 50 || ms > 5000)
    throw new Error("GAME_READER_INTERVAL_MS must be an integer from 50 to 5000");
  return ms;
}
/** Age past which the reader's last game-clock reading no longer dates frames (GameDevice.gameClock). */
const CLOCK_STALE_MS = 3000;

/** SSH target (user@address) and source root on the game host, from .env. */
export function gameHost() {
  const host = process.env.GAME_SSH_HOST;
  const root = process.env.GAME_REMOTE_ROOT;
  if (!host || !root)
    throw new Error("Set GAME_SSH_HOST and GAME_REMOTE_ROOT in .env (see .env.example)");
  if (!/^[a-zA-Z0-9_.@-]+$/.test(host) || host.startsWith("-"))
    throw new Error("Invalid GAME_SSH_HOST");
  return { host, root };
}

/**
 * Run one tools/ubuntu script on the game host over SSH (key login, strict host keys).
 * Scripts that talk to the game window use the pinned python-xlib environment.
 */
export function remoteScript(script: string, args: string[] = []) {
  const { host, root } = gameHost();
  const py = ["game-window.py", "record-window.py"].includes(script)
    ? `${root}/.venv-control/bin/python`
    : "python3";
  return spawn(
    "ssh",
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=2",
      host,
      `${quote(py)} ${quote(`${root}/tools/ubuntu/${script}`)}${args.map((a) => " " + quote(a)).join("")}`,
    ],
    { stdio: "pipe" },
  );
}

/** Raw native layers for a tile rectangle; arrays are row-major with y outer. */
export type TileRegion = {
  x0: number;
  y0: number;
  w: number;
  h: number;
  stable: boolean;
  layers: Record<"structure" | "organism" | "logic" | "logic2" | "height" | "occupancy" | "walk" | "gfx", number[]>;
  /** Building type per structure id in the region (52 = signpost); newer probes only. */
  structure_types?: Record<string, number>;
  /** The game's signpost no-build radius global; the placement check allows radius + 4 steps. */
  signpost_radius?: number;
};

/** A game input about to be sent: an agent or host action, or a whitelisted hotkey. */
export type GameInput = (GameAction | { type: "hotkey"; name: GameHotkey }) & { width: number; height: number };

/** One monitor-memory.py JSONL record; `sample` rows carry the memory fields. */
export type GuardRecord = {
  kind?: string;
  limits?: string[];
  rss_kib?: number;
  swap_kib?: number;
  available_kib?: number;
  threads?: number;
  elapsed_seconds?: number;
  [key: string]: unknown;
};

export class GameDevice {
  readonly events = new GameEvents();
  private child?: ChildProcessWithoutNullStreams;
  private watcher?: ChildProcessWithoutNullStreams;
  private guard?: ChildProcessWithoutNullStreams;
  /**
   * Memory guard state. The game's garbage collector can stop collecting, and the reader's
   * watchdog may not break every stall (see docs/status.md, Known issues), so every connection
   * runs monitor-memory.py, which terminates the game before the laptop runs out.
   */
  guardState: "off" | "starting" | "active" | "failed" = "off";
  lastGuardSample: GuardRecord | undefined;
  private guardListeners = new Set<(record: GuardRecord) => void>();
  private sampleListeners = new Set<(stats: Stats) => void>();
  private inputListeners = new Set<(input: GameInput) => void>();
  /** Requests sent to the bridge and not yet answered, oldest first; only the oldest's time runs (startNext). */
  private pending = new Map<
    string,
    {
      resolve: (x: any) => void;
      reject: (e: Error) => void;
      timeoutMs: number;
      timer?: NodeJS.Timeout;
    }
  >();
  private frames = new Map<string, Frame>();
  private tail: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  latest: Frame | null = null;
  private inputCount = 0;
  /**
   * Bumped on every game input sent (click, drag, key or hotkey), whatever tool sent it. model.ts
   * compares this against a value it saved earlier to tell whether anything has touched the game
   * since: a build_structure call's remembered open construction-tray category is only good while
   * this has not moved.
   */
  get inputSerial() {
    return this.inputCount;
  }
  /** Last lines of the reader's diagnostics when its stream closed. */
  readerDiagnostics = "";
  private readerRestarts = 0;
  stats: Stats | null = null;
  currentStats() {
    return this.stats?.valid_until_unix_ms &&
      this.stats.valid_until_unix_ms > Date.now()
      ? this.stats
      : { status: "unavailable", observation: null };
  }
  connected = false;
  constructor(
    private onStats: (stats: Stats | null) => void,
    private onClose: (reason: string) => void,
    private onLocalStop: () => void = () => {},
  ) {}
  private command(script: string, args: string[] = []) {
    return remoteScript(script, args);
  }
  async connect() {
    this.disconnect();
    const child = this.command("game-window.py");
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.bridgeLine(line));
    let diagnostics = "";
    child.stderr.on("data", (b) => {
      diagnostics = (diagnostics + b.toString()).slice(-1600);
    });
    child.on("error", () => {
      if (this.child === child) this.fail("Could not start SSH.");
    });
    child.stdin.on("error", () => {
      if (this.child === child) this.fail("Game input channel closed.");
    });
    child.on("close", () => {
      if (this.child === child)
        this.fail(
          diagnostics.includes("Permission denied")
            ? "SSH authentication failed."
            : `Game connection closed. Start the game and reconnect.${
                diagnostics.trim() ? ` (bridge: ${diagnostics.trim().split("\n").at(-1)!.slice(0, 200)})` : ""}`,
        );
    });
    try {
      const frame = await this.capture();
      this.connected = true;
      this.readerRestarts = 0;
      // Keepalive: the bridge exits after 30 s without input, so an orphaned session cannot hold its lock.
      const ping = setInterval(() => {
        if (this.child !== child) return clearInterval(ping);
        void this.rpc("ping").catch(() => {});
      }, 10000);
      this.startStats();
      this.startGuard();
      return frame;
    } catch (e) {
      this.disconnect();
      throw e;
    }
  }
  private startStats() {
    this.readerDiagnostics = "";
    const watcher = this.command("run-proton.py", ["watch", "--interval-ms", String(readerIntervalMs())]);
    this.watcher = watcher;
    createInterface({ input: watcher.stdout }).on("line", (line) => {
      if (this.watcher !== watcher) return;
      try {
        this.stats = JSON.parse(line);
        this.events.ingest(this.stats);
        this.onStats(this.stats);
        for (const listener of this.sampleListeners) listener(this.stats!);
        if (
          this.stats?.status === "game_exited" ||
          this.stats?.status === "game_exiting"
        )
          this.fail("Game exited; run stopped.");
      } catch {}
    });
    // Keep the reader's last diagnostics: a stream that closes early otherwise leaves no trace.
    let diagnostics = "";
    watcher.stderr.on("data", (b) => {
      diagnostics = (diagnostics + b.toString()).slice(-1200);
      if (this.watcher === watcher) this.readerDiagnostic(diagnostics);
    });
    watcher.on("error", () => {
      if (this.watcher !== watcher) return;
      this.events.ingest({ status: "reader_error" });
      this.stats = null;
      this.onStats(null);
    });
    watcher.on("close", () => {
      if (this.watcher === watcher) {
        this.readerDiagnostics = diagnostics.trim().split("\n").slice(-3).join(" | ");
        this.events.ingest({ status: "stream_closed" });
        this.stats = null;
        this.onStats(null);
        // The reader exits while the game is still starting ("wait until the game loads");
        // restart it while connected, a bounded number of times per connection.
        if (this.connected && this.readerRestarts++ < 30)
          setTimeout(() => {
            if (this.connected && this.watcher === watcher) this.startStats();
          }, 5000);
      }
    });
  }
  private startGuard() {
    // Limits: stop the game above 7 GiB RSS or below 2 GiB system available memory. The Intel
    // laptop keeps ~4.6 GiB of graphics buffers in shared memory, so only ~3.8 GiB is available
    // with the game loaded; a 3 GiB floor stopped runs after ~0.8 GiB of growth (2026-09-29).
    const guard = this.command("monitor-memory.py", [
      "--seconds", "86400", "--interval", "5",
      "--max-rss-mib", "7168", "--min-available-mib", "2048", "--terminate-on-limit",
      // A memory-map snapshot per GiB of growth shows which regions grow (2026-09-29 guard stop).
      "--map-step-mib", "1024", "--max-maps", "8",
    ]);
    this.guard = guard;
    this.guardState = "starting";
    createInterface({ input: guard.stdout }).on("line", (line) => {
      if (this.guard === guard) this.guardLine(line);
    });
    guard.stderr.resume();
    const ended = () => {
      if (this.guard !== guard) return;
      this.guard = undefined;
      if (this.connected) this.guardState = "failed";
    };
    guard.on("error", ended);
    guard.on("close", ended);
  }
  /** The whole map as category letters per tile (`crusader_probe --map-summary`, about 2 s). */
  mapSummary(): Promise<MapSummary> {
    if (!this.connected) return Promise.reject(new Error("Connect before reading the map."));
    const child = this.command("run-proton.py", ["map"]);
    return new Promise((resolve, reject) => {
      let out = "";
      let err = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("Map read timed out.")); }, 30000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", () => {
        clearTimeout(timer);
        const line = out.split("\n").find((l) => l.startsWith("map_summary: "));
        if (!line) return reject(new Error(err.trim().split("\n").pop() || "No map summary returned."));
        try {
          resolve(JSON.parse(line.slice("map_summary: ".length)) as MapSummary);
        } catch (e) {
          reject(e);
        }
      });
    });
  }
  /**
   * Native tile layers for a rectangle of map tiles, read by the external probe with
   * ReadProcessMemory (no game calls; about 2 s including the Proton start).
   */
  tiles(x0: number, y0: number, w: number, h: number): Promise<TileRegion> {
    if (!this.connected) return Promise.reject(new Error("Connect before reading tiles."));
    const child = this.command("run-proton.py", ["tiles", "--region", ...[x0, y0, w, h].map((n) => String(Math.round(n)))]);
    return new Promise((resolve, reject) => {
      let out = "";
      let err = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("Tile read timed out.")); }, 30000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", () => {
        clearTimeout(timer);
        const line = out.split("\n").find((l) => l.startsWith("tile_region: "));
        if (!line) return reject(new Error(`Tile read failed: ${err.trim().split("\n").at(-1) ?? "no output"}`));
        try {
          resolve(JSON.parse(line.slice("tile_region: ".length)) as TileRegion);
        } catch (e) {
          reject(e);
        }
      });
    });
  }
  /** Interpret one line from the bridge (game-window.py): an answer to a request, or a local stop. */
  bridgeLine(line: string) {
    try {
      const msg = JSON.parse(line);
      if (msg.event === "local_stop") {
        this.cancelQueued();
        this.onLocalStop();
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      this.startNext();
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
    } catch {
      /* Ignore non-protocol diagnostics. */
    }
  }
  /** Interpret one monitor-memory.py JSONL record. */
  guardLine(line: string) {
    let record: GuardRecord;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (record.kind === "started") this.guardState = "active";
    if (record.kind === "monitor_error") this.guardState = "failed";
    if (record.kind === "sample") this.lastGuardSample = record;
    for (const listener of this.guardListeners) listener(record);
    if (record.kind === "termination_requested") {
      const last = this.lastGuardSample;
      const gib = (kib?: number) => (typeof kib === "number" ? `${(kib / 1048576).toFixed(1)} GiB` : "?");
      const reading = last ? `; game ${gib(last.rss_kib)} resident, ${gib(last.swap_kib)} swap, system ${gib(last.available_kib)} available` : "";
      this.fail(`Memory guard stopped the game (${(record.limits ?? []).join(", ")}${reading}); the game's memory kept growing, as when its garbage collector stops collecting. Relaunch before continuing.`);
    }
  }
  /** Hear each game input just before it is sent (the run video marks clicks and keys). */
  onInput(listener: (input: GameInput) => void) {
    this.inputListeners.add(listener);
    return () => void this.inputListeners.delete(listener);
  }
  private announce(input: GameInput) {
    this.inputCount++;
    for (const listener of this.inputListeners) listener(input);
  }
  /** Receive every memory-guard record (samples every 5 s, memory maps, termination). */
  onGuard(listener: (record: GuardRecord) => void) {
    this.guardListeners.add(listener);
    return () => void this.guardListeners.delete(listener);
  }
  /** Hear every reader sample as it arrives (the run's production ledger, production.ts). */
  onSample(listener: (stats: Stats) => void) {
    this.sampleListeners.add(listener);
    return () => void this.sampleListeners.delete(listener);
  }
  /**
   * True once the reader confirms an active local single-player map within the timeout. The
   * reader refuses multiplayer, editor and spectator states, so runs start only after an ok
   * sample; brief unavailable samples are normal on a live stream.
   */
  async singlePlayerConfirmed(timeoutMs = 3000) {
    for (const end = Date.now() + timeoutMs; ; ) {
      if (this.currentStats().status === "ok") return true;
      if (Date.now() >= end) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  /** A refused read names its state on stderr; a multiplayer game ends the connection. */
  readerDiagnostic(text: string) {
    if (/multiplayerGame=1\b/.test(text))
      this.fail("Multiplayer game detected; Crusader Arena only plays single-player maps.");
  }
  private fail(reason: string) {
    this.disconnect();
    this.onClose(reason);
  }
  disconnect() {
    this.events.disconnect();
    this.epoch++;
    const c = this.child;
    this.child = undefined;
    c?.stdin.end();
    c?.kill();
    this.watcher?.kill();
    this.watcher = undefined;
    const guard = this.guard;
    this.guard = undefined;
    guard?.kill();
    this.guardState = "off";
    this.connected = false;
    this.latest = null;
    this.stats = null;
    this.clock = null;
    this.frames.clear();
    this.onStats(null);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Device disconnected"));
    }
    this.pending.clear();
  }
  private rpc(op: string, extra: object = {}, timeoutMs = BRIDGE_TIMEOUT_MS) {
    return new Promise<any>((resolve, reject) => {
      if (!this.child?.stdin.writable)
        return reject(new Error("Connect the game first."));
      const id = randomUUID();
      this.pending.set(id, { resolve, reject, timeoutMs });
      this.startNext();
      this.child.stdin.write(JSON.stringify({ id, op, ...extra }) + "\n");
    });
  }
  /**
   * Starts the time of the request the bridge is on: the oldest unanswered one. The bridge answers
   * one request at a time, in order, so a request's time starts when the one ahead of it is
   * answered. Counted from sending, the status line sent every second timed out behind a save's
   * 13 s run of keys, and the timeout disconnected the game in the middle of the save (live, 2026-10-14).
   */
  private startNext() {
    const head = this.pending.entries().next();
    if (head.done || head.value[1].timer) return;
    const [id, p] = head.value;
    p.timer = setTimeout(() => {
      this.pending.delete(id);
      p.reject(new Error("Game request timed out; reconnect before retrying."));
      this.fail("Game bridge timed out.");
    }, p.timeoutMs);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const next = this.tail
      .catch(() => {})
      .then(() => {
        if (epoch !== this.epoch) throw new Error("Control cancelled.");
        return fn();
      });
    this.tail = next;
    return next;
  }
  status(status: object) {
    if (this.connected) void this.rpc("status", { status }).catch(() => {});
  }
  cancelQueued() {
    this.epoch++;
  }
  /**
   * Width the bridge scales captures down to (the run's screenshotWidth); undefined keeps the
   * window's own size. Input is scaled back to the window (windowAction).
   */
  screenshotWidth: number | undefined;
  /**
   * The game clock of the reader's latest valid sample: its tick, its map and when the host saw it.
   * Kept through the reader's brief unavailable samples, so frame ages (frameAge) stay on the game
   * clock; one older than CLOCK_STALE_MS no longer counts.
   */
  private clock: { tick: number; map: string; at: number } | null = null;
  gameClock(): { tick: number; map: string } | null {
    const stats = this.currentStats();
    const o = stats.observation;
    if (stats.status === "ok" && typeof o?.game_time === "number" && typeof o.map_name === "string")
      this.clock = { tick: o.game_time, map: o.map_name, at: Date.now() };
    return this.clock && Date.now() - this.clock.at <= CLOCK_STALE_MS ? { tick: this.clock.tick, map: this.clock.map } : null;
  }
  /**
   * Seconds of play since `frame` was captured (frameAgeSeconds): game seconds on the game clock,
   * or without one real time at the benchmark speed less `creditMs`, the time the host kept the
   * game paused since the capture.
   */
  frameAge(frame: Frame, creditMs = 0) {
    return frameAgeSeconds(frame, this.gameClock(), Date.now(), creditMs);
  }
  async capture(): Promise<Frame> {
    return this.serial(async () => {
      // The clock before the capture: at most a reader interval early, so an age only errs long.
      const clock = this.gameClock();
      let result;
      try {
        result = await this.rpc("capture", this.screenshotWidth ? { width: this.screenshotWidth } : {});
      } catch (error) {
        this.fail("Game capture failed; reconnect before continuing.");
        throw error;
      }
      const f: Frame = { ...result, id: randomUUID(), receivedAt: Date.now(), ...(clock ? { gameTick: clock.tick, mapName: clock.map } : {}) };
      this.latest = f;
      this.frames.set(f.id, f);
      for (const [id, old] of this.frames)
        if (Date.now() - old.receivedAt > 600000) this.frames.delete(id);
      while (this.frames.size > 64)
        this.frames.delete(this.frames.keys().next().value!);
      return f;
    });
  }
  /**
   * Set during a run with fast waits (controller.ts): throws while the game may run at another
   * speed than the benchmark's, so no input aimed at the game (action, hotkey) goes out then. The
   * host's own pause and speed keys (pressKey) are exempt.
   */
  speedGuard?: () => void;
  async action(action: GameAction, frameId: string, guard?: () => void, ageCreditMs = 0) {
    return this.serial(async () => {
      guard?.();
      this.speedGuard?.();
      const frame = this.frames.get(frameId);
      if (!frame) throw new Error("Unknown or expired game image: call observe for a fresh screenshot.");
      validateFrameAction(action, frame, this.frameAge(frame, ageCreditMs));
      this.announce({ ...action, width: frame.width, height: frame.height });
      return this.rpc("action", {
        action: {
          ...windowAction(action, frame),
          windowId: frame.windowId,
          width: frame.windowWidth ?? frame.width,
          height: frame.windowHeight ?? frame.height,
        },
      });
    });
  }
  /**
   * Move the pointer to `point` of `frameId`'s image without clicking, so the game shows what is
   * under it (observation.mouse_tile): placement checks the tile a click there would pick.
   * Harness-internal, like hotkey: the model's actions have no move. Not counted as input.
   */
  async move(point: { x: number; y: number }, frameId: string, ageCreditMs = 0) {
    return this.serial(async () => {
      this.speedGuard?.();
      const frame = this.frames.get(frameId);
      if (!frame) throw new Error("Unknown or expired game image: call observe for a fresh screenshot.");
      const at = { type: "click" as const, x: point.x, y: point.y, button: 1 as const };
      validateFrameAction(at, frame, this.frameAge(frame, ageCreditMs));
      const { x, y } = windowAction(at, frame);
      return this.rpc("action", {
        action: { type: "move", x, y, windowId: frame.windowId, width: frame.windowWidth ?? frame.width, height: frame.windowHeight ?? frame.height },
      }) as Promise<{ at?: number } | undefined>;
    });
  }
  /**
   * Trigger one whitelisted game hotkey by action name (the bridge resolves the
   * game's own binding). Harness-internal: not reachable through game_action.
   * No coordinates, so only the latest image's window identity is needed.
   */
  async hotkey(name: GameHotkey, guard?: () => void) {
    return this.serial(async () => {
      guard?.();
      this.speedGuard?.();
      const frame = this.latest;
      if (!frame) throw new Error("Capture the game before sending a hotkey.");
      this.announce({ type: "hotkey", name, width: frame.width, height: frame.height });
      return this.rpc("action", {
        action: { type: "hotkey", name, windowId: frame.windowId, width: frame.windowWidth ?? frame.width, height: frame.windowHeight ?? frame.height },
      }) as Promise<{ at?: number }>;
    });
  }
  /**
   * Type a run of keys in one bridge request (the runner's save name, about 100 keys): the bridge
   * checks the window and its focus once, before the first key, then presses each in turn. One
   * request a key took 0.71 s each, 67 to 73 s for a save name (live, 2026-10-14). The keys carry
   * no coordinates, so `frameId`'s capture serves only for the window and its age.
   */
  async keys(keys: readonly AllowedKey[], frameId: string) {
    return this.serial(async () => {
      this.speedGuard?.();
      if (keys.length < 1 || keys.length > KEY_RUN_LIMIT) throw new Error(`A run of keys has 1 to ${KEY_RUN_LIMIT} keys.`);
      const frame = this.frames.get(frameId);
      if (!frame) throw new Error("Unknown or expired game image: call observe for a fresh screenshot.");
      validateFrameAction({ type: "key", key: keys[0] }, frame, this.frameAge(frame));
      for (const key of keys) this.announce({ type: "key", key, width: frame.width, height: frame.height });
      return this.rpc("action", {
        action: { type: "keys", keys, windowId: frame.windowId, width: frame.windowWidth ?? frame.width, height: frame.windowHeight ?? frame.height },
      }, BRIDGE_TIMEOUT_MS + keys.length * KEY_RUN_MS) as Promise<{ at?: number } | undefined>;
    });
  }
  /**
   * Send one of the host's own control keys (pause, speed) the same way as hotkey(): the latest
   * captured frame's window identity, no fresh capture. These carry no coordinates either, so an
   * old frame serves as well as a new one; the caller captures once first if there is none yet.
   */
  async pressKey(key: HostKey, guard?: () => void) {
    return this.serial(async () => {
      guard?.();
      const frame = this.latest;
      if (!frame) throw new Error("Capture the game before sending a key.");
      this.announce({ type: "key", key, width: frame.width, height: frame.height });
      return this.rpc("action", {
        action: { type: "key", key, windowId: frame.windowId, width: frame.windowWidth ?? frame.width, height: frame.windowHeight ?? frame.height },
      }) as Promise<{ at?: number } | undefined>;
    });
  }
}

/** Game actions the bridge accepts as hotkeys (tools/ubuntu/game-window.py HOTKEY_NAMES). */
export type GameHotkey =
  | "HomeKeep" | "Granary" | "Market" | "Barracks" | "Armoury" | "Signpost" | "EngineersGuild"
  | "MercPost" | "BedouinStockade" | "Lord" | "IncreaseEngineSpeed" | "DecreaseEngineSpeed"
  | "FlattenLandscape"
  | `SetBookmark${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | `GotoBookmark${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

/** The host's own control keys, sent with pressKey() (pause and the game's speed keys). */
export type HostKey = "P" | "+" | "-";

export type AllowedKey = (typeof allowedKeys)[number];
/** Real time the bridge may take for one request, from when it gets to it, before the host gives up on the connection. */
const BRIDGE_TIMEOUT_MS = 12_000;
/** Most keys in one run (tools/ubuntu/game-window.py checks the same). */
export const KEY_RUN_LIMIT = 200;
/** Time allowed per key of a run: the bridge holds each 70 ms and waits 50 ms after it. */
const KEY_RUN_MS = 250;
