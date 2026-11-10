import type { ChainId } from "../chains.ts";
import { type Asset, assetId, type Transfer, type TxDetail } from "../schema.ts";

export interface ProviderStats {
  apiCalls: number;
  cacheHits: number;
}

/**
 * Time bound for a transfer listing (unix seconds). Backward queries pass `beforeTs` and get rows
 * nearest-first (newest first); forward queries pass `afterTs` and get rows nearest-first (oldest
 * first). An empty window means no time bound, newest first.
 */
export interface TransferWindow {
  beforeTs?: number;
  afterTs?: number;
}

export interface ListTransfersQuery {
  address: string;
  direction: "in" | "out";
  window: TransferWindow;
  signal: AbortSignal;
  /** Optional page cap, applied as min(this, provider maxPages). */
  maxPages?: number;
}

export interface ListTransfersResult {
  /** May include both directions; the engine filters. */
  rows: Transfer[];
  /** True when a listing hit the page cap with a full last page. */
  truncated: boolean;
}

export interface ExplorerProvider {
  readonly chain: ChainId;
  getTransaction(hash: string, signal: AbortSignal): Promise<TxDetail>;
  listTransfers(q: ListTransfersQuery): Promise<ListTransfersResult>;
  stats(): ProviderStats;
}

export interface PriceRequest {
  asset: Asset;
  /** Unix seconds. */
  timestamp: number;
}

/** Price lookups are bucketed to the hour: `${assetId}@${hourStart}`. */
export function priceKey(asset: Asset, timestamp: number): string {
  return `${assetId(asset)}@${Math.floor(timestamp / 3600) * 3600}`;
}

/** Token decimals were guessed (18): `amount` may be off by orders of magnitude, so it is never priced. */
export function hasGuessedDecimals(asset: Asset): boolean {
  return asset.kind === "token" && asset.decimalsGuessed;
}

/**
 * USD value of `transfer` from a `priceMany` result: null when its hour bucket is unpriced or its
 * token decimals were guessed.
 */
export function transferUsd(
  transfer: Transfer,
  prices: ReadonlyMap<string, number | null>,
): number | null {
  if (hasGuessedDecimals(transfer.asset)) return null;
  const price = prices.get(priceKey(transfer.asset, transfer.timestamp));
  return price == null ? null : transfer.amount * price;
}

export interface PriceResult {
  /** Keyed by `priceKey(asset, timestamp)`; null = unpriced. */
  prices: Map<string, number | null>;
  warning: { code: string; message: string } | null;
}

export interface PriceSource {
  priceMany(items: PriceRequest[], signal: AbortSignal): Promise<PriceResult>;
  stats(): ProviderStats;
}
