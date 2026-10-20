import { normalizeAddress } from "../chains.ts";
import { isSpoofed } from "../labels/spoof.ts";
import { type Asset, assetId, type DropReason, type Transfer } from "../schema.ts";

/** Candidates may be this many seconds "later" (backward) / "earlier" (forward) than the edge. */
export const TIME_TOLERANCE_SEC = 5;

export interface ScoreBreakdown {
  asset: number;
  amount: number;
  time: number;
  dust: number;
}

export interface ScoreReference {
  asset: Asset;
  amount: number;
  usd: number | null;
  /** Unix seconds of the edge being expanded. */
  timestamp: number;
}

export interface Scored {
  score: number;
  breakdown: ScoreBreakdown;
}

/** Points for the relative amount difference `|ref - c| / ref`. */
export function amountPoints(rel: number): number {
  if (rel < 1e-4) return 25;
  if (rel < 0.01) return 18;
  if (rel < 0.05) return 12;
  if (rel < 0.1) return 6;
  if (rel < 0.5) return 2;
  return 0;
}

/** Points for the absolute time difference in seconds. */
export function timePoints(deltaSec: number): number {
  const dt = Math.abs(deltaSec);
  if (dt < 60) return 30;
  if (dt < 300) return 22;
  if (dt < 3600) return 15;
  if (dt < 86400) return 7;
  if (dt < 604800) return 2;
  return 0;
}

/** -10 for dust: under 1 USD when priced, otherwise under 0.001 units. */
export function dustPoints(usd: number | null, amount: number): number {
  const dust = usd !== null ? usd < 1 : amount < 0.001;
  return dust ? -10 : 0;
}

function relativeDifference(ref: ScoreReference, t: Transfer, usd: number | null): number | null {
  if (assetId(ref.asset) === assetId(t.asset)) {
    return ref.amount > 0 ? Math.abs(ref.amount - t.amount) / ref.amount : null;
  }
  if (ref.usd !== null && usd !== null && ref.usd > 0) return Math.abs(ref.usd - usd) / ref.usd;
  return null;
}

export function scoreCandidate(ref: ScoreReference, t: Transfer, usd: number | null): Scored {
  const asset = assetId(ref.asset) === assetId(t.asset) ? 50 : 0;
  const rel = relativeDifference(ref, t, usd);
  const amount = rel === null ? 0 : amountPoints(rel);
  const time = timePoints(t.timestamp - ref.timestamp);
  const dust = dustPoints(usd, t.amount);
  return { score: asset + amount + time + dust, breakdown: { asset, amount, time, dust } };
}

/** Score desc, then time distance asc. Stable for equal keys (listing order). */
export function compareScored(
  a: { score: number; transfer: Transfer },
  b: { score: number; transfer: Transfer },
  refTimestamp: number,
): number {
  if (a.score !== b.score) return b.score - a.score;
  return (
    Math.abs(a.transfer.timestamp - refTimestamp) - Math.abs(b.transfer.timestamp - refTimestamp)
  );
}

export interface DropContext {
  direction: "backward" | "forward";
  /** Transaction hash of the edge being expanded. */
  edgeTxHash: string;
  /** Unix seconds of the edge being expanded. */
  refTimestamp: number;
  minUsd: number;
}

/** First applicable drop reason in the fixed order, or null when the candidate stays in play. */
export function dropReason(t: Transfer, usd: number | null, ctx: DropContext): DropReason | null {
  if (t.txHash.toLowerCase() === ctx.edgeTxHash.toLowerCase()) return "same_tx";
  if (normalizeAddress(t.chain, t.from) === normalizeAddress(t.chain, t.to)) {
    return "self_transfer";
  }
  if (t.amountRaw === "0" || /^0+$/.test(t.amountRaw)) return "zero_value";
  if (isSpoofed(t.asset)) return "spoofed_token";
  const outside =
    ctx.direction === "backward"
      ? t.timestamp > ctx.refTimestamp + TIME_TOLERANCE_SEC
      : t.timestamp < ctx.refTimestamp - TIME_TOLERANCE_SEC;
  if (outside) return "outside_time_window";
  if (ctx.minUsd > 0) {
    if (usd === null) return "unpriced";
    if (usd < ctx.minUsd) return "below_min_usd";
  }
  return null;
}
