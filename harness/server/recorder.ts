import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Stats } from "../shared/protocol.js";
import { remoteScript, type GameInput } from "./device.js";

/** Compact reader snapshot stored with each frame for the video's stats bar. */
export function frameStats(stats: Stats) {
  const o = stats.status === "ok" ? stats.observation : null;
  if (!o) return null;
  return {
    gameTime: o.game_time,
    paused: o.paused,
    gold: o.gold,
    population: o.population,
    popularity: o.popularity,
    housing: o.settlement?.housing_cap,
    food: o.settlement?.total_food,
    wood: o.resources_by_name?.wood_planks ?? o.wood_planks,
    stone: o.resources_by_name?.stone,
    iron: o.resources_by_name?.iron,
  };
}

type Header = { event?: string; t?: number; w?: number; h?: number; sw?: number; sh?: number; bytes?: number; ms?: number; error?: string };

/**
 * Splits record-window.py output (a JSON header line, then `bytes` bytes of JPEG when
 * the header announces a frame) into headers and frame data across arbitrary chunks.
 */
export class FrameStreamParser {
  private buffer: Buffer = Buffer.alloc(0);
  constructor(private onRecord: (header: Header, jpeg?: Buffer) => void) {}
  push(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (true) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) {
        if (this.buffer.length > 65536) throw new Error("Recorder header too long.");
        return;
      }
      const header = JSON.parse(this.buffer.subarray(0, newline).toString("utf8")) as Header;
      const size = typeof header.bytes === "number" ? header.bytes : 0;
      if (this.buffer.length < newline + 1 + size) return;
      const jpeg = size ? Buffer.from(this.buffer.subarray(newline + 1, newline + 1 + size)) : undefined;
      this.buffer = this.buffer.subarray(newline + 1 + size);
      this.onRecord(header, jpeg);
    }
  }
}

/**
 * Idle play is captured sparsely (the video fast-forwards it) and the seconds after each
 * input densely. A 1920×1080 capture costs about 74 ms on the laptop (live 2026-09-30).
 */
export type RecordingOptions = { fps: number; burstFps: number; burstSeconds: number; width: number; quality: number };
export const defaultRecording: RecordingOptions = { fps: 4, burstFps: 10, burstSeconds: 2.5, width: 1440, quality: 78 };

/**
 * Records the game window for a run video while the agent acts, not while it thinks.
 * A separate SSH session runs tools/ubuntu/record-window.py (capture only, no input), so
 * recording never queues behind the agent's screenshots and clicks. Frames go to
 *
 *   <run>/recording/frames/000001.jpg …
 *   <run>/recording/frames.jsonl   {i, at: Mac receive ms, t: game-host capture ms, w, h, sw, sh, ms, stats}
 *   <run>/recording/inputs.jsonl   {at: Mac send ms, type, x, y, key, name, …, width, height}
 *
 * and run/hold marks to the run's events. Each input also asks the recorder for a burst of
 * frames, and lets the video play actions at real speed and fast-forward idle play. tools/video/render-video.py turns these and events.jsonl
 * into video.mp4. A recording failure is logged and never stops the run.
 */
