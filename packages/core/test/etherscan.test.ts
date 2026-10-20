import { describe, expect, test } from "bun:test";
import { FotError } from "../src/errors.ts";
import { MinIntervalLimiter } from "../src/infra/limiter.ts";
import { MemoryCacheStore } from "../src/infra/store.ts";
import {
  FixtureTransport,
  type Transport,
  type TransportResponse,
} from "../src/infra/transport.ts";
import { type EtherscanChain, EtherscanV2Provider } from "../src/providers/etherscan.ts";
import recorded from "./fixtures/etherscan/recorded.json";

const SWAP_TX = "0xdd2bac0374e8ba8981b491643c5e8f2fde652efdf77a121daa88204a8c16828a";
const SWAP_TS = 1765584371;
const SWAP_SENDER = "0x3e3c3cc69d3db4c3c1dfa09c367e4d15c4e2d825";
const FAILED_TX = "0xf9fa24a9109ca27e70e3f94674c039f8470bc0e56ed8c76019b2c6b1f8a69cf7";
const NOW_MS = (SWAP_TS + 10 * 86400) * 1000;
const signal = new AbortController().signal;

const fixtureMap = new Map(
  Object.entries(recorded as Record<string, { status: number; body: unknown }>).map(([k, v]) => [
    k,
    { status: v.status, body: JSON.stringify(v.body) },
  ]),
);

interface Spy {
  transport: Transport;
  calls: URLSearchParams[];
  urls: string[];
}

function spy(inner: Transport): Spy {
  const calls: URLSearchParams[] = [];
  const urls: string[] = [];
  return {
    calls,
    urls,
    transport: async (req) => {
      urls.push(req.url);
      calls.push(new URL(req.url).searchParams);
      return inner(req);
    },
  };
}

const json = (body: unknown, status = 200): TransportResponse => ({
  status,
  body: JSON.stringify(body),
});

function scripted(handler: (p: URLSearchParams, n: number) => TransportResponse): Spy {
  let n = 0;
  return spy(async (req) => handler(new URL(req.url).searchParams, n++));
}

function make(
  transport: Transport,
  opts: { chain?: EtherscanChain; maxPages?: number; cache?: MemoryCacheStore } = {},
) {
  return new EtherscanV2Provider(opts.chain ?? "ethereum", {
    apiKey: "TESTKEY",
    limiter: new MinIntervalLimiter(0),
    transport,
    cache: opts.cache ?? new MemoryCacheStore(() => NOW_MS),
    now: () => NOW_MS,
    retry: { sleep: async () => {} },
    ...(opts.maxPages === undefined ? {} : { maxPages: opts.maxPages }),
  });
}

async function failure(p: Promise<unknown>): Promise<FotError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(FotError);
  return e as FotError;
}

const addr = "0x00000000000000000000000000000000000000aa";
const list = (p: EtherscanV2Provider) =>
  p.listTransfers({ address: addr, direction: "in", window: {}, signal });

const emptyEnvelope = { status: "0", message: "No transactions found", result: [] };

