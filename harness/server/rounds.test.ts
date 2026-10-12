import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { forwardedArgs, readRounds, roundPlan, writeRound, type Rounds } from "./rounds.js";

const oasis = { version: "1.5.1", fingerprint: "e5d9", commit: "fe97546", since: "2026-10-11" };
const rounds: Rounds = { rounds: { "Oasis by the Sea construction": oasis } };
const here = { version: "1.5.6", fingerprint: "bb6e", commit: "9c34b50" };

test("a run plays on its benchmark's round, here only when the round is this version", () => {
  // Claude Opus 5.5 joining the Oasis round after 1.5.6: it plays 1.5.1 from the round's commit.
  assert.deepEqual(roundPlan(rounds, "Oasis by the Sea construction", here, false), { kind: "elsewhere", round: oasis });
  assert.deepEqual(roundPlan(rounds, "Oasis by the Sea construction", { ...here, version: "1.5.1" }, false),
    { kind: "here", startsRound: false, round: oasis });
  // A benchmark's first run starts its round on this version; --new-round moves an older one.
  assert.deepEqual(roundPlan(rounds, "Large Barren Desert construction", here, false), { kind: "here", startsRound: true });
  assert.deepEqual(roundPlan(rounds, "Oasis by the Sea construction", here, true), { kind: "here", startsRound: true, round: oasis });
  assert.equal(roundPlan(rounds, "Oasis by the Sea construction", { ...here, version: "1.5.1" }, true).kind, "here");
  // Custom runs and an unversioned checkout have no rounds.
  assert.deepEqual(roundPlan(rounds, "Custom", here, false), { kind: "here", startsRound: false, round: undefined });
  assert.deepEqual(roundPlan(rounds, "Oasis by the Sea construction", { ...here, version: null }, false),
    { kind: "here", startsRound: false, round: oasis });
});

test("the round's runner gets the same arguments on its own port, without --new-round", () => {
  assert.deepEqual(
    forwardedArgs(["--save", "Oasis by the Sea benchmark start", "--model", "Claude Opus 5.5", "--port", "4317", "--new-round", "--record"], "4318"),
    ["--save", "Oasis by the Sea benchmark start", "--model", "Claude Opus 5.5", "--record", "--port", "4318"]);
  assert.deepEqual(forwardedArgs(["--resume", "20261012T1-abc", "--port=4400"], "4401"), ["--resume", "20261012T1-abc", "--port", "4401"]);
});

test("recording a round keeps the others and the note, sorted by benchmark", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "rounds-")), "benchmark-rounds.json");
  assert.deepEqual(readRounds(file), { rounds: {} }, "no file: no rounds");
  writeFileSync(file, JSON.stringify({ about: "note", rounds: { "Oasis by the Sea construction": oasis } }));
  const desert = { version: "1.5.6", fingerprint: "bb6e", commit: "9c34b50", since: "2026-10-12" };
  writeRound("Large Barren Desert construction", desert, file);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.about, "note");
  assert.deepEqual(Object.keys(saved.rounds), ["Large Barren Desert construction", "Oasis by the Sea construction"]);
  assert.deepEqual(readRounds(file).rounds["Large Barren Desert construction"], desert);
});
