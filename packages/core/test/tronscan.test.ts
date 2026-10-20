import { describe, expect, test } from "bun:test";
import { FotError } from "../src/errors.ts";
import { MemoryCacheStore } from "../src/infra/store.ts";
import type { Transport } from "../src/infra/transport.ts";
import { TronscanProvider } from "../src/providers/tronscan.ts";
import { TronscanKeyPool } from "../src/providers/tronscan-key-pool.ts";
import txPage from "./fixtures/tronscan/transaction-in-page.json" with { type: "json" };
import txInfoTrc20 from "./fixtures/tronscan/transaction-info-trc20.json" with { type: "json" };
import txInfoTrx from "./fixtures/tronscan/transaction-info-trx.json" with { type: "json" };
import trc20Page from "./fixtures/tronscan/trc20-in-page.json" with { type: "json" };

const ADDR = "TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const NOW_MS = 1_800_000_000_000;
const noRetrySleep = { attempts: 4, baseMs: 1, capMs: 1, sleep: async () => {} };

interface Call {
  endpoint: string;
  params: Record<string, string>;
  apiKey: string;
}
type Reply = { status: number; body: unknown };
type Handler = (call: Call, n: number) => Reply;

function setup(keys: string[], handler: Handler, maxPages = 2) {
  const calls: Call[] = [];
  const transport: Transport = async (req) => {
    const u = new URL(req.url);
    const call: Call = {
      endpoint: u.pathname.split("/").pop() ?? "",
      params: Object.fromEntries(u.searchParams.entries()),
      apiKey: req.headers?.["TRON-PRO-API-KEY"] ?? "",
    };
    calls.push(call);
    const r = handler(call, calls.length - 1);
    return { status: r.status, body: JSON.stringify(r.body) };
  };
  const keyPool = new TronscanKeyPool({
    keys,
    keyIntervalMs: 0,
    globalIntervalMs: 0,
    now: () => NOW_MS,
    sleep: async () => {},
  });
  const provider = new TronscanProvider({
    keyPool,
    maxPages,
    transport,
    cache: new MemoryCacheStore(() => NOW_MS),
    now: () => NOW_MS,
    retry: noRetrySleep,
  });
  return { provider, keyPool, calls };
}

const signal = new AbortController().signal;
const ok = (body: unknown): Reply => ({ status: 200, body });

function fakeClock() {
  const state = { t: 1_000_000, sleeps: [] as number[] };
  return {
    state,
    now: () => state.t,
    sleep: async (ms: number) => {
      state.sleeps.push(ms);
      state.t += ms;
    },
  };
}

describe("TronscanKeyPool", () => {
  test("honors per-key and global spacing, round-robin", async () => {
    const c = fakeClock();
    const pool = new TronscanKeyPool({
      keys: ["a", "b"],
      keyIntervalMs: 2000,
      globalIntervalMs: 500,
      now: c.now,
      sleep: c.sleep,
    });
    const t0 = c.state.t;
    const got: Array<[string, number]> = [];
    for (let i = 0; i < 4; i++) got.push([await pool.acquire(), c.state.t - t0]);
    expect(got).toEqual([
      ["a", 0],
      ["b", 500],
      ["a", 2000],
      ["b", 2500],
    ]);
  });

  test("skips exhausted keys, recovers after 24h, throws fatal when none left", async () => {
    const c = fakeClock();
    const pool = new TronscanKeyPool({
      keys: ["a", "b"],
      keyIntervalMs: 0,
      globalIntervalMs: 0,
      now: c.now,
      sleep: c.sleep,
    });
    pool.markExhausted("a");
    expect(await pool.acquire()).toBe("b");
    expect(await pool.acquire()).toBe("b");
    expect(pool.activeKeyCount).toBe(1);
    pool.markExhausted("b");
    const err = await pool.acquire().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FotError);
    expect((err as FotError).code).toBe("rate_limited");
    expect((err as FotError).fatal).toBe(true);
    expect((err as FotError).message).toBe("All Tronscan API keys exhausted");
    c.state.t += 24 * 3600 * 1000;
    expect(pool.activeKeyCount).toBe(2);
    expect(await pool.acquire()).toBe("a");
  });

  test("preferKey sticks to the key while active; abort leaves the queue", async () => {
    const c = fakeClock();
    const pool = new TronscanKeyPool({
      keys: ["a", "b"],
      keyIntervalMs: 1000,
      globalIntervalMs: 0,
      now: c.now,
      sleep: c.sleep,
    });
    expect(await pool.acquire({ preferKey: "b" })).toBe("b");
    expect(await pool.acquire({ preferKey: "b" })).toBe("b");
    expect(c.state.sleeps).toEqual([1000]);
    const ac = new AbortController();
    ac.abort(new Error("stop"));
    await expect(pool.acquire({ signal: ac.signal })).rejects.toThrow("stop");
  });
});

