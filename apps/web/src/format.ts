import { CHAINS } from "@fot/core/chains";
import type { Asset, ChainId } from "@fot/core/schema";
import { getAddress } from "viem";

/** Full address: EVM checksummed (EIP-55), TRON unchanged. */
export function fullAddress(chain: ChainId, address: string): string {
  if (CHAINS[chain].kind !== "evm") return address;
  try {
    return getAddress(address);
  } catch {
    return address;
  }
}

/** `first6…last4` of the display address. */
export function shortAddress(chain: ChainId, address: string): string {
  const full = fullAddress(chain, address);
  return full.length > 12 ? `${full.slice(0, 6)}…${full.slice(-4)}` : full;
}

export function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}

export function formatUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  const abs = Math.abs(usd);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: abs > 0 && abs < 1 ? 4 : 2,
  }).format(usd);
}

export function formatAmount(amount: number): string {
  const abs = Math.abs(amount);
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: abs >= 1000 ? 2 : abs >= 1 ? 4 : 8,
  }).format(amount);
}

export function assetSymbol(asset: Asset): string {
  return asset.kind === "native" ? CHAINS[asset.chain].nativeSymbol : asset.symbol;
}

/** `2026-10-20 14:03:09 UTC` from unix seconds. */
export function formatTimestamp(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function txUrl(chain: ChainId, hash: string): string {
  return CHAINS[chain].txUrl(hash);
}

export function addressUrl(chain: ChainId, address: string): string {
  return CHAINS[chain].addressUrl(address);
}

/** `ethereum` → `Ethereum`, `tron` → `TRON`. */
export function chainName(chain: ChainId): string {
  return chain === "tron" ? "TRON" : chain.charAt(0).toUpperCase() + chain.slice(1);
}

export function directionName(direction: "backward" | "forward"): string {
  return direction === "backward" ? "Source of funds" : "Destination of funds";
}

/** The run's title, or its id when it has none. */
export function runTitle(run: { id: string; title: string | null }): string {
  return run.title?.trim() || run.id;
}

/** `2026-10-21 18:51 UTC` from an ISO string or epoch milliseconds. */
export function formatUtcMinute(value: string | number): string {
  return `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** `10-21 18:51` from an ISO string or epoch milliseconds. */
export function formatCompactUtc(value: string | number): string {
  return new Date(value).toISOString().slice(5, 16).replace("T", " ");
}

/** `10-20 20:38` from unix seconds (transfer timestamps). */
export function formatCompactTimestamp(unixSeconds: number): string {
  return formatCompactUtc(unixSeconds * 1000);
}

/** `m:ss` for durations under an hour and `h:mm:ss` thereafter. */
export function formatClock(milliseconds: number): string {
  const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}:${seconds}`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = String(totalMinutes % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

/** `10-minute` for whole minutes, else `90-second`; run time limits (`timeoutSec`). */
export function formatTimeLimit(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60}-minute` : `${seconds}-second`;
}
