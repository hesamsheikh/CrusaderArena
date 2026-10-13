/**
 * A prompt cache key on OpenRouter requests for models whose provider routes by one. Meta keeps
 * Muse Wonder's prompt cache on each server replica and sends requests that share a
 * `prompt_cache_key` to the same replica; without one, a run's requests spread over replicas and
 * miss the cache. Live on 2026-10-13: 3 of a Muse Wonder run's first 11 requests read nothing
 * from the cache, and in a 15-turn test conversation every follow-up read it with a key, against
 * 79% of input tokens without. The key is the run's id, the value its OpenRouter session header
 * (x-session-id) already carries, so one run keeps one replica.
 */

/** Models that need the key: Meta's (meta/…), whose cache is per replica. */
export function wantsCacheKey(model: string) {
  return model.startsWith("meta/");
}

const OPENROUTER_CHAT = /^https:\/\/openrouter\.ai\/api\/v1\/chat\/completions(?:[?#]|$)/;

function urlOf(input: string | URL | Request) {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/**
 * `init` with the run's cache key added, for a chat request to OpenRouter whose model wants one
 * (wantsCacheKey) and that carries the session header but no key; any other request's `init`
 * unchanged. A body that is not JSON text passes through as it is.
 */
export function withCacheKey(input: string | URL | Request, init?: RequestInit): RequestInit | undefined {
  if (!init || typeof init.body !== "string" || (init.method ?? "GET").toUpperCase() !== "POST") return init;
  if (!OPENROUTER_CHAT.test(urlOf(input))) return init;
  const session = new Headers(init.headers).get("x-session-id");
  if (!session) return init;
  let body: unknown;
  try {
    body = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (!body || typeof body !== "object") return init;
  const request = body as { model?: unknown; prompt_cache_key?: unknown };
  if (typeof request.model !== "string" || !wantsCacheKey(request.model) || request.prompt_cache_key !== undefined) return init;
  return { ...init, body: JSON.stringify({ ...request, prompt_cache_key: session }) };
}

/** A fetch that adds the cache key (withCacheKey) before handing the request to `inner`. */
export function cacheKeyFetch(inner: typeof fetch): typeof fetch {
  return (input, init) => inner(input, withCacheKey(input, init));
}
