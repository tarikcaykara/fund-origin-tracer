import { CHAINS, type ChainId, normalizeAddress } from "../../src/chains.ts";
import { FotError } from "../../src/errors.ts";
import type {
  ExplorerProvider,
  ListTransfersQuery,
  ListTransfersResult,
  PriceRequest,
  PriceResult,
  PriceSource,
  ProviderStats,
} from "../../src/providers/types.ts";
import { priceKey } from "../../src/providers/types.ts";
import type { RunEvent } from "../../src/schema.ts";
import { type Asset, assetId, type Transfer, type TxDetail } from "../../src/schema.ts";

export const T0 = 1_700_000_000;

/** Deterministic EVM address from a small integer. */
export function addr(n: number): string {
  return `0x${n.toString(16).padStart(40, "0")}`;
}

export function txHash(n: number): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

export const NATIVE_ETH: Asset = { chain: "ethereum", kind: "native" };

export function token(symbol: string, contract: string, decimals = 6): Asset {
  return {
    chain: "ethereum",
    kind: "token",
    contract,
    symbol,
    name: symbol,
    decimals,
    decimalsGuessed: false,
  };
}

export const USDT: Asset = token("USDT", "0xdac17f958d2ee523a2206206994597c13d831ec7");
export const USDC: Asset = token("USDC", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
export const WETH: Asset = token("WETH", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", 18);
/** Spoof: Cyrillic "Т" in the symbol, not the canonical contract. */
export const FAKE_USDT: Asset = token("USD\u0422", "0x00000000000000000000000000000000000fa4e1");

export interface TransferInit {
  tx: string | number;
  from: string;
  to: string;
  amount: number;
  ts: number;
  asset?: Asset;
  chain?: ChainId;
}

export function mkTransfer(init: TransferInit): Transfer {
  const asset = init.asset ?? USDT;
  const decimals = asset.kind === "native" ? CHAINS[asset.chain].nativeDecimals : asset.decimals;
  const raw =
    BigInt(Math.round(init.amount * 10 ** Math.min(decimals, 8))) *
    10n ** BigInt(Math.max(0, decimals - 8));
  return {
    chain: init.chain ?? asset.chain,
    txHash: typeof init.tx === "number" ? txHash(init.tx) : init.tx,
    blockNumber: init.ts,
    timestamp: init.ts,
    from: init.from,
    to: init.to,
    asset,
    amountRaw: raw.toString(),
    amount: init.amount,
  };
}

export function mkTx(
  hash: string,
  transfers: Transfer[],
  status: "success" | "failed" = "success",
): TxDetail {
  const first = transfers[0];
  return {
    chain: first?.chain ?? "ethereum",
    hash,
    blockNumber: first?.blockNumber ?? 0,
    timestamp: first?.timestamp ?? T0,
    from: first?.from ?? addr(0xdead),
    to: first?.to ?? null,
    status,
    transfers,
  };
}

export interface FakeCall {
  kind: "list" | "tx";
  key: string;
  direction?: "in" | "out";
  window?: { beforeTs?: number; afterTs?: number };
}

export interface FakeProviderOptions {
  chain?: ChainId;
  transfers?: Transfer[];
  txs?: TxDetail[];
  /** Per address (listTransfers) or tx hash (getTransaction): throw this error. */
  errors?: Record<string, FotError>;
  /** Awaited before every call resolves; may pause the controller, delay, etc. */
  onCall?: (call: FakeCall) => Promise<void> | void;
  /** Seconds beyond the requested bound that rows may still leak through (default 5). */
  windowSlackSec?: number;
  /** Return rows of both directions instead of only the requested one. */
  bothDirections?: boolean;
  /** Report every listing as truncated. */
  truncated?: boolean;
}

export class FakeProvider implements ExplorerProvider {
  readonly chain: ChainId;
  readonly calls: FakeCall[] = [];
  readonly #transfers: Transfer[];
  readonly #txs = new Map<string, TxDetail>();
  readonly #opts: FakeProviderOptions;

  constructor(opts: FakeProviderOptions = {}) {
    this.#opts = opts;
    this.chain = opts.chain ?? "ethereum";
    this.#transfers = opts.transfers ?? [];
    for (const tx of opts.txs ?? []) this.#txs.set(tx.hash.toLowerCase(), tx);
  }

  get listCalls(): FakeCall[] {
    return this.calls.filter((c) => c.kind === "list");
  }

  async #enter(call: FakeCall, signal: AbortSignal): Promise<void> {
    this.calls.push(call);
    await this.#opts.onCall?.(call);
    if (signal.aborted) throw new Error("aborted");
    const err = this.#opts.errors?.[call.key];
    if (err) throw err;
  }

  async getTransaction(hash: string, signal: AbortSignal): Promise<TxDetail> {
    await this.#enter({ kind: "tx", key: hash }, signal);
    const tx = this.#txs.get(hash.toLowerCase());
    if (!tx) throw new FotError("not_found", `tx ${hash} not found`);
    return tx;
  }

  async listTransfers(q: ListTransfersQuery): Promise<ListTransfersResult> {
    await this.#enter(
      { kind: "list", key: q.address, direction: q.direction, window: { ...q.window } },
      q.signal,
    );
    const a = normalizeAddress(this.chain, q.address);
    const { beforeTs, afterTs } = q.window;
    const slack = this.#opts.windowSlackSec ?? 5;
    let rows = this.#transfers.filter((t) => {
      const from = normalizeAddress(this.chain, t.from) === a;
      const to = normalizeAddress(this.chain, t.to) === a;
      if (!from && !to) return false;
      if (!this.#opts.bothDirections && !(q.direction === "in" ? to : from)) return false;
      if (beforeTs !== undefined && t.timestamp > beforeTs + slack) return false;
      if (afterTs !== undefined && t.timestamp < afterTs - slack) return false;
      return true;
    });
    rows = rows.sort((x, y) =>
      afterTs !== undefined ? x.timestamp - y.timestamp : y.timestamp - x.timestamp,
    );
    return { rows, truncated: this.#opts.truncated ?? false };
  }

  stats(): ProviderStats {
    return { apiCalls: this.calls.length, cacheHits: 0 };
  }
}

export class FakePrices implements PriceSource {
  calls = 0;
  /** Set to make `priceMany` return nulls plus this warning. */
  failWith: { code: string; message: string } | null = null;

  constructor(
    /** USD per unit by assetId. Unknown assets are unpriced (null). */
    private readonly usdPerUnit: Record<string, number> = {
      [assetId(USDT)]: 1,
      [assetId(USDC)]: 1,
    },
  ) {}

  async priceMany(items: PriceRequest[], signal: AbortSignal): Promise<PriceResult> {
    this.calls++;
    if (signal.aborted) throw new Error("aborted");
    const prices = new Map<string, number | null>();
    for (const it of items) {
      prices.set(
        priceKey(it.asset, it.timestamp),
        this.failWith ? null : (this.usdPerUnit[assetId(it.asset)] ?? null),
      );
    }
    return { prices, warning: this.failWith };
  }

  stats(): ProviderStats {
    return { apiCalls: this.calls, cacheHits: 0 };
  }
}

/** Collects emitted events and offers lookups by type. */
export class EventLog {
  readonly events: RunEvent[] = [];
  readonly emit = (e: RunEvent): void => {
    this.events.push(e);
  };
  of<T extends RunEvent["type"]>(type: T): Extract<RunEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);
  }
}
