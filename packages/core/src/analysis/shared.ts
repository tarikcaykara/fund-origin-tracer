import { CHAINS } from "../chains.ts";
import type { Asset, ChainId, Direction, Label, LabelCategory, TraceEdge } from "../schema.ts";

/** Everything the analysis stages share; built once by `analyze()`. */
export interface AnalysisContext {
  chain: ChainId;
  direction: Direction;
  /** Edges in deterministic order (depth, seed index, rank, id). */
  edges: readonly TraceEdge[];
  edgeById: ReadonlyMap<string, TraceEdge>;
  /** Seed ids in `params.seeds` order. */
  seedOrder: ReadonlyMap<string, number>;
  /** Seeds that reach each edge, in `params.seeds` order. */
  edgeSeedIds: ReadonlyMap<string, readonly string[]>;
  /** Cached registry lookup. */
  labelsOf(address: string): readonly Label[];
}

/** Exposure label priority, most severe first. `other` never produces exposure. */
export const LABEL_PRIORITY: readonly LabelCategory[] = [
  "sanctioned",
  "mixer",
  "scam",
  "exchange",
  "bridge",
  "dex",
  "defi",
  "token",
];

export function pickExposureLabel(labels: readonly Label[]): Label | null {
  let best: Label | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const label of labels) {
    const rank = LABEL_PRIORITY.indexOf(label.category);
    if (rank !== -1 && rank < bestRank) {
      best = label;
      bestRank = rank;
    }
  }
  return best;
}

export function entityOf(label: Label): string {
  return label.entity ?? label.name;
}

export function symbolOf(asset: Asset): string {
  return asset.kind === "native" ? CHAINS[asset.chain].nativeSymbol : asset.symbol;
}

/** Sum of the non-null values; null when none is known. */
export function sumUsd(values: Iterable<number | null>): number | null {
  let total = 0;
  let any = false;
  for (const v of values) {
    if (v !== null) {
      total += v;
      any = true;
    }
  }
  return any ? total : null;
}

/** Descending by usd, unknown (null) last. */
export function compareUsdDesc(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

export function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

export function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
