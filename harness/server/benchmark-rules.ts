/**
 * A benchmark's rules file, prompt/benchmarks/<slug>.md, where the slug is the benchmark's name in
 * lower case with every run of other characters made one hyphen. Its front matter says whether
 * the benchmark has military play (`military: false`) and whether weapons and armour count toward
 * net worth (`arms: false`), and it can take its rules text from another benchmark's file
 * (`rules: <slug>`), whose `<!-- arms -->` and `<!-- no-arms -->` blocks then tell the two apart
 * (preparation.ts). Kept free of the prompt's other imports so the runner, reports and overlay
 * can score by it.
 */
import { existsSync, readFileSync } from "node:fs";

export type BenchmarkRules = { body: string; military: boolean; arms: boolean };

function rulesFile(slug: string) {
  const file = new URL(`../../prompt/benchmarks/${slug}.md`, import.meta.url);
  if (!existsSync(file)) return null;
  const source = readFileSync(file, "utf8");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(source);
  return { front: front?.[1] ?? "", body: front ? source.slice(front[0].length) : source };
}

// Read once, as the host reads prompt/ once at startup.
const read = new Map<string, BenchmarkRules | null>();

/** The benchmark's rules; null when it has no rules file (Custom). */
export function benchmarkRules(benchmarkType: string): BenchmarkRules | null {
  if (read.has(benchmarkType)) return read.get(benchmarkType)!;
  const slug = benchmarkType.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const own = slug ? rulesFile(slug) : null;
  const from = own ? /^rules:\s*(\S+)\s*$/m.exec(own.front)?.[1] : undefined;
  const base = from ? rulesFile(from) : null;
  if (from && !base) throw new Error(`prompt/benchmarks/${slug}.md takes its rules from ${from}.md, which does not exist`);
  const rules = own && {
    body: base ? base.body : own.body,
    military: !/^military:\s*false\s*$/m.test(own.front),
    arms: !/^arms:\s*false\s*$/m.test(own.front),
  };
  read.set(benchmarkType, rules);
  return rules;
}

/** Whether weapons and armour count toward the benchmark's net worth: unless its rules say `arms: false`. */
export const armsCounted = (benchmarkType: string | null | undefined) => benchmarkRules(benchmarkType ?? "")?.arms ?? true;
