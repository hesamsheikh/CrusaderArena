import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import type { Context, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { modelConfig, requestOptions } from "./model.js";
import { Store } from "./store.js";
import { ROUND_PRELOAD } from "./version-checkout.js";
import type { ModelProfile } from "../shared/protocol.js";

const astra: ModelProfile = {
  id: "a", name: "GPT-6 Astra", modelId: "gpt-6-astra", baseUrl: "https://api.openai.com/v1", keyConfigured: true,
  reasoning: "medium", maxTokens: 32768, providers: [], allowFallbacks: true,
  prices: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
};
const context: Context = {
  systemPrompt: "Play the game.",
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
  tools: [{ name: "observe", description: "Look at the game.", parameters: Type.Object({}) }],
};

/** The request body this checkout's host sends for a profile; stopped before any network use. */
async function payload(profile: ModelProfile) {
  let body: Record<string, unknown> | undefined;
  const model = modelConfig(profile);
  assert.equal(model.api, "openai-responses");
  await streamSimple(model as Model<"openai-responses">, context, {
    ...requestOptions(profile),
    apiKey: "test",
    sessionId: "run-7",
    onPayload: (params) => {
      body = params as Record<string, unknown>;
      throw new Error("captured");
    },
  }).result();
  assert.ok(body, "payload captured");
  return body;
}

test("an OpenAI profile goes through the Responses API, carrying its reasoning between requests", async () => {
  const body = await payload(astra);
  assert.deepEqual(body.reasoning, { effort: "medium", summary: "auto" });
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.max_output_tokens, 32768);
  assert.equal(body.store, false);
  assert.equal(body.prompt_cache_key, "run-7");
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.messages, undefined);
});

test("OpenAI reasoning: max is its xhigh, default sends no setting", async () => {
  assert.deepEqual((await payload({ ...astra, reasoning: "max" })).reasoning, { effort: "xhigh", summary: "auto" });
  assert.equal((await payload({ ...astra, reasoning: "default" })).reasoning, undefined);
});

test("an earlier round's host, through the preload, sends an OpenAI profile the same request", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "round-openai-"));
  const pi = (file: string) => pathToFileURL(path.resolve("node_modules/@earendil-works/pi-ai/dist", file)).href;
  // What a host before this change does: Pi's chat-completions provider (moonshotaiProvider) with
  // the model its modelConfig made for any endpoint but OpenRouter's, Anthropic's and Moonshot's.
  writeFileSync(path.join(dir, "host.mjs"), `
    const { moonshotaiProvider } = await import(${JSON.stringify(pi("providers/moonshotai.js"))});
    const context = ${JSON.stringify({ ...context, tools: [{ ...context.tools![0], parameters: Type.Object({}) }] })};
    for (const baseUrl of ["https://api.openai.com/v1", "https://api.moonshot.ai/v1"]) {
      const model = { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "a", api: "openai-completions", baseUrl, reasoning: true,
        input: ["text", "image"], contextWindow: 1048576, maxTokens: 32768, cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
        compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" } };
      let body;
      await moonshotaiProvider().streamSimple(model, context, { apiKey: "test", reasoning: "medium", maxTokens: 32768, sessionId: "run-7",
        onPayload: (params) => { body = params; throw new Error("captured"); } }).result();
      console.log(JSON.stringify(body));
    }`);
  const run = spawnSync(process.execPath, ["--import", "tsx", "--import", ROUND_PRELOAD, path.join(dir, "host.mjs")], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const [openai, moonshot] = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
  // As sent: JSON leaves out the fields Pi sets to undefined.
  assert.deepEqual(openai, JSON.parse(JSON.stringify(await payload(astra))));
  assert.equal(moonshot.max_tokens, 32768, "other endpoints keep chat completions");
  assert.ok(Array.isArray(moonshot.messages));
});

test("an OpenAI profile reads OPENAI_API_KEY, only for OpenAI's endpoint, and runs never record it", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arena-store-openai-"));
  const env = { OPENAI_API_KEY: "openai-secret-test" };
  const store = new Store(root, env);
  const model = store.saveModel({ name: "GPT-6 Astra", modelId: "gpt-6-astra", baseUrl: "https://api.openai.com/v1", envKey: "OPENAI_API_KEY" });
  assert.equal(store.key(model.id), env.OPENAI_API_KEY);
  assert.ok(!readFileSync(path.join(root, "config/models.json"), "utf8").includes(env.OPENAI_API_KEY));
  assert.equal(store.redact(`key ${env.OPENAI_API_KEY}`), "key [redacted]");
  assert.throws(() => store.saveModel({
    name: "Wrong endpoint", modelId: "gpt-6-astra", baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENAI_API_KEY",
  }), /does not match/);
});
