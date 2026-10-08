import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../tools/video/render-video.py", import.meta.url));
let queue: Promise<unknown> = Promise.resolve();

export type VideoResult = { output: string; seconds: number; turns: number; frames: number; recorded: boolean };

/**
 * Render <run>/video.mp4 with tools/video/render-video.py (Pillow and ffmpeg on the host).
 * Renders run one at a time; a failure is reported through `log` and resolves to null.
 */
export function renderVideo(
  runDirectory: string,
  log: (text: string) => void = () => {},
  spawnRenderer = (args: string[]) =>
    spawn(process.env.PYTHON || "python3", [script, ...args], { stdio: ["ignore", "pipe", "pipe"] }),
): Promise<VideoResult | null> {
  const job = queue.then(
    () =>
      new Promise<VideoResult | null>((resolve) => {
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
              const result = JSON.parse(out.trim().split("\n").at(-1) || "") as VideoResult;
              const minutes = Math.floor(result.seconds / 60);
              const seconds = String(Math.round(result.seconds % 60)).padStart(2, "0");
              log(`Video saved: ${result.output} (${minutes}:${seconds}).`);
              return resolve(result);
            } catch {}
          }
          log(`Video render failed: ${err.trim().split("\n").at(-1) || `exit ${code}`}`);
          resolve(null);
        });
      }),
  );
  queue = job;
  return job;
}
