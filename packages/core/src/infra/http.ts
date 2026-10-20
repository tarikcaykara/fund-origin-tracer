import type { ProviderStats } from "../providers/types.ts";
import { type RetryOptions, withRetry } from "./retry.ts";
import type { CacheStore } from "./store.ts";

/** One successful attempt: the response body to return and how long to cache it (null = never). */
export interface AttemptResult {
  body: string;
  ttlSec: number | null;
}

/**
 * Provider request pipeline: cache → (retry → attempt). `attempt` acquires its rate-limit slot,
 * calls the transport once, counts `stats.apiCalls`, and throws a `FotError` for error envelopes
 * (retryable ones are retried here). Error envelopes are never cached; callers return `ttlSec`
 * for genuine results, including empty ones.
 */
export async function cachedRequest(opts: {
  cache: CacheStore;
  key: string;
  stats: ProviderStats;
  signal: AbortSignal;
  retry?: Omit<RetryOptions, "signal">;
  attempt: () => Promise<AttemptResult>;
}): Promise<string> {
  const hit = await opts.cache.get(opts.key);
  if (hit !== null) {
    opts.stats.cacheHits++;
    return hit;
  }
  const result = await withRetry(opts.attempt, { ...opts.retry, signal: opts.signal });
  if (result.ttlSec !== null && result.ttlSec > 0) {
    await opts.cache.set(opts.key, result.body, result.ttlSec);
  }
  return result.body;
}

export const TTL_IMMUTABLE_SEC = 30 * 86400;
export const TTL_RECENT_SEC = 300;

/** 30 days when the queried time bound (or tx time) is older than 1 h, else 300 s. */
export function ttlForTimestamp(ts: number | undefined, nowMs: number): number {
  if (ts === undefined) return TTL_RECENT_SEC;
  return nowMs / 1000 - ts > 3600 ? TTL_IMMUTABLE_SEC : TTL_RECENT_SEC;
}
