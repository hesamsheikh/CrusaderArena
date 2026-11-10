/**
 * Claude Fable 5.2 binds each thinking block's signature to the conversation that came before it.
 * A compaction keeps the last exchange after a new handoff, so that exchange's thinking block no
 * longer follows the content it was made after, and the API refuses the next request ("Invalid
 * `signature` in `thinking` block. The block is bound to a different conversation"). Live on
 * 2026-11-10: both attempts of Fable 5.2's first Oasis game ended on the first request after the
 * first compaction. The API's own remedy is to ask it to drop such a block
 * (`thinking.block_binding.prefix_mismatch_behavior: "drop_block"`, behind a beta header); a block
 * whose conversation is unchanged is still used. Checked on the API the same day: the rewritten
 * conversation is refused without the setting and answered with it.
 *
 * Only models that bind thinking blocks get the setting, so every other model's requests are sent
 * byte for byte as before.
 */

/** The beta that allows `thinking.block_binding` on the Messages API. */
export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

/** Models that bind thinking blocks to their conversation: Claude Fable 5.2. */
export function bindsThinking(model: string) {
  return /^claude-fable-5-2(?:$|-)/.test(model);
}

const MESSAGES = /^https:\/\/api\.anthropic\.com\/v1\/messages(?:[?#]|$)/;

function urlOf(input: string | URL | Request) {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/**
 * `init` with drop_block and its beta added, for a Messages API request with thinking from a model
 * that binds thinking blocks (bindsThinking) and no block_binding of its own; any other request's
 * `init` unchanged. A body that is not JSON text passes through as it is.
 */
export function withThinkingBinding(input: string | URL | Request, init?: RequestInit): RequestInit | undefined {
  if (!init || typeof init.body !== "string" || (init.method ?? "GET").toUpperCase() !== "POST") return init;
  if (!MESSAGES.test(urlOf(input))) return init;
  let body: unknown;
  try {
    body = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (!body || typeof body !== "object") return init;
  const request = body as { model?: unknown; thinking?: unknown };
  if (typeof request.model !== "string" || !bindsThinking(request.model)) return init;
  const thinking = request.thinking as Record<string, unknown> | undefined;
  if (!thinking || typeof thinking !== "object" || thinking.type === "disabled" || thinking.block_binding !== undefined)
    return init;
  const headers = new Headers(init.headers);
  const betas = (headers.get("anthropic-beta") ?? "").split(",").map((b) => b.trim()).filter(Boolean);
  if (!betas.includes(THINKING_BINDING_BETA)) betas.push(THINKING_BINDING_BETA);
  headers.set("anthropic-beta", betas.join(","));
  return {
    ...init,
    headers,
    body: JSON.stringify({ ...request, thinking: { ...thinking, block_binding: { prefix_mismatch_behavior: "drop_block" } } }),
  };
}

/** A fetch that adds drop_block (withThinkingBinding) before handing the request to `inner`. */
export function thinkingBindingFetch(inner: typeof fetch): typeof fetch {
  return (input, init) => inner(input, withThinkingBinding(input, init));
}
