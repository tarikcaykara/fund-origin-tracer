import { FotError } from "../errors.ts";
import { abortableSleep } from "../infra/limiter.ts";

export const KEY_EXHAUSTION_RECOVERY_MS = 24 * 3600 * 1000;

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
 * stays exact under concurrency; a key whose quota is spent is skipped for 24 h.
 */
export class TronscanKeyPool {
  private readonly keys: string[];
  private readonly keyIntervalMs: number;
  private readonly globalIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly lastUsed: number[];
  private readonly exhaustedAt: number[];
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
    this.exhaustedAt = this.keys.map(() => Number.NEGATIVE_INFINITY);
  }

  get keyCount(): number {
    return this.keys.length;
  }

  get activeKeyCount(): number {
    const now = this.now();
    return this.keys.filter((_, i) => this.isActive(i, now)).length;
  }

  markExhausted(key: string): void {
    const i = this.keys.indexOf(key);
    if (i >= 0) this.exhaustedAt[i] = this.now();
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
    return now - (this.exhaustedAt[idx] ?? Number.NEGATIVE_INFINITY) >= KEY_EXHAUSTION_RECOVERY_MS;
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
