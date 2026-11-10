import { FotError } from "../errors.ts";
import { abortableSleep } from "./limiter.ts";

/** The longest Retry-After waited out; a longer one ends the request as `rate_limited`. */
export const MAX_RETRY_AFTER_SEC = 60;

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  capMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 1000;
  const capMs = opts.capMs ?? 8000;
  const sleep = opts.sleep ?? abortableSleep;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof FotError) || !e.retryable || i >= attempts - 1) throw e;
      if (opts.signal?.aborted) throw e;
      if (e.retryAfterSec !== undefined && e.retryAfterSec > MAX_RETRY_AFTER_SEC) {
        throw retryAfterTooLong(e, e.retryAfterSec);
      }
      const backoff = Math.min(capMs, baseMs * 2 ** i);
      const wait =
        e.retryAfterSec !== undefined ? Math.max(backoff, e.retryAfterSec * 1000) : backoff;
      await sleep(wait, opts.signal);
    }
  }
}

/**
 * A `rate_limited` error passes through unchanged, so callers that handle its subclass still
 * see it (Tronscan retires the key); any other code becomes `rate_limited`.
 */
function retryAfterTooLong(e: FotError, retryAfterSec: number): FotError {
  if (e.code === "rate_limited") return e;
  return new FotError(
    "rate_limited",
    `${e.message} (Retry-After ${retryAfterSec} s exceeds ${MAX_RETRY_AFTER_SEC} s)`,
    { retryAfterSec, cause: e },
  );
}

export function parseRetryAfter(value: string | undefined, nowMs: number): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, (date - nowMs) / 1000);
}

/** Throws a retryable FotError for HTTP 429/5xx; other statuses pass through. */
export function assertHttpOk(
  res: { status: number; retryAfter?: string },
  what: string,
  nowMs: number,
): void {
  const retryAfterSec = parseRetryAfter(res.retryAfter, nowMs);
  const extra = retryAfterSec === undefined ? {} : { retryAfterSec };
  if (res.status === 429) {
    throw new FotError("rate_limited", `${what}: HTTP 429`, { retryable: true, ...extra });
  }
  if (res.status >= 500) {
    throw new FotError("provider_error", `${what}: HTTP ${res.status}`, {
      retryable: true,
      ...extra,
    });
  }
}

/** Wraps an arbitrary thrown network failure as a retryable FotError (abort errors pass through). */
export function toNetworkError(e: unknown, signal?: AbortSignal): unknown {
  if (e instanceof FotError || signal?.aborted) return e;
  return new FotError("network_error", `Network request failed: ${String(e)}`, {
    retryable: true,
    cause: e,
  });
}
