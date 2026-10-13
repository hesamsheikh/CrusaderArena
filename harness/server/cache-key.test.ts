import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { Model } from "@earendil-works/pi-ai";
import { withCacheKey } from "./cache-key.js";
import { costReader, modelConfig, requestOptions } from "./model.js";
import { ROUND_PRELOAD } from "./version-checkout.js";
import type { ModelProfile } from "../shared/protocol.js";

const CHAT = "https://openrouter.ai/api/v1/chat/completions";
const request = (model: string, headers: Record<string, string> = { "x-session-id": "run-1" }, extra = {}) =>
  ({ method: "POST", headers, body: JSON.stringify({ model, messages: [], ...extra }) });
const sent = (init?: RequestInit) => JSON.parse(String(init?.body));

test("a Meta model's OpenRouter request gets the run's session id as its prompt cache key", () => {
  assert.equal(sent(withCacheKey(CHAT, request("meta/muse-wonder"))).prompt_cache_key, "run-1");
  assert.equal(sent(withCacheKey(new URL(CHAT), request("meta/muse-spark-1.3"))).prompt_cache_key, "run-1");
});

test("other models, other endpoints, requests without a session and keys already set pass unchanged", () => {
  for (const [input, init] of [
    [CHAT, request("z-ai/glm-5.3-flash")],
    [CHAT, request("openai/gpt-6.1-sol")],
    ["https://api.moonshot.ai/v1/chat/completions", request("meta/muse-wonder")],
    [CHAT, request("meta/muse-wonder", {})],
    [CHAT, request("meta/muse-wonder", { "x-session-id": "run-1" }, { prompt_cache_key: "mine" })],
    [CHAT, { ...request("meta/muse-wonder"), body: "not json" }],
    [CHAT, { ...request("meta/muse-wonder"), method: "GET" }],
  ] as const)
    assert.equal(withCacheKey(input, init as RequestInit), init);
});

test("the harness's own Muse Wonder requests carry the key, Pi's request and headers as sent", async () => {
  const wonder: ModelProfile = {
    id: "w", name: "Muse Wonder", modelId: "meta/muse-wonder", baseUrl: "https://openrouter.ai/api/v1", keyConfigured: true,
    reasoning: "medium", maxTokens: 32768, providers: ["meta"], allowFallbacks: false,
  };
  const body = async (profile: ModelProfile) => {
    let captured: Record<string, unknown> | undefined;
    const network = (async (_input: string | URL | Request, init?: RequestInit) => {
      captured = sent(init);
      throw new Error("captured");
    }) as typeof fetch;
    const stream = streamSimple(modelConfig(profile) as Model<"openai-completions">, { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { ...requestOptions(profile), apiKey: "test", sessionId: "run-42", maxRetries: 0, fetch: costReader(() => {}, network) });
    await stream.result();
    assert.ok(captured, "request captured");
    return captured;
  };
  assert.equal((await body(wonder)).prompt_cache_key, "run-42");
  assert.equal((await body({ ...wonder, modelId: "z-ai/glm-5.3-flash", providers: ["z-ai"] })).prompt_cache_key, undefined);
});

test("the preload gives an earlier round's host the key through its global fetch", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "round-preload-"));
  // Stands in for the network, installed before the preload wraps it.
  writeFileSync(path.join(dir, "network.mjs"),
    `globalThis.fetch = async (_input, init) => { const b = JSON.parse(init.body); console.log(b.model + " " + (b.prompt_cache_key ?? "none")); return new Response("{}"); };`);
  writeFileSync(path.join(dir, "host.mjs"), `
    const init = (model) => ({ method: "POST", headers: { "x-session-id": "run-7" }, body: JSON.stringify({ model }) });
    await fetch(${JSON.stringify(CHAT)}, init("meta/muse-wonder"));
    await fetch(${JSON.stringify(CHAT)}, init("z-ai/glm-5.3-flash"));`);
  const run = spawnSync(process.execPath, ["--import", "tsx", "--import", path.join(dir, "network.mjs"), "--import", ROUND_PRELOAD, path.join(dir, "host.mjs")], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split("\n"), ["meta/muse-wonder run-7", "z-ai/glm-5.3-flash none"]);
});
