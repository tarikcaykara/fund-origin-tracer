import { type ChainId, listingCalls } from "@fot/core/chains";
import type { Direction } from "@fot/core/schema";
import type { RunExpansion, RunState } from "./run-state.ts";

/** Depth the detail panel's "Expand further" asks for: one hop per click (the API default is 3). */
export const PANEL_EXPAND_DEPTH = 1;

export interface ExpansionProgress {
  /** Edges this expansion has expanded so far. */
  edges: number;
  queued: number;
  apiCalls: number;
  cacheHits: number;
  elapsedMs: number;
  /** Share done for deeper expansions; null (indeterminate) for one hop, a single listing. */
  ratio: number | null;
}

/** The expansion's own counters: the run totals in `progress` minus the totals before it began. */
export function expansionProgress(
  expansion: RunExpansion,
  progress: RunState["progress"],
): ExpansionProgress {
  const { base } = expansion;
  const since = (total: number | undefined, before: number) =>
    Math.max(0, (total ?? before) - before);
  const edges = since(progress?.expandedEdges, base.expandedEdges);
  const queued = progress?.queued ?? 0;
  return {
    edges,
    queued,
    apiCalls: since(progress?.apiCalls, base.apiCalls),
    cacheHits: since(progress?.cacheHits, base.cacheHits),
    elapsedMs: progress?.elapsedMs ?? 0,
    ratio: expansion.maxDepth <= 1 ? null : edges + queued === 0 ? 0 : edges / (edges + queued),
  };
}

/** `≈ 3–7 API calls`: one listing of the edge's address plus at most one price lookup. */
export function expandCallHint(chain: ChainId, direction: Direction, maxPages: number): string {
  const { min, max } = listingCalls(chain, direction, maxPages);
  return `≈ ${min}–${max + 1} API calls`;
}