describe("TronscanProvider.getTransaction", () => {
  test("parses a TRC20 transfer, canonical USDT metadata, ms→s timestamp", async () => {
    const { provider, calls } = setup(["k1"], () => ok(txInfoTrc20));
    const tx = await provider.getTransaction(txInfoTrc20.hash.toUpperCase(), signal);
    expect(calls[0]?.endpoint).toBe("transaction-info");
    expect(calls[0]?.params.hash).toBe(txInfoTrc20.hash);
    expect(tx.status).toBe("success");
    expect(tx.timestamp).toBe(Math.floor(txInfoTrc20.timestamp / 1000));
    expect(tx.transfers).toHaveLength(1);
    const t = tx.transfers[0];
    expect(t?.asset).toMatchObject({ kind: "token", contract: USDT, symbol: "USDT", decimals: 6 });
    expect(t?.amountRaw).toBe("2000000");
    expect(t?.amount).toBe(2);
    expect(t?.from).toBe(txInfoTrc20.ownerAddress);
  });

  test("parses a native TRX transfer in SUN", async () => {
    const { provider } = setup(["k1"], () => ok(txInfoTrx));
    const tx = await provider.getTransaction(txInfoTrx.hash, signal);
    expect(tx.transfers).toEqual([
      expect.objectContaining({
        asset: { chain: "tron", kind: "native" },
        amountRaw: "10000",
        amount: 0.01,
        from: txInfoTrx.contractData.owner_address,
        to: txInfoTrx.contractData.to_address,
      }),
    ]);
  });

  test("non-SUCCESS contractRet → tx_failed", async () => {
    const { provider } = setup(["k1"], () => ok({ ...txInfoTrc20, contractRet: "OUT_OF_ENERGY" }));
    const err = await provider.getTransaction(txInfoTrc20.hash, signal).catch((e: unknown) => e);
    expect((err as FotError).code).toBe("tx_failed");
  });

  test("empty object → not_found, and is not cached", async () => {
    const { provider, calls } = setup(["k1"], () => ok({}));
    for (let i = 0; i < 2; i++) {
      const err = await provider.getTransaction(txInfoTrc20.hash, signal).catch((e: unknown) => e);
      expect((err as FotError).code).toBe("not_found");
    }
    expect(calls).toHaveLength(2);
  });

  test("a successful response is cached (second read is a cache hit)", async () => {
    const { provider, calls } = setup(["k1"], () => ok(txInfoTrc20));
    await provider.getTransaction(txInfoTrc20.hash, signal);
    await provider.getTransaction(txInfoTrc20.hash, signal);
    expect(calls).toHaveLength(1);
    expect(provider.stats()).toEqual({ apiCalls: 1, cacheHits: 1 });
  });
});

describe("TronscanProvider key rotation", () => {
  test("quota-style error body retires the key and retries once on the next", async () => {
    const { provider, keyPool, calls } = setup(["k1", "k2"], (c) =>
      c.apiKey === "k1" ? ok({ Error: "Daily request limit exceeded" }) : ok(txInfoTrx),
    );
    const tx = await provider.getTransaction(txInfoTrx.hash, signal);
    expect(tx.transfers).toHaveLength(1);
    expect(calls.map((c) => c.apiKey)).toEqual(["k1", "k2"]);
    expect(keyPool.activeKeyCount).toBe(1);
  });

  test("HTTP 429 is retried on the same key, then the key is retired", async () => {
    const { provider, keyPool, calls } = setup(["k1", "k2"], (c) =>
      c.apiKey === "k1" ? { status: 429, body: { message: "slow down" } } : ok(txInfoTrx),
    );
    await provider.getTransaction(txInfoTrx.hash, signal);
    expect(calls.map((c) => c.apiKey)).toEqual(["k1", "k1", "k1", "k1", "k2"]);
    expect(keyPool.activeKeyCount).toBe(1);
  });

  test("a non-quota error body is a provider_error and keeps the key", async () => {
    const { provider, keyPool } = setup(["k1"], () => ok({ error: "invalid address format" }));
    const err = await provider.getTransaction(txInfoTrx.hash, signal).catch((e: unknown) => e);
    expect((err as FotError).code).toBe("provider_error");
    expect(keyPool.activeKeyCount).toBe(1);
  });

  test("every key exhausted → fatal rate_limited", async () => {
    const { provider } = setup(["k1", "k2"], () => ok({ Error: "frequency limit" }));
    const err = await provider.getTransaction(txInfoTrx.hash, signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FotError);
    expect((err as FotError).code).toBe("rate_limited");
    expect((err as FotError).fatal).toBe(true);
    expect((err as FotError).message).toBe("All Tronscan API keys exhausted");
  });
});

