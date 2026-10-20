import { z } from "zod";
import { findCanonicalToken, normalizeTx } from "../chains.ts";
import { FotError } from "../errors.ts";
import { cachedRequest, ttlForTimestamp } from "../infra/http.ts";
import {
  assertHttpOk,
  parseRetryAfter,
  type RetryOptions,
  toNetworkError,
} from "../infra/retry.ts";
import { type CacheStore, cacheKey } from "../infra/store.ts";
import type { Transport } from "../infra/transport.ts";
import type { Asset, Transfer, TxDetail } from "../schema.ts";
import type { TronscanKeyPool } from "./tronscan-key-pool.ts";
import type {
  ExplorerProvider,
  ListTransfersQuery,
  ListTransfersResult,
  ProviderStats,
} from "./types.ts";

export const TRONSCAN_BASE_URL = "https://apilist.tronscanapi.com/api";
const PAGE_SIZE = 50;
const TRX_DECIMALS = 6;
const FORWARD_WINDOW_SEC = 30 * 86400;
const FORWARD_NARROW_WINDOW_SEC = 86400;
const TOLERANCE_SEC = 5;
const EXHAUSTION_RE = /limit|frequency|exceeded|quota|banned|too many/i;

export interface TronscanProviderOptions {
  keyPool: TronscanKeyPool;
  /** Pages of 50 rows per list, 1–4. */
  maxPages?: number;
  transport: Transport;
  cache: CacheStore;
  now: () => number;
  pauseGate?: () => Promise<void>;
  retry?: Omit<RetryOptions, "signal">;
}

/** A key's quota is spent (HTTP 403/429 after retries, or a quota-style error body). */
class KeyExhaustedError extends FotError {
  constructor(
    readonly apiKey: string,
    message: string,
    opts: { retryable: boolean; retryAfterSec?: number },
  ) {
    super("rate_limited", message, opts);
  }
}

const num = z.number();
const amountField = z.union([z.string(), z.number()]).transform((v) => String(v));

const TokenInfoSchema = z.looseObject({
  tokenId: z.string().optional(),
  tokenAbbr: z.string().optional(),
  tokenName: z.string().optional(),
  tokenDecimal: num.optional(),
});

const Trc20RowSchema = z.looseObject({
  transaction_id: z.string(),
  block_ts: num,
  block: num,
  from_address: z.string(),
  to_address: z.string(),
  contract_address: z.string().optional(),
  quant: z.string().regex(/^\d+$/),
  finalResult: z.string().optional(),
  revert: z.boolean().optional(),
  tokenInfo: TokenInfoSchema.optional(),
});
const Trc20PageSchema = z.looseObject({
  rangeTotal: num.optional(),
  token_transfers: z.array(Trc20RowSchema),
});

const TxRowSchema = z.looseObject({
  hash: z.string(),
  timestamp: num,
  block: num,
  ownerAddress: z.string(),
  toAddress: z.string().optional(),
  amount: amountField.optional(),
  contractType: num.optional(),
  contractRet: z.string().optional(),
  revert: z.boolean().optional(),
});
const TxPageSchema = z.looseObject({
  rangeTotal: num.optional(),
  data: z.array(TxRowSchema),
});

const Trc20InfoSchema = z.looseObject({
  from_address: z.string(),
  to_address: z.string(),
  amount_str: z.string().regex(/^\d+$/),
  contract_address: z.string(),
  decimals: num.optional(),
  symbol: z.string().optional(),
  name: z.string().optional(),
});
const TxInfoSchema = z.looseObject({
  hash: z.string(),
  block: num,
  timestamp: num,
  ownerAddress: z.string(),
  toAddress: z.string().optional(),
  contractType: num.optional(),
  contractRet: z.string().optional(),
  contractData: z
    .looseObject({
      amount: amountField.optional(),
      owner_address: z.string().optional(),
      to_address: z.string().optional(),
    })
    .optional(),
  trc20TransferInfo: z.array(Trc20InfoSchema).optional(),
});

type Trc20Row = z.infer<typeof Trc20RowSchema>;
type TxRow = z.infer<typeof TxRowSchema>;

interface ListFetch<R> {
  rows: R[];
  /** Raw rows fetched across pages (before filtering). */
  fetched: number;
  rangeTotal: number | undefined;
  /** Stopped at the page cap with more rows still available. */
  capped: boolean;
}

