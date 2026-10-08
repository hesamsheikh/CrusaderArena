import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
/** Retain complete tool exchanges; only image blocks are replaced. Audit originals stay on disk. */
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
          return {
            type: "text" as const,
            text: "[Earlier image omitted to save context; take targets only from the latest screenshot.]",
          };
        })
        .reverse();
      return changed ? ({ ...message, content } as AgentMessage) : message;
    })
    .reverse();
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