describe("TronscanProvider.listTransfers", () => {
  const emptyPage = (endpoint: string) =>
    endpoint === "transaction"
      ? { rangeTotal: 0, data: [] }
      : { rangeTotal: 0, token_transfers: [] };

  test("backward: end_timestamp = (before+5)s, direction passes through, filters bad rows", async () => {
    const goodTrc20 = trc20Page.token_transfers[2]; // USDT, real row
    const badTrc20 = [
      { ...goodTrc20, transaction_id: "r", revert: true },
      { ...goodTrc20, transaction_id: "f", finalResult: "OUT_OF_ENERGY" },
    ];
    const trxGood = txPage.data[2];
    const badTx = [
      { ...trxGood, hash: "z", amount: "0" },
      { ...trxGood, hash: "c", contractType: 31 },
      { ...trxGood, hash: "f", contractRet: "REVERT" },
      { ...trxGood, hash: "v", revert: true },
    ];
    const { provider, calls } = setup(["k1"], (c) =>
      ok(
        c.endpoint === "transaction"
          ? { rangeTotal: 5, data: [...badTx, trxGood] }
          : { rangeTotal: 3, token_transfers: [...badTrc20, goodTrc20] },
      ),
    );
    const before = 1_790_456_700;
    const res = await provider.listTransfers({
      address: ADDR,
      direction: "in",
      window: { beforeTs: before },
      signal,
    });
    for (const c of calls) {
      expect(c.params.end_timestamp).toBe(String((before + 5) * 1000));
      expect(c.params.start_timestamp).toBeUndefined();
      expect(c.params.direction).toBe("in");
      expect(c.params.limit).toBe("50");
      expect(c.params.start).toBe("0");
    }
    expect(calls.find((c) => c.endpoint === "transfers")?.params.relatedAddress).toBe(ADDR);
    expect(calls.find((c) => c.endpoint === "transaction")?.params.address).toBe(ADDR);
    expect(res.truncated).toBe(false);
    // The TRX row (2026-09) is newer than the USDT row (2025-11).
    expect(res.rows.map((r) => r.txHash)).toEqual([
      trxGood?.hash ?? "",
      goodTrc20?.transaction_id ?? "",
    ]);
    const usdt = res.rows.find((r) => r.txHash === goodTrc20?.transaction_id);
    expect(usdt).toMatchObject({
      from: goodTrc20?.from_address,
      to: ADDR,
      amountRaw: "2000000",
      amount: 2,
      asset: { kind: "token", symbol: "USDT", contract: USDT },
    });
    expect(res.rows).toHaveLength(2);
  });

  test("non-canonical token uses the row's own symbol/decimals", async () => {
    const lse = trc20Page.token_transfers[0];
    const { provider } = setup(["k1"], (c) =>
      ok(
        c.endpoint === "transaction"
          ? emptyPage("transaction")
          : { rangeTotal: 1, token_transfers: [lse] },
      ),
    );
    const res = await provider.listTransfers({
      address: ADDR,
      direction: "in",
      window: {},
      signal,
    });
    expect(res.rows[0]?.asset).toMatchObject({
      kind: "token",
      symbol: "LSE",
      decimals: 6,
      decimalsGuessed: false,
    });
    expect(res.rows[0]?.amount).toBe(0.000001);
  });

  test("empty window sends no timestamps and returns newest first", async () => {
    const { provider, calls } = setup(["k1"], (c) =>
      ok(
        c.endpoint === "transaction"
          ? { rangeTotal: 1, data: [txPage.data[2]] }
          : {
              rangeTotal: 2,
              token_transfers: [trc20Page.token_transfers[0], trc20Page.token_transfers[2]],
            },
      ),
    );
    const res = await provider.listTransfers({
      address: ADDR,
      direction: "in",
      window: {},
      signal,
    });
    for (const c of calls) {
      expect(c.params.start_timestamp).toBeUndefined();
      expect(c.params.end_timestamp).toBeUndefined();
    }
    const ts = res.rows.map((r) => r.timestamp);
    expect(ts).toEqual([...ts].sort((a, b) => b - a));
  });

  test("forward: complete window → one pass, asc order, not truncated", async () => {
    const after = 1_764_517_600;
    const { provider, calls } = setup(["k1"], (c) =>
      ok(
        c.endpoint === "transaction"
          ? { rangeTotal: 0, data: [] }
          : {
              rangeTotal: 2,
              token_transfers: [trc20Page.token_transfers[0], trc20Page.token_transfers[2]],
            },
      ),
    );
    const res = await provider.listTransfers({
      address: ADDR,
      direction: "out",
      window: { afterTs: after },
      signal,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.params.start_timestamp).toBe(String((after - 5) * 1000));
    expect(calls[0]?.params.end_timestamp).toBe(String((after + 30 * 86400) * 1000));
    expect(res.truncated).toBe(false);
    const ts = res.rows.map((r) => r.timestamp);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  test("forward: rangeTotal > fetched → narrower re-query, truncated, ascending", async () => {
    const after = 1_764_517_600;
    const rows = trc20Page.token_transfers; // newest-first
    const { provider, calls } = setup(["k1"], (c) => {
      if (c.endpoint === "transaction") return ok({ rangeTotal: 0, data: [] });
      const wide = c.params.end_timestamp === String((after + 30 * 86400) * 1000);
      return ok(
        wide
          ? { rangeTotal: 400, token_transfers: [rows[0]] }
          : { rangeTotal: 3, token_transfers: rows },
      );
    });
    const res = await provider.listTransfers({
      address: ADDR,
      direction: "out",
      window: { afterTs: after },
      signal,
    });
    const narrow = calls.filter(
      (c) =>
        c.endpoint !== "transaction" && c.params.end_timestamp === String((after + 86400) * 1000),
    );
    expect(narrow).toHaveLength(1);
    expect(narrow[0]?.params.start_timestamp).toBe(String((after - 5) * 1000));
    expect(res.truncated).toBe(true);
    expect(res.rows).toHaveLength(3);
    const ts = res.rows.map((r) => r.timestamp);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(ts[0]).toBeLessThan(ts[2] ?? 0);
  });

  test("paging stops at maxPages with a full last page; truncated", async () => {
    const proto = trc20Page.token_transfers[2];
    const page = (start: number) =>
      Array.from({ length: 50 }, (_, i) => ({
        ...proto,
        transaction_id: `t${start + i}`,
        block_ts: 1_764_517_689_000 - (start + i) * 1000,
      }));
    for (const maxPages of [1, 2, 3]) {
      const { provider, calls } = setup(
        ["k1"],
        (c) =>
          ok(
            c.endpoint === "transaction"
              ? emptyPage("transaction")
              : { rangeTotal: 500, token_transfers: page(Number(c.params.start)) },
          ),
        maxPages,
      );
      const res = await provider.listTransfers({
        address: ADDR,
        direction: "in",
        window: { beforeTs: 1_764_517_700 },
        signal,
      });
      const trc20Calls = calls.filter((c) => c.endpoint !== "transaction");
      expect(trc20Calls.map((c) => c.params.start)).toEqual(
        Array.from({ length: maxPages }, (_, i) => String(i * 50)),
      );
      expect(res.rows).toHaveLength(maxPages * 50);
      expect(res.truncated).toBe(true);
    }
  });

  test("paging stops early on a short page or when rangeTotal is reached", async () => {
    const proto = trc20Page.token_transfers[2];
    const full = Array.from({ length: 50 }, (_, i) => ({ ...proto, transaction_id: `t${i}` }));
    const { provider, calls } = setup(["k1"], (c) =>
      ok(
        c.endpoint === "transaction"
          ? emptyPage("transaction")
          : { rangeTotal: 50, token_transfers: full },
      ),
    );
    const res = await provider.listTransfers({
      address: ADDR,
      direction: "in",
      window: { beforeTs: 1_764_517_700 },
      signal,
    });
    expect(calls.filter((c) => c.endpoint !== "transaction")).toHaveLength(1);
    expect(res.truncated).toBe(false);
  });

  test("a wrong-shaped body is a provider_error and is not cached", async () => {
    const { provider, calls } = setup(["k1"], () => ok({ message: "end_timestamp must be > 0" }));
    for (let i = 0; i < 2; i++) {
      const err = await provider
        .listTransfers({ address: ADDR, direction: "in", window: {}, signal })
        .catch((e: unknown) => e);
      expect((err as FotError).code).toBe("provider_error");
    }
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
