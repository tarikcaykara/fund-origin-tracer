import { describe, expect, test } from "bun:test";
import type { Transport } from "@fot/core";
import { createRuntime, loadConfig, MEMORY_DB, openDb } from "../src/index.ts";
import { scheduleOfacRefresh } from "../src/ofac-refresh.ts";
import { FAKE_SDN_XML } from "./helpers/fake-etherscan.ts";

const MINUTE = 60_000;
const LISTED = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

interface Clock {
  t: number;
}

/** A manual timer queue: `fire` advances the clock to the pending timer and runs it. */
function timers(clock: Clock) {
  const pending: { run: () => Promise<void>; ms: number; cancelled: boolean }[] = [];
  return {
    setTimer(run: () => Promise<void>, ms: number) {
      const timer = { run, ms, cancelled: false };
      pending.push(timer);
      return {
        cancel() {
          timer.cancelled = true;
        },
      };
    },
    /** Delay of the one live timer. */
    next(): number {
      const live = pending.filter((p) => !p.cancelled);
      expect(live).toHaveLength(1);
      return live[0]?.ms ?? Number.NaN;
    },
    async fire(): Promise<void> {
      const timer = pending.splice(0).find((p) => !p.cancelled);
      if (!timer) throw new Error("no pending timer");
      clock.t += timer.ms;
      await timer.run();
    },
  };
}

/** Fails while `down()` is true, otherwise serves a one-entry SDN list; every fetch takes `fetchMs`. */
function ofacStub(clock: Clock, down: () => boolean, fetchMs = 0) {
  let fetches = 0;
  const transport: Transport = async () => {
    fetches++;
    clock.t += fetchMs;
    return down() ? { status: 503, body: "down" } : { status: 200, body: FAKE_SDN_XML };
  };
  return { transport, fetches: () => fetches };
}

describe("scheduleOfacRefresh", () => {
  test("a failed load is retried after 1, 2, 5, then every 15 minutes, then the regular refresh takes over", async () => {
    const clock = { t: Date.parse("2026-11-01T00:00:00Z") };
    const now = () => clock.t;
    const queue = timers(clock);
    let failing = 6;
    const stub = ofacStub(clock, () => failing-- > 0);
    const runtime = await createRuntime(loadConfig({}), {
      db: openDb(MEMORY_DB),
      transport: stub.transport,
      now,
    });
    expect(runtime.ofacFetchedAt).toBeNull();
    const warnings: string[] = [];
    const refresh = scheduleOfacRefresh({
      runtime,
      refreshHours: runtime.config.ofacRefreshHours,
      now,
      setTimer: queue.setTimer,
      onWarning: (message) => warnings.push(message),
    });

    const delays: number[] = [];
    while (runtime.ofacFetchedAt === null) {
      delays.push(queue.next());
      await queue.fire();
    }
    expect(delays).toEqual([1, 2, 5, 15, 15, 15].map((m) => m * MINUTE));
    expect(stub.fetches()).toBe(7);
    expect(warnings).toHaveLength(5);
    expect(warnings[0]).toContain("sanctions screening disabled");
    expect(runtime.labels.isSanctioned("ethereum", LISTED)).toBe(true);
    expect(runtime.ofacFetchedAt).toBe(new Date(clock.t).toISOString());
    expect(queue.next()).toBe(24 * 60 * MINUTE);

    // A later failure keeps the stale list and starts the backoff from 1 minute again.
    failing = 1;
    await queue.fire();
    expect(warnings.at(-1)).toContain("using stale snapshot");
    expect(runtime.labels.isSanctioned("ethereum", LISTED)).toBe(true);
    expect(queue.next()).toBe(MINUTE);
    await queue.fire();
    expect(queue.next()).toBe(24 * 60 * MINUTE);

    refresh.stop();
    expect(() => queue.next()).toThrow();
  });

  test("OFAC_REFRESH_HOURS=0.5 refreshes every 30 minutes, measured from each download", async () => {
    const clock = { t: Date.parse("2026-11-01T00:00:00Z") };
    const now = () => clock.t;
    const queue = timers(clock);
    // Each download takes 20 s, so a snapshot is always younger than the time since the last tick.
    const stub = ofacStub(clock, () => false, 20_000);
    const config = loadConfig({ OFAC_REFRESH_HOURS: "0.5" });
    const runtime = await createRuntime(config, {
      db: openDb(MEMORY_DB),
      transport: stub.transport,
      now,
    });
    scheduleOfacRefresh({
      runtime,
      refreshHours: config.ofacRefreshHours,
      now,
      setTimer: queue.setTimer,
    });
    for (let i = 1; i <= 3; i++) {
      expect(queue.next()).toBe(30 * MINUTE);
      await queue.fire();
      expect(stub.fetches()).toBe(1 + i);
    }
  });

  test("a snapshot loaded from the database is refreshed when it reaches the configured age", async () => {
    const clock = { t: Date.parse("2026-11-01T00:00:00Z") };
    const now = () => clock.t;
    const queue = timers(clock);
    const db = openDb(MEMORY_DB);
    const stub = ofacStub(clock, () => false);
    await createRuntime(loadConfig({}), { db, transport: stub.transport, now });
    clock.t += 10 * 60 * MINUTE;
    const runtime = await createRuntime(loadConfig({}), { db, transport: stub.transport, now });
    expect(stub.fetches()).toBe(1);
    scheduleOfacRefresh({ runtime, refreshHours: 24, now, setTimer: queue.setTimer });
    expect(queue.next()).toBe(14 * 60 * MINUTE);
    await queue.fire();
    expect(stub.fetches()).toBe(2);
  });
});
