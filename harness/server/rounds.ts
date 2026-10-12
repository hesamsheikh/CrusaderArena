/**
 * Rounds: every run on one benchmark (map) is played on the benchmark version of that map's last
 * run, so the models on a map stay comparable after later versions change the prompt or tools.
 * `benchmark-rounds.json` records each benchmark's round: the version, its fingerprint and the git
 * commit to run it from. A map's first valid run sets its round, and a run with --new-round moves
 * it to the checkout's version once valid (docs/benchmark.md#rounds). The file is not part of the
 * fingerprint: moving a round changes no version.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const ROUNDS_FILE = path.join(root, "benchmark-rounds.json");

export type Round = { version: string; fingerprint: string; commit: string; since: string };
export type Rounds = { about?: string; rounds: Record<string, Round> };

/** The version, fingerprint and commit of a checkout's running host. */
export type Checkout = { version: string | null; fingerprint: string; commit: string | null };

export function readRounds(file = ROUNDS_FILE): Rounds {
  if (!existsSync(file)) return { rounds: {} };
  const data = JSON.parse(readFileSync(file, "utf8")) as Rounds;
  return { ...data, rounds: data.rounds ?? {} };
}

/** Records `benchmark`'s round as `round`, keeping the file's other rounds and its note. */
export function writeRound(benchmark: string, round: Round, file = ROUNDS_FILE) {
  const data = readRounds(file);
  data.rounds = Object.fromEntries(Object.entries({ ...data.rounds, [benchmark]: round }).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/**
 * How a run of `benchmark` is played from this checkout:
 * - `here`: on this checkout's version. `startsRound` when the run, once valid, sets the round
 *   (the benchmark has none yet, or --new-round moves it to this version).
 * - `elsewhere`: on the round's version, from its commit.
 * Runs outside the versioned benchmarks (Custom, or no version on this checkout) play here and
 * start nothing.
 */
export function roundPlan(rounds: Rounds, benchmark: string, here: Checkout, newRound: boolean):
  | { kind: "here"; startsRound: boolean; round?: Round }
  | { kind: "elsewhere"; round: Round } {
  const round = rounds.rounds[benchmark];
  if (benchmark === "Custom" || !here.version) return { kind: "here", startsRound: false, round };
  if (newRound) return { kind: "here", startsRound: round?.version !== here.version, round };
  if (!round) return { kind: "here", startsRound: true };
  if (round.version === here.version) return { kind: "here", startsRound: false, round };
  return { kind: "elsewhere", round };
}

/** The runner's arguments for the round's own runner: its port, and without --new-round. */
export function forwardedArgs(argv: string[], port: string) {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--new-round") continue;
    if (arg === "--port") { i++; continue; }
    if (arg.startsWith("--port=")) continue;
    out.push(arg);
  }
  return [...out, "--port", port];
}
