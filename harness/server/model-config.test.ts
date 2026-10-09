import { test } from "node:test";
import assert from "node:assert/strict";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { modelConfig, prepareModel, requestOptions } from "./model.js";
import { placeAnthropicCacheBreakpoints, placeCacheBreakpoints, pruneImages } from "./context.js";
import type { ModelProfile } from "../shared/protocol.js";

/** The request body Pi would send for a profile; the request is stopped before any network use. */
async function payload(
  profile: ModelProfile,
  context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
) {
  let body: Record<string, unknown> | undefined;
  const model = modelConfig(profile);
  const send = (model.api === "anthropic-messages" ? anthropicStream : streamSimple) as (
    ...args: [Model<any>, Context, Parameters<typeof streamSimple>[2]]
  ) => ReturnType<typeof streamSimple>;
  const stream = send(
    model,
    context,
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

const claude: ModelProfile = { ...openRouter, name: "Claude", modelId: "anthropic/claude-sonnet-5.5" };
const image = (n: number) => ({ type: "image" as const, data: Buffer.from(`shot ${n}`).toString("base64"), mimeType: "image/png" });
const reply = (text: string, call?: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }, ...(call ? [{ type: "toolCall" as const, id: call, name: "observe", arguments: {} }] : [])],
  api: "openai-completions", provider: "p", model: "m", stopReason: call ? "toolUse" : "stop", timestamp: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
/** One gameplay turn: a reply calling observe, its screenshot, then the host's screenshot. */
const turn = (n: number): Message[] => [
  reply(`Turn ${n}: placing a granary.`, `call-${n}`),
  { role: "toolResult", toolCallId: `call-${n}`, toolName: "observe", content: [{ type: "text", text: `{"turn":${n}}` }, image(n)], isError: false, timestamp: 0 },
  { role: "user", content: [{ type: "text", text: "Fresh screenshot from the host." }, image(100 + n)], timestamp: 0 },
];
const guide: Message[] = [
  { role: "user", content: [{ type: "text", text: "Preparation guide." }, image(0)], timestamp: 0 },
  reply("Understood.\nBEGIN"),
];
const tools = [{ name: "observe", description: "Screenshot.", parameters: Type.Object({}) }];
type Sent = { role: string; content?: unknown };
/** A request's messages with Claude's cache markers placed as the harness does. */
async function claudeRequest(messages: Message[]) {
  const body = await payload(claude, { systemPrompt: "Rules.", messages, tools });
  placeCacheBreakpoints(body as { messages: Sent[] }, guide.length);
  return body as { messages: Sent[]; tools: Record<string, unknown>[] };
}
const marked = (message: Sent) => JSON.stringify(message).includes("cache_control");
/** Message content as the provider reads it: without markers, one text part as plain text. */
const plain = (message: Sent) => {
  const content = Array.isArray(message.content)
    ? message.content.map(({ cache_control, ...part }: Record<string, unknown>) => part)
    : message.content;
  return JSON.stringify({ ...message, content: Array.isArray(content) && content.length === 1 && content[0].type === "text" ? content[0].text : content });
};

test("Claude through OpenRouter marks the system prompt, tools, guide and the conversation up to the oldest kept screenshot", async () => {
  const pinned = new Set(guide);
  // As the controller does each turn: append, then keep the newest two unpinned screenshots.
  const prune = (messages: Message[]) => pruneImages(messages, 2, pinned) as Message[];
  let history = [...guide];
  for (let n = 1; n <= 3; n++) history = prune([...history, ...turn(n)]);
  const now = await claudeRequest(history);
  history = prune([...history, ...turn(4)]);
  const next = await claudeRequest(history);
  for (const request of [now, next]) {
    const markers = JSON.stringify(request).match(/cache_control/g)?.length;
    assert.equal(markers, 4, "Anthropic allows four breakpoints");
    assert.ok(marked(request.messages[0]), "system prompt");
    assert.ok(JSON.stringify(request.tools.at(-1)).includes("cache_control"), "last tool");
    assert.ok(marked(request.messages[guide.length]), "end of the guide");
    assert.ok(!marked(request.messages.at(-1)!), "the last message changes next turn");
  }
  // Everything up to this turn's conversation breakpoint is sent again unchanged next turn,
  // where the breakpoint has moved on by one turn.
  const breakpoint = (request: typeof now) => request.messages.length - 1 - [...request.messages].reverse().findIndex(marked);
  const at = breakpoint(now);
  assert.ok(at > guide.length);
  assert.ok(breakpoint(next) > at);
  assert.deepEqual(next.messages.slice(0, at + 1).map(plain), now.messages.slice(0, at + 1).map(plain));
  // The next message holds the screenshot pruned since, so it differs.
  assert.notEqual(plain(next.messages[at + 1]), plain(now.messages[at + 1]));
});

test("other models get no cache markers", async () => {
  for (const profile of [openRouter, { ...openRouter, modelId: "kimi-k3", baseUrl: "https://api.moonshot.ai/v1" }]) {
    const body = await payload(profile, { systemPrompt: "Rules.", messages: [...guide, ...turn(1)], tools });
    assert.ok(!JSON.stringify(body).includes("cache_control"));
  }
});

/** A preparation request against a fake provider stream; returns the request body, the reply and the costs read. */
async function prepareAgainst(profile: ModelProfile, usage: Record<string, unknown>) {
  const chunks = [
    { id: "gen-1", choices: [{ index: 0, delta: { content: "Ready.\nBEGIN" }, finish_reason: null }] },
    { id: "gen-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { id: "gen-1", choices: [], usage },
  ];
  const stream = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  let sent: Record<string, unknown> | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const costs: number[] = [];
  try {
    const reply = await prepareModel(
      profile, "test", "Rules.", { role: "user", content: "Prepare.", timestamp: 0 },
      AbortSignal.timeout(5000), (dollars) => costs.push(dollars),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { sent, reply, costs };
  } finally {
    globalThis.fetch = original;
  }
}

test("OpenRouter is asked for the billed amount, which is read from a copy of the stream", async () => {
  const { sent, reply, costs } = await prepareAgainst(openRouter, {
    prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, cost: 0.00123, prompt_tokens_details: { cached_tokens: 40 },
  });
  assert.deepEqual(sent?.usage, { include: true });
  assert.deepEqual(costs, [0.00123]);
  // Pi still reads the whole reply and its usage.
  assert.deepEqual(reply.content.filter((part) => part.type === "text").map((part) => part.text), ["Ready.\nBEGIN"]);
  assert.equal(reply.usage.cacheRead, 40);
});

test("other providers are not sent OpenRouter's usage option, and report no cost", async () => {
  const kimi = { ...openRouter, modelId: "kimi-k3", baseUrl: "https://api.moonshot.ai/v1" };
  const { sent, costs } = await prepareAgainst(kimi, { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 });
  assert.equal(sent?.usage, undefined);
  assert.deepEqual(costs, []);
});

const haiku: ModelProfile = {
  id: "h", name: "Claude Haiku 5.5", modelId: "claude-haiku-5-5", baseUrl: "https://api.anthropic.com", keyConfigured: true,
};

test("Anthropic requests use adaptive thinking at the profile's effort and its output limit", async () => {
  const body = await payload({ ...haiku, reasoning: "medium", maxTokens: 32768 });
  assert.equal(body.model, "claude-haiku-5-5");
  assert.equal((body.thinking as { type: string }).type, "adaptive");
  assert.deepEqual(body.output_config, { effort: "medium" });
  assert.equal(body.max_tokens, 32768);
  const plain = await payload({ ...haiku, reasoning: "default" });
  assert.equal(plain.thinking, undefined, "default leaves thinking to the model");
  assert.equal(plain.output_config, undefined);
});

type Block = { type: string; content?: Block[]; cache_control?: unknown };
type AnthropicSent = { role: string; content: Block[] | string };
/** A request to Anthropic with the cache markers placed as the harness does. */
async function anthropicRequest(messages: Message[]) {
  const body = await payload({ ...haiku, reasoning: "medium" }, { systemPrompt: "Rules.", messages, tools });
  placeAnthropicCacheBreakpoints(body as { messages: AnthropicSent[] }, guide.length);
  return body as { system: Block[]; messages: AnthropicSent[]; tools: Block[] };
}
const markedAt = (request: { messages: AnthropicSent[] }) =>
  request.messages.flatMap((message, i) => (JSON.stringify(message).includes("cache_control") ? [i] : []));
const unmarked = (message: AnthropicSent) =>
  JSON.stringify(message, (key, value) => (key === "cache_control" ? undefined : value));

/** A turn with many tool calls: more content blocks than Anthropic searches back for an earlier entry. */
const bigTurn = (n: number, calls: number): Message[] => {
  const ids = Array.from({ length: calls }, (_, i) => `call-${n}-${i}`);
  return [
    { ...reply(`Turn ${n}: reading everything.`), content: [{ type: "text", text: `Turn ${n}.` }, ...ids.map((id) => ({ type: "toolCall" as const, id, name: "observe", arguments: {} }))], stopReason: "toolUse" },
    ...ids.map((id, i): Message => ({ role: "toolResult", toolCallId: id, toolName: "observe", content: [{ type: "text", text: `{"read":${i}}` }, ...(i === calls - 1 ? [image(n)] : [])], isError: false, timestamp: 0 })),
    { role: "user", content: [{ type: "text", text: "Fresh screenshot from the host." }, image(100 + n)], timestamp: 0 },
  ];
};
/** Content blocks in messages from..to, as Anthropic counts them for its look-back. */
const blocksBetween = (request: { messages: AnthropicSent[] }, from: number, to: number) =>
  request.messages.slice(from, to + 1).reduce((n, m) => n + (Array.isArray(m.content) ? m.content.length : 1), 0);

test("Claude through Anthropic marks the system prompt, guide, this turn's and the last turn's conversation", async () => {
  const pinned = new Set(guide);
  const prune = (messages: Message[]) => pruneImages(messages, 2, pinned) as Message[];
  let history = [...guide];
  for (let n = 1; n <= 3; n++) history = prune([...history, ...turn(n)]);
  const now = await anthropicRequest(history);
  history = prune([...history, ...bigTurn(4, 20)]);
  const next = await anthropicRequest(history);
  for (const request of [now, next]) {
    assert.ok(JSON.stringify(request.system).includes("cache_control"), "system prompt");
    assert.ok(!JSON.stringify(request.tools).includes("cache_control"), "the system prompt's breakpoint covers the tools");
    assert.ok(JSON.stringify(request).match(/cache_control/g)!.length <= 4, "Anthropic allows four breakpoints");
    assert.equal(markedAt(request)[0], guide.length - 1, "end of the guide");
    assert.ok(!markedAt(request).includes(request.messages.length - 1), "the last message changes next turn");
  }
  // The screenshots sit inside tool results, where the oldest kept one is found.
  assert.ok(JSON.stringify(now.messages).includes('"type":"tool_result"'));
  const written = markedAt(now).at(-1)!;
  assert.ok(written > guide.length - 1);
  // Next turn repeats everything up to this turn's breakpoint and writes further on.
  assert.deepEqual(next.messages.slice(0, written + 1).map(unmarked), now.messages.slice(0, written + 1).map(unmarked));
  const latest = markedAt(next).at(-1)!;
  assert.ok(latest > written);
  // After a long turn this turn's breakpoint is too far on to find that entry, but the one
  // before the newest placeholder is within Anthropic's look-back of about 20 blocks.
  assert.ok(blocksBetween(next, written + 1, latest) > 20);
  const read = markedAt(next).find((i) => i >= written)!;
  assert.ok(read < latest && blocksBetween(next, written + 1, read) <= 20, "the previous entry is found");
});
