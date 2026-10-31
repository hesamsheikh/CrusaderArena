/**
 * OpenAI's own API (api.openai.com). Its models go through Pi's Responses API, not chat
 * completions: there a reply's reasoning comes back encrypted and goes out again with the next
 * request, as OpenRouter's reasoning details carry it for the same models, while chat completions
 * drops it after every reply. Pi sends the run's id as the prompt cache key and stores nothing at
 * OpenAI (`store: false`).
 *
 * An earlier round's host predates this and would send an OpenAI profile through chat completions,
 * which OpenAI's reasoning models refuse (they take no `max_tokens`). Its preload
 * (round-preload.ts) loads routingModule in place of Pi's chat-completions factory so such a
 * profile makes the same requests there as here.
 */
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { isOpenAI } from "../shared/protocol.js";

/** "default" (no level given) sends no reasoning setting; "max" is OpenAI's highest effort, "xhigh". */
export const OPENAI_THINKING_LEVELS: ThinkingLevelMap = { off: null, max: "xhigh" };

/**
 * The model an earlier round's host makes for an OpenAI profile, a chat-completions model with
 * the compat settings of an OpenAI-compatible endpoint, as modelConfig makes it here.
 */
export function viaResponses<M extends { api: string; compat?: unknown }>(model: M) {
  const { compat: _compat, ...rest } = model;
  return { ...rest, api: "openai-responses" as const, thinkingLevelMap: OPENAI_THINKING_LEVELS };
}

/** For an earlier round's host: the Responses model for a model on OpenAI's endpoint, else null. */
export function openAIRoute<M extends { api: string; baseUrl: string; compat?: unknown }>(model: M) {
  return isOpenAI(model.baseUrl) ? viaResponses(model) : null;
}

/** Pi's chat-completions factory, which an earlier round's host gives every profile but Claude's. */
export const PI_COMPLETIONS_FACTORY = "/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js";

/**
 * The module an earlier round's host loads in place of Pi's chat-completions factory (the file
 * URL `factory`): the same factory, except that a model on OpenAI's endpoint goes to Pi's
 * Responses API (openAIRoute, from `self`, this module's URL) and every other model to chat
 * completions as before. It imports the original as `factory?chat`, a URL the preload leaves alone.
 */
export function routingModule(factory: string, self: string) {
  return [
    `import { openAICompletionsApi as chatCompletionsApi } from ${JSON.stringify(`${factory}?chat`)};`,
    `import { openAIResponsesApi } from ${JSON.stringify(new URL("openai-responses.lazy.js", factory).href)};`,
    `import { openAIRoute } from ${JSON.stringify(self)};`,
    "export const openAICompletionsApi = () => {",
    "  const chat = chatCompletionsApi();",
    "  const responses = openAIResponsesApi();",
    "  const route = (send) => (model, context, options) => {",
    "    const openai = openAIRoute(model);",
    "    return openai ? responses[send](openai, context, options) : chat[send](model, context, options);",
    "  };",
    `  return { ...chat, stream: route("stream"), streamSimple: route("streamSimple") };`,
    "};",
    "",
  ].join("\n");
}
