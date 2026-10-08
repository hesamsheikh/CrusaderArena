import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessVersion } from "../shared/protocol.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
/** Paths whose contents decide how a run behaves; docs and notes do not. */
const RUN_PATHS = ["harness", "prompt", "src", "tools", "package.json", "package-lock.json"];

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function git(...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/**
 * The code this host process runs, read once at start: the server does not reload its modules,
 * so later edits only take effect after a restart.
 */
function readCodeVersion(): Pick<HarnessVersion, "commit" | "dirty" | "diffSha256"> {
  const commit = git("rev-parse", "HEAD")?.trim() || null;
  if (!commit) return { commit: null, dirty: null };
  const diff = git("diff", "HEAD", "--", ...RUN_PATHS);
  const untracked = git("ls-files", "--others", "--exclude-standard", "--", ...RUN_PATHS);
  if (diff === null || untracked === null) return { commit, dirty: null };
  const added = untracked.split("\n").filter(Boolean).sort();
  if (!diff && !added.length) return { commit, dirty: false };
  const hash = createHash("sha256").update(diff);
  try {
    for (const file of added) hash.update(`\0${file}\0`).update(readFileSync(path.join(root, file)));
  } catch {
    return { commit, dirty: true };
  }
  return { commit, dirty: true, diffSha256: hash.digest("hex") };
}

export const codeVersion = readCodeVersion();
