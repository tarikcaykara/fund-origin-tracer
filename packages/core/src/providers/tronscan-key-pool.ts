import { FotError } from "../errors.ts";
import { abortableSleep } from "../infra/limiter.ts";

/** First rest of a rate-limited key; it doubles each time the key is rested again without a success. */
export const KEY_COOLDOWN_BASE_MS = 60_000;
/** The longest rest, also the cap on a `Retry-After`. */
export const KEY_COOLDOWN_MAX_MS = 24 * 3600 * 1000;

export interface TronscanKeyPoolOptions {
  keys: readonly string[];
  /** Minimum spacing between two uses of the same key. */
  keyIntervalMs?: number;
  /** Minimum spacing between any two requests, regardless of key. */
  globalIntervalMs?: number;
  /** Epoch milliseconds; injected so core never reads the clock itself. */
  now: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface AcquireOptions {
  signal?: AbortSignal;
  pauseGate?: () => Promise<void>;
  /** Keep using this key while it is still active (used for retries within one attempt round). */
  preferKey?: string;
}

/**
 * Round-robin Tronscan key rotator, shared by every run. Slots are handed out FIFO so spacing
 * stays exact under concurrency. A rate-limited key rests for `KEY_COOLDOWN_BASE_MS`, doubling while
 * it keeps failing, up to `KEY_COOLDOWN_MAX_MS`; a successful request resets the backoff.
 */
export class TronscanKeyPool {
  private readonly keys: string[];
  private readonly keyIntervalMs: number;
  private readonly globalIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly lastUsed: number[];
  /** Epoch ms until which each key rests. */
  private readonly restUntil: number[];
  /** Rests since the key's last successful request. */
  private readonly strikes: number[];
  private lastGlobal = Number.NEGATIVE_INFINITY;
  private cursor = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: TronscanKeyPoolOptions) {
    this.keys = [...new Set(opts.keys.map((k) => k.trim()).filter((k) => k !== ""))];
    if (this.keys.length === 0) throw new Error("TronscanKeyPool needs at least one API key");
    this.keyIntervalMs = opts.keyIntervalMs ?? 2000;
    this.globalIntervalMs = opts.globalIntervalMs ?? 500;
    this.now = opts.now;
    this.sleep = opts.sleep ?? abortableSleep;
    this.lastUsed = this.keys.map(() => Number.NEGATIVE_INFINITY);
    this.restUntil = this.keys.map(() => Number.NEGATIVE_INFINITY);
    this.strikes = this.keys.map(() => 0);
  }

  get keyCount(): number {
    return this.keys.length;
  }

  get activeKeyCount(): number {
    const now = this.now();
    return this.keys.filter((_, i) => this.isActive(i, now)).length;
  }

  /**
   * Rests `key` after a rate limit. A failure while the key is already resting does not add a strike
   * (one burst on concurrent requests counts once), but a longer `retryAfterMs` still extends it.
   */
  markExhausted(key: string, retryAfterMs?: number): void {
    const i = this.keys.indexOf(key);
    if (i < 0) return;
    const now = this.now();
    let backoff = 0;
    if (this.isActive(i, now)) {
      const strikes = (this.strikes[i] ?? 0) + 1;
      this.strikes[i] = strikes;
      backoff = KEY_COOLDOWN_BASE_MS * 2 ** (strikes - 1);
    }
    const cooldown = Math.min(KEY_COOLDOWN_MAX_MS, Math.max(backoff, retryAfterMs ?? 0));
    this.restUntil[i] = Math.max(this.restUntil[i] ?? Number.NEGATIVE_INFINITY, now + cooldown);
  }

  /** The key served a request: its next rest starts at `KEY_COOLDOWN_BASE_MS` again. */
  markSucceeded(key: string): void {
    const i = this.keys.indexOf(key);
    if (i >= 0) this.strikes[i] = 0;
  }

  async acquire(opts: AcquireOptions = {}): Promise<string> {
    const { signal, pauseGate, preferKey } = opts;
    if (pauseGate) await pauseGate();
    signal?.throwIfAborted();
    const run = async (): Promise<string> => {
      for (;;) {
        signal?.throwIfAborted();
        const now = this.now();
        const idx = this.pick(now, preferKey);
        const readyAt = Math.max(this.keyReadyFloor(idx), this.lastGlobal + this.globalIntervalMs);
        const wait = readyAt - now;
        if (wait > 0) {
          await this.sleep(wait, signal);
          continue;
        }
        this.lastUsed[idx] = now;
        this.lastGlobal = now;
        this.cursor = (idx + 1) % this.keys.length;
        return this.keys[idx] as string;
      }
    };
    const result = this.tail.then(run);
    this.tail = result.catch(() => undefined);
    return raceAbort(result, signal);
  }

  private keyReadyFloor(idx: number): number {
    return (this.lastUsed[idx] ?? Number.NEGATIVE_INFINITY) + this.keyIntervalMs;
  }

  private isActive(idx: number, now: number): boolean {
    return now >= (this.restUntil[idx] ?? Number.NEGATIVE_INFINITY);
  }

  /** Index of the key to use next: the preferred one, else the first ready from the cursor, else the soonest ready. */
  private pick(now: number, preferKey: string | undefined): number {
    if (preferKey !== undefined) {
      const p = this.keys.indexOf(preferKey);
      if (p >= 0 && this.isActive(p, now)) return p;
    }
    let best = -1;
    let bestReady = Number.POSITIVE_INFINITY;
    for (let step = 0; step < this.keys.length; step++) {
      const i = (this.cursor + step) % this.keys.length;
      if (!this.isActive(i, now)) continue;
      const ready = this.keyReadyFloor(i);
      if (ready <= now) return i;
      if (ready < bestReady) {
        bestReady = ready;
        best = i;
      }
    }
    if (best < 0) {
      throw new FotError("rate_limited", "All Tronscan API keys exhausted", { fatal: true });
    }
    return best;
  }
}

function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  signal.addEventListener("abort", onAbort, { once: true });
  p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  return promise;
}
