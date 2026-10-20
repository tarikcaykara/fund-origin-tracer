import { decodeAbiParameters, formatUnits, type Hex, hexToString } from "viem";
import { z } from "zod";
import {
  CHAINS,
  type ChainId,
  findCanonicalToken,
  normalizeAddress,
  normalizeTx,
} from "../chains.ts";
import { FotError } from "../errors.ts";
import {
  type AttemptResult,
  cachedRequest,
  TTL_IMMUTABLE_SEC,
  TTL_RECENT_SEC,
  ttlForTimestamp,
} from "../infra/http.ts";
import type { MinIntervalLimiter } from "../infra/limiter.ts";
import { assertHttpOk, type RetryOptions, toNetworkError } from "../infra/retry.ts";
import { type CacheStore, cacheKey } from "../infra/store.ts";
import type { Transport, TransportResponse } from "../infra/transport.ts";
import type { Asset, Transfer, TxDetail } from "../schema.ts";
import type {
  ExplorerProvider,
  ListTransfersQuery,
  ListTransfersResult,
  ProviderStats,
} from "./types.ts";

export const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";
const PAGE_SIZE = 50;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** Margin (seconds) around the requested time bound when resolving it to a block. */
const BOUND_MARGIN_SEC = 5;

export type EtherscanChain = "ethereum" | "polygon" | "arbitrum";

export interface EtherscanOptions {
  apiKey: string;
  /** Shared across chains and runs: Etherscan's quota is per account, not per chain. */
  limiter: MinIntervalLimiter;
  /** 1–4 pages of 50 rows per list. Default 2. */
  maxPages?: number;
  transport: Transport;
  cache: CacheStore;
  /** Epoch milliseconds. */
  now: () => number;
  pauseGate?: () => Promise<void>;
  retry?: Omit<RetryOptions, "signal">;
}

const FREE_TIER_RE = /free api access is not supported/i;
const RATE_LIMIT_RE = /rate limit/i;
const INVALID_KEY_RE = /invalid api key|missing\/invalid api key/i;
const NO_RESULTS_RE = /no (transactions|records) found/i;

type Params = Record<string, string | number>;

const HexString = z.string().regex(/^0x[0-9a-fA-F]*$/);

const RpcTx = z.object({
  hash: z.string(),
  blockNumber: HexString.nullable(),
  from: z.string(),
  to: z.string().nullable(),
  value: HexString,
});
const RpcLog = z.object({
  address: z.string(),
  topics: z.array(z.string()),
  data: HexString,
  removed: z.boolean().optional(),
});
const RpcReceipt = z.object({
  status: HexString.nullish(),
  contractAddress: z.string().nullish(),
  logs: z.array(RpcLog),
});
const RpcBlock = z.object({ timestamp: HexString });

function parseRpc<T>(schema: z.ZodType<T>, raw: unknown, method: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw providerError(`Etherscan ${method}: unexpected result shape`);
  return parsed.data;
}

// `txlistinternal&txhash=` rows carry no `hash` field (observed live); the tx is already known.
const InternalRow = z.object({
  from: z.string(),
  to: z.string(),
  value: z.string().regex(/^\d+$/),
  isError: z.string(),
  contractAddress: z.string().optional(),
  blockNumber: z.string().optional(),
  timeStamp: z.string().optional(),
});
const NormalRow = z.object({
  hash: z.string(),
  from: z.string(),
  to: z.string(),
  value: z.string().regex(/^\d+$/),
  isError: z.string(),
  contractAddress: z.string().optional(),
  blockNumber: z.string().regex(/^\d+$/),
  timeStamp: z.string().regex(/^\d+$/),
});
const TokenRow = z.object({
  hash: z.string(),
  from: z.string(),
  to: z.string(),
  value: z.string().regex(/^\d+$/),
  contractAddress: z.string(),
  tokenSymbol: z.string(),
  tokenName: z.string(),
  tokenDecimal: z.string(),
  blockNumber: z.string().regex(/^\d+$/),
  timeStamp: z.string().regex(/^\d+$/),
});

function providerError(message: string, extra: { retryable?: boolean } = {}): FotError {
  return new FotError("provider_error", message, extra);
}

