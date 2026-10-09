/**
 * Benchmark versions. Runs are comparable only when everything that decides how a run plays and
 * is scored is the same: the prompts, the tools and their code, the run loop and its rules, the
 * scoring, the game-machine helpers and the reader. The fingerprint is a hash of those files; every
 * fingerprint the benchmark accepts is listed with its version in benchmark-versions.json, and a
 * test fails when the files change without a new entry. Each run records its version.
 *
 * Versions follow semantic versioning, MAJOR.MINOR.PATCH:
 * - major: the task or the scoring changes; scores are not comparable across majors;
 * - minor: what the model is told or can do changes (prompts, tools, run rules); compare runs
 *   within one minor version;
 * - patch: a fix that changes how the harness behaves, not the task, the prompts, the tools'
 *   definitions or the scoring; runs stay comparable across patches;
 * - relock: no change in behaviour (comments, refactors, failure handling); the version stays.
 *
 *   npm run benchmark-version -- check                          # is the current code a known version?
 *   npm run benchmark-version -- bump patch|minor|major "what"  # behaviour changed: next version
 *   npm run benchmark-version -- relock "why"                   # same behaviour
 *
 * The repository's version is the benchmark's: bump writes it into package.json and
 * package-lock.json before taking the fingerprint (the lock file is part of it).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BenchmarkStamp } from "../shared/protocol.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const VERSIONS_FILE = path.join(root, "benchmark-versions.json");

/**
 * Git pathspec of the files that decide how a run plays or is scored, leaving out files under
 * those paths that only report, render or test. The run's uncommitted-change check (version.ts)
 * uses the same set.
 */
export const BEHAVIOUR_PATHSPEC = [
  "harness/server", "harness/shared", "prompt", "tools/ubuntu", "src", "CMakeLists.txt", "cmake", "package-lock.json",
  ":(exclude,glob)**/*.test.ts", ":(exclude,glob)**/test_*.py",
  ":(exclude)harness/server/run-report.ts", ":(exclude)harness/server/video.ts",
];

export type VersionEntry = { version: string; fingerprint: string; date: string; note: string };
export type Versions = { current: string; history: VersionEntry[] };

function git(args: string[], input?: string) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** The behavioural files: tracked or new (not ignored), present on disk, sorted. */
export function behaviourFiles() {
  return git(["ls-files", "--cached", "--others", "--exclude-standard", "--", ...BEHAVIOUR_PATHSPEC])
    .split("\n")
    .filter((file) => file && existsSync(path.join(root, file)))
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

/** Sets the version in package.json and package-lock.json (both npm's two-space JSON). */
export function setPackageVersion(version: string) {
  for (const file of ["package.json", "package-lock.json"]) {
    const target = path.join(root, file);
    const data = JSON.parse(readFileSync(target, "utf8"));
    data.version = version;
    if (data.packages?.[""]) data.packages[""].version = version;
    writeFileSync(target, JSON.stringify(data, null, 2) + "\n");
  }
}

export const LEVELS = ["major", "minor", "patch"] as const;
export type Level = (typeof LEVELS)[number];

/** The version after `current` at `level`; the first version is 1.0.0. */
export function nextVersion(current: string, level: Level) {
  if (!current) return "1.0.0";
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)?.slice(1).map(Number);
  if (!parts) throw new Error(`Unexpected version ${JSON.stringify(current)}; versions are MAJOR.MINOR.PATCH, such as 1.0.0.`);
  const [major, minor, patch] = parts;
  return level === "major" ? `${major + 1}.0.0` : level === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

function main() {
  const [command, ...words] = process.argv.slice(2);
  const fingerprint = benchmarkFingerprint();
  const versions: Versions = existsSync(VERSIONS_FILE) ? readVersions() : { current: "", history: [] };
  const known = versionOf(fingerprint, versions);
  if (command === "check" || !command) {
    console.log(known ? `${known} (fingerprint ${fingerprint.slice(0, 12)})` : `No version for fingerprint ${fingerprint.slice(0, 12)}: bump or relock (see harness/server/benchmark-version.ts).`);
    process.exitCode = known === versions.current ? 0 : 1;
    return;
  }
  if (command !== "bump" && command !== "relock") throw new Error('Commands: check, bump patch|minor|major "note", relock "note".');
  const level = command === "bump" ? words.shift() : undefined;
  const note = words.join(" ").trim();
  if (command === "bump" && !LEVELS.includes(level as Level))
    throw new Error('Say which part changes: bump patch, bump minor or bump major (see harness/server/benchmark-version.ts).');
  if (!note) throw new Error(`Say what changed: npm run benchmark-version -- ${command}${level ? ` ${level}` : ""} "..."`);
  if (known) throw new Error(`The current files are already ${known}; nothing to record.`);
  const version = command === "bump" ? nextVersion(versions.current, level as Level) : versions.current;
  if (!version) throw new Error("There is no version to relock yet; use bump for the first one.");
  if (command === "bump") setPackageVersion(version);
  const recorded = command === "bump" ? benchmarkFingerprint() : fingerprint;
  versions.current = version;
  versions.history.push({ version, fingerprint: recorded, date: new Date().toISOString().slice(0, 10), note });
  writeFileSync(VERSIONS_FILE, JSON.stringify(versions, null, 2) + "\n");
  console.log(`${version}: recorded fingerprint ${recorded.slice(0, 12)}. Commit benchmark-versions.json${command === "bump" ? ", package.json and package-lock.json" : ""} with the change${command === "bump" ? ", and add the version's section to CHANGELOG.md" : "; note it in CHANGELOG.md under [Unreleased] if users should know"}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
