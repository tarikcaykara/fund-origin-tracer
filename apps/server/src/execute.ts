import {
  type AnalysisResult,
  analyze,
  type CacheStore,
  type ContinueFrom,
  type Emit,
  type LabelRegistry,
  type RunController,
  type RunParams,
  type RunStatus,
  runTrace,
  type StopReason,
  type TraceEdge,
  type TraceStats,
  type Transport,
} from "@fot/core";
import type { Runtime } from "./runtime.ts";

export interface ContinueRequest {
  edgeId: string;
  maxDepth: number;
  throughEntities: boolean;
  /** The finished result being extended; its graph is the starting point. */
  previous: AnalysisResult;
}

export interface ExecuteRunOptions {
  params: RunParams;
  runtime: Runtime;
  controller: RunController;
  emit: Emit;
  runId: string;
  /** Defaults to `runtime.labels`. Demo runs pass bundled labels + the scenario's OFAC snapshot. */
  labels?: LabelRegistry;
  /** Defaults to `runtime.ofacFetchedAt`. */
  ofacFetchedAt?: string | null;
  /** Explorer and price traffic go through this transport (recording or fixture replay). */
  transport?: Transport;
  cache?: CacheStore;
  /** Offline replay: no keys, no throttling. */
  replay?: boolean;
  /** Defaults to `config.engineConcurrency`. */
  concurrency?: number;
  continueFrom?: ContinueRequest;
}

function mergeStats(prev: TraceStats, next: TraceStats): TraceStats {
  return {
    expandedEdges: prev.expandedEdges + next.expandedEdges,
    apiCalls: prev.apiCalls + next.apiCalls,
    cacheHits: prev.cacheHits + next.cacheHits,
    droppedCandidates: prev.droppedCandidates + next.droppedCandidates,
    maxDepthReached: Math.max(prev.maxDepthReached, next.maxDepthReached),
  };
}

/** Stop reason a run with this status leaves on the edges it could not finish. */
const OPEN_STOP_REASON: Partial<Record<RunStatus, StopReason>> = {
  timed_out: "timeout",
  cancelled: "cancelled",
};

/**
 * The status of a run after "Expand further" describes the merged graph, not the continuation.
 * A continuation that times out or fails reports that. Otherwise the previous status stands
 * (a cancelled expansion keeps the edges it found), except that a timed-out or cancelled run
 * becomes `completed` once no edge carries its open stop reason any more.
 */
function statusAfterExpand(
  previous: RunStatus,
  continuation: RunStatus,
  edges: readonly TraceEdge[],
): RunStatus {
  if (continuation === "timed_out" || continuation === "failed") return continuation;
  const open = OPEN_STOP_REASON[previous];
  if (open !== undefined && !edges.some((edge) => edge.stopReason === open)) return "completed";
  return previous;
}

/**
 * Runs the engine and the analysis for one run, streaming events through `emit`, and finishes
 * with `result` then `done`. Throws (without emitting `result`/`done`) on unexpected errors so the
 * caller decides how to report them.
 */
export async function executeRun(opts: ExecuteRunOptions): Promise<AnalysisResult> {
  const { runtime, controller, emit, runId } = opts;
  const startedAt = opts.continueFrom?.previous.startedAt ?? new Date().toISOString();
  const params = opts.continueFrom?.previous.params ?? opts.params;
  const labels = opts.labels ?? runtime.labels;
  const pauseGate = () => controller.waitIfPaused();
  const providerOptions = {
    pauseGate,
    ...(opts.transport ? { transport: opts.transport } : {}),
    ...(opts.cache ? { cache: opts.cache } : {}),
    ...(opts.replay ? { replay: true } : {}),
  };
  const provider = runtime.explorerFor(params.chain, providerOptions);
  const prices = runtime.pricesFor(providerOptions);

  let continueFrom: ContinueFrom | undefined;
  let traceEmit = emit;
  if (opts.continueFrom) {
    const { edgeId, maxDepth, throughEntities, previous } = opts.continueFrom;
    continueFrom = { edges: previous.graph.edges, edgeId, maxDepth, throughEntities };
    // The engine counts the continuation alone; report run totals, as `mergeStats` does at the end,
    // so counters never go backwards. `queued` and `elapsedMs` stay the continuation's.
    const base = previous.stats;
    traceEmit = (event) =>
      emit(
        event.type === "progress"
          ? {
              ...event,
              expandedEdges: base.expandedEdges + event.expandedEdges,
              apiCalls: base.apiCalls + event.apiCalls,
              cacheHits: base.cacheHits + event.cacheHits,
            }
          : event,
      );
  }

  const trace = await runTrace(
    params,
    {
      provider,
      prices,
      labels,
      now: Date.now,
      concurrency: opts.concurrency ?? runtime.config.engineConcurrency,
    },
    controller,
    traceEmit,
    continueFrom,
  );
  if (opts.continueFrom) {
    const { previous } = opts.continueFrom;
    trace.stats = mergeStats(previous.stats, trace.stats);
    trace.status = statusAfterExpand(previous.status, trace.status, trace.edges);
  }

  const result = await analyze(trace, params, labels, runtime.policy, {
    provider,
    prices,
    signal: controller.signal,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    ofacFetchedAt: opts.ofacFetchedAt === undefined ? runtime.ofacFetchedAt : opts.ofacFetchedAt,
  });
  emit({ type: "result", result });
  emit({ type: "done", status: result.status });
  return result;
}
