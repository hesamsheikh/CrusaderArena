import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { Model } from "@earendil-works/pi-ai";
import { THINKING_BINDING_BETA, bindsThinking, thinkingBindingFetch, withThinkingBinding } from "./thinking-binding.js";
import { modelConfig, requestOptions } from "./model.js";
import { ROUND_PRELOAD } from "./version-checkout.js";
import type { ModelProfile } from "../shared/protocol.js";

const MESSAGES = "https://api.anthropic.com/v1/messages";
const request = (model: string, extra: Record<string, unknown> = { thinking: { type: "adaptive", display: "summarized" } }, headers: HeadersInit = { "anthropic-beta": "fine-grained-tool-streaming-2025-05-14" }) =>
  ({ method: "POST", headers, body: JSON.stringify({ model, messages: [], ...extra }) });

test("only Claude Fable 5.2 binds thinking blocks", () => {
  assert.ok(bindsThinking("claude-fable-5-2"));
  assert.ok(bindsThinking("claude-fable-5-2-20261109"));
  for (const model of ["claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-fable-5-20", "anthropic/claude-fable-5-2"])
    assert.ok(!bindsThinking(model), model);
});

test("a Fable 5.2 request with thinking asks to drop blocks bound to another conversation", () => {
  const init = withThinkingBinding(`${MESSAGES}?beta=true`, request("claude-fable-5-2"));
  const body = JSON.parse(String(init?.body));
  assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } });
  assert.equal(new Headers(init?.headers).get("anthropic-beta"), `fine-grained-tool-streaming-2025-05-14,${THINKING_BINDING_BETA}`);
  const bare = withThinkingBinding(new URL(MESSAGES), request("claude-fable-5-2", undefined, {}));
  assert.equal(new Headers(bare?.headers).get("anthropic-beta"), THINKING_BINDING_BETA);
});

test("other models, endpoints, requests without thinking and bindings already set pass unchanged", () => {
  for (const [input, init] of [
    [MESSAGES, request("claude-fable-5-1")],
    [MESSAGES, request("claude-opus-5-5")],
    ["https://openrouter.ai/api/v1/chat/completions", request("claude-fable-5-2")],
    [MESSAGES, request("claude-fable-5-2", {})],
    [MESSAGES, request("claude-fable-5-2", { thinking: { type: "disabled" } })],
    [MESSAGES, request("claude-fable-5-2", { thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } } })],
    [MESSAGES, { ...request("claude-fable-5-2"), body: "not json" }],
    [MESSAGES, { ...request("claude-fable-5-2"), method: "GET" }],
  ] as const)
    assert.equal(withThinkingBinding(input, init as RequestInit), init);
});

test("Pi's own Fable 5.2 request gets drop_block; Fable 5.1's is sent as it was", async () => {
  const fable: ModelProfile = {
    id: "f", name: "Claude Fable 5.2", modelId: "claude-fable-5-2", baseUrl: "https://api.anthropic.com", keyConfigured: true,
    reasoning: "medium", maxTokens: 32768, providers: [], allowFallbacks: true,
  };
  const capture = async (profile: ModelProfile, wrap: boolean) => {
    let sent: { body: Record<string, unknown>; beta: string | null } | undefined;
    const network = (async (_input: string | URL | Request, init?: RequestInit) => {
      sent = { body: JSON.parse(String(init?.body)), beta: new Headers(init?.headers).get("anthropic-beta") };
      throw new Error("captured");
    }) as typeof fetch;
    await streamSimple(modelConfig(profile) as Model<"anthropic-messages">, { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { ...requestOptions(profile), apiKey: "test", maxRetries: 0, fetch: wrap ? thinkingBindingFetch(network) : network }).result();
    assert.ok(sent, "request captured");
    return sent;
  };
  const five2 = await capture(fable, true);
  assert.deepEqual((five2.body.thinking as Record<string, unknown>).block_binding, { prefix_mismatch_behavior: "drop_block" });
  assert.ok(five2.beta?.split(",").includes(THINKING_BINDING_BETA));
  const five1 = { ...fable, modelId: "claude-fable-5-1" };
  assert.deepEqual(await capture(five1, true), await capture(five1, false));
});

test("the preload gives an earlier round's host drop_block through its global fetch", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "round-preload-"));
  writeFileSync(path.join(dir, "network.mjs"),
    `globalThis.fetch = async (_input, init) => { const b = JSON.parse(init.body); console.log(b.model + " " + (b.thinking.block_binding?.prefix_mismatch_behavior ?? "none")); return new Response("{}"); };`);
  writeFileSync(path.join(dir, "host.mjs"), `
    const init = (model) => ({ method: "POST", headers: {}, body: JSON.stringify({ model, thinking: { type: "adaptive" } }) });
    await fetch(${JSON.stringify(MESSAGES)}, init("claude-fable-5-2"));
    await fetch(${JSON.stringify(MESSAGES)}, init("claude-fable-5-1"));`);
  const run = spawnSync(process.execPath, ["--import", "tsx", "--import", path.join(dir, "network.mjs"), "--import", ROUND_PRELOAD, path.join(dir, "host.mjs")], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split("\n"), ["claude-fable-5-2 drop_block", "claude-fable-5-1 none"]);
});
