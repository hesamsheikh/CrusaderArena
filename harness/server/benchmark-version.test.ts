import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { behaviourFiles, benchmarkFingerprint, nextVersion, readVersions, versionOf } from "./benchmark-version.js";

test("the benchmark files are a recorded version (bump or relock it with the change)", () => {
  const versions = readVersions();
  const fingerprint = benchmarkFingerprint();
  const latest = versions.history.at(-1);
  assert.equal(
    latest?.fingerprint,
    fingerprint,
    `Files that decide how a run plays or is scored changed (fingerprint ${fingerprint.slice(0, 12)}). ` +
      `Record it in the same commit: npm run benchmark-version -- bump "what changed" for a change in behaviour, ` +
      `or relock "why" when behaviour is the same (comments, refactors). See docs/benchmark.md#versions.`,
  );
  assert.equal(latest.version, versions.current);
  assert.equal(versionOf(fingerprint, versions), versions.current);
  assert.match(versions.current, /^\d+\.\d+\.\d+$/);
});

test("the repository's package version is the current benchmark version", () => {
  const { current } = readVersions();
  const json = (file: string) => JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"));
  assert.equal(json("package.json").version, current, "npm run benchmark-version -- bump sets it");
  assert.equal(json("package-lock.json").version, current);
  assert.equal(json("package-lock.json").packages[""].version, current);
});

test("versions follow semantic versioning", () => {
  assert.equal(nextVersion("", "patch"), "1.0.0");
  assert.equal(nextVersion("1.0.0", "patch"), "1.0.1");
  assert.equal(nextVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(nextVersion("1.2.3", "major"), "2.0.0");
  assert.throws(() => nextVersion("v1", "patch"), /MAJOR\.MINOR\.PATCH/);
});

test("the fingerprint covers what runs and leaves out tests, reports and video rendering", () => {
  const files = behaviourFiles();
  for (const file of ["harness/server/model.ts", "harness/shared/protocol.ts", "prompt/game-controls.md", "tools/ubuntu/run-proton.py"])
    assert.ok(files.includes(file), file);
  for (const file of ["harness/server/series.test.ts", "harness/server/run-report.ts", "harness/server/video.ts", "docs/benchmark.md", "harness/src/main.tsx"])
    assert.ok(!files.includes(file), file);
  assert.ok(!files.some((file) => /(^|\/)test_[^/]*\.py$/.test(file)));
  assert.equal(benchmarkFingerprint(), benchmarkFingerprint());
});
