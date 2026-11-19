import type {
  AnalysisResult,
  DerivedAnalysis,
  RunEvent,
  RunStatus,
  TraceEdge,
} from "@fot/core/schema";

/** `connecting` until the first `snapshot` arrives; the rest mirrors the server's run status. */
export type RunPhase = "connecting" | "running" | "paused" | RunStatus;

export type SnapshotStats = Extract<RunEvent, { type: "snapshot" }>["stats"];
export type RunProgress = Extract<RunEvent, { type: "progress" }>;
export type RunExpansion = Omit<Extract<RunEvent, { type: "expansion" }>, "type">;

export interface RunState {
  phase: RunPhase;
  /** Edges by id, in arrival order. */
  edges: Record<string, TraceEdge>;
  stats: SnapshotStats;
  /** Latest `progress` event, null before the first one. */
  progress: Omit<RunProgress, "type"> | null;
  warnings: { code: string; message: string }[];
  error: { code: string; message: string } | null;
  /** Live-only analysis of the edges so far; cleared by `snapshot`, replaced by `result`. */
  provisional: DerivedAnalysis | null;
  /** The "Expand further" in progress; cleared by `snapshot` and `result`. */
  expansion: RunExpansion | null;
  /** The final analysis; set by the `result` event. */
  result: AnalysisResult | null;
  /** True after `done`; the stream is finished and must not be reconnected. */
  done: boolean;
}

export const initialRunState: RunState = {
  phase: "connecting",
  edges: {},
  stats: {},
  progress: null,
  warnings: [],
  error: null,
  provisional: null,
  expansion: null,
  result: null,
  done: false,
};

export function isLivePhase(phase: RunPhase): phase is "running" | "paused" {
  return phase === "running" || phase === "paused";
}

function indexEdges(edges: readonly TraceEdge[]): Record<string, TraceEdge> {
  const out: Record<string, TraceEdge> = {};
  for (const e of edges) out[e.id] = e;
  return out;
}

type EdgeEvent = Extract<
  RunEvent,
  { type: "edge_added" | "edge_linked" | "edge_expanded" | "edge_stopped" }
>;

/** The edge an edge event produces, or null when the event changes nothing. */
function nextEdge(edges: Readonly<Record<string, TraceEdge>>, event: EdgeEvent): TraceEdge | null {
  if (event.type === "edge_added") return event.edge;
  const edge = edges[event.edgeId];
  if (!edge) return null;
  switch (event.type) {
    case "edge_linked":
      return edge.parents.includes(event.parentId)
        ? null
        : { ...edge, parents: [...edge.parents, event.parentId] };
    case "edge_expanded":
      return {
        ...edge,
        status: "expanded",
        children: event.selected,
        droppedTotal: event.droppedTotal,
      };
    case "edge_stopped":
      return { ...edge, status: "stopped", stopReason: event.reason, stopDetail: event.detail };
  }
}

/** Pure reducer: folds one streamed `RunEvent` into the run state. */
export function reduceRunEvent(state: RunState, event: RunEvent): RunState {
  return reduceRunEvents(state, [event]);
}

/**
 * Folds a batch of streamed events into the run state, as `reduceRunEvent` one by one would. The
 * edge events of a batch write into one copy of the edge index, made on the first real change, so
 * a burst of n edge events costs one copy instead of n. A batch that changes nothing returns `state`.
 */
export function reduceRunEvents(state: RunState, events: readonly RunEvent[]): RunState {
  let next = state;
  // The copy of `next.edges` this batch owns; written in place until an event replaces the index.
  let owned: Record<string, TraceEdge> | null = null;
  for (const event of events) {
    if (
      event.type === "edge_added" ||
      event.type === "edge_linked" ||
      event.type === "edge_expanded" ||
      event.type === "edge_stopped"
    ) {
      const edge = nextEdge(next.edges, event);
      if (edge === null) continue;
      if (owned === null || owned !== next.edges) {
        owned = { ...next.edges };
        next = { ...next, edges: owned };
      }
      owned[edge.id] = edge;
      continue;
    }
    next = reduceOtherEvent(next, event);
  }
  return next;
}

function reduceOtherEvent(state: RunState, event: Exclude<RunEvent, EdgeEvent>): RunState {
  switch (event.type) {
    case "snapshot":
      return {
        ...initialRunState,
        phase: event.status,
        edges: indexEdges(event.edges),
        stats: event.stats,
        done: false,
      };
    case "status":
      return { ...state, phase: event.status };
    case "progress": {
      const { type: _type, ...progress } = event;
      return { ...state, progress };
    }
    case "expansion": {
      const { type: _type, ...expansion } = event;
      return { ...state, expansion };
    }
    case "provisional":
      return { ...state, provisional: event.analysis };
    case "warning":
      return {
        ...state,
        warnings: [...state.warnings, { code: event.code, message: event.message }],
      };
    case "error":
      return { ...state, error: { code: event.code, message: event.message } };
    case "result":
      return {
        ...state,
        phase: event.result.status,
        edges: indexEdges(event.result.graph.edges),
        stats: event.result.stats,
        provisional: null,
        expansion: null,
        result: event.result,
      };
    case "done":
      return { ...state, phase: event.status, done: true };
  }
}

/** Transfer-list order: hop ascending, priced USD descending, unpriced last. Ties keep input order. */
export function transferOrder(a: TraceEdge, b: TraceEdge): number {
  const depth = a.depth - b.depth;
  if (depth !== 0) return depth;
  if (a.usd === null && b.usd !== null) return 1;
  if (a.usd !== null && b.usd === null) return -1;
  if (a.usd !== null && b.usd !== null && a.usd !== b.usd) return b.usd - a.usd;
  return 0;
}

/** Edges in transfer-list order, ties in arrival order. */
export function sortedEdges(state: RunState): TraceEdge[] {
  return Object.values(state.edges).sort(transferOrder);
}
