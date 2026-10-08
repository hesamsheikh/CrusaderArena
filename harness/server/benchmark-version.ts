/**
 * Benchmark versions. Runs are comparable only when everything that decides how a run plays and
 * is scored is the same: the prompts, the tools and their code, the run loop and its rules, the
 * scoring, the game-machine helpers and the reader. The fingerprint is a hash of those files; every
 * fingerprint the benchmark accepts is listed with its version in benchmark-versions.json, and a
 * test fails when the files change without a new entry. Each run records its version.
 *
 *   npm run benchmark-version -- check                  # is the current code a known version?
 *   npm run benchmark-version -- bump "what changed"    # a behavioural change: next version
 *   npm run benchmark-version -- relock "why"           # same behaviour (comments, refactors)
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BenchmarkStamp } from "../shared/protocol.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const VERSIONS_FILE = path.join(root, "benchmark-versions.json");

/** Paths whose files decide how a run plays or is scored. */
const BEHAVIOUR_PATHS = ["harness/server", "harness/shared", "prompt", "tools/ubuntu", "src", "CMakeLists.txt", "cmake", "package-lock.json"];
/** Files under those paths that only report, render or test. */
const NOT_BEHAVIOUR = [/\.test\.ts$/, /(^|\/)test_[^/]*\.py$/, /^harness\/server\/run-report\.ts$/, /^harness\/server\/video\.ts$/];

export type VersionEntry = { version: string; fingerprint: string; date: string; note: string };
export type Versions = { current: string; history: VersionEntry[] };

function git(args: string[], input?: string) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** The behavioural files: tracked or new (not ignored), present on disk, sorted. */
export function behaviourFiles() {
  return git(["ls-files", "--cached", "--others", "--exclude-standard", "--", ...BEHAVIOUR_PATHS])
    .split("\n")
    .filter((file) => file && !NOT_BEHAVIOUR.some((pattern) => pattern.test(file)) && existsSync(path.join(root, file)))
    .sort()
    .filter((file, i, all) => file !== all[i - 1]);
}

/**
 * SHA-256 over each behavioural file's path and git blob ID. Blob IDs apply git's line-ending
 * rules, so a clean checkout on any platform gives the fingerprint of its commit.
 */
export function benchmarkFingerprint() {
  const files = behaviourFiles();
  const blobs = git(["hash-object", "--stdin-paths"], files.join("\n") + "\n").trim().split("\n");
  if (blobs.length !== files.length) throw new Error("git hash-object returned the wrong number of IDs.");
  return createHash("sha256").update(files.map((file, i) => `${file} ${blobs[i]}`).join("\n")).digest("hex");
}

/**
 * The private preparation images (.internal/ui-reference): which guide the model gets is part of
 * what it sees, but the images are not in the repository, so they are recorded beside the version.
 */
export function guideFingerprint(): string | null {
  const dir = path.join(root, ".internal/ui-reference");
  if (!existsSync(dir)) return null;
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const file = path.join(d, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.(png|jpe?g)$/i.test(name)) files.push(file);
    }
  };
  walk(dir);
  if (!files.length) return null;
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${path.relative(dir, file)}\0`).update(readFileSync(file));
  return hash.digest("hex");
}

export function readVersions(): Versions {
  return JSON.parse(readFileSync(VERSIONS_FILE, "utf8")) as Versions;
}

/** The version a fingerprint belongs to, or null when no version accepts it. */
export function versionOf(fingerprint: string, versions = readVersions()) {
  return versions.history.find((entry) => entry.fingerprint === fingerprint)?.version ?? null;
}

/** What a run records about the benchmark it ran, read once when the host starts. */
export function readBenchmarkStamp(): BenchmarkStamp {
  const fingerprint = benchmarkFingerprint();
  let version: string | null = null;
  try {
    version = versionOf(fingerprint);
  } catch {
    version = null;
  }
  return { version, fingerprint, guide: guideFingerprint() };
}

function nextVersion(current: string) {
  const n = Number(/^v(\d+)$/.exec(current)?.[1]);
  if (!Number.isInteger(n)) throw new Error(`Unexpected version name ${JSON.stringify(current)}; versions are v1, v2, …`);
  return `v${n + 1}`;
}

function main() {
  const [command, ...words] = process.argv.slice(2);
  const note = words.join(" ").trim();
  const fingerprint = benchmarkFingerprint();
  const versions: Versions = existsSync(VERSIONS_FILE) ? readVersions() : { current: "", history: [] };
  const known = versionOf(fingerprint, versions);
  if (command === "check" || !command) {
    console.log(known ? `${known} (fingerprint ${fingerprint.slice(0, 12)})` : `No version for fingerprint ${fingerprint.slice(0, 12)}: bump or relock (see harness/server/benchmark-version.ts).`);
    process.exitCode = known === versions.current ? 0 : 1;
    return;
  }
  if (command !== "bump" && command !== "relock") throw new Error("Commands: check, bump \"note\", relock \"note\".");
  if (!note) throw new Error(`Say what changed: npm run benchmark-version -- ${command} "..."`);
  if (known) throw new Error(`The current files are already ${known}; nothing to record.`);
  const version = command === "bump" ? (versions.current ? nextVersion(versions.current) : "v1") : versions.current;
  if (!version) throw new Error("There is no version to relock yet; use bump for the first one.");
  versions.current = version;
  versions.history.push({ version, fingerprint, date: new Date().toISOString().slice(0, 10), note });
  writeFileSync(VERSIONS_FILE, JSON.stringify(versions, null, 2) + "\n");
  console.log(`${version}: recorded fingerprint ${fingerprint.slice(0, 12)}. Commit benchmark-versions.json with the change.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
