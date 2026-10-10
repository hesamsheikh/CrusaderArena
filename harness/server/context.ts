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
/** What an events.jsonl record keeps in place of a duplicate image's data (store.ts, index.ts). */
export const IMAGE_LOGGED_ELSEWHERE = "see tool_execution_end";
/**
 * pi-agent-core emits a tool call's image result three times: tool_execution_end's own result,
 * and message_start and message_end of the toolResult message it builds from that same result
 * (the same content array, not a copy). For the event log, index.ts keeps tool_execution_end's
 * copy full and passes the message_start/message_end ones through here, so only one of the three
 * keeps the image's data; the other two keep its mimeType and a pointer to where it is. Returns a
 * new message (or the same one, when there is nothing to replace); the live conversation, which
 * holds the very same content array tool_execution_end emitted, is never mutated.
 */
export function omitDuplicateToolImages<T extends { role: string; content?: unknown }>(message: T): T {
  if (message.role !== "toolResult" || !Array.isArray(message.content)) return message;
  if (!message.content.some((part) => (part as { type?: string })?.type === "image")) return message;
  return {
    ...message,
    content: message.content.map((part) =>
      (part as { type?: string })?.type === "image"
        ? { type: "image", mimeType: (part as { mimeType?: unknown }).mimeType, omitted: IMAGE_LOGGED_ELSEWHERE }
        : part,
    ),
  };
}
type PayloadMessage = { role: string; content?: unknown };
type CacheControl = Record<string, unknown>;
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
 * The message the previous request ended with: the one just before the latest assistant reply,
 * since a request is the previous one plus that reply, its tool results and the host's message.
 * -1 when the conversation has no reply after the guide yet.
 */
function previousEnd(messages: PayloadMessage[], after: number) {
  for (let i = messages.length - 1; i > after; i--) if (messages[i].role === "assistant") return i - 1;
  return -1;
}
/**
 * Moves Anthropic cache breakpoints in an OpenAI-format request (Claude through OpenRouter). Pi
 * marks the system prompt, the last tool and the last message. The conversation only grows
 * between compactions (screenshots stay in it; see capImages), so every request repeats the
 * previous one: the second conversation mark goes where the previous request ended, whose entry
 * it wrote at its own last message, and is read back from there even after a turn with more
 * content than Anthropic searches back over (about 20 blocks) from the new last message. Both
 * marks fall on the last message with text at or before their place, the same rule both times.
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
  const markAtOrBefore = (index: number) => {
    for (let i = index; i > guideEnd; i--) if (markText(messages[i], cacheControl!)) return;
  };
  markAtOrBefore(messages.length - 1);
  const previous = previousEnd(messages, guideEnd);
  // Before the first reply after the guide, the guide's own end is the entry to read.
  if (previous > guideEnd) markAtOrBefore(previous);
  else if (pinned > 0 && messages[guideEnd]) markText(messages[guideEnd], cacheControl);
}
type AnthropicBlock = { type?: string; content?: unknown; cache_control?: CacheControl };
const anthropicBlocks = (message: PayloadMessage) =>
  Array.isArray(message.content) ? (message.content as AnthropicBlock[]) : [];
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
 * API) for the same reason as placeCacheBreakpoints: the end of the pinned guide (read again
 * after a compaction, which keeps the guide), where the previous request ended (read), and the
 * last message (written, read next turn). With the system prompt, which covers the tools before
 * it, four marks, Anthropic's limit.
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
  const markAtOrBefore = (index: number) => {
    for (let i = index; i > guideEnd; i--) if (markBlock(messages[i], cacheControl!)) return;
  };
  markAtOrBefore(messages.length - 1);
  const previous = previousEnd(messages, guideEnd);
  if (previous > guideEnd) markAtOrBefore(previous);
}
/**
 * Screenshots stay in the conversation between compactions, so every request repeats the
 * previous one and the provider's prompt cache covers it; removing an old image would change the
 * conversation from that point on and turn everything after it into uncached input (live
 * 2026-10-11: 20–47k uncached tokens after each new image when only the newest two were kept).
 * Compaction bounds them, as their tokens count toward the context budget. Past IMAGE_CAP
 * unpinned images, a safety limit for providers' per-request image limits, the oldest are
 * replaced in one go, down to IMAGES_AFTER_CAP: one cache miss instead of one per new image.
 */
export const IMAGE_CAP = 16;
export const IMAGES_AFTER_CAP = 4;
export function capImages(messages: AgentMessage[], pinned: ReadonlySet<AgentMessage> = new Set()): AgentMessage[] {
  let count = 0;
  for (const message of messages)
    if (!pinned.has(message) && "content" in message && Array.isArray(message.content))
      count += message.content.filter((block) => block.type === "image").length;
  return count > IMAGE_CAP ? pruneImages(messages, IMAGES_AFTER_CAP, pinned) : messages;
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
/** The instruction's own estimated size, fixed since its text never changes. */
export const handoffInstructionTokens = textTokens(Buffer.byteLength(handoffInstruction));

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
