import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readVersions } from "./benchmark-version.js";

/**
 * CHANGELOG.md's version sections: `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD`, newest first, after an
 * optional `## [Unreleased]` section for changes not yet in a version.
 */
function changelog() {
  const text = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
  const sections = text.split(/^(?=## )/m).slice(1);
  if (sections[0]?.startsWith("## [Unreleased]\n")) sections.shift();
  return sections.map((section) => {
    const heading = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\n/.exec(section);
    assert.ok(heading, `changelog heading must be "## [MAJOR.MINOR.PATCH] - YYYY-MM-DD": ${section.split("\n")[0]}`);
    return { version: heading[1], date: heading[2], body: section.slice(heading[0].length) };
  });
}

test("the changelog has a section for every benchmark version, newest first, dated when it was first recorded", () => {
  const { current, history } = readVersions();
  const first = new Map<string, string>();
  for (const entry of history) if (!first.has(entry.version)) first.set(entry.version, entry.date);
  const sections = changelog();
  assert.deepEqual(
    sections.map((s) => [s.version, s.date]),
    [...first].reverse(),
    "add a CHANGELOG.md section for each new version (npm run benchmark-version -- bump ...)",
  );
  assert.equal(sections[0].version, current);
  for (const s of sections) {
    assert.match(s.body, /^### (Benchmark|Harness)$/m, `${s.version} lists its changes under Benchmark or Harness`);
    for (const heading of s.body.match(/^### .*$/gm) ?? [])
      assert.ok(["### Benchmark", "### Harness"].includes(heading), `${s.version}: unexpected ${heading}`);
  }
});
