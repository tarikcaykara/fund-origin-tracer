export interface LimiterOptions {
  now?: () => number;
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

/** FIFO limiter: consecutive slots are at least `intervalMs` apart. */
export class MinIntervalLimiter {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private lastSlot = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly intervalMs: number,
    opts: LimiterOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? abortableSleep;
  }

  acquire(signal?: AbortSignal, pauseGate?: () => Promise<void>): Promise<void> {
    const run = async () => {
      if (signal?.aborted) throw abortReason(signal);
      if (pauseGate) await pauseGate();
      if (signal?.aborted) throw abortReason(signal);
      const wait = this.lastSlot + this.intervalMs - this.now();
      if (wait > 0) await this.sleep(wait, signal);
      this.lastSlot = this.now();
    };
    const result = this.tail.then(run);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