export class TronscanProvider implements ExplorerProvider {
  readonly chain = "tron" as const;
  private readonly keyPool: TronscanKeyPool;
  private readonly maxPages: number;
  private readonly transport: Transport;
  private readonly cache: CacheStore;
  private readonly now: () => number;
  private readonly pauseGate: (() => Promise<void>) | undefined;
  private readonly retry: Omit<RetryOptions, "signal"> | undefined;
  private readonly counters: ProviderStats = { apiCalls: 0, cacheHits: 0 };

  constructor(opts: TronscanProviderOptions) {
    this.keyPool = opts.keyPool;
    this.maxPages = Math.min(4, Math.max(1, Math.trunc(opts.maxPages ?? 2)));
    this.transport = opts.transport;
    this.cache = opts.cache;
    this.now = opts.now;
    this.pauseGate = opts.pauseGate;
    this.retry = opts.retry;
  }

  stats(): ProviderStats {
    return { ...this.counters };
  }

  async getTransaction(hash: string, signal: AbortSignal): Promise<TxDetail> {
    const h = normalizeTx("tron", hash);
    const info = await this.fetchParsed(
      "transaction-info",
      { hash: h },
      undefined,
      signal,
      (raw) => {
        if (isEmptyObject(raw) || !hasField(raw, "hash")) {
          throw new FotError("not_found", `Transaction ${h} not found on Tronscan`);
        }
        return parseWith(TxInfoSchema, raw, "transaction-info");
      },
      (parsed) => ttlForTimestamp(Math.floor(parsed.timestamp / 1000), this.now()),
    );
    if (info.contractRet !== "SUCCESS") {
      throw new FotError(
        "tx_failed",
        `Transaction ${h} did not succeed (${info.contractRet ?? "no contractRet"})`,
      );
    }
    const timestamp = Math.floor(info.timestamp / 1000);
    const transfers: Transfer[] = [];
    for (const t of info.trc20TransferInfo ?? []) {
      transfers.push({
        chain: "tron",
        txHash: info.hash,
        blockNumber: info.block,
        timestamp,
        from: t.from_address,
        to: t.to_address,
        asset: tokenAsset(t.contract_address, t.symbol, t.name, t.decimals),
        amountRaw: t.amount_str,
        amount: rawToAmount(t.amount_str, tokenDecimals(t.contract_address, t.decimals)),
      });
    }
    const trx = info.contractData?.amount;
    if (info.contractType === 1 && trx !== undefined && /^\d+$/.test(trx) && trx !== "0") {
      transfers.unshift({
        chain: "tron",
        txHash: info.hash,
        blockNumber: info.block,
        timestamp,
        from: info.contractData?.owner_address ?? info.ownerAddress,
        to: info.contractData?.to_address ?? info.toAddress ?? "",
        asset: { chain: "tron", kind: "native" },
        amountRaw: trx,
        amount: rawToAmount(trx, TRX_DECIMALS),
      });
    }
    return {
      chain: "tron",
      hash: info.hash,
      blockNumber: info.block,
      timestamp,
      from: info.ownerAddress,
      to: info.toAddress ?? info.contractData?.to_address ?? null,
      status: "success",
      transfers,
    };
  }

  async listTransfers(q: ListTransfersQuery): Promise<ListTransfersResult> {
    const { beforeTs, afterTs } = q.window;
    const forward = afterTs !== undefined;
    const startMs = afterTs !== undefined ? (afterTs - TOLERANCE_SEC) * 1000 : undefined;
    const endSec =
      beforeTs !== undefined
        ? beforeTs + TOLERANCE_SEC
        : afterTs !== undefined
          ? afterTs + FORWARD_WINDOW_SEC
          : undefined;

    const fetchLists = (endTs: number | undefined) =>
      Promise.all([
        this.fetchList(
          "token_trc20/transfers",
          Trc20PageSchema,
          (p) => p.token_transfers,
          {
            relatedAddress: q.address,
            direction: q.direction,
            ...window(startMs, endTs),
          },
          q,
          endTs,
        ),
        this.fetchList(
          "transaction",
          TxPageSchema,
          (p) => p.data,
          {
            address: q.address,
            direction: q.direction,
            ...window(startMs, endTs),
          },
          q,
          endTs,
        ),
      ]);

    let [trc20, txs] = await fetchLists(endSec);
    let truncated = trc20.capped || txs.capped;

    if (forward && (isIncomplete(trc20) || isIncomplete(txs))) {
      // Rows come newest-first, so an oversized forward window drops the nearest ones. Re-query a
      // narrower window right after the reference time.
      const narrowEnd = (afterTs as number) + FORWARD_NARROW_WINDOW_SEC;
      if (narrowEnd < (endSec as number)) {
        const [t2, x2] = await fetchLists(narrowEnd);
        if (isIncomplete(trc20)) trc20 = t2;
        if (isIncomplete(txs)) txs = x2;
      }
      truncated = true;
    }

    const rows: Transfer[] = [];
    for (const r of trc20.rows) {
      if (r.finalResult !== "SUCCESS" || r.revert === true) continue;
      rows.push(trc20ToTransfer(r));
    }
    for (const r of txs.rows) {
      const t = txRowToTransfer(r);
      if (t) rows.push(t);
    }
    rows.sort((a, b) => (forward ? a.timestamp - b.timestamp : b.timestamp - a.timestamp));
    return { rows, truncated };
  }

