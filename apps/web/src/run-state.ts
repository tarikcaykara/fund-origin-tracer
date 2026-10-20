import type { AnalysisResult, RunEvent, RunStatus, TraceEdge } from "@fot/core/schema";

/** `connecting` until the first `snapshot` arrives; the rest mirrors the server's run status. */
export type RunPhase = "connecting" | "running" | "paused" | RunStatus;

export type SnapshotStats = Extract<RunEvent, { type: "snapshot" }>["stats"];
export type RunProgress = Extract<RunEvent, { type: "progress" }>;

export interface RunState {
  phase: RunPhase;
  /** Edges by id, in arrival order. */
  edges: Record<string, TraceEdge>;
  stats: SnapshotStats;
  /** Latest `progress` event, null before the first one. */
  progress: Omit<RunProgress, "type"> | null;
  warnings: { code: string; message: string }[];
  error: { code: string; message: string } | null;
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

function patchEdge(
  state: RunState,
  edgeId: string,
  patch: (edge: TraceEdge) => TraceEdge,
): RunState {
  const edge = state.edges[edgeId];
  if (!edge) return state;
  return { ...state, edges: { ...state.edges, [edgeId]: patch(edge) } };
}

/** Pure reducer: folds one streamed `RunEvent` into the run state. */
export function reduceRunEvent(state: RunState, event: RunEvent): RunState {
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
    case "edge_added":
      return { ...state, edges: { ...state.edges, [event.edge.id]: event.edge } };
    case "edge_linked":
      return patchEdge(state, event.edgeId, (e) =>
        e.parents.includes(event.parentId) ? e : { ...e, parents: [...e.parents, event.parentId] },
      );
    case "edge_expanded":
      return patchEdge(state, event.edgeId, (e) => ({
        ...e,
        status: "expanded",
        children: event.selected,
        droppedTotal: event.droppedTotal,
      }));
    case "edge_stopped":
      return patchEdge(state, event.edgeId, (e) => ({
        ...e,
        status: "stopped",
        stopReason: event.reason,
        stopDetail: event.detail,
      }));
    case "progress": {
      const { type: _type, ...progress } = event;
      return { ...state, progress };
    }
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
        result: event.result,
      };
    case "done":
      return { ...state, phase: event.status, done: true };
  }
}

/** Edges in a stable order for tables: depth, then arrival. */
export function sortedEdges(state: RunState): TraceEdge[] {
  return Object.values(state.edges).sort((a, b) => a.depth - b.depth);
}
