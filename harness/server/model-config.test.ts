import { test } from "node:test";
import assert from "node:assert/strict";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { modelConfig, requestOptions } from "./model.js";
import type { ModelProfile } from "../shared/protocol.js";

/** The request body Pi would send for a profile; the request is stopped before any network use. */
async function payload(profile: ModelProfile) {
  let body: Record<string, unknown> | undefined;
  const stream = streamSimple(
    modelConfig(profile),
    { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    {
      ...requestOptions(profile),
      apiKey: "test",
      onPayload: (params) => {
        body = params as Record<string, unknown>;
        throw new Error("captured");
      },
    },
  );
  await stream.result();
  assert.ok(body, "payload captured");
  return body;
}

const openRouter: ModelProfile = {
  id: "p", name: "GLM", modelId: "z-ai/glm-5.3-flash", baseUrl: "https://openrouter.ai/api/v1", keyConfigured: true,
};

test("OpenRouter requests carry the profile's reasoning, output limit and provider pinning", async () => {
  const body = await payload({ ...openRouter, reasoning: "medium", maxTokens: 16384, providers: ["z-ai"], allowFallbacks: false });
  assert.deepEqual(body.reasoning, { effort: "medium" });
  assert.equal(body.max_tokens, 16384);
  assert.deepEqual(body.provider, { order: ["z-ai"], allow_fallbacks: false });
});

test("profiles saved before the settings keep the old requests: low reasoning, 8192 tokens, no pinning", async () => {
  const body = await payload(openRouter);
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.provider, undefined);
});

test("reasoning default sends no setting; off asks OpenRouter for none", async () => {
  assert.equal((await payload({ ...openRouter, reasoning: "default" })).reasoning, undefined);
  assert.deepEqual((await payload({ ...openRouter, reasoning: "off" })).reasoning, { effort: "none" });
});

test("Moonshot requests send no reasoning setting and no provider routing", async () => {
  const body = await payload({ ...openRouter, modelId: "kimi-k3", baseUrl: "https://api.moonshot.ai/v1", reasoning: "default", maxTokens: 12288 });
  assert.equal(body.reasoning, undefined);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.provider, undefined);
  assert.equal(body.max_tokens, 12288);
});
