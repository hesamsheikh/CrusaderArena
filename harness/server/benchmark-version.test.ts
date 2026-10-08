import test from "node:test";
import assert from "node:assert/strict";
import { behaviourFiles, benchmarkFingerprint, readVersions, versionOf } from "./benchmark-version.js";

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
  assert.match(versions.current, /^v\d+$/);
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