  private async fetchList<P, R>(
    endpoint: string,
    schema: z.ZodType<P>,
    rowsOf: (page: P) => R[],
    params: Record<string, string | number>,
    q: ListTransfersQuery,
    ttlTs: number | undefined,
  ): Promise<ListFetch<R>> {
    const out: ListFetch<R> = { rows: [], fetched: 0, rangeTotal: undefined, capped: false };
    const maxPages = Math.max(1, Math.min(q.maxPages ?? this.maxPages, this.maxPages));
    for (let page = 0; page < maxPages; page++) {
      const parsed = await this.fetchParsed(
        endpoint,
        { ...params, limit: PAGE_SIZE, start: page * PAGE_SIZE },
        ttlTs,
        q.signal,
        (raw) => parseWith(schema, raw, endpoint),
      );
      const rows = rowsOf(parsed);
      out.rows.push(...rows);
      out.fetched += rows.length;
      const total = (parsed as { rangeTotal?: number }).rangeTotal;
      if (total !== undefined) out.rangeTotal = total;
      if (rows.length < PAGE_SIZE) return out;
      if (out.rangeTotal !== undefined && out.fetched >= out.rangeTotal) return out;
    }
    out.capped = true;
    return out;
  }

  /**
   * One Tronscan GET through cache → key pool → retry → transport. `parse` validates the body
   * inside the attempt, so malformed or not-found responses are never cached. A key that reports
   * its quota spent is retired and the request moves once to the next key.
   */
  private async fetchParsed<T>(
    endpoint: string,
    params: Record<string, string | number>,
    ttlTs: number | undefined,
    signal: AbortSignal,
    parse: (raw: unknown) => T,
    ttlFor?: (parsed: T) => number,
  ): Promise<T> {
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    const url = `${TRONSCAN_BASE_URL}/${endpoint}?${qs}`;
    const key = await cacheKey("tronscan", "tron", endpoint, params);

    for (let round = 0; ; round++) {
      let pinned: string | undefined;
      try {
        const body = await cachedRequest({
          cache: this.cache,
          key,
          stats: this.counters,
          signal,
          ...(this.retry ? { retry: this.retry } : {}),
          attempt: async () => {
            const apiKey = await this.keyPool.acquire({
              signal,
              ...(this.pauseGate ? { pauseGate: this.pauseGate } : {}),
              ...(pinned !== undefined ? { preferKey: pinned } : {}),
            });
            pinned = apiKey;
            const res = await this.transport({
              url,
              headers: { "TRON-PRO-API-KEY": apiKey },
              signal,
            }).catch((e: unknown) => {
              throw toNetworkError(e, signal);
            });
            this.counters.apiCalls++;
            const retryAfterSec = parseRetryAfter(res.retryAfter, this.now());
            const extra = retryAfterSec === undefined ? {} : { retryAfterSec };
            if (res.status === 429 || res.status === 403) {
              throw new KeyExhaustedError(apiKey, `Tronscan ${endpoint}: HTTP ${res.status}`, {
                retryable: true,
                ...extra,
              });
            }
            assertHttpOk(res, `Tronscan ${endpoint}`, this.now());
            if (res.status !== 200) {
              throw new FotError("provider_error", `Tronscan ${endpoint}: HTTP ${res.status}`);
            }
            const raw = parseJson(res.body, endpoint);
            const err = errorMessage(raw);
            if (err !== null) {
              if (EXHAUSTION_RE.test(err)) {
                throw new KeyExhaustedError(apiKey, `Tronscan ${endpoint}: ${err}`, {
                  retryable: false,
                });
              }
              throw new FotError("provider_error", `Tronscan ${endpoint}: ${err}`);
            }
            const parsed = parse(raw);
            const ttl = ttlFor ? ttlFor(parsed) : ttlForTimestamp(ttlTs, this.now());
            return { body: res.body, ttlSec: ttl };
          },
        });
        return parse(parseJson(body, endpoint));
      } catch (e) {
        if (!(e instanceof KeyExhaustedError)) throw e;
        this.keyPool.markExhausted(e.apiKey);
        if (round >= 1 && this.keyPool.activeKeyCount > 0) {
          throw new FotError("rate_limited", e.message, { retryable: false });
        }
        // With no active key left, the next acquire() throws the fatal "all keys exhausted".
      }
    }
  }
}

