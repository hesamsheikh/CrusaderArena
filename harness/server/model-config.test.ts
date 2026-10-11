import { test } from "node:test";
import assert from "node:assert/strict";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { modelConfig, prepareModel, requestOptions } from "./model.js";
import { placeAnthropicCacheBreakpoints, placeCacheBreakpoints } from "./context.js";
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

test("max reasoning asks each endpoint for its highest effort: OpenRouter's xhigh, Claude's max", async () => {
  // As Artificial Analysis reports models; Pi would otherwise send Claude "high" for it.
  assert.deepEqual((await payload({ ...openRouter, reasoning: "max" })).reasoning, { effort: "xhigh" });
  assert.deepEqual((await payload({ ...openRouter, reasoning: "high" })).reasoning, { effort: "high" });
  const claude = await payload({ ...haiku, reasoning: "max", maxTokens: 32768 });
  assert.equal((claude.thinking as { type: string }).type, "adaptive");
  assert.deepEqual(claude.output_config, { effort: "max" });
  assert.deepEqual((await payload({ ...haiku, reasoning: "high" })).output_config, { effort: "high" });
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

test("a Moonshot level is sent as Kimi K3's reasoning_effort", async () => {
  const kimi = { ...openRouter, modelId: "kimi-k3", baseUrl: "https://api.moonshot.ai/v1", maxTokens: 32768 };
  for (const level of ["low", "high", "max"] as const) {
    const body = await payload({ ...kimi, reasoning: level });
    assert.equal(body.reasoning_effort, level);
    assert.equal(body.reasoning, undefined);
    assert.equal(body.thinking, undefined);
  }
});

/**
 * The request headers Pi would send for a profile, given a run's session id; the request is
 * stopped (via a throwing fetch) before any network use.
 */
async function requestHeaders(profile: ModelProfile, sessionId: string) {
  let headers: Headers | undefined;
  const stream = streamSimple(
    modelConfig(profile) as Model<"openai-completions">,
    { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    {
      ...requestOptions(profile),
      apiKey: "test",
      sessionId,
      maxRetries: 0,
      fetch: (_input, init) => {
        headers = new Headers(init?.headers);
        throw new Error("captured");
      },
    },
  );
  await stream.result();
  assert.ok(headers, "request headers captured");
  return headers;
}

test("an OpenRouter request carries the run's session id for upstream cache affinity", async () => {
  const headers = await requestHeaders(openRouter, "run-123");
  assert.equal(headers.get("x-session-id"), "run-123");
});

test("a non-OpenRouter request carries no session-affinity header", async () => {
  const headers = await requestHeaders({ ...openRouter, baseUrl: "https://api.moonshot.ai/v1" }, "run-123");
  assert.equal(headers.get("x-session-id"), null);
  assert.equal(headers.get("session_id"), null);
  assert.equal(headers.get("x-session-affinity"), null);
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

test("Claude through OpenRouter marks the system prompt, tools, where the previous request ended and the end", async () => {
  // As the controller does: the conversation only grows; screenshots stay in it.
  let history = [...guide, ...turn(1)];
  const first = await claudeRequest(history);
  for (let n = 2; n <= 3; n++) history = [...history, ...turn(n)];
  const now = await claudeRequest(history);
  history = [...history, ...bigTurn(4, 20)];
  const next = await claudeRequest(history);
  for (const request of [first, now, next]) {
    const markers = JSON.stringify(request).match(/cache_control/g)?.length;
    assert.equal(markers, 4, "Anthropic allows four breakpoints");
    assert.ok(marked(request.messages[0]), "system prompt");
    assert.ok(JSON.stringify(request.tools.at(-1)).includes("cache_control"), "last tool");
    assert.ok(marked(request.messages.at(-1)!), "the end, written for the next request");
  }
  // The first request after the guide reads the guide's entry.
  assert.ok(marked(first.messages[guide.length]), "end of the guide");
  // Each request repeats the previous one unchanged and marks where it ended, so the entry the
  // previous request wrote is read even after a turn of more than 20 blocks.
  const end = now.messages.length - 1;
  assert.ok(marked(next.messages[end]), "where the previous request ended");
  assert.deepEqual(next.messages.slice(0, end + 1).map(plain), now.messages.map(plain));
});

test("other models get no cache markers", async () => {
  for (const profile of [openRouter, { ...openRouter, modelId: "kimi-k3", baseUrl: "https://api.moonshot.ai/v1" }]) {
    const body = await payload(profile, { systemPrompt: "Rules.", messages: [...guide, ...turn(1)], tools });
    assert.ok(!JSON.stringify(body).includes("cache_control"));
  }
});

/** A preparation request against a fake OpenAI-format stream; returns the request body, the reply and the costs read. */
async function prepareAgainst(profile: ModelProfile, usage: Record<string, unknown>) {
  const chunks = [
    { id: "gen-1", choices: [{ index: 0, delta: { content: "Ready.\nBEGIN" }, finish_reason: null }] },
    { id: "gen-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { id: "gen-1", choices: [], usage },
  ];
  const stream = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return prepareWith(profile, stream);
}
/** A preparation request answered with `stream`; returns the request body, the reply and the costs recorded. */
async function prepareWith(profile: ModelProfile, stream: string) {
  let sent: Record<string, unknown> | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const costs: number[] = [];
  const sources: string[] = [];
  const upstreams: (string | undefined)[] = [];
  try {
    const reply = await prepareModel(
      profile, "test", "Rules.", { role: "user", content: "Prepare.", timestamp: 0 },
      tools as never,
      AbortSignal.timeout(5000),
      (dollars, source, upstream) => (costs.push(dollars), sources.push(source), upstreams.push(upstream)),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { sent, reply, costs, sources, upstreams };
  } finally {
    globalThis.fetch = original;
  }
}

test("OpenRouter is asked for the billed amount, which is read from a copy of the stream", async () => {
  const { sent, reply, costs, sources } = await prepareAgainst(openRouter, {
    prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, cost: 0.00123, prompt_tokens_details: { cached_tokens: 40 },
  });
  assert.deepEqual(sent?.usage, { include: true });
  // The gameplay tools go with it, so the first gameplay request starts with this one (cached).
  assert.deepEqual((sent?.tools as { function: { name: string } }[]).map((t) => t.function.name), ["observe"]);
  assert.deepEqual(costs, [0.00123]);
  assert.deepEqual(sources, ["billed"]);
  // Pi still reads the whole reply and its usage.
  assert.deepEqual(reply.content.filter((part) => part.type === "text").map((part) => part.text), ["Ready.\nBEGIN"]);
  assert.equal(reply.usage.cacheRead, 40);
});

test("the upstream provider OpenRouter routed the request to is read from the same chunk as the cost", async () => {
  const chunks = [
    { id: "gen-1", provider: "DeepInfra", choices: [{ index: 0, delta: { content: "Ready.\nBEGIN" }, finish_reason: null }] },
    { id: "gen-1", provider: "DeepInfra", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { id: "gen-1", provider: "DeepInfra", choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, cost: 0.00123 } },
  ];
  const stream = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  const { costs, sources, upstreams } = await prepareWith(openRouter, stream);
  assert.deepEqual(costs, [0.00123]);
  assert.deepEqual(sources, ["billed"]);
  assert.deepEqual(upstreams, ["DeepInfra"]);
});

test("a cost chunk without a provider field reports no upstream", async () => {
  const { upstreams } = await prepareAgainst(openRouter, { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, cost: 0.00123 });
  assert.deepEqual(upstreams, [undefined]);
});

test("other providers are not sent OpenRouter's usage option; their tokens are priced with the profile's prices", async () => {
  const kimi = { ...openRouter, modelId: "kimi-k3", baseUrl: "https://api.moonshot.ai/v1" };
  const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 400 } };
  const { sent, costs } = await prepareAgainst(kimi, usage);
  assert.equal(sent?.usage, undefined);
  assert.deepEqual(costs, [], "no prices, no cost");
  const priced = await prepareAgainst({ ...kimi, prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 } }, usage);
  assert.deepEqual(priced.sources, ["prices"]);
  assert.ok(Math.abs(priced.costs[0] - (3 * 600 + 0.3 * 400 + 15 * 100) / 1e6) < 1e-12);
});

test("OpenRouter's billed amount is used even when the profile has prices", async () => {
  const prices = { input: 100, output: 100, cacheRead: 100, cacheWrite: 100 };
  assert.deepEqual(modelConfig({ ...openRouter, prices }).cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const { costs, sources } = await prepareAgainst({ ...openRouter, prices }, { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, cost: 0.002 });
  assert.deepEqual([costs, sources], [[0.002], ["billed"]]);
});

const haiku: ModelProfile = {
  id: "h", name: "Claude Haiku 5.5", modelId: "claude-haiku-5-5", baseUrl: "https://api.anthropic.com", keyConfigured: true,
};

/** Anthropic's stream for a reply with this usage. */
function anthropicReply(usage: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, output: number) {
  const events = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Ready.\nBEGIN" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: output } },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

test("Anthropic reports no cost, so each request is priced from its tokens, long prompts at their own rates", async () => {
  const prices = {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
    longPrompt: { above: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  };
  const short = await prepareWith({ ...haiku, prices }, anthropicReply({ input_tokens: 1000, cache_read_input_tokens: 50000, cache_creation_input_tokens: 2000 }, 500));
  assert.equal(short.reply.usage.output, 500);
  assert.deepEqual(short.sources, ["prices"]);
  assert.ok(Math.abs(short.costs[0] - 0.0011) < 1e-12, String(short.costs[0]));
  const long = await prepareWith({ ...haiku, prices }, anthropicReply({ input_tokens: 1000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 2000 }, 500));
  assert.ok(Math.abs(long.costs[0] - 0.008) < 1e-12, String(long.costs[0]));
  const unpriced = await prepareWith(haiku, anthropicReply({ input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 5));
  assert.deepEqual(unpriced.costs, []);
});

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

test("Claude through Anthropic marks the system prompt, guide, where the previous request ended and the end", async () => {
  let history = [...guide];
  for (let n = 1; n <= 3; n++) history = [...history, ...turn(n)];
  const now = await anthropicRequest(history);
  history = [...history, ...bigTurn(4, 20)];
  const next = await anthropicRequest(history);
  for (const request of [now, next]) {
    assert.ok(JSON.stringify(request.system).includes("cache_control"), "system prompt");
    assert.ok(!JSON.stringify(request.tools).includes("cache_control"), "the system prompt's breakpoint covers the tools");
    assert.ok(JSON.stringify(request).match(/cache_control/g)!.length <= 4, "Anthropic allows four breakpoints");
    assert.equal(markedAt(request)[0], guide.length - 1, "end of the guide");
    assert.ok(markedAt(request).includes(request.messages.length - 1), "the end, written for the next request");
  }
  // The screenshots sit inside tool results and stay there.
  assert.ok(JSON.stringify(now.messages).includes('"type":"tool_result"'));
  const written = now.messages.length - 1;
  // Next turn repeats everything this request sent and reads it at its own mark, though the turn
  // in between has more blocks than Anthropic searches back over from the new end.
  assert.deepEqual(next.messages.slice(0, written + 1).map(unmarked), now.messages.map(unmarked));
  assert.ok(markedAt(next).includes(written), "where the previous request ended");
  assert.ok(blocksBetween(next, written + 1, next.messages.length - 1) > 20);
});
