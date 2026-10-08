import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { atlasPages } from "../harness/server/visual-atlas.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, ".internal/ui-reference/legends");
const output = path.join(root, ".internal/ui-reference/construction-trays.png");
const directory = mkdtempSync(path.join(tmpdir(), "construction-trays-"));
try {
  const manifest = path.join(directory, "pages.json");
  writeFileSync(
    manifest,
    JSON.stringify(
      atlasPages.map(({ id, title, file, labels }) => ({
        id,
        title,
        file,
        labels: labels.map(({ name, detail }) => ({ name, detail })),
      })),
    ),
  );
  const binary = path.join(directory, "make-construction-trays");
  const compile = spawnSync(
    "clang",
    ["-fobjc-arc", "-framework", "AppKit", path.join(root, "tools/make-construction-trays.m"), "-o", binary],
    { stdio: "inherit" },
  );
  if (compile.status !== 0) process.exitCode = compile.status || 1;
  else {
    const result = spawnSync(binary, [manifest, source, output], { stdio: "inherit" });
    if (result.status !== 0) process.exitCode = result.status || 1;
    else process.stdout.write(`${output}\n`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
