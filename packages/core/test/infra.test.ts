import { describe, expect, test } from "bun:test";
import { FotError } from "../src/errors.ts";
import { RunController } from "../src/infra/controller.ts";
import { MinIntervalLimiter } from "../src/infra/limiter.ts";
import { assertHttpOk, parseRetryAfter, withRetry } from "../src/infra/retry.ts";
import { cacheKey, MemoryCacheStore } from "../src/infra/store.ts";
import { FixtureTransport, RecordingTransport, requestKey } from "../src/infra/transport.ts";

describe("transport", () => {
  test("requestKey sorts params and strips apikey", () => {
    expect(requestKey({ url: "https://x.io/api?b=2&apikey=SECRET&a=1" })).toBe(
      "GET https://x.io/api?a=1&b=2",
    );
    expect(requestKey({ url: "https://x.io/api?apikey=K" })).toBe("GET https://x.io/api");
  });

  test("fixture transport hit, miss and recording", async () => {
    const recs: Array<{ key: string; status: number; body: string }> = [];
    const fixtures = FixtureTransport(
      new Map([["GET https://x.io/a?k=1", { status: 200, body: "ok" }]]),
    );
    const t = RecordingTransport(fixtures, (r) => recs.push(r));
    const res = await t({ url: "https://x.io/a?k=1&apikey=Z", headers: { "X-Key": "secret" } });
    expect(res.body).toBe("ok");
    expect(recs).toEqual([{ key: "GET https://x.io/a?k=1", status: 200, body: "ok" }]);
    expect(JSON.stringify(recs)).not.toContain("secret");
    const miss = await fixtures({ url: "https://x.io/zzz" }).catch((e) => e);
    expect(miss).toBeInstanceOf(FotError);
    expect(miss.code).toBe("fixture_miss");
  });
});

describe("limiter", () => {
  function fake() {
    let t = 0;
    const slept: number[] = [];
    return {
      slept,
      now: () => t,
      sleep: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
    };
  }

  test("FIFO with min spacing", async () => {
    const f = fake();
    const lim = new MinIntervalLimiter(1000, f);
    const order: number[] = [];
    await Promise.all([0, 1, 2].map((i) => lim.acquire().then(() => order.push(i))));
    expect(order).toEqual([0, 1, 2]);
    expect(f.slept).toEqual([1000, 1000]);
  });

  test("abort rejects and does not block the queue", async () => {
    const f = fake();
    const lim = new MinIntervalLimiter(1000, f);
    const ac = new AbortController();
    await lim.acquire();
    const a = lim.acquire(ac.signal);
    ac.abort();
    await expect(a).rejects.toBeDefined();
    await lim.acquire();
  });

  test("awaits the pause gate before the slot", async () => {
    const f = fake();
    const lim = new MinIntervalLimiter(1000, f);
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let done = false;
    const p = lim
      .acquire(undefined, () => gate)
      .then(() => {
        done = true;
      });
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await p;
    expect(done).toBe(true);
  });
});

describe("withRetry", () => {
  const noSleep = () => {
    const waits: number[] = [];
    return { waits, sleep: async (ms: number) => void waits.push(ms) };
  };

  test("retries retryable errors with exponential backoff then succeeds", async () => {
    const s = noSleep();
    let n = 0;
    const out = await withRetry(
      async () => {
        if (++n < 4) throw new FotError("provider_error", "x", { retryable: true });
        return "ok";
      },
      { sleep: s.sleep },
    );
    expect(out).toBe("ok");
    expect(s.waits).toEqual([1000, 2000, 4000]);
  });

  test("caps backoff and gives up after attempts", async () => {
    const s = noSleep();
    let n = 0;
    const err = await withRetry(
      async () => {
        n++;
        throw new FotError("network_error", "x", { retryable: true });
      },
      { attempts: 6, sleep: s.sleep },
    ).catch((e) => e);
    expect(err.code).toBe("network_error");
    expect(n).toBe(6);
    expect(s.waits).toEqual([1000, 2000, 4000, 8000, 8000]);
  });

  test("does not retry non-retryable or foreign errors", async () => {
    const s = noSleep();
    let n = 0;
    await withRetry(
      async () => {
        n++;
        throw new FotError("not_found", "x");
      },
      { sleep: s.sleep },
    ).catch(() => {});
    await withRetry(
      async () => {
        n++;
        throw new Error("boom");
      },
      { sleep: s.sleep },
    ).catch(() => {});
    expect(n).toBe(2);
    expect(s.waits).toEqual([]);
  });

  test("honors Retry-After", async () => {
    const s = noSleep();
    let n = 0;
    await withRetry(
      async () => {
        if (++n < 2) throw new FotError("rate_limited", "x", { retryable: true, retryAfterSec: 7 });
      },
      { sleep: s.sleep },
    );
    expect(s.waits).toEqual([7000]);
  });

  test("assertHttpOk maps statuses", () => {
    expect(() => assertHttpOk({ status: 200 }, "t", 0)).not.toThrow();
    expect(() => assertHttpOk({ status: 404 }, "t", 0)).not.toThrow();
    try {
      assertHttpOk({ status: 429, retryAfter: "3" }, "t", 0);
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: "rate_limited", retryable: true, retryAfterSec: 3 });
    }
    try {
      assertHttpOk({ status: 503 }, "t", 0);
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: "provider_error", retryable: true });
    }
    expect(parseRetryAfter(undefined, 0)).toBeUndefined();
    expect(parseRetryAfter("abc", 0)).toBeUndefined();
    // An HTTP-date is measured against the injected clock, not the wall clock.
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:10 GMT", 4000)).toBe(6);
  });
});

describe("store", () => {
  test("MemoryCacheStore TTL expiry", async () => {
    let now = 1000;
    const s = new MemoryCacheStore(() => now);
    await s.set("k", "v", 10);
    expect(await s.get("k")).toBe("v");
    now += 9999;
    expect(await s.get("k")).toBe("v");
    now += 1;
    expect(await s.get("k")).toBeNull();
    expect(await s.get("missing")).toBeNull();
  });

  test("cacheKey is order-independent, ignores apikey, is hex sha-256", async () => {
    const a = await cacheKey("etherscan", "ethereum", "tokentx", { b: 2, a: 1, apikey: "X" });
    const b = await cacheKey("etherscan", "ethereum", "tokentx", { a: 1, b: 2, apikey: "Y" });
    const c = await cacheKey("etherscan", "ethereum", "tokentx", { a: 1, b: 3 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("RunController", () => {
  test("pause/resume", async () => {
    const c = new RunController();
    expect(c.status).toBe("running");
    await c.waitIfPaused();
    c.pause();
    expect(c.status).toBe("paused");
    let resumed = false;
    const w = c.waitIfPaused().then(() => {
      resumed = true;
    });
    await Promise.resolve();
    expect(resumed).toBe(false);
    c.resume();
    await w;
    expect(c.status).toBe("running");
  });

  test("cancel releases waiters, aborts signal, first reason wins", async () => {
    const c = new RunController();
    c.pause();
    const w = c.waitIfPaused();
    c.cancel("timeout");
    await w;
    expect(c.signal.aborted).toBe(true);
    expect(c.status).toBe("timed_out");
    c.cancel("cancelled");
    expect(c.cancelReason).toBe("timeout");
    c.pause();
    expect(c.status).toBe("timed_out");
  });
});
