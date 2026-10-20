import { describe, expect, test } from "bun:test";
import { MinIntervalLimiter } from "../src/infra/limiter.ts";
import { MemoryCacheStore } from "../src/infra/store.ts";
import {
  FixtureTransport,
  requestKey,
  type Transport,
  type TransportRequest,
} from "../src/infra/transport.ts";
import { PriceService } from "../src/prices/defillama.ts";
import { priceKey } from "../src/providers/types.ts";
import type { Asset } from "../src/schema.ts";

const fixture = await Bun.file(
  new URL("./fixtures/defillama/batch-historical.json", import.meta.url),
).text();

const NOW = 1_760_000_000_000;
const signal = new AbortController().signal;

const ETH: Asset = { chain: "ethereum", kind: "native" };
const WTRX: Asset = {
  chain: "tron",
  kind: "token",
  contract: "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR",
  symbol: "WTRX",
  name: "Wrapped TRX",
  decimals: 6,
  decimalsGuessed: false,
};
const token = (chain: "ethereum", contract: string, symbol: string): Asset => ({
  chain,
  kind: "token",
  contract,
  symbol,
  name: symbol,
  decimals: 6,
  decimalsGuessed: false,
});
const REAL_USDT = token("ethereum", "0xdac17f958d2ee523a2206206994597c13d831ec7", "USDT");
const FAKE_USDT = token("ethereum", "0x1111111111111111111111111111111111111111", "USDT");

function make(transport: Transport, cache = new MemoryCacheStore(() => NOW)) {
  return new PriceService({
    transport,
    cache,
    limiter: new MinIntervalLimiter(0),
    now: () => NOW,
  });
}

function recorder(respond: (req: TransportRequest) => { status: number; body: string }) {
  const urls: string[] = [];
  const transport: Transport = async (req) => {
    urls.push(req.url);
    return respond(req);
  };
  return { urls, transport };
}

const OLD_TS = 1_759_996_800 + 120; // bucket 1759996800, > 1 h before NOW