function parseArray<T>(schema: z.ZodType<T>, result: unknown, what: string): T[] {
  if (!Array.isArray(result)) throw providerError(`Etherscan ${what}: unexpected result shape`);
  const out: T[] = [];
  for (const item of result) {
    const parsed = schema.safeParse(item);
    if (!parsed.success) throw providerError(`Etherscan ${what}: malformed row`);
    out.push(parsed.data);
  }
  return out;
}

/**
 * Turns a raw Etherscan V2 response body into its `result` or throws the matching FotError.
 * Error envelopes arrive as HTTP 200, so the body is the only source of truth.
 */
function classifyEnvelope(body: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw providerError("Etherscan returned a non-JSON response", { retryable: true });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw providerError("Etherscan returned an unexpected response");
  }
  const rec = parsed as Record<string, unknown>;

  if ("status" in rec) {
    if (rec.status === "1") return rec.result;
    const message = typeof rec.message === "string" ? rec.message : "";
    const text = typeof rec.result === "string" ? rec.result : "";
    const hay = `${message} ${text}`;
    if (FREE_TIER_RE.test(hay)) {
      throw new FotError("chain_requires_paid_plan", text || message, { fatal: true });
    }
    if (RATE_LIMIT_RE.test(hay)) {
      throw new FotError("rate_limited", text || message, { retryable: true });
    }
    if (INVALID_KEY_RE.test(hay)) {
      throw new FotError("invalid_api_key", text || message, { fatal: true });
    }
    if ((Array.isArray(rec.result) && rec.result.length === 0) || NO_RESULTS_RE.test(message)) {
      return [];
    }
    throw providerError(`Etherscan error: ${[message, text].filter(Boolean).join(": ")}`);
  }

  if ("error" in rec && rec.error !== null && rec.error !== undefined) {
    const err = rec.error as { message?: unknown };
    const message = typeof err.message === "string" ? err.message : "unknown proxy error";
    if (RATE_LIMIT_RE.test(message)) {
      throw new FotError("rate_limited", message, { retryable: true });
    }
    throw providerError(`Etherscan proxy error: ${message}`);
  }
  if (!("result" in rec)) throw providerError("Etherscan returned an unexpected response");
  if (rec.result === null) throw new FotError("not_found", "Etherscan proxy returned no result");
  return rec.result;
}

function hexToNumber(hex: string): number {
  return Number(BigInt(hex));
}

function decodeSymbol(hex: string): string | null {
  let symbol: string | null = null;
  try {
    const [s] = decodeAbiParameters([{ type: "string" }], hex as Hex);
    symbol = s ?? null;
  } catch {
    if (hex.length === 66) {
      try {
        symbol = hexToString(hex as Hex, { size: 32 });
      } catch {
        symbol = null;
      }
    }
  }
  const clean = symbol?.replaceAll("\0", "").trim();
  return clean ? clean : null;
}

function validDecimals(hex: unknown): number | null {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(hex)) return null;
  const n = BigInt(hex);
  return n <= 255n ? Number(n) : null;
}

export class EtherscanV2Provider implements ExplorerProvider {
  readonly chain: ChainId;
  private readonly evmChainId: number;
  private readonly maxPages: number;
  private readonly counters: ProviderStats = { apiCalls: 0, cacheHits: 0 };
  private readonly tokenMeta = new Map<string, Promise<Extract<Asset, { kind: "token" }>>>();
  private readonly blockTs = new Map<number, Promise<number>>();

  constructor(
    chain: EtherscanChain,
    private readonly opts: EtherscanOptions,
  ) {
    this.chain = chain;
    const id = CHAINS[chain].evmChainId;
    if (id === null) throw new Error(`Chain ${chain} has no EVM chain id`);
    this.evmChainId = id;
    this.maxPages = Math.min(4, Math.max(1, Math.trunc(opts.maxPages ?? 2)));
  }

  stats(): ProviderStats {
    return { ...this.counters };
  }

  // ---- request pipeline ----------------------------------------------------------------

