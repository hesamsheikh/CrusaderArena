/**
 * What a run's requests cost. OpenRouter reports what it billed for each request (model.ts reads
 * it from the stream). Other endpoints, Anthropic's and Moonshot's included, report only token
 * counts, so the host prices each request's usage with the model profile's list prices.
 *
 * Run as `npm run cost` to list finished runs that have token usage but no recorded cost, priced
 * at their model profile's current prices; `npm run cost -- --write` records those costs in each
 * run's events.jsonl and run.json, as if they had been recorded live.
 */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { calculateCost, type ModelCost, type Usage } from "@earendil-works/pi-ai";
import { isOpenRouter, type Run, type TokenPrices } from "../shared/protocol.js";

/** Pi's rates for a profile's prices; Pi then fills in each reply's `usage.cost`. */
export function modelCost(prices?: TokenPrices): ModelCost {
  if (!prices) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const { longPrompt, ...rates } = prices;
  if (!longPrompt) return rates;
  const { above, ...tier } = longPrompt;
  return { ...rates, tiers: [{ inputTokensAbove: above, ...tier }] };
}

/** US dollars for one request's usage at these prices. */
export function requestCost(prices: TokenPrices, usage: Partial<Usage>) {
  const counted: Usage = {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    ...(usage.cacheWrite1h ? { cacheWrite1h: usage.cacheWrite1h } : {}),
    totalTokens: usage.totalTokens ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return calculateCost({ cost: modelCost(prices) } as Parameters<typeof calculateCost>[0], counted).total;
}

/** Whether a request used any tokens; a request refused before it started bills nothing. */
export const usedTokens = (usage: Partial<Usage>) =>
  (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > 0;

type Line = { at?: number; event?: { type?: string; [key: string]: unknown } };
/** The usage of the request an event line records, and which kind of request it was. */
function requestUsage(event: Line["event"]): { kind: string; usage: Partial<Usage> } | null {
  const usage = (value: unknown) => (value && typeof value === "object" ? (value as Partial<Usage>) : null);
  if (event?.type === "message_end") {
    const message = event.message as { role?: string; usage?: unknown } | undefined;
    const u = message?.role === "assistant" ? usage(message.usage) : null;
    return u ? { kind: "gameplay", usage: u } : null;
  }
  if (event?.type === "preparation_reply") {
    const u = usage((event.reply as { usage?: unknown } | undefined)?.usage);
    return u ? { kind: "preparation", usage: u } : null;
  }
  if (event?.type === "compaction_usage" || event?.type === "reflection_usage") {
    const u = usage(event.usage);
    return u ? { kind: event.type.replace("_usage", ""), usage: u } : null;
  }
  return null;
}

/**
 * A run's events.jsonl with a request_cost event after every request that used tokens, priced at
 * `prices`, and the run's total. Null when the run already records a cost.
 */
export function backfillEvents(text: string, prices: TokenPrices) {
  const out: string[] = [];
  let dollars = 0;
  let requests = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line.includes('"request_cost"')) return null;
    out.push(line);
    let parsed: Line;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const request = requestUsage(parsed.event);
    if (!request || !usedTokens(request.usage)) continue;
    const cost = requestCost(prices, request.usage);
    dollars += cost;
    requests++;
    out.push(JSON.stringify({
      at: parsed.at,
      event: { type: "request_cost", kind: request.kind, dollars: cost, source: "prices", backfilled: true },
    }));
  }
  return { text: out.join("\n") + "\n", dollars, requests, lines: out.length };
}

function writeAtomic(file: string, text: string) {
  writeFileSync(file + ".tmp", text, { mode: 0o600 });
  renameSync(file + ".tmp", file);
}

async function main() {
  const { values } = parseArgs({
    options: {
      runtime: { type: "string", default: "harness/runtime" },
      write: { type: "boolean", default: false },
    },
  });
  const root = path.resolve(values.runtime!);
  const config = path.join(root, "config/models.json");
  const profiles: { id: string; name: string; prices?: TokenPrices }[] = existsSync(config)
    ? JSON.parse(readFileSync(config, "utf8"))
    : [];
  const runsDir = path.join(root, "runs");
  let total = 0;
  let changed = 0;
  // Runs left without a cost, counted by model and reason.
  const skipped = new Map<string, number>();
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  for (const folder of readdirSync(runsDir).sort()) {
    const runFile = path.join(runsDir, folder, "run.json");
    const eventsFile = path.join(runsDir, folder, "events.jsonl");
    if (!existsSync(runFile) || !existsSync(eventsFile)) continue;
    const run: Run = JSON.parse(readFileSync(runFile, "utf8"));
    if (run.cost !== undefined || run.status === "running" || !run.tokens) continue;
    let openRouter = false;
    try {
      openRouter = isOpenRouter(run.model.baseUrl);
    } catch {}
    if (openRouter) {
      skip(`${run.model.name}: OpenRouter runs from before billed amounts were recorded; not priced`);
      continue;
    }
    const prices = run.model.prices ?? profiles.find((p) => p.id === run.modelId)?.prices;
    if (!prices) {
      skip(`${run.model.name}: no prices; enter them in its model settings`);
      continue;
    }
    const filled = backfillEvents(readFileSync(eventsFile, "utf8"), prices);
    if (!filled) continue;
    total += filled.dollars;
    changed++;
    console.log(`${folder}: ${filled.requests} requests, $${filled.dollars.toFixed(4)}`);
    if (!values.write) continue;
    writeAtomic(eventsFile, filled.text);
    writeAtomic(
      runFile,
      JSON.stringify(
        { ...run, model: { ...run.model, prices }, cost: filled.dollars, eventCount: filled.lines },
        null,
        2,
      ) + "\n",
    );
  }
  for (const [reason, count] of skipped) console.log(`Skipped ${count} run(s) of ${reason}.`);
  if (!changed) return console.log("No run can be given a cost.");
  console.log(
    values.write
      ? `Recorded the cost of ${changed} run(s), $${total.toFixed(4)} in all. Restart the host to show them in the dashboard.`
      : `${changed} run(s), $${total.toFixed(4)} in all. Pass --write to record these costs.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  });
}
