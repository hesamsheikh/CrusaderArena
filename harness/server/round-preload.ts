/**
 * Loaded into an earlier round's host (version-checkout.ts startHost, `--import`): request
 * handling from this checkout that leaves what a run plays and scores unchanged, for versions
 * made before it. The round's own code stays as its version recorded it.
 *
 * - The prompt cache key for models whose provider routes by one (cache-key.ts). Those hosts send
 *   every model request through the global fetch with the run's session header, so wrapping it
 *   adds the key the same way this checkout's costReader does.
 */
import { cacheKeyFetch } from "./cache-key.js";

globalThis.fetch = cacheKeyFetch(globalThis.fetch.bind(globalThis));
