/**
 * Retries a model request whose connection failed before any response arrived.
 *
 * On 2026-11-12 five games of Gemini 4 Hydrogen on OpenRouter (Google AI Studio) ended on "Connection
 * error.": the request's fetch failed about 0.6 s after it started, with no response, while small
 * requests from the same machine kept succeeding. The run loop retries provider errors it knows to be
 * transient, with the game paused, but not this one, so each ended its game. A request that got no
 * response never reached the model, so sending it again changes nothing the model sees; the game
 * stays paused meanwhile, as for any request. A response that starts and then fails is the run loop's
 * to judge (isTransientProviderError), as before; so is an aborted request.
 */

/** Waits before each retry; the last failure is thrown after them. */
export const CONNECTION_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

/** A body fetch can send again unchanged: every model request's JSON string qualifies. */
function replayable(body: RequestInit["body"]) {
  return body == null || typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)
    || body instanceof URLSearchParams || body instanceof Blob;
}

/** The underlying reason, which the SDKs' "Connection error." leaves out (e.g. "other side closed"). */
export function connectionFailure(error: unknown) {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const message = error instanceof Error ? error.message : String(error);
  return cause ? `${message} (${[cause.code, cause.message].filter(Boolean).join(": ")})` : message;
}

export function connectionRetryFetch(
  inner: typeof fetch,
  delays: readonly number[] = CONNECTION_RETRY_DELAYS_MS,
  onRetry: (attempt: number, reason: string) => void = (attempt, reason) =>
    console.warn(`Request connection failed (${reason}); retry ${attempt} of ${delays.length}.`),
): typeof fetch {
  return async (input, init) => {
    if (input instanceof Request || !replayable(init?.body)) return inner(input, init);
    for (let attempt = 0; ; attempt++) {
      try {
        return await inner(input, init);
      } catch (error) {
        const aborted = init?.signal?.aborted || (error as { name?: string })?.name === "AbortError";
        if (aborted || attempt >= delays.length) throw error;
        onRetry(attempt + 1, connectionFailure(error));
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        if (init?.signal?.aborted) throw error;
      }
    }
  };
}
