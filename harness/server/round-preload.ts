/**
 * Loaded into an earlier round's host (version-checkout.ts startHost, `--import`): request
 * handling from this checkout that leaves what a run plays and scores unchanged, for versions
 * made before it. The round's own code stays as its version recorded it.
 *
 * - The prompt cache key for models whose provider routes by one (cache-key.ts). Those hosts send
 *   every model request through the global fetch with the run's session header, so wrapping it
 *   adds the key the same way this checkout's costReader does.
 * - OpenAI's own endpoint through the Responses API (openai.ts). Those hosts give an OpenAI
 *   profile Pi's chat-completions API, so a resolve hook loads routingModule in place of Pi's
 *   chat-completions factory, which hands that profile's requests to Pi's Responses API as this
 *   checkout's modelConfig does. (A load hook cannot pass modules through unchanged here: Node
 *   24's in-thread load hooks fail Pi's dynamic imports under tsx.)
 * - drop_block for models that bind thinking blocks to their conversation (thinking-binding.ts).
 *   Pi's Anthropic client takes the global fetch when it is made, once per request.
 */
import { registerHooks } from "node:module";
import { cacheKeyFetch } from "./cache-key.js";
import { thinkingBindingFetch } from "./thinking-binding.js";
import { PI_COMPLETIONS_FACTORY, routingModule } from "./openai.js";

globalThis.fetch = thinkingBindingFetch(cacheKeyFetch(globalThis.fetch.bind(globalThis)));

const self = new URL("./openai.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (!resolved.url.endsWith(PI_COMPLETIONS_FACTORY)) return resolved;
    const source = routingModule(resolved.url, self);
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, format: "module", shortCircuit: true };
  },
});