export class RunRecorder {
  private child?: ChildProcessWithoutNullStreams;
  private ping?: NodeJS.Timeout;
  private active = false;
  private stopped = false;
  private restarts = 0;
  private closed?: Promise<void>;
  readonly directory: string;
  frames = 0;
  bytes = 0;
  lastError?: string;
  constructor(
    runDirectory: string,
    private stats: () => Stats,
    private event: (event: Record<string, unknown>) => void,
    private log: (text: string) => void,
    readonly options: RecordingOptions = defaultRecording,
    private spawnRecorder: (args: string[]) => ChildProcessWithoutNullStreams = (args) =>
      remoteScript("record-window.py", args),
    private now: () => number = Date.now,
  ) {
    this.directory = path.join(runDirectory, "recording");
    mkdirSync(path.join(this.directory, "frames"), { recursive: true, mode: 0o700 });
  }
  start() {
    if (this.child || this.stopped) return;
    const child = this.spawnRecorder([
      "--fps", String(this.options.fps),
      "--burst-fps", String(this.options.burstFps),
      "--burst-seconds", String(this.options.burstSeconds),
      "--width", String(this.options.width),
      "--quality", String(this.options.quality),
    ]);
    this.child = child;
    let diagnostics = "";
    const parser = new FrameStreamParser((header, jpeg) => this.record(header, jpeg));
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      try {
        parser.push(chunk);
      } catch (error) {
        this.fail(child, `Unreadable recorder output: ${String(error)}`);
      }
    });
    child.stderr.on("data", (b) => (diagnostics = (diagnostics + b.toString()).slice(-800)));
    child.stdin.on("error", () => {});
    this.closed = new Promise((resolve) => {
      child.on("error", () => resolve());
      child.on("close", () => {
        resolve();
        if (this.child === child)
          this.fail(child, diagnostics.trim().split("\n").at(-1) || "Recorder session closed.");
      });
    });
    this.ping = setInterval(() => this.send("ping"), 5000);
    this.event({ type: "recording_started", ...this.options });
    if (this.active) this.send("run");
  }
  /** Capture while the game runs for the agent's actions; hold while the agent thinks. */
  setActive(active: boolean) {
    if (this.stopped || this.active === active) return;
    this.active = active;
    this.send(active ? "run" : "hold");
    this.event({ type: "recording_state", state: active ? "run" : "hold" });
  }
  /** A click, key or hotkey about to reach the game (GameDevice.onInput). */
  input(input: GameInput) {
    if (this.stopped) return;
    appendFileSync(
      path.join(this.directory, "inputs.jsonl"),
      JSON.stringify({ at: this.now(), ...input }) + "\n",
      { mode: 0o600 },
    );
    if (this.active) this.send("burst");
  }
  async stop() {
    if (this.stopped) return this.summary();
    this.setActive(false);
    this.stopped = true;
    clearInterval(this.ping);
    const child = this.child;
    this.child = undefined;
    if (child) {
      this.send("quit", child);
      child.stdin.end();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.closed, new Promise((resolve) => (timer = setTimeout(resolve, 3000)))]);
      clearTimeout(timer);
      child.kill();
    }
    const summary = this.summary();
    this.event({ type: "recording_stopped", ...summary });
    return summary;
  }
  summary() {
    return {
      frames: this.frames,
      bytes: this.bytes,
      directory: this.directory,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
  private send(command: string, child = this.child) {
    if (child?.stdin.writable) child.stdin.write(command + "\n");
  }
  private record(header: Header, jpeg?: Buffer) {
    if (header.event === "error") {
      // Transient (window briefly unavailable); the recorder retries each second.
      if (header.error !== this.lastError) this.event({ type: "recording_error", error: header.error });
      this.lastError = header.error;
      return;
    }
    if (!jpeg || typeof header.t !== "number") return;
    const i = ++this.frames;
    const file = `${String(i).padStart(6, "0")}.jpg`;
    writeFileSync(path.join(this.directory, "frames", file), jpeg, { mode: 0o600 });
    this.bytes += jpeg.length;
    appendFileSync(
      path.join(this.directory, "frames.jsonl"),
      JSON.stringify({
        i,
        file,
        at: this.now(),
        t: header.t,
        w: header.w,
        h: header.h,
        sw: header.sw,
        sh: header.sh,
        ms: header.ms,
        stats: frameStats(this.stats()),
      }) + "\n",
      { mode: 0o600 },
    );
  }
  private fail(child: ChildProcessWithoutNullStreams, reason: string) {
    if (this.child !== child) return;
    this.child = undefined;
    clearInterval(this.ping);
    child.kill();
    this.lastError = reason;
    this.event({ type: "recording_error", error: reason, restarts: this.restarts });
    if (this.stopped) return;
    if (this.restarts++ < 3) {
      this.log(`Recording interrupted (${reason}); restarting the recorder.`);
      setTimeout(() => this.start(), 2000);
    } else this.log(`Recording stopped after repeated failures (${reason}); the run continues.`);
  }
}
