import {
  type AnalysisResult,
  analyze,
  type CacheStore,
  type ContinueFrom,
  type Emit,
  type LabelRegistry,
  type RunController,
  type RunParams,
  runTrace,
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
  if (opts.continueFrom) {
    const { edgeId, maxDepth, throughEntities, previous } = opts.continueFrom;
    continueFrom = { edges: previous.graph.edges, edgeId, maxDepth, throughEntities };
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
    emit,
    continueFrom,
  );
  if (opts.continueFrom) trace.stats = mergeStats(opts.continueFrom.previous.stats, trace.stats);

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
