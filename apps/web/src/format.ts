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

/** ISO-8601 time without milliseconds, from unix seconds. */
export function isoTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
];

/** "3 days ago" for unix seconds or an ISO string, relative to `nowMs`. */
export function relativeTime(when: number | string, nowMs: number = Date.now()): string {
  const ms = typeof when === "number" ? when * 1000 : Date.parse(when);
  if (Number.isNaN(ms)) return "—";
  const diffSec = Math.round((ms - nowMs) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (Math.abs(diffSec) >= seconds || unit === "second") {
      return rtf.format(Math.trunc(diffSec / seconds), unit);
    }
  }
  return "—";
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
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