describe("envelope classification", () => {
  test("free-tier text is fatal chain_requires_paid_plan", async () => {
    const t = scripted(() =>
      json({
        status: "0",
        message: "NOTOK",
        result:
          "Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage.",
      }),
    );
    const e = await failure(list(make(t.transport)));
    expect(e.code).toBe("chain_requires_paid_plan");
    expect(e.fatal).toBe(true);
    expect(e.retryable).toBe(false);
  });

  test.each(["Invalid API Key (#err2)", "Missing/Invalid API Key"])(
    "%s is fatal invalid_api_key and not retried",
    async (text) => {
      const t = scripted(() => json({ status: "0", message: "NOTOK", result: text }));
      const e = await failure(
        make(t.transport).listTransfers({ address: addr, direction: "in", window: {}, signal }),
      );
      expect(e.code).toBe("invalid_api_key");
      expect(e.fatal).toBe(true);
      expect(t.calls.length).toBeLessThanOrEqual(3); // one attempt per parallel list, no retries
    },
  );

  test("HTTP 200 rate-limit envelope is retried and recovers", async () => {
    const t = scripted((p, n) => {
      if (p.get("action") === "getblocknobytime") {
        return n === 0
          ? json({ status: "0", message: "NOTOK", result: "Max rate limit reached" })
          : json({ status: "1", message: "OK", result: "100" });
      }
      return json(emptyEnvelope);
    });
    const res = await make(t.transport).listTransfers({
      address: addr,
      direction: "in",
      window: { beforeTs: 1_700_000_000 },
      signal,
    });
    expect(res.rows).toEqual([]);
    expect(t.calls.filter((p) => p.get("action") === "getblocknobytime")).toHaveLength(2);
  });

  test("persistent rate limit surfaces retryable rate_limited after bounded attempts", async () => {
    const t = scripted(() =>
      json({
        status: "0",
        message: "NOTOK",
        result: "Max calls per sec rate limit reached (3/sec)",
      }),
    );
    const e = await failure(list(make(t.transport)));
    expect(e.code).toBe("rate_limited");
    expect(e.retryable).toBe(true);
    expect(t.calls.length).toBeGreaterThanOrEqual(4);
  });

  test("other status 0 is a non-retryable provider_error", async () => {
    const t = scripted(() =>
      json({ status: "0", message: "NOTOK", result: "Error! Invalid address format" }),
    );
    const e = await failure(list(make(t.transport)));
    expect(e.code).toBe("provider_error");
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("Invalid address format");
  });

  test("HTTP 5xx is retried then recovers; HTTP 429 maps to rate_limited", async () => {
    let first = true;
    const flaky = scripted((p) => {
      if (p.get("action") === "tokentx" && first) {
        first = false;
        return { status: 503, body: "bad gateway" };
      }
      return json(emptyEnvelope);
    });
    expect((await list(make(flaky.transport))).rows).toEqual([]);
    expect(flaky.calls.filter((p) => p.get("action") === "tokentx")).toHaveLength(2);

    const limited = scripted(() => ({ status: 429, body: "" }));
    expect((await failure(list(make(limited.transport)))).code).toBe("rate_limited");
  });

  test("a non-JSON body is a retryable provider_error", async () => {
    const t = scripted(() => ({ status: 200, body: "<html>Cloudflare</html>" }));
    const e = await failure(list(make(t.transport)));
    expect(e.code).toBe("provider_error");
    expect(e.retryable).toBe(true);
  });

  test("'No transactions found' is an empty, cacheable result; errors are not cached", async () => {
    const cache = new MemoryCacheStore(() => NOW_MS);
    const t = scripted(() => json(emptyEnvelope));
    const a = make(t.transport, { cache });
    expect((await list(a)).rows).toEqual([]);
    const callsAfterFirst = t.calls.length;
    expect(callsAfterFirst).toBe(3);

    const b = make(t.transport, { cache });
    expect((await list(b)).rows).toEqual([]);
    expect(t.calls.length).toBe(callsAfterFirst);
    expect(b.stats()).toEqual({ apiCalls: 0, cacheHits: 3 });

    // An error envelope must not poison the cache: the next call goes to the network again.
    const sink = new MemoryCacheStore(() => NOW_MS);
    let broken = true;
    const e = scripted(() =>
      broken ? json({ status: "0", message: "NOTOK", result: "Error! boom" }) : json(emptyEnvelope),
    );
    await failure(list(make(e.transport, { cache: sink })));
    broken = false;
    expect((await list(make(e.transport, { cache: sink }))).rows).toEqual([]);
  });

  test("proxy {error} is provider_error and result:null is not_found", async () => {
    const rpcError = scripted(() =>
      json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid argument 0" } }),
    );
    const e1 = await failure(make(rpcError.transport).getTransaction(SWAP_TX, signal));
    expect(e1.code).toBe("provider_error");
    expect(e1.retryable).toBe(false);

    const empty = scripted(() => json({ jsonrpc: "2.0", id: 1, result: null }));
    const e2 = await failure(make(empty.transport).getTransaction(SWAP_TX, signal));
    expect(e2.code).toBe("not_found");
    expect(empty.calls).toHaveLength(1);
  });
});

