import {
  type AnalysisResult,
  analyzeProvisional,
  BUNDLED_LABEL_FILES,
  type DerivedAnalysis,
  EXPANDABLE_REASONS,
  FixtureTransport,
  isFotError,
  LabelRegistry,
  MemoryCacheStore,
  RunController,
  type RunEvent,
  type RunParams,
  type TraceEdge,
} from "@fot/core";
import { chainHealth } from "./config.ts";
import type {
  Db,
  InvestigationListQuery,
  InvestigationStatus,
  InvestigationSummary,
} from "./db.ts";
import { DEFAULT_FIXTURES_DIR, listScenarios, loadScenario, type Scenario } from "./demo.ts";
import { executeRun } from "./execute.ts";
import type { Runtime } from "./runtime.ts";

export type ApiStatus = 400 | 403 | 404 | 409 | 429 | 500;

export class ApiError extends Error {
  constructor(
    readonly status: ApiStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const DEFAULT_EXPAND_DEPTH = 3;

export type StartRequest = { params: RunParams } | { demo: string };
export type RunEventListener = (event: RunEvent) => void;

export interface RunManagerOptions {
  runtime: Runtime;
  db: Db;
  /** Directory holding `<id>/scenario.json` demo scenarios. */
  fixturesDir?: string;
  /** Per-request latency of demo replays so the stream visibly animates. */
  replayDelayMs?: number;
  /** Concurrent live (non-demo) runs. */
  maxLiveRuns?: number;
  /** Minimum time between two provisional analyses of a live run. */
  provisionalIntervalMs?: number;
}

type LiveStatus = "running" | "paused";
type Stats = Extract<RunEvent, { type: "snapshot" }>["stats"];
type Expansion = Omit<Extract<RunEvent, { type: "expansion" }>, "type">;

interface LiveRun {
  id: string;
  controller: RunController;
  status: LiveStatus;
  live: boolean;
  edges: Map<string, TraceEdge>;
  stats: Stats;
  subscribers: Set<RunEventListener>;
  lastError: string | null;
  finished: Promise<void>;
  /** What the run is analyzed with: the same params and label registry `executeRun` uses. */
  params: RunParams;
  labels: LabelRegistry;
  /** Latest provisional analysis; replayed to late subscribers after the snapshot. */
  provisional: DerivedAnalysis | null;
  /** Edges changed since `provisional` was computed. */
  stale: boolean;
  /** Set by `result` (or a failed provisional pass): no provisional analysis follows. */
  settled: boolean;
  /** The expansion in progress, replayed to late subscribers; null for a fresh run. */
  expansion: Expansion | null;
}

export type ControlStatus = InvestigationStatus;

export type RunDetail = InvestigationSummary & { result: AnalysisResult | null };

function shortValue(v: string): string {
  return v.length > 14 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v;
}

function defaultTitle(params: RunParams): string {
  const kind = params.direction === "backward" ? "Source of funds" : "Destination of funds";
  const first = params.seeds[0];
  const more = params.seeds.length > 1 ? ` +${params.seeds.length - 1}` : "";
  return `${kind} · ${params.chain} · ${first ? shortValue(first.value) : "?"}${more}`;
}

export class RunManager {
  private readonly runtime: Runtime;
  private readonly db: Db;
  private readonly fixturesDir: string;
  private readonly replayDelayMs: number;
  private readonly maxLiveRuns: number;
  private readonly provisionalIntervalMs: number;
  private readonly runs = new Map<string, LiveRun>();

  constructor(options: RunManagerOptions) {
    this.runtime = options.runtime;
    this.db = options.db;
    this.fixturesDir = options.fixturesDir ?? DEFAULT_FIXTURES_DIR;
    this.replayDelayMs = options.replayDelayMs ?? 40;
    this.maxLiveRuns = options.maxLiveRuns ?? 3;
    this.provisionalIntervalMs = options.provisionalIntervalMs ?? 1000;
  }

  demos(): Scenario[] {
    return listScenarios(this.fixturesDir);
  }

  /** Number of in-flight runs that hit the real explorer APIs. */
  get liveCount(): number {
    let n = 0;
    for (const r of this.runs.values()) if (r.live) n++;
    return n;
  }

  isActive(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** Resolves when the run is finished (immediately when it is not active). */
  async waitForRun(runId: string): Promise<void> {
    await this.runs.get(runId)?.finished;
  }

  // ---------------------------------------------------------------- start

  async start(request: StartRequest): Promise<{ runId: string }> {
    if ("demo" in request) return this.startDemo(request.demo);
    const { params } = request;
    const { config } = this.runtime;
    if (config.demoOnly) {
      throw new ApiError(403, "demo_only", "This instance only serves recorded demo scenarios.");
    }
    this.assertLiveCapacity(params.chain);
    const runId = crypto.randomUUID();
    this.db.investigations.insert({
      id: runId,
      chain: params.chain,
      direction: params.direction,
      seeds: params.seeds,
      params,
      status: "running",
      title: defaultTitle(params),
      demo: null,
      createdAt: new Date().toISOString(),
    });
    const run = this.register(runId, true, params, this.runtime.labels);
    this.launch(run, () =>
      executeRun({
        params,
        runtime: this.runtime,
        controller: run.controller,
        emit: (e) => this.handle(run, e),
        runId,
        labels: run.labels,
      }),
    );
    return { runId };
  }

  private async startDemo(id: string): Promise<{ runId: string }> {
    const loaded = await loadScenario(this.fixturesDir, id);
    if (!loaded) throw new ApiError(404, "demo_not_found", `Unknown demo scenario "${id}".`);
    const { scenario, http, ofac } = loaded;
    const runId = crypto.randomUUID();
    this.db.investigations.insert({
      id: runId,
      chain: scenario.chain,
      direction: scenario.direction,
      seeds: scenario.params.seeds,
      params: scenario.params,
      status: "running",
      title: scenario.title,
      demo: scenario.id,
      createdAt: new Date().toISOString(),
    });
    const labels = new LabelRegistry(BUNDLED_LABEL_FILES, null, ofac);
    const run = this.register(runId, false, scenario.params, labels);
    this.launch(run, () =>
      executeRun({
        params: scenario.params,
        runtime: this.runtime,
        controller: run.controller,
        emit: (e) => this.handle(run, e),
        runId,
        labels,
        ofacFetchedAt: ofac.fetchedAt,
        transport: FixtureTransport(http, { delayMs: this.replayDelayMs }),
        cache: new MemoryCacheStore(Date.now),
        replay: true,
        concurrency: 1,
      }),
    );
    return { runId };
  }

  // --------------------------------------------------------------- expand

  async expand(
    runId: string,
    edgeId: string,
    options: { maxDepth?: number } = {},
  ): Promise<{ status: LiveStatus }> {
    const summary = this.db.investigations.get(runId);
    if (!summary) throw new ApiError(404, "not_found", "Unknown run.");
    if (this.runs.has(runId)) {
      throw new ApiError(409, "run_active", "The run is still in progress.");
    }
    const previous = this.db.investigations.getResult(runId);
    if (!previous) throw new ApiError(409, "not_finished", "The run has no result to expand.");
    const edge = previous.graph.edges.find((e) => e.id === edgeId);
    if (!edge) throw new ApiError(404, "edge_not_found", "Unknown edge.");
    if (edge.status !== "stopped" || edge.stopReason === null) {
      throw new ApiError(409, "edge_not_expandable", "Only stopped edges can be expanded.");
    }
    if (!EXPANDABLE_REASONS.has(edge.stopReason)) {
      throw new ApiError(
        409,
        "edge_not_expandable",
        `Edges stopped by "${edge.stopReason}" cannot be expanded.`,
      );
    }
    if (this.runtime.config.demoOnly) {
      throw new ApiError(409, "demo_only", "This instance only serves recorded demo scenarios.");
    }
    if (summary.demo !== null) {
      throw new ApiError(
        409,
        "demo_run_not_expandable",
        "Recorded demo runs replay fixed data and cannot be expanded; start a live trace from this address instead.",
      );
    }
    this.assertLiveCapacity(previous.chain);

    const throughEntities = edge.stopReason === "entity";
    const run = this.register(runId, true, previous.params, this.runtime.labels);
    for (const e of previous.graph.edges) run.edges.set(e.id, structuredClone(e));
    const target = run.edges.get(edgeId) as TraceEdge;
    target.status = "pending";
    target.stopReason = null;
    target.stopDetail = null;
    run.stats = { ...previous.stats };
    this.db.investigations.update(runId, { status: "running", finishedAt: null, error: null });
    const maxDepth = options.maxDepth ?? DEFAULT_EXPAND_DEPTH;
    const { expandedEdges, apiCalls, cacheHits } = previous.stats;
    run.expansion = { edgeId, maxDepth, base: { expandedEdges, apiCalls, cacheHits } };
    this.handle(run, { type: "expansion", ...run.expansion });
    // The first subscriber gets the merged graph's analysis with its snapshot, not a blank tab.
    run.stale = true;
    this.refreshProvisional(run);

    this.launch(
      run,
      () =>
        executeRun({
          params: previous.params,
          runtime: this.runtime,
          controller: run.controller,
          emit: (e) => this.handle(run, e),
          runId,
          labels: run.labels,
          continueFrom: { edgeId, maxDepth, throughEntities, previous },
        }),
      previous,
    );
    return { status: "running" };
  }

  // -------------------------------------------------------------- control

  pause(runId: string): { status: ControlStatus } {
    const run = this.runs.get(runId);
    if (!run) return { status: this.knownStatus(runId) };
    if (run.status === "running") {
      run.controller.pause();
      run.status = "paused";
      this.handle(run, { type: "status", status: "paused" });
      this.refreshProvisional(run);
    }
    return { status: run.status };
  }

  resume(runId: string): { status: ControlStatus } {
    const run = this.runs.get(runId);
    if (!run) return { status: this.knownStatus(runId) };
    if (run.status === "paused") {
      run.controller.resume();
      run.status = "running";
      this.handle(run, { type: "status", status: "running" });
    }
    return { status: run.status };
  }

  cancel(runId: string): { status: ControlStatus } {
    const run = this.runs.get(runId);
    if (!run) return { status: this.knownStatus(runId) };
    run.controller.cancel("cancelled");
    return { status: run.status };
  }

  /** Cancels every active run and waits for them to settle (server shutdown). */
  async shutdown(): Promise<void> {
    const active = [...this.runs.values()];
    for (const r of active) r.controller.cancel("cancelled");
    await Promise.allSettled(active.map((r) => r.finished));
  }

  private knownStatus(runId: string): ControlStatus {
    const row = this.db.investigations.get(runId);
    if (!row) throw new ApiError(404, "not_found", "Unknown run.");
    return row.status;
  }

  // ----------------------------------------------------------------- read

  has(runId: string): boolean {
    return this.db.investigations.get(runId) !== null;
  }

  list(query: InvestigationListQuery): {
    items: InvestigationSummary[];
    total: number;
    totalAll: number;
  } {
    const page = this.db.investigations.list(query);
    // Overlay live status (paused) on the rows still in flight.
    return {
      total: page.total,
      totalAll: page.totalAll,
      items: page.items.map((i) => {
        const run = this.runs.get(i.id);
        return run ? { ...i, status: run.status } : i;
      }),
    };
  }

  /** The persisted result of a finished run (not while it is being extended). */
  result(runId: string): AnalysisResult | null {
    return this.runs.has(runId) ? null : this.db.investigations.getResult(runId);
  }

  patch(
    runId: string,
    fields: { title?: string | null; notes?: string | null },
  ): InvestigationSummary | null {
    if (!this.db.investigations.update(runId, fields)) return null;
    return this.db.investigations.get(runId);
  }

  remove(runId: string): boolean {
    return this.db.investigations.delete(runId);
  }

  get(runId: string): RunDetail | null {
    const summary = this.db.investigations.get(runId);
    if (!summary) return null;
    const run = this.runs.get(runId);
    if (run) return { ...summary, status: run.status, result: null };
    return { ...summary, result: this.db.investigations.getResult(runId) };
  }

  /**
   * Delivers a `snapshot` synchronously, then live events until the run is done. Finished runs get
   * `snapshot`, `result` and `done` at once. Returns an unsubscribe function, or null for an
   * unknown run.
   */
  subscribe(runId: string, listener: RunEventListener): (() => void) | null {
    const run = this.runs.get(runId);
    if (run) {
      listener({
        type: "snapshot",
        status: run.status,
        edges: [...run.edges.values()],
        stats: run.stats,
      });
      if (run.expansion) listener({ type: "expansion", ...run.expansion });
      if (run.provisional) listener({ type: "provisional", analysis: run.provisional });
      run.subscribers.add(listener);
      return () => run.subscribers.delete(listener);
    }
    const summary = this.db.investigations.get(runId);
    if (!summary) return null;
    const result = this.db.investigations.getResult(runId);
    listener({
      type: "snapshot",
      status: summary.status === "interrupted" ? "failed" : summary.status,
      edges: result?.graph.edges ?? [],
      stats: result?.stats ?? {},
    });
    if (result) {
      listener({ type: "result", result });
      listener({ type: "done", status: result.status });
    } else {
      listener({
        type: "error",
        code: summary.status === "interrupted" ? "interrupted" : "no_result",
        message: summary.error ?? "The run has no result.",
      });
      listener({ type: "done", status: "failed" });
    }
    return () => {};
  }

  // ------------------------------------------------------------- internals

  private assertLiveCapacity(chain: AnalysisResult["chain"]): void {
    if (chainHealth(this.runtime.config)[chain] !== "ready") {
      throw new ApiError(
        409,
        "chain_not_ready",
        chain === "tron" ? "TRONSCAN_API_KEYS is not set." : "ETHERSCAN_API_KEY is not set.",
      );
    }
    if (this.liveCount >= this.maxLiveRuns) {
      throw new ApiError(429, "too_many_runs", `At most ${this.maxLiveRuns} live runs at a time.`);
    }
  }

  private register(id: string, live: boolean, params: RunParams, labels: LabelRegistry): LiveRun {
    const run: LiveRun = {
      id,
      controller: new RunController(),
      status: "running",
      live,
      edges: new Map(),
      stats: {},
      subscribers: new Set(),
      lastError: null,
      finished: Promise.resolve(),
      params,
      labels,
      provisional: null,
      stale: false,
      settled: false,
      expansion: null,
    };
    this.runs.set(id, run);
    return run;
  }

  /** Runs `work` in the background; failures are persisted and streamed, never thrown. */
  private launch(
    run: LiveRun,
    work: () => Promise<AnalysisResult>,
    fallback?: AnalysisResult,
  ): void {
    const ticker = setInterval(() => this.refreshProvisional(run), this.provisionalIntervalMs);
    run.finished = (async () => {
      try {
        await work();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const code = isFotError(e) ? e.code : "run_failed";
        const status = fallback?.status ?? "failed";
        this.db.investigations.update(run.id, {
          status,
          finishedAt: new Date().toISOString(),
          error: message,
        });
        this.handle(run, { type: "error", code, message });
        this.handle(run, { type: "done", status });
      } finally {
        clearInterval(ticker);
        this.runs.delete(run.id);
        run.subscribers.clear();
      }
    })();
  }

  /**
   * Recomputes the provisional analysis when the edges changed since the last one and streams it.
   * Network-free and never persisted; nothing follows the final `result`.
   */
  private refreshProvisional(run: LiveRun): void {
    if (run.settled || !run.stale || run.edges.size === 0) return;
    run.stale = false;
    let analysis: DerivedAnalysis;
    try {
      analysis = analyzeProvisional(
        [...run.edges.values()],
        run.params,
        run.labels,
        this.runtime.policy,
      );
    } catch (e) {
      // Runs from a timer, so a failure must not take the server down. The final analysis still
      // runs inside `launch` and reports its own errors.
      console.error(`[runs] provisional analysis of ${run.id} failed:`, e);
      run.settled = true;
      return;
    }
    run.provisional = analysis;
    this.handle(run, { type: "provisional", analysis });
  }

  /** Mirrors an engine event into live state, persists the result, then fans out to subscribers. */
  private handle(run: LiveRun, event: RunEvent): void {
    switch (event.type) {
      case "edge_added":
        run.edges.set(event.edge.id, event.edge);
        run.stale = true;
        break;
      case "edge_linked": {
        const e = run.edges.get(event.edgeId);
        if (e && !e.parents.includes(event.parentId)) e.parents.push(event.parentId);
        run.stale = true;
        break;
      }
      case "edge_expanded": {
        const e = run.edges.get(event.edgeId);
        if (e) {
          e.status = "expanded";
          e.children = event.selected;
          e.droppedTotal = event.droppedTotal;
        }
        run.stale = true;
        break;
      }
      case "edge_stopped": {
        const e = run.edges.get(event.edgeId);
        if (e) {
          e.status = "stopped";
          e.stopReason = event.reason;
          e.stopDetail = event.detail;
        }
        run.stale = true;
        break;
      }
      case "progress":
        run.stats = {
          expandedEdges: event.expandedEdges,
          apiCalls: event.apiCalls,
          cacheHits: event.cacheHits,
        };
        break;
      case "error":
        run.lastError = event.message;
        break;
      case "result":
        run.settled = true;
        run.provisional = null;
        run.expansion = null;
        this.db.investigations.update(run.id, {
          status: event.result.status,
          riskLevel: event.result.riskLevel,
          finishedAt: event.result.finishedAt,
          result: event.result,
          error: event.result.status === "failed" ? run.lastError : null,
        });
        break;
      default:
        break;
    }
    for (const listener of [...run.subscribers]) {
      try {
        listener(event);
      } catch {
        run.subscribers.delete(listener);
      }
    }
  }
}
