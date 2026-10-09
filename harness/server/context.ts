import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
/** Retain complete tool exchanges; only image blocks are replaced. Audit originals stay on disk. */
const IMAGE_PLACEHOLDER = "[Earlier image omitted to save context; take targets only from the latest screenshot.]";
/**
 * Keep only the newest `keep` images; older ones become a short text placeholder. Pinned
 * messages (the preparation guide) are returned untouched and do not count, and unchanged
 * messages keep their identity, so the start of the conversation stays byte-identical for
 * the provider's prompt cache.
 */
export function pruneImages(
  messages: AgentMessage[],
  keep = 2,
  pinned: ReadonlySet<AgentMessage> = new Set(),
): AgentMessage[] {
  let remaining = keep;
  return messages
    .slice()
    .reverse()
    .map((message) => {
      if (pinned.has(message) || !("content" in message) || !Array.isArray(message.content))
        return message;
      let changed = false;
      const content = message.content
        .slice()
        .reverse()
        .map((block) => {
          if (block.type !== "image" || remaining-- > 0) return block;
          changed = true;
          return { type: "text" as const, text: IMAGE_PLACEHOLDER };
        })
        .reverse();
      return changed ? ({ ...message, content } as AgentMessage) : message;
    })
    .reverse();
}
type PayloadMessage = { role: string; content?: unknown };
type CacheControl = Record<string, unknown>;
const hasImage = (message: PayloadMessage) =>
  Array.isArray(message.content) && message.content.some((part) => part?.type === "image_url");
/** Marks the message's last text part; false when it has none. */
function markText(message: PayloadMessage, cacheControl: CacheControl) {
  if (typeof message.content === "string" && message.content) {
    message.content = [{ type: "text", text: message.content, cache_control: cacheControl }];
    return true;
  }
  const text = Array.isArray(message.content)
    ? (message.content as CacheControl[]).filter((part) => part?.type === "text").at(-1)
    : undefined;
  if (text) text.cache_control = cacheControl;
  return Boolean(text);
}
/**
 * Moves Anthropic cache breakpoints in an OpenAI-format request (Claude through OpenRouter) to
 * places the next request repeats. Pi marks the system prompt, the last tool and the last
 * message, but the last message never pays off here: every turn prunes the oldest kept
 * screenshot, which changes the conversation before it, so each turn would write a cache entry
 * that no later request reads. Instead mark the end of the pinned guide, unchanged for the whole
 * run, and the last message before the oldest unpinned image; everything up to it is sent
 * unchanged next turn. `pinned` counts the guide messages at the start of the conversation.
 */
export function placeCacheBreakpoints(params: { messages: PayloadMessage[] }, pinned: number) {
  const { messages } = params;
  const start = ["system", "developer"].includes(messages[0]?.role) ? 1 : 0;
  let cacheControl: CacheControl | undefined;
  for (let i = messages.length - 1; i >= start && !cacheControl; i--) {
    const parts = Array.isArray(messages[i].content) ? (messages[i].content as CacheControl[]) : [];
    const marked = parts.find((part) => part?.cache_control);
    if (marked) {
      cacheControl = marked.cache_control as CacheControl;
      delete marked.cache_control;
    }
  }
  if (!cacheControl) return;
  const guideEnd = start + pinned - 1;
  if (pinned > 0 && messages[guideEnd]) markText(messages[guideEnd], cacheControl);
  const oldest = messages.findIndex((message, i) => i > guideEnd && hasImage(message));
  if (oldest < 0) {
    markText(messages[messages.length - 1], cacheControl);
    return;
  }
  // Pi sends the images of a group of tool results in a user message after the group's tool
  // messages; their text changes with the images, so the breakpoint goes before the group.
  let i = oldest - 1;
  const content = messages[oldest].content as { text?: string }[];
  if (content[0]?.text === "Attached image(s) from tool result:")
    while (i > guideEnd && messages[i].role === "tool") i--;
  for (; i > guideEnd; i--) if (markText(messages[i], cacheControl)) return;
}
type AnthropicBlock = { type?: string; content?: unknown; cache_control?: CacheControl };
const anthropicBlocks = (message: PayloadMessage) =>
  Array.isArray(message.content) ? (message.content as AnthropicBlock[]) : [];
/** An image block, also inside a tool result. */
const anthropicImage = (message: PayloadMessage) =>
  anthropicBlocks(message).some(
    (block) => block?.type === "image" || (block?.type === "tool_result" && Array.isArray(block.content) && block.content.some((part) => part?.type === "image")),
  );
const MARKABLE = new Set(["text", "image", "tool_use", "tool_result"]);
/** Marks the message's last block that can carry a breakpoint (not thinking); false when it has none. */
function markBlock(message: PayloadMessage, cacheControl: CacheControl) {
  if (typeof message.content === "string" && message.content) {
    message.content = [{ type: "text", text: message.content, cache_control: cacheControl }];
    return true;
  }
  const block = anthropicBlocks(message).filter((b) => MARKABLE.has(b?.type ?? "")).at(-1);
  if (block) block.cache_control = cacheControl;
  return Boolean(block);
}
/**
 * Places the cache breakpoints of an Anthropic Messages request (Claude through Anthropic's own
 * API) for the same reason as placeCacheBreakpoints: Pi marks the system prompt and the last
 * message, and the last message never pays off. Marks the end of the pinned guide, the last
 * message before the oldest unpinned image (written this turn, read next turn), and the last
 * message before the newest placeholder: where the previous request wrote. Anthropic looks for an
 * earlier entry only about 20 blocks back from a breakpoint, and a turn with many tool calls has
 * more, so the previous entry is read at its own breakpoint. With the system prompt, four marks,
 * Anthropic's limit.
 */