function window(startMs: number | undefined, endSec: number | undefined) {
  return {
    ...(startMs !== undefined ? { start_timestamp: startMs } : {}),
    ...(endSec !== undefined ? { end_timestamp: endSec * 1000 } : {}),
  };
}

function isIncomplete<R>(l: ListFetch<R>): boolean {
  return l.rangeTotal !== undefined && l.rangeTotal > l.fetched;
}

function parseJson(body: string, endpoint: string): unknown {
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new FotError("provider_error", `Tronscan ${endpoint}: response is not JSON`, {
      cause: e,
    });
  }
}

function parseWith<T>(schema: z.ZodType<T>, raw: unknown, endpoint: string): T {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const detail = r.error.issues[0];
  throw new FotError(
    "provider_error",
    `Tronscan ${endpoint}: unexpected response shape (${detail?.path.join(".") ?? ""}: ${detail?.message ?? "invalid"})`,
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isEmptyObject(v: unknown): boolean {
  return isRecord(v) && Object.keys(v).length === 0;
}

function hasField(v: unknown, field: string): boolean {
  return isRecord(v) && typeof v[field] === "string" && v[field] !== "";
}

/** Body-level error text (`Error` / `error`), when the response carries one. */
function errorMessage(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  for (const k of ["Error", "error"]) {
    const v = raw[k];
    if (typeof v === "string" && v !== "") return v;
    if (isRecord(v) && typeof v.message === "string") return v.message;
  }
  return null;
}

function tokenDecimals(contract: string, rowDecimals: number | undefined): number {
  return findCanonicalToken("tron", contract)?.decimals ?? rowDecimals ?? 18;
}

function tokenAsset(
  contract: string,
  symbol: string | undefined,
  name: string | undefined,
  decimals: number | undefined,
): Asset {
  const canonical = findCanonicalToken("tron", contract);
  if (canonical) {
    return {
      chain: "tron",
      kind: "token",
      contract,
      symbol: canonical.symbol,
      name: name ?? canonical.symbol,
      decimals: canonical.decimals,
      decimalsGuessed: false,
    };
  }
  const known = decimals !== undefined && Number.isInteger(decimals) && decimals >= 0;
  return {
    chain: "tron",
    kind: "token",
    contract,
    symbol: symbol ?? "",
    name: name ?? symbol ?? "",
    decimals: known ? decimals : 18,
    decimalsGuessed: !known,
  };
}

function rawToAmount(raw: string, decimals: number): number {
  return Number(BigInt(raw)) / 10 ** decimals;
}

function trc20ToTransfer(r: Trc20Row): Transfer {
  const contract = r.contract_address ?? r.tokenInfo?.tokenId ?? "";
  const asset = tokenAsset(
    contract,
    r.tokenInfo?.tokenAbbr,
    r.tokenInfo?.tokenName,
    r.tokenInfo?.tokenDecimal,
  );
  return {
    chain: "tron",
    txHash: r.transaction_id,
    blockNumber: r.block,
    timestamp: Math.floor(r.block_ts / 1000),
    from: r.from_address,
    to: r.to_address,
    asset,
    amountRaw: r.quant,
    amount: rawToAmount(r.quant, asset.kind === "token" ? asset.decimals : TRX_DECIMALS),
  };
}

function txRowToTransfer(r: TxRow): Transfer | null {
  if (r.contractType !== 1 || r.contractRet !== "SUCCESS" || r.revert === true) return null;
  const amount = r.amount;
  if (amount === undefined || !/^\d+$/.test(amount) || amount === "0") return null;
  if (r.toAddress === undefined) return null;
  return {
    chain: "tron",
    txHash: r.hash,
    blockNumber: r.block,
    timestamp: Math.floor(r.timestamp / 1000),
    from: r.ownerAddress,
    to: r.toAddress,
    asset: { chain: "tron", kind: "native" },
    amountRaw: amount,
    amount: rawToAmount(amount, TRX_DECIMALS),
  };
}