describe("listTransfers", () => {
  test("a block-bound failure is provider_error and no list is queried (never 'latest')", async () => {
    const t = scripted(() =>
      json({ status: "0", message: "NOTOK", result: "Error! No closest block found" }),
    );
    const e = await failure(
      make(t.transport).listTransfers({
        address: addr,
        direction: "in",
        window: { beforeTs: 1_700_000_000 },
        signal,
      }),
    );
    expect(e.code).toBe("provider_error");
    expect(t.calls.map((p) => p.get("action"))).toEqual(["getblocknobytime"]);
  });

  test("backward bound: timestamp+5, closest=before, endblock, sort=desc; includes swap legs", async () => {
    const s = spy(FixtureTransport(fixtureMap));
    const res = await make(s.transport).listTransfers({
      address: SWAP_SENDER,
      direction: "in",
      window: { beforeTs: SWAP_TS },
      signal,
    });
    const block = s.calls.find((p) => p.get("action") === "getblocknobytime");
    expect(block?.get("timestamp")).toBe(String(SWAP_TS + 5));
    expect(block?.get("closest")).toBe("before");
    const tokentx = s.calls.find((p) => p.get("action") === "tokentx");
    expect(tokentx?.get("endblock")).toBe("24000000");
    expect(tokentx?.get("sort")).toBe("desc");
    expect(tokentx?.get("startblock")).toBeNull();
    expect(tokentx?.get("offset")).toBe("50");
    expect(s.urls.every((u) => u.includes("apikey=TESTKEY"))).toBe(true);

    // The swap (MHRD out, ETH back through an internal transfer) shows up as two assets in one tx.
    const legs = res.rows.filter((r) => r.txHash === SWAP_TX);
    const kinds = legs.map((r) => (r.asset.kind === "token" ? r.asset.symbol : "native"));
    expect(kinds).toContain("MHRD");
    expect(kinds).toContain("native");
    const mhrd = legs.find((r) => r.asset.kind === "token");
    expect(mhrd?.amountRaw).toBe("385383680978706623362073");
    expect(mhrd?.amount).toBeCloseTo(385383.68097870663, 6);
    expect(mhrd?.from).toBe(SWAP_SENDER);
    // Newest first.
    const ts = res.rows.map((r) => r.timestamp);
    expect(ts).toEqual([...ts].sort((a, b) => b - a));
  });

  test("forward bound: timestamp-5, closest=after, startblock, sort=asc, oldest first", async () => {
    const s = spy(FixtureTransport(fixtureMap));
    const afterTs = SWAP_TS - 3 * 86400;
    const res = await make(s.transport).listTransfers({
      address: SWAP_SENDER,
      direction: "out",
      window: { afterTs },
      signal,
    });
    const block = s.calls.find((p) => p.get("action") === "getblocknobytime");
    expect(block?.get("timestamp")).toBe(String(afterTs - 5));
    expect(block?.get("closest")).toBe("after");
    const txlist = s.calls.find((p) => p.get("action") === "txlist");
    expect(txlist?.get("startblock")).toBe("23978662");
    expect(txlist?.get("sort")).toBe("asc");
    expect(txlist?.get("endblock")).toBeNull();
    const ts = res.rows.map((r) => r.timestamp);
    expect(ts.length).toBeGreaterThan(1);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  test("empty window sends no block bounds and no block lookup", async () => {
    const s = spy(FixtureTransport(fixtureMap));
    const res = await make(s.transport, { chain: "polygon" }).listTransfers({
      address: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
      direction: "in",
      window: {},
      signal,
    });
    expect(s.calls.some((p) => p.get("action") === "getblocknobytime")).toBe(false);
    expect(s.calls.every((p) => p.get("chainid") === "137")).toBe(true);
    expect(s.calls.every((p) => p.get("startblock") === null && p.get("endblock") === null)).toBe(
      true,
    );
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.rows.every((r) => r.chain === "polygon")).toBe(true);
    const native = res.rows.find((r) => r.asset.kind === "native");
    expect(native?.amount).toBeGreaterThan(0);
  });

  test("arbitrum uses chainid 42161", async () => {
    const s = spy(FixtureTransport(fixtureMap));
    const res = await make(s.transport, { chain: "arbitrum" }).listTransfers({
      address: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
      direction: "in",
      window: {},
      signal,
    });
    expect(s.calls.every((p) => p.get("chainid") === "42161")).toBe(true);
    expect(res.rows.length).toBeGreaterThan(0);
  });

  describe("paging", () => {
    const tokenRow = (i: number, contract: string, symbol: string) => ({
      blockNumber: String(1000 + i),
      timeStamp: String(2_000_000 - i),
      hash: `0x${i.toString(16).padStart(64, "0")}`,
      from: "0x00000000000000000000000000000000000000AA",
      to: "0x00000000000000000000000000000000000000bb",
      value: "1000000",
      contractAddress: contract,
      tokenName: symbol,
      tokenSymbol: symbol,
      tokenDecimal: "6",
    });
    const fullPage = (page: number) =>
      Array.from({ length: 50 }, (_, i) => tokenRow((page - 1) * 50 + i, "0xc0ffee", "AAA"));

    function pagedTransport(tokenPages: Record<number, unknown[]>) {
      return scripted((p) => {
        if (p.get("action") !== "tokentx") return json(emptyEnvelope);
        const rows = tokenPages[Number(p.get("page"))] ?? [];
        return rows.length === 0
          ? json(emptyEnvelope)
          : json({ status: "1", message: "OK", result: rows });
      });
    }

    test("stops at maxPages and flags truncated", async () => {
      const t = pagedTransport({ 1: fullPage(1), 2: fullPage(2), 3: fullPage(3) });
      const res = await list(make(t.transport, { maxPages: 2 }));
      const pages = t.calls.filter((p) => p.get("action") === "tokentx").map((p) => p.get("page"));
      expect(pages).toEqual(["1", "2"]);
      expect(res.rows).toHaveLength(100);
      expect(res.truncated).toBe(true);
    });

    test("a short last page ends paging without truncation", async () => {
      const t = pagedTransport({ 1: fullPage(1), 2: fullPage(2).slice(0, 7), 3: fullPage(3) });
      const res = await list(make(t.transport, { maxPages: 4 }));
      const pages = t.calls.filter((p) => p.get("action") === "tokentx").map((p) => p.get("page"));
      expect(pages).toEqual(["1", "2"]);
      expect(res.rows).toHaveLength(57);
      expect(res.truncated).toBe(false);
    });

    test("maxPages is clamped to 1..4", async () => {
      const t = pagedTransport({
        1: fullPage(1),
        2: fullPage(2),
        3: fullPage(3),
        4: fullPage(4),
        5: fullPage(5),
      });
      await list(make(t.transport, { maxPages: 99 }));
      expect(t.calls.filter((p) => p.get("action") === "tokentx")).toHaveLength(4);
      const t0 = pagedTransport({ 1: fullPage(1), 2: fullPage(2) });
      await list(make(t0.transport, { maxPages: 0 }));
      expect(t0.calls.filter((p) => p.get("action") === "tokentx")).toHaveLength(1);
    });

    test("two tokens in one tx both survive, lowercased, with canonical metadata applied", async () => {
      const usdt = "0xdac17f958d2ee523a2206206994597c13d831ec7";
      const hash = `0x${"ab".repeat(32)}`;
      const t = pagedTransport({
        1: [
          {
            ...tokenRow(1, usdt.toUpperCase().replace("0X", "0x"), "FAKE"),
            hash,
            tokenDecimal: "",
          },
          { ...tokenRow(2, "0xC0FFEE0000000000000000000000000000000001", "WIF"), hash, value: "5" },
        ],
      });
      const res = await list(make(t.transport));
      const legs = res.rows.filter((r) => r.txHash === hash);
      expect(legs).toHaveLength(2);
      const stable = legs.find((r) => r.asset.kind === "token" && r.asset.contract === usdt);
      expect(stable?.asset).toMatchObject({ symbol: "USDT", decimals: 6, decimalsGuessed: false });
      expect(stable?.from).toBe("0x00000000000000000000000000000000000000aa");
      const other = legs.find((r) => r.asset.kind === "token" && r.asset.symbol === "WIF");
      expect(other?.asset).toMatchObject({
        contract: "0xc0ffee0000000000000000000000000000000001",
        decimals: 6,
      });
    });

    test("failed and zero-value native rows are dropped; zero-value tokens are kept", async () => {
      const norm = (over: Record<string, string>) => ({
        blockNumber: "10",
        timeStamp: "100",
        hash: `0x${"01".repeat(32)}`,
        from: addr,
        to: "0x00000000000000000000000000000000000000bb",
        value: "7",
        contractAddress: "",
        isError: "0",
        ...over,
      });
      const t = scripted((p) => {
        const action = p.get("action");
        if (action === "txlist") {
          return json({
            status: "1",
            message: "OK",
            result: [norm({}), norm({ isError: "1" }), norm({ value: "0" })],
          });
        }
        if (action === "txlistinternal") {
          return json({
            status: "1",
            message: "OK",
            result: [norm({ value: "9", timeStamp: "101" })],
          });
        }
        return json(emptyEnvelope);
      });
      const res = await list(make(t.transport));
      expect(res.rows.map((r) => r.amountRaw)).toEqual(["9", "7"]);
      expect(res.rows.every((r) => r.asset.kind === "native")).toBe(true);
    });
  });
});

describe("getTransaction", () => {
  test("parses ERC-20 logs (symbol/decimals via eth_call), internal native transfers; ignores other logs", async () => {
    const s = spy(FixtureTransport(fixtureMap));
    const tx = await make(s.transport).getTransaction(
      SWAP_TX.toUpperCase().replace("0X", "0x"),
      signal,
    );
    expect(tx).toMatchObject({
      chain: "ethereum",
      hash: SWAP_TX,
      blockNumber: 24000000,
      timestamp: SWAP_TS,
      from: SWAP_SENDER,
      to: "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
      status: "success",
    });
    const tokens = tx.transfers.filter((t) => t.asset.kind === "token");
    const natives = tx.transfers.filter((t) => t.asset.kind === "native");

    const mhrd = tokens.find((t) => t.asset.kind === "token" && t.asset.symbol === "MHRD");
    expect(mhrd).toMatchObject({
      from: SWAP_SENDER,
      to: "0x332a24318d56f9cca677a242aff668314492bf80",
      amountRaw: "385383680978706623362073",
    });
    expect(mhrd?.asset).toMatchObject({
      contract: "0x10ee9f68ee4e4d311e854ae14c53f5b25a917f85",
      decimals: 18,
      decimalsGuessed: false,
    });
    const weth = tokens.find((t) => t.asset.kind === "token" && t.asset.symbol === "WETH");
    expect(weth?.asset).toMatchObject({ decimals: 18, decimalsGuessed: false });

    // Two internal ETH legs (WETH -> router -> sender); tx.value is 0 so no top-level native leg.
    expect(natives.map((n) => [n.from, n.to, n.amountRaw])).toEqual([
      [
        "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
        "86780918916945158",
      ],
      ["0x7a250d5630b4cf539739df2c5dacb4c659f2488d", SWAP_SENDER, "86780918916945158"],
    ]);
    expect(natives[0]?.amount).toBeCloseTo(0.08678091891694516, 15);
    expect(tx.transfers.every((t) => t.txHash === SWAP_TX && t.timestamp === SWAP_TS)).toBe(true);
    // Swap/Sync-style events (non-Transfer topic0) must not become transfers.
    expect(tokens).toHaveLength(2);
    // Canonical WETH needs no metadata call; only the unknown token triggered eth_call.
    expect(
      s.calls
        .filter((p) => p.get("action") === "eth_call")
        .map((p) => p.get("data"))
        .sort(),
    ).toEqual(["0x313ce567", "0x95d89b41"]);
  });

  test("a failed receipt (status 0x0) is tx_failed", async () => {
    const s = spy(FixtureTransport(fixtureMap));
    const e = await failure(make(s.transport).getTransaction(FAILED_TX, signal));
    expect(e.code).toBe("tx_failed");
    expect(e.fatal).toBe(false);
    expect(s.calls.some((p) => p.get("action") === "txlistinternal")).toBe(false);
  });

  const NFT_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const pad = (a: string) => `0x${a.replace("0x", "").padStart(64, "0")}`;
  const hex32 = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
  const UNKNOWN = "0x1111111111111111111111111111111111111111";
  const A = "0x00000000000000000000000000000000000000aa";
  const B = "0x00000000000000000000000000000000000000bb";

  function syntheticTx(opts: { decimals: string | null; symbolHex: string }) {
    return scripted((p) => {
      switch (p.get("action")) {
        case "eth_getTransactionByHash":
          return json({
            result: {
              hash: SWAP_TX,
              blockNumber: "0x10",
              from: A,
              to: B,
              value: "0xde0b6b3a7640000",
            },
          });
        case "eth_getBlockByNumber":
          return json({ result: { timestamp: "0x1000" } });
        case "eth_getTransactionReceipt":
          return json({
            result: {
              status: "0x1",
              contractAddress: null,
              logs: [
                { address: UNKNOWN, topics: [NFT_TOPIC, pad(A), pad(B)], data: hex32(1234n) },
                // ERC-721 Transfer: 4 topics, must be ignored.
                { address: UNKNOWN, topics: [NFT_TOPIC, pad(A), pad(B), hex32(7n)], data: "0x" },
                {
                  address: UNKNOWN,
                  topics: [NFT_TOPIC, pad(B), pad(A)],
                  data: hex32(1n),
                  removed: true,
                },
              ],
            },
          });
        case "txlistinternal":
          return json({
            status: "1",
            message: "OK",
            result: [
              { from: B, to: A, value: "5", isError: "0", contractAddress: "" },
              { from: B, to: A, value: "6", isError: "1", contractAddress: "" },
              { from: B, to: A, value: "0", isError: "0", contractAddress: "" },
            ],
          });
        case "eth_call":
          if (p.get("data") === "0x95d89b41") return json({ result: opts.symbolHex });
          return opts.decimals === null
            ? json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } })
            : json({ result: opts.decimals });
        default:
          return json({
            jsonrpc: "2.0",
            id: 1,
            error: { message: `unexpected ${p.get("action")}` },
          });
      }
    });
  }

  test("native value, internal txs (isError 0, value>0) and 3-topic logs only; unknown decimals guessed as 18 and not cached", async () => {
    // bytes32-style symbol ("MKR"), decimals call reverts.
    const symbolHex = `0x${"4d4b52".padEnd(64, "0")}`;
    const t = syntheticTx({ decimals: null, symbolHex });
    const cache = new MemoryCacheStore(() => NOW_MS);
    const tx = await make(t.transport, { cache }).getTransaction(SWAP_TX, signal);

    expect(tx.transfers.map((x) => [x.asset.kind, x.from, x.to, x.amountRaw])).toEqual([
      ["native", A, B, "1000000000000000000"],
      ["native", B, A, "5"],
      ["token", A, B, "1234"],
    ]);
    expect(tx.transfers[0]?.amount).toBe(1);
    const token = tx.transfers[2]?.asset;
    expect(token).toMatchObject({
      kind: "token",
      contract: UNKNOWN,
      symbol: "MKR",
      decimals: 18,
      decimalsGuessed: true,
    });

    // Symbol was cached; the failed decimals lookup was not, so a fresh instance asks again.
    const before = t.calls.filter((p) => p.get("data") === "0x313ce567").length;
    const symBefore = t.calls.filter((p) => p.get("data") === "0x95d89b41").length;
    await make(t.transport, { cache }).getTransaction(SWAP_TX, signal);
    expect(t.calls.filter((p) => p.get("data") === "0x313ce567").length).toBeGreaterThan(before);
    expect(t.calls.filter((p) => p.get("data") === "0x95d89b41").length).toBe(symBefore);
  });

  test("ABI string symbol and real decimals are used when the token answers", async () => {
    const abiString = `0x${"20".padStart(64, "0")}${"3".padStart(64, "0")}${Buffer.from("WIF").toString("hex").padEnd(64, "0")}`;
    const t = syntheticTx({ decimals: hex32(9n), symbolHex: abiString });
    const tx = await make(t.transport).getTransaction(SWAP_TX, signal);
    expect(tx.transfers[2]?.asset).toMatchObject({
      symbol: "WIF",
      decimals: 9,
      decimalsGuessed: false,
    });
    expect(tx.transfers[2]?.amount).toBeCloseTo(0.000001234, 12);
  });

  test("a repeat lookup is served from cache without touching the transport", async () => {
    const cache = new MemoryCacheStore(() => NOW_MS);
    const first = spy(FixtureTransport(fixtureMap));
    const a = make(first.transport, { cache });
    const tx1 = await a.getTransaction(SWAP_TX, signal);
    expect(first.calls.length).toBeGreaterThan(0);
    expect(a.stats().apiCalls).toBe(first.calls.length);

    const second = spy(FixtureTransport(fixtureMap));
    const b = make(second.transport, { cache });
    const tx2 = await b.getTransaction(SWAP_TX, signal);
    expect(second.calls).toHaveLength(0);
    expect(b.stats()).toEqual({ apiCalls: 0, cacheHits: first.calls.length });
    expect(tx2).toEqual(tx1);
  });
});

