import { z } from "zod";
import { CHAINS, findCanonicalToken } from "../chains.ts";
import { FotError } from "../errors.ts";
import { TTL_IMMUTABLE_SEC, TTL_RECENT_SEC } from "../infra/http.ts";
import type { MinIntervalLimiter } from "../infra/limiter.ts";
import { assertHttpOk, toNetworkError, withRetry } from "../infra/retry.ts";
import { type CacheStore, cacheKey } from "../infra/store.ts";
import type { Transport, TransportResponse } from "../infra/transport.ts";
import {
  type PriceRequest,
  type PriceResult,
  type PriceSource,
  type ProviderStats,
  priceKey,
} from "../providers/types.ts";
import type { Asset } from "../schema.ts";

const BASE_URL = "https://coins.llama.fi/batchHistorical";
const SEARCH_WIDTH = 600;
const MAX_COINS_PER_REQUEST = 100;
const BUCKET_SEC = 3600;

const responseSchema = z.object({
  coins: z.record(
    z.string(),
    z.object({
      prices: z.array(z.object({ timestamp: z.number(), price: z.number() })),
    }),
  ),
});

export interface PriceServiceOptions {
  transport: Transport;
  cache: CacheStore;
  /** Shared across runs (recommended 200 ms interval). */
  limiter: MinIntervalLimiter;
  now: () => number;
  pauseGate?: () => Promise<void>;
}

/** DefiLlama coin key for an asset: `coingecko:<id>` for natives, `<prefix>:<contract>` for tokens. */
function coinKey(asset: Asset): string {
  const chain = CHAINS[asset.chain];
  return asset.kind === "native" ? chain.nativePriceKey : `${chain.llamaPrefix}:${asset.contract}`;
}

function isCanonicalStable(asset: Asset): boolean {
  if (asset.kind !== "token") return false;
  return findCanonicalToken(asset.chain, asset.contract)?.stable === true;
}

interface Wanted {
  key: string;
  coin: string;
  bucket: number;
  chain: Asset["chain"];
}

export class PriceService implements PriceSource {
  private readonly counters: ProviderStats = { apiCalls: 0, cacheHits: 0 };

  constructor(private readonly opts: PriceServiceOptions) {}

  stats(): ProviderStats {
    return { ...this.counters };
  }

  async priceMany(items: PriceRequest[], signal: AbortSignal): Promise<PriceResult> {
    const prices = new Map<string, number | null>();
    const wanted = new Map<string, Wanted>();
    for (const { asset, timestamp } of items) {
      const key = priceKey(asset, timestamp);
      if (prices.has(key) || wanted.has(key)) continue;
      if (isCanonicalStable(asset)) {
        prices.set(key, 1);
        continue;
      }
      wanted.set(key, {
        key,
        coin: coinKey(asset),
        bucket: Math.floor(timestamp / BUCKET_SEC) * BUCKET_SEC,
        chain: asset.chain,
      });
    }

    const missing: Wanted[] = [];
    for (const w of wanted.values()) {
      const hit = await this.opts.cache.get(await this.bucketCacheKey(w));
      if (hit === null) {
        missing.push(w);
        continue;
      }
      this.counters.cacheHits++;
      prices.set(w.key, JSON.parse(hit) as number | null);
    }

    let warning: PriceResult["warning"] = null;
    for (const chunk of chunkByCoin(missing)) {
      try {
        await this.fetchChunk(chunk, prices, signal);
      } catch (e) {
        if (signal.aborted) throw e;
        warning ??= {
          code: "prices_unavailable",
          message: `DefiLlama price lookup failed: ${e instanceof Error ? e.message : String(e)}`,
        };
        for (const w of chunk) if (!prices.has(w.key)) prices.set(w.key, null);
      }
    }
    return { prices, warning };
  }

  private bucketCacheKey(w: Wanted): Promise<string> {
    return cacheKey("defillama", w.chain, "price", { coin: w.coin, bucket: w.bucket });
  }

  private async fetchChunk(
    chunk: Wanted[],
    prices: Map<string, number | null>,
    signal: AbortSignal,
  ): Promise<void> {
    const byCoin = new Map<string, number[]>();
    for (const w of chunk) {
      const list = byCoin.get(w.coin) ?? [];
      if (!list.includes(w.bucket)) list.push(w.bucket);
      byCoin.set(w.coin, list);
    }
    const coins: Record<string, number[]> = {};
    for (const coin of [...byCoin.keys()].sort()) {
      coins[coin] = (byCoin.get(coin) ?? []).sort((a, b) => a - b);
    }
    const url = `${BASE_URL}?${new URLSearchParams({
      coins: JSON.stringify(coins),
      searchWidth: String(SEARCH_WIDTH),
    }).toString()}`;

    const body = await withRetry(
      async () => {
        await this.opts.limiter.acquire(signal, this.opts.pauseGate);
        this.counters.apiCalls++;
        let res: TransportResponse;
        try {
          res = await this.opts.transport({ url, signal });
        } catch (e) {
          throw toNetworkError(e, signal);
        }
        assertHttpOk(res, "DefiLlama");
        if (res.status !== 200) {
          throw new FotError("provider_error", `DefiLlama: HTTP ${res.status}`);
        }
        return res.body;
      },
      { signal },
    );

    let parsed: z.infer<typeof responseSchema>;
    try {
      parsed = responseSchema.parse(JSON.parse(body));
    } catch {
      throw new FotError("provider_error", "DefiLlama: malformed response");
    }

    const nowSec = this.opts.now() / 1000;
    for (const w of chunk) {
      const series = parsed.coins[w.coin]?.prices ?? [];
      let best: number | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const p of series) {
        const dist = Math.abs(p.timestamp - w.bucket);
        if (dist < bestDist) {
          bestDist = dist;
          best = p.price;
        }
      }
      prices.set(w.key, best);
      // Missing data may be a transient index gap: keep nulls short-lived.
      const ttl =
        best !== null && nowSec - w.bucket > BUCKET_SEC ? TTL_IMMUTABLE_SEC : TTL_RECENT_SEC;
      await this.opts.cache.set(await this.bucketCacheKey(w), JSON.stringify(best), ttl);
    }
  }
}

/** Splits wanted buckets into groups touching at most 100 distinct coins, in sorted coin order. */
function chunkByCoin(items: Wanted[]): Wanted[][] {
  const coins = [...new Set(items.map((w) => w.coin))].sort();
  const chunks: Wanted[][] = [];
  for (let i = 0; i < coins.length; i += MAX_COINS_PER_REQUEST) {
    const slice = new Set(coins.slice(i, i + MAX_COINS_PER_REQUEST));
    chunks.push(items.filter((w) => slice.has(w.coin)));
  }
  return chunks;
}