describe("PriceService", () => {
  test("replays a recorded DefiLlama response and picks the price per coin", async () => {
    const coins = JSON.stringify({
      "coingecko:ethereum": [1759996800],
      "tron:TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR": [1759996800],
    });
    const url = `https://coins.llama.fi/batchHistorical?coins=${encodeURIComponent(coins)}&searchWidth=600`;
    const svc = make(FixtureTransport({ [requestKey({ url })]: { status: 200, body: fixture } }));
    const res = await svc.priceMany(
      [
        { asset: ETH, timestamp: OLD_TS },
        { asset: WTRX, timestamp: OLD_TS + 5 },
      ],
      signal,
    );
    expect(res.warning).toBeNull();
    expect(res.prices.get(priceKey(ETH, OLD_TS))).toBeCloseTo(4427.1887, 3);
    expect(res.prices.get(priceKey(WTRX, OLD_TS))).toBeCloseTo(0.3389, 3);
  });

  test("canonical stable contract is 1.0 with zero requests; spoofed symbol is not shortcut", async () => {
    const { urls, transport } = recorder(() => ({ status: 200, body: '{"coins":{}}' }));
    const svc = make(transport);
    const stable = await svc.priceMany([{ asset: REAL_USDT, timestamp: OLD_TS }], signal);
    expect(stable.prices.get(priceKey(REAL_USDT, OLD_TS))).toBe(1);
    expect(urls).toHaveLength(0);

    const spoof = await svc.priceMany([{ asset: FAKE_USDT, timestamp: OLD_TS }], signal);
    expect(spoof.prices.get(priceKey(FAKE_USDT, OLD_TS))).toBeNull();
    expect(urls).toHaveLength(1);
  });

  test("request URL is deterministic regardless of item order and sorts timestamps", async () => {
    const a = token("ethereum", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "AAA");
    const urlsFor = async (items: { asset: Asset; timestamp: number }[]) => {
      const { urls, transport } = recorder(() => ({ status: 200, body: '{"coins":{}}' }));
      await make(transport).priceMany(items, signal);
      return urls;
    };
    const items = [
      { asset: ETH, timestamp: 1_759_996_800 + 7200 },
      { asset: a, timestamp: 1_759_996_800 },
      { asset: ETH, timestamp: 1_759_996_800 },
      { asset: ETH, timestamp: 1_759_996_800 + 10 }, // same bucket: deduplicated
    ];
    const u1 = await urlsFor(items);
    const u2 = await urlsFor([...items].reverse());
    expect(u1).toHaveLength(1);
    expect(u1).toEqual(u2);
    const coins = JSON.parse(new URL(u1[0] ?? "").searchParams.get("coins") ?? "{}");
    expect(Object.keys(coins)).toEqual([
      "coingecko:ethereum",
      "ethereum:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
    expect(coins["coingecko:ethereum"]).toEqual([1_759_996_800, 1_760_004_000]);
  });

  test("picks the price nearest to the bucket timestamp", async () => {
    const { transport } = recorder(() => ({
      status: 200,
      body: JSON.stringify({
        coins: {
          "coingecko:ethereum": {
            prices: [
              { timestamp: 1_759_996_800 - 400, price: 1 },
              { timestamp: 1_759_996_800 + 100, price: 2 },
              { timestamp: 1_759_996_800 + 500, price: 3 },
            ],
          },
        },
      }),
    }));
    const res = await make(transport).priceMany([{ asset: ETH, timestamp: OLD_TS }], signal);
    expect(res.prices.get(priceKey(ETH, OLD_TS))).toBe(2);
  });

  test("a coin absent from the response is null without a warning", async () => {
    const { transport } = recorder(() => ({ status: 200, body: '{"coins":{}}' }));
    const res = await make(transport).priceMany([{ asset: ETH, timestamp: OLD_TS }], signal);
    expect(res.prices.get(priceKey(ETH, OLD_TS))).toBeNull();
    expect(res.warning).toBeNull();
  });

  test("more than 100 coins are split into two requests", async () => {
    const { urls, transport } = recorder(() => ({ status: 200, body: '{"coins":{}}' }));
    const items = Array.from({ length: 101 }, (_, i) => ({
      asset: token("ethereum", `0x${i.toString(16).padStart(40, "0")}`, `T${i}`),
      timestamp: OLD_TS,
    }));
    const res = await make(transport).priceMany(items, signal);
    expect(urls).toHaveLength(2);
    const sizes = urls.map(
      (u) => Object.keys(JSON.parse(new URL(u).searchParams.get("coins") ?? "{}")).length,
    );
    expect(sizes).toEqual([100, 1]);
    expect(res.prices.size).toBe(101);
  });

  test("HTTP failure and bad JSON yield nulls plus prices_unavailable", async () => {
    for (const bad of [
      { status: 400, body: "nope" },
      { status: 200, body: "<html>" },
    ]) {
      const { transport } = recorder(() => bad);
      const res = await make(transport).priceMany([{ asset: ETH, timestamp: OLD_TS }], signal);
      expect(res.prices.get(priceKey(ETH, OLD_TS))).toBeNull();
      expect(res.warning?.code).toBe("prices_unavailable");
    }
  });

  test("cached buckets are not requested again", async () => {
    const cache = new MemoryCacheStore(() => NOW);
    const { urls, transport } = recorder(() => ({
      status: 200,
      body: JSON.stringify({
        coins: { "coingecko:ethereum": { prices: [{ timestamp: 1_759_996_803, price: 42 }] } },
      }),
    }));
    const svc = make(transport, cache);
    await svc.priceMany([{ asset: ETH, timestamp: OLD_TS }], signal);
    const again = await svc.priceMany([{ asset: ETH, timestamp: OLD_TS + 60 }], signal);
    expect(urls).toHaveLength(1);
    expect(again.prices.get(priceKey(ETH, OLD_TS))).toBe(42);
    expect(svc.stats()).toEqual({ apiCalls: 1, cacheHits: 1 });
  });
});
