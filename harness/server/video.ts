import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../tools/video/render-video.py", import.meta.url));
const compactScript = fileURLToPath(new URL("../../tools/video/compact-recording.py", import.meta.url));
let queue: Promise<unknown> = Promise.resolve();

export type VideoResult = { output: string; seconds: number; turns: number; frames: number; recorded: boolean };

/** `nice -n 15` on platforms that have it: compaction is CPU-heavy and must not starve the host. */
function spawnLowPriority(command: string, args: string[]): ChildProcess {
  const stdio: Array<"ignore" | "pipe"> = ["ignore", "pipe", "pipe"];
  return process.platform === "win32"
    ? spawn(command, args, { stdio })
    : spawn("nice", ["-n", "15", command, ...args], { stdio });
}

/**
 * Render <run>/video.mp4 with tools/video/render-video.py (Pillow and ffmpeg on the host), then
 * compact the run's raw recording frames into recording/frames.mp4 with compact-recording.py.
 * Both steps share one serial queue (a render failure skips compaction; a compaction failure is
 * only logged, leaving the JPEGs). The run is reported through `log`, which resolves to the
 * render's result, or null if it failed.
 */
export function renderVideo(
  runDirectory: string,
  log: (text: string) => void = () => {},
  spawnRenderer: (args: string[]) => ChildProcess = (args) =>
    spawn(process.env.PYTHON || "python3", [script, ...args], { stdio: ["ignore", "pipe", "pipe"] }),
  spawnCompactor: (args: string[]) => ChildProcess = (args) =>
    spawnLowPriority(process.env.PYTHON || "python3", [compactScript, ...args]),
): Promise<VideoResult | null> {
  const job = queue.then(async () => {
    const result = await new Promise<VideoResult | null>((resolve) => {
      const child = spawnRenderer([runDirectory, "--quiet"]);
      let out = "";
      let err = "";
      child.stdout?.on("data", (d) => (out += d));
      child.stderr?.on("data", (d) => (err = (err + d).slice(-2000)));
      child.on("error", (error) => {
        log(`Video render could not start: ${error.message}`);
        resolve(null);
      });
      child.on("close", (code) => {
        if (code === 0) {
          try {
            const parsed = JSON.parse(out.trim().split("\n").at(-1) || "") as VideoResult;
            const minutes = Math.floor(parsed.seconds / 60);
            const seconds = String(Math.round(parsed.seconds % 60)).padStart(2, "0");
            log(`Video saved: ${parsed.output} (${minutes}:${seconds}).`);
            return resolve(parsed);
          } catch {}
        }
        log(`Video render failed: ${err.trim().split("\n").at(-1) || `exit ${code}`}`);
        resolve(null);
      });
    });
    if (result) await compactRecording(runDirectory, log, spawnCompactor);
    return result;
  });
  queue = job;
  return job;
}

/** Compacts <run>/recording/frames/*.jpg into frames.mp4 (compact-recording.py); logs, never throws. */
function compactRecording(
  runDirectory: string,
  log: (text: string) => void,
  spawnCompactor: (args: string[]) => ChildProcess,
): Promise<void> {
  return new Promise((resolve) => {
    const child = spawnCompactor([runDirectory, "--quiet"]);
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err = (err + d).slice(-2000)));
    child.on("error", (error) => {
      log(`Recording compaction could not start: ${error.message}`);
      resolve();
    });
    child.on("close", (code) => {
      if (code === 0) {
        try {
          const outcome = Object.values(JSON.parse(out.trim().split("\n").at(-1) || "{}"))[0];
          if (outcome && typeof outcome === "object") {
            const { source_bytes, video_bytes } = outcome as { source_bytes: number; video_bytes: number };
            log(`Recording compacted: ${(source_bytes / 1e6).toFixed(0)} MB -> ${(video_bytes / 1e6).toFixed(0)} MB.`);
          } else if (outcome) {
            log(`Recording not compacted: ${outcome}.`);
          }
          return resolve();
        } catch {}
      }
      log(`Recording compaction failed: ${err.trim().split("\n").at(-1) || `exit ${code}`}`);
      resolve();
    });
  });
}