  /**
   * cache → limiter → retry → transport. `ttl` maps the classified result to a cache TTL
   * (null = do not cache). Returns the classified `result`.
   */
  private async call(
    module: string,
    action: string,
    params: Params,
    signal: AbortSignal,
    ttl: (result: unknown) => number | null,
  ): Promise<unknown> {
    const query: Params = { chainid: this.evmChainId, module, action, ...params };
    const key = await cacheKey("etherscan", this.chain, `${module}.${action}`, query);
    const search = new URLSearchParams(
      Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]),
    );
    search.set("apikey", this.opts.apiKey);
    const url = `${ETHERSCAN_V2_URL}?${search.toString()}`;

    const attempt = async (): Promise<AttemptResult> => {
      await this.opts.limiter.acquire(signal, this.opts.pauseGate);
      let res: TransportResponse;
      try {
        res = await this.opts.transport({ url, signal });
      } catch (e) {
        throw toNetworkError(e, signal);
      } finally {
        this.counters.apiCalls++;
      }
      assertHttpOk(res, `Etherscan ${module}.${action}`, this.opts.now());
      if (res.status !== 200) {
        throw providerError(`Etherscan ${module}.${action}: HTTP ${res.status}`);
      }
      const result = classifyEnvelope(res.body);
      return { body: res.body, ttlSec: ttl(result) };
    };

    const body = await cachedRequest({
      cache: this.opts.cache,
      key,
      stats: this.counters,
      signal,
      ...(this.opts.retry ? { retry: this.opts.retry } : {}),
      attempt,
    });
    return classifyEnvelope(body);
  }

  private ttlAt(ts: number | undefined): number {
    return ttlForTimestamp(ts, this.opts.now());
  }

  // ---- getTransaction ------------------------------------------------------------------

  async getTransaction(hash: string, signal: AbortSignal): Promise<TxDetail> {
    const txHash = normalizeTx(this.chain, hash);
    const recent = this.ttlAt(undefined);

    const rawTx = await this.call(
      "proxy",
      "eth_getTransactionByHash",
      { txhash: txHash },
      signal,
      () => recent,
    );
    const tx = parseRpc(RpcTx, rawTx, "eth_getTransactionByHash");
    if (tx.blockNumber === null) {
      throw new FotError("not_found", `Transaction ${txHash} is not mined yet`);
    }
    const blockNumber = hexToNumber(tx.blockNumber);
    const timestamp = await this.blockTimestamp(blockNumber, signal);
    const ttl = this.ttlAt(timestamp);

    const rawReceipt = await this.call(
      "proxy",
      "eth_getTransactionReceipt",
      { txhash: txHash },
      signal,
      () => ttl,
    );
    const receipt = parseRpc(RpcReceipt, rawReceipt, "eth_getTransactionReceipt");
    if (
      receipt.status !== null &&
      receipt.status !== undefined &&
      hexToNumber(receipt.status) === 0
    ) {
      throw new FotError("tx_failed", `Transaction ${txHash} failed on-chain`);
    }

    const rawInternal = await this.call(
      "account",
      "txlistinternal",
      { txhash: txHash },
      signal,
      () => ttl,
    );
    const internal = parseArray(InternalRow, rawInternal, "txlistinternal");

    const base = { chain: this.chain, txHash, blockNumber, timestamp } as const;
    const transfers: Transfer[] = [];
    const native: Asset = { chain: this.chain, kind: "native" };
    const addNative = (from: string, to: string, raw: string) => {
      transfers.push({
        ...base,
        from: normalizeAddress(this.chain, from),
        to: normalizeAddress(this.chain, to),
        asset: native,
        amountRaw: raw,
        amount: this.toAmount(raw, CHAINS[this.chain].nativeDecimals),
      });
    };

    const nativeValue = BigInt(tx.value);
    const txTo = tx.to ?? receipt.contractAddress ?? null;
    if (nativeValue > 0n && txTo) addNative(tx.from, txTo, nativeValue.toString());

    for (const row of internal) {
      if (row.isError !== "0" || row.value === "0") continue;
      const to = row.to || row.contractAddress;
      if (!to) continue;
      addNative(row.from, to, row.value);
    }

    for (const log of receipt.logs) {
      if (
        log.removed ||
        log.topics.length !== 3 ||
        log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC
      ) {
        continue;
      }
      const [, fromTopic, toTopic] = log.topics;
      if (!fromTopic || !toTopic || log.data === "0x") continue;
      const asset = await this.tokenAsset(log.address, signal);
      const raw = BigInt(log.data).toString();
      transfers.push({
        ...base,
        from: topicAddress(fromTopic),
        to: topicAddress(toTopic),
        asset,
        amountRaw: raw,
        amount: this.toAmount(raw, asset.decimals),
      });
    }

    return {
      chain: this.chain,
      hash: txHash,
      blockNumber,
      timestamp,
      from: normalizeAddress(this.chain, tx.from),
      to: tx.to === null ? null : normalizeAddress(this.chain, tx.to),
      status: "success",
      transfers,
    };
  }

  private blockTimestamp(blockNumber: number, signal: AbortSignal): Promise<number> {
    const memo = this.blockTs.get(blockNumber);
    if (memo) return memo;
    const p = (async () => {
      const raw = await this.call(
        "proxy",
        "eth_getBlockByNumber",
        { tag: `0x${blockNumber.toString(16)}`, boolean: "false" },
        signal,
        (r) => {
          const parsed = RpcBlock.safeParse(r);
          return parsed.success ? this.ttlAt(hexToNumber(parsed.data.timestamp)) : null;
        },
      );
      return hexToNumber(parseRpc(RpcBlock, raw, "eth_getBlockByNumber").timestamp);
    })();
    this.blockTs.set(blockNumber, p);
    p.catch(() => this.blockTs.delete(blockNumber));
    return p;
  }

  private tokenAsset(
    contract: string,
    signal: AbortSignal,
  ): Promise<Extract<Asset, { kind: "token" }>> {
    const address = normalizeAddress(this.chain, contract);
    const canonical = findCanonicalToken(this.chain, address);
    if (canonical) {
      return Promise.resolve({
        chain: this.chain,
        kind: "token",
        contract: address,
        symbol: canonical.symbol,
        name: canonical.symbol,
        decimals: canonical.decimals,
        decimalsGuessed: false,
      });
    }
    const memo = this.tokenMeta.get(address);
    if (memo) return memo;
    const p = (async () => {
      const [symbol, decimals] = await Promise.all([
        this.ethCall(address, "0x95d89b41", signal, (r) =>
          typeof r === "string" && decodeSymbol(r) !== null ? TTL_IMMUTABLE_SEC : null,
        ),
        this.ethCall(address, "0x313ce567", signal, (r) =>
          validDecimals(r) !== null ? TTL_IMMUTABLE_SEC : null,
        ),
      ]);
      const sym = typeof symbol === "string" ? decodeSymbol(symbol) : null;
      const dec = validDecimals(decimals);
      const asset: Extract<Asset, { kind: "token" }> = {
        chain: this.chain,
        kind: "token",
        contract: address,
        symbol: sym ?? "UNKNOWN",
        name: sym ?? "UNKNOWN",
        decimals: dec ?? 18,
        decimalsGuessed: dec === null,
      };
      return asset;
    })();
    this.tokenMeta.set(address, p);
    p.catch(() => this.tokenMeta.delete(address));
    return p;
  }

  /** eth_call that tolerates non-contract / reverting tokens; auth, quota and abort errors propagate. */
  private async ethCall(
    to: string,
    data: string,
    signal: AbortSignal,
    ttl: (result: unknown) => number | null,
  ): Promise<unknown> {
    try {
      return await this.call("proxy", "eth_call", { to, data, tag: "latest" }, signal, ttl);
    } catch (e) {
      if (e instanceof FotError && !e.fatal && e.code !== "network_error") return null;
      throw e;
    }
  }

  private toAmount(raw: string, decimals: number): number {
    return Number(formatUnits(BigInt(raw), decimals));
  }

  // ---- listTransfers -------------------------------------------------------------------

  async listTransfers(q: ListTransfersQuery): Promise<ListTransfersResult> {
    const { window, signal } = q;
    const address = normalizeAddress(this.chain, q.address);
    const ascending = window.afterTs !== undefined && window.beforeTs === undefined;

    const range: Params = {};
    if (window.beforeTs !== undefined) {
      range.endblock = await this.blockAt(window.beforeTs + BOUND_MARGIN_SEC, "before", signal);
    }
    if (window.afterTs !== undefined) {
      range.startblock = await this.blockAt(window.afterTs - BOUND_MARGIN_SEC, "after", signal);
    }
    const boundTs = window.beforeTs ?? window.afterTs;
    const ttl = this.ttlAt(boundTs);
    const maxPages = Math.max(1, Math.min(q.maxPages ?? this.maxPages, this.maxPages));
    const sort = ascending ? "asc" : "desc";

    const fetchList = async <T>(action: string, schema: z.ZodType<T>) => {
      const rows: T[] = [];
      let truncated = false;
      for (let page = 1; page <= maxPages; page++) {
        const raw = await this.call(
          "account",
          action,
          { address, page, offset: PAGE_SIZE, sort, ...range },
          signal,
          // Forward listings can still gain rows unless the page is already full.
          (r) => (ascending && !(Array.isArray(r) && r.length >= PAGE_SIZE) ? TTL_RECENT_SEC : ttl),
        );
        const batch = parseArray(schema, raw, action);
        rows.push(...batch);
        if (batch.length < PAGE_SIZE) break;
        if (page === maxPages) truncated = true;
      }
      return { rows, truncated };
    };

    const [tokens, normals, internals] = await Promise.all([
      fetchList("tokentx", TokenRow),
      fetchList("txlist", NormalRow),
      fetchList("txlistinternal", NormalRow),
    ]);

    const out: Transfer[] = [];
    for (const r of tokens.rows) out.push(this.tokenRowTransfer(r));
    for (const r of [...normals.rows, ...internals.rows]) {
      if (r.isError !== "0" || r.value === "0") continue;
      const to = r.to || r.contractAddress;
      if (!to) continue;
      out.push({
        chain: this.chain,
        txHash: r.hash.toLowerCase(),
        blockNumber: Number(r.blockNumber),
        timestamp: Number(r.timeStamp),
        from: normalizeAddress(this.chain, r.from),
        to: normalizeAddress(this.chain, to),
        asset: { chain: this.chain, kind: "native" },
        amountRaw: r.value,
        amount: this.toAmount(r.value, CHAINS[this.chain].nativeDecimals),
      });
    }

    const dir = ascending ? 1 : -1;
    out.sort((a, b) => dir * (a.timestamp - b.timestamp) || dir * (a.blockNumber - b.blockNumber));
    return { rows: out, truncated: tokens.truncated || normals.truncated || internals.truncated };
  }

  private tokenRowTransfer(r: z.infer<typeof TokenRow>): Transfer {
    const contract = normalizeAddress(this.chain, r.contractAddress);
    const canonical = findCanonicalToken(this.chain, contract);
    const parsedDecimals = /^\d+$/.test(r.tokenDecimal) ? Number(r.tokenDecimal) : null;
    const decimals = canonical?.decimals ?? parsedDecimals ?? 18;
    const symbol = canonical?.symbol ?? r.tokenSymbol;
    return {
      chain: this.chain,
      txHash: r.hash.toLowerCase(),
      blockNumber: Number(r.blockNumber),
      timestamp: Number(r.timeStamp),
      from: normalizeAddress(this.chain, r.from),
      to: normalizeAddress(this.chain, r.to),
      asset: {
        chain: this.chain,
        kind: "token",
        contract,
        symbol,
        name: canonical?.symbol ?? r.tokenName,
        decimals,
        decimalsGuessed: canonical === undefined && parsedDecimals === null,
      },
      amountRaw: r.value,
      amount: this.toAmount(r.value, decimals),
    };
  }

  /** Resolves a timestamp to a block. A failure is an error: never fall back to "latest". */
  private async blockAt(
    timestamp: number,
    closest: "before" | "after",
    signal: AbortSignal,
  ): Promise<number> {
    const ts = Math.max(0, Math.trunc(timestamp));
    const ttl = this.ttlAt(ts);
    const result = await this.call(
      "block",
      "getblocknobytime",
      { timestamp: ts, closest },
      signal,
      (r) => (typeof r === "string" && /^\d+$/.test(r) ? ttl : null),
    );
    if (typeof result !== "string" || !/^\d+$/.test(result)) {
      throw providerError(`Etherscan getblocknobytime: unexpected result for timestamp ${ts}`);
    }
    return Number(result);
  }
}

function topicAddress(topic: string): string {
  return `0x${topic.slice(-40).toLowerCase()}`;
}
