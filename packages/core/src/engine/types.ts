import type { LabelRegistry } from "../labels/registry.ts";
import type { ExplorerProvider, PriceSource } from "../providers/types.ts";
import type { RunEvent, TraceEdge } from "../schema.ts";

export interface EngineDeps {
  provider: ExplorerProvider;
  prices: PriceSource;
  labels: LabelRegistry;
  /** Epoch milliseconds. */
  now: () => number;
  /** Expansions in flight (default 4). */
  concurrency?: number;
}

export type TraceStatus = "completed" | "cancelled" | "timed_out" | "failed";

export interface TraceStats {
  expandedEdges: number;
  apiCalls: number;
  cacheHits: number;
  droppedCandidates: number;
  maxDepthReached: number;
}

/** Engine output consumed by `analyze()`. Edges are in creation order. */
export interface TraceOutput {
  edges: TraceEdge[];
  stats: TraceStats;
  status: TraceStatus;
  warnings: { code: string; message: string }[];
}

/**
 * Re-expansion of one stopped edge of a finished run ("Expand further"). The engine starts from
 * `edges` (all edges of the run), re-expands `edgeId` with a relative depth budget
 * (`edge.depth + maxDepth`) and, when `throughEntities` is set, ignores the entity stop for that
 * edge. New edges are appended; existing transfers are linked, never duplicated.
 */
export interface ContinueFrom {
  edges: TraceEdge[];
  edgeId: string;
  maxDepth: number;
  throughEntities: boolean;
}

export type Emit = (event: RunEvent) => void;