describe("review fixes", () => {
  const A = "0x00000000000000000000000000000000000000aa";
  const B = "0x00000000000000000000000000000000000000bb";
  const C = "0x00000000000000000000000000000000000000cc";

  test("forward listing under a full page is cached for 300 s even when the bound is old", async () => {
    const ttls: number[] = [];
    const inner = new MemoryCacheStore(() => NOW_MS);
    const cache: MemoryCacheStore = Object.assign(Object.create(inner), {
      get: inner.get.bind(inner),
      set: (k: string, v: string, ttl: number) => {
        ttls.push(ttl);
        return inner.set(k, v, ttl);
      },
    });
    const t = scripted((p) => {
      if (p.get("action") === "getblocknobytime") return json({ status: "1", result: "100" });
      return json(emptyEnvelope);
    });
    const afterTs = NOW_MS / 1000 - 2 * 86400;
    await make(t.transport, { cache }).listTransfers({
      address: addr,
      direction: "out",
      window: { afterTs },
      signal,
    });
    // Block lookup is immutable (30 d); the three listings must be 300 s.
    expect(ttls.filter((x) => x === 300)).toHaveLength(3);
  });

  test("internal CREATE rows use contractAddress as recipient; rows with neither are skipped", async () => {
    const t = scripted((p) => {
      switch (p.get("action")) {
        case "eth_getTransactionByHash":
          return json({
            result: { hash: SWAP_TX, blockNumber: "0x10", from: A, to: B, value: "0x0" },
          });
        case "eth_getBlockByNumber":
          return json({ result: { timestamp: "0x1000" } });
        case "eth_getTransactionReceipt":
          return json({ result: { status: "0x1", contractAddress: null, logs: [] } });
        case "txlistinternal":
          return json({
            status: "1",
            message: "OK",
            result: [
              { from: B, to: "", value: "5", isError: "0", contractAddress: C },
              { from: B, to: "", value: "7", isError: "0", contractAddress: "" },
            ],
          });
        default:
          return json({ error: { message: "unexpected" } });
      }
    });
    const tx = await make(t.transport).getTransaction(SWAP_TX, signal);
    expect(tx.transfers.map((x) => [x.from, x.to, x.amountRaw])).toEqual([[B, C, "5"]]);
  });

  test("a malformed RPC result is provider_error", async () => {
    const t = scripted(() => json({ result: { hash: "0x1" } }));
    const e = await failure(make(t.transport).getTransaction(SWAP_TX, signal));
    expect(e.code).toBe("provider_error");
    expect(e.message).toContain("eth_getTransactionByHash: unexpected result shape");
  });

  test("query.maxPages caps paging below the provider maxPages", async () => {
    const row = (i: number) => ({
      blockNumber: String(1000 + i),
      timeStamp: String(2_000_000 - i),
      hash: `0x${i.toString(16).padStart(64, "0")}`,
      from: A,
      to: B,
      value: "1000000",
      contractAddress: "0xc0ffee",
      tokenName: "AAA",
      tokenSymbol: "AAA",
      tokenDecimal: "6",
    });
    const t = scripted((p) =>
      p.get("action") === "tokentx"
        ? json({ status: "1", message: "OK", result: Array.from({ length: 50 }, (_, i) => row(i)) })
        : json(emptyEnvelope),
    );
    await make(t.transport, { maxPages: 4 }).listTransfers({
      address: addr,
      direction: "in",
      window: {},
      maxPages: 1,
      signal,
    });
    expect(t.calls.filter((p) => p.get("action") === "tokentx")).toHaveLength(1);
  });
});
