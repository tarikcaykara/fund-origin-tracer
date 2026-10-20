export interface LimiterOptions {
  /** Epoch milliseconds; injected so core never reads the clock itself. */
  now: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

/**
 * FIFO limiter: consecutive slots are at least `intervalMs` apart. One instance may be shared
 * by concurrent runs, so the pause gate is awaited before queueing (a paused run never blocks
 * other runs) and an aborted waiter leaves the queue immediately.
 */
export class MinIntervalLimiter {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private lastSlot = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly intervalMs: number,
    opts: LimiterOptions,
  ) {
    this.now = opts.now;
    this.sleep = opts.sleep ?? abortableSleep;
  }

  async acquire(signal?: AbortSignal, pauseGate?: () => Promise<void>): Promise<void> {
    if (pauseGate) await pauseGate();
    if (signal?.aborted) throw abortReason(signal);
    const run = async () => {
      if (signal?.aborted) throw abortReason(signal);
      const wait = this.lastSlot + this.intervalMs - this.now();
      if (wait > 0) await this.sleep(wait, signal);
      this.lastSlot = this.now();
    };
    const result = this.tail.then(run);
    this.tail = result.catch(() => undefined);
    return raceAbort(result, signal);
  }
}

function raceAbort(p: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return p;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = () => reject(abortReason(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  return promise;
}