export function placeAnthropicCacheBreakpoints(params: { messages: PayloadMessage[] }, pinned: number) {
  const { messages } = params;
  let cacheControl: CacheControl | undefined;
  for (let i = messages.length - 1; i >= 0 && !cacheControl; i--) {
    const block = anthropicBlocks(messages[i]).find((b) => b?.cache_control);
    if (block) {
      cacheControl = block.cache_control;
      delete block.cache_control;
    }
  }
  if (!cacheControl) return;
  const guideEnd = pinned - 1;
  if (pinned > 0 && messages[guideEnd]) markBlock(messages[guideEnd], cacheControl);
  const markBefore = (index: number) => {
    for (let i = index - 1; i > guideEnd; i--) if (markBlock(messages[i], cacheControl!)) return;
  };
  const oldest = messages.findIndex((message, i) => i > guideEnd && anthropicImage(message));
  if (oldest < 0) {
    markBlock(messages[messages.length - 1], cacheControl);
    return;
  }
  markBefore(oldest);
  let pruned = -1;
  for (let i = oldest - 1; i > guideEnd && pruned < 0; i--)
    if (JSON.stringify(messages[i].content).includes(IMAGE_PLACEHOLDER)) pruned = i;
  if (pruned > guideEnd) markBefore(pruned);
}
/**
 * Text tokens estimated at 2.5 UTF-8 bytes each (the harness's JSON and prose measured about
 * 3.2 bytes per provider token, 2026-09-28; one token per byte made compaction fire every few
 * turns) plus a configurable image allowance. Not an exact tokenizer.
 */
export const BYTES_PER_TOKEN = 2.5;
const textTokens = (bytes: number) => Math.ceil(bytes / BYTES_PER_TOKEN);
export function contextEstimate(
  messages: AgentMessage[],
  system: string,
  imageTokens = 4096,
) {
  let images = 0;
  const text = JSON.stringify(messages, (key, value) => {
    if (value?.type === "image") {
      images++;
      return { type: "image" };
    }
    return value;
  });
  return textTokens(Buffer.byteLength(text + system)) + images * imageTokens;
}
export const handoffInstruction = `Your conversation context is about to be compacted. Write a concise handoff to your future self to continue this same run without repeating completed work. Include verified progress with evidence IDs/timestamps, decisions and brief reasons, failed attempts, unresolved issues, uncertain action outcomes, constraints and immediate next steps. Separate observations from assumptions. Do not perform actions or disclose private chain-of-thought. The harness keeps the benchmark rules, the operator's instruction, the controls, the plan and the notebook separately, so do not restate them. Return only the handoff, between 40 and 12000 UTF-8 bytes.`;

/** Last assistant response plus its complete tool results, with stale images removed. */
export function recentExchange(messages: AgentMessage[]) {
  let index = messages.length - 1;
  while (index >= 0 && messages[index].role !== "assistant") index--;
  return index < 0 ? [] : pruneImages(messages.slice(index), 0);
}

/** Provider input usage anchors the unchanged prefix; new/replaced parts retain
 * the conservative byte/image allowance. Removed parts never subtract tokens.
 * This is a budget estimate, not a tokenizer or a provider context guarantee. */
export class ContextBudget {
  private anchor?: { tokens: number; parts: Map<string, number>; systemBytes: number; toolsBytes: number };
  reset() {
    this.anchor = undefined;
  }
  private parts(messages: AgentMessage[], system: string, tools: unknown) {
    // Hash image-bearing messages: calibration must not retain another base64 copy.
    return [
      system,
      JSON.stringify(tools),
      ...messages.map((m) => JSON.stringify(m)),
    ].map((part) => createHash("sha256").update(part).digest("hex"));
  }
  record(
    messages: AgentMessage[],
    system: string,
    tools: unknown,
    tokens: number,
  ) {
    this.reset();
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const parts = new Map<string, number>();
    for (const part of this.parts(messages, system, tools))
      parts.set(part, (parts.get(part) || 0) + 1);
    this.anchor = {
      tokens,
      parts,
      systemBytes: Buffer.byteLength(system),
      toolsBytes: Buffer.byteLength(JSON.stringify(tools)),
    };
  }
  estimate(
    messages: AgentMessage[],
    system: string,
    tools: unknown,
    imageTokens = 4096,
  ) {
    if (!this.anchor)
      return contextEstimate(
        messages,
        system + JSON.stringify(tools),
        imageTokens,
      );
    const remaining = new Map(this.anchor.parts);
    let estimate = this.anchor.tokens;
    const parts = this.parts(messages, system, tools);
    for (let i = 0; i < parts.length; i++) {
      const count = remaining.get(parts[i]) || 0;
      if (count) remaining.set(parts[i], count - 1);
      else
        // The system prompt changes every turn (time left, plan) and is already in the anchor's
        // tokens, so a changed system prompt or tool list adds only its growth, not its full size.
        estimate +=
          i === 0
            ? textTokens(Math.max(0, Buffer.byteLength(system) - this.anchor.systemBytes))
            : i === 1
              ? textTokens(Math.max(0, Buffer.byteLength(JSON.stringify(tools)) - this.anchor.toolsBytes))
              : contextEstimate([messages[i - 2]], "", imageTokens);
    }
    return estimate;
  }
}
