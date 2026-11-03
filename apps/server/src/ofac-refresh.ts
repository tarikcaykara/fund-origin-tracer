import type { Runtime } from "./runtime.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Lower bound for any wait, so a clock that disagrees with the timers cannot spin. */
const MIN_DELAY_MS = 1_000;
/** `setTimeout` fires at once for longer delays; a longer wait is reached in steps. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/** Waits between retries while no list within its refresh window is loaded; the last one repeats. */
export const OFAC_RETRY_DELAYS_MS: readonly number[] = [1, 2, 5, 15].map((m) => m * MINUTE_MS);

export interface OfacTimer {
  cancel(): void;
}

export interface OfacRefreshOptions {
  runtime: Pick<Runtime, "refreshOfac" | "ofacFetchedAt">;
  refreshHours: number;
  now?: () => number;
  /** Receives the message of every failed load. */
  onWarning?: (message: string) => void;
  /** Defaults to an unref'd `setTimeout`. */
  setTimer?: (run: () => Promise<void>, ms: number) => OfacTimer;
}

export interface OfacRefresh {
  stop(): void;
}

function defaultTimer(run: () => Promise<void>, ms: number): OfacTimer {
  const handle = setTimeout(run, ms);
  handle.unref();
  return { cancel: () => clearTimeout(handle) };
}

/**
 * Keeps the runtime's OFAC list current. While no list within its refresh window is loaded
 * (a failed boot load, or only a stale snapshot) it retries after 1, 2, 5, then every 15 minutes.
 * Once one is loaded, the next refresh is due when that snapshot is `refreshHours` old, so the
 * time a download takes never pushes a refresh past its window.
 */
export function scheduleOfacRefresh(options: OfacRefreshOptions): OfacRefresh {
  const { runtime } = options;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? defaultTimer;
  const refreshMs = options.refreshHours * HOUR_MS;
  let failures = 0;
  let timer: OfacTimer | null = null;
  let stopped = false;

  function scheduleNext(): void {
    if (stopped) return;
    const age = now() - Date.parse(runtime.ofacFetchedAt ?? "");
    let delay: number;
    if (Number.isFinite(age) && age >= 0 && age < refreshMs) {
      failures = 0;
      delay = refreshMs - age;
    } else {
      delay =
        OFAC_RETRY_DELAYS_MS[Math.min(failures, OFAC_RETRY_DELAYS_MS.length - 1)] ?? MINUTE_MS;
      failures++;
    }
    timer = setTimer(run, Math.min(Math.max(delay, MIN_DELAY_MS), MAX_DELAY_MS));
  }

  async function run(): Promise<void> {
    timer = null;
    try {
      const warning = await runtime.refreshOfac();
      if (warning) options.onWarning?.(warning.message);
    } catch (e) {
      options.onWarning?.(`OFAC refresh failed (${e instanceof Error ? e.message : String(e)})`);
    }
    scheduleNext();
  }

  scheduleNext();
  return {
    stop() {
      stopped = true;
      timer?.cancel();
      timer = null;
    },
  };
}
