import { describe, expect, test } from "bun:test";
import type { AnalysisResult, DerivedAnalysis, RunEvent, TraceEdge } from "@fot/core/schema";
import { initialRunState, type RunState, reduceRunEvent, sortedEdges } from "../src/run-state.ts";

function edge(id: string, overrides: Partial<TraceEdge> = {}): TraceEdge {
  return {
    id,
    depth: 0,
    from: "0xfrom",
    to: "0xto",
    far: "0xfrom",
    near: "0xto",
    transfer: {
      chain: "ethereum",
      txHash: `0x${id}`,
      blockNumber: 1,
      timestamp: 1_700_000_000,
      from: "0xfrom",
      to: "0xto",
      asset: { chain: "ethereum", kind: "native" },
      amountRaw: "1000",
      amount: 1,
    },
    usd: null,
    parents: [],
    children: [],
    status: "pending",
    stopReason: null,
    stopDetail: null,
    selection: null,
    swap: null,
    dropped: [],
    droppedTotal: 0,
    seedId: null,
    ...overrides,
  };
}

function fold(events: RunEvent[], from: RunState = initialRunState): RunState {
  return events.reduce(reduceRunEvent, from);
}

describe("reduceRunEvent", () => {
  test("a snapshot replaces the state, then patches apply", () => {
    const stale = fold([{ type: "warning", code: "old", message: "stale" }]);
    const state = fold(
      [
        { type: "snapshot", status: "running", edges: [edge("a")], stats: { apiCalls: 2 } },
        { type: "edge_added", edge: edge("b", { depth: 1, parents: ["a"] }) },
        { type: "edge_expanded", edgeId: "a", selected: ["b"], droppedTotal: 4 },
        { type: "edge_stopped", edgeId: "b", reason: "max_depth", detail: null },
        {
          type: "progress",
          expandedEdges: 1,
          queued: 0,
          apiCalls: 5,
          cacheHits: 1,
          elapsedMs: 1200,
        },
        { type: "warning", code: "prices_unavailable", message: "no prices" },
        { type: "status", status: "paused" },
      ],
      stale,
    );

    expect(state.warnings).toEqual([{ code: "prices_unavailable", message: "no prices" }]);
    expect(Object.keys(state.edges)).toEqual(["a", "b"]);
    expect(state.edges.a).toMatchObject({ status: "expanded", children: ["b"], droppedTotal: 4 });
    expect(state.edges.b).toMatchObject({ status: "stopped", stopReason: "max_depth" });
    expect(state.stats).toEqual({ apiCalls: 2 });
    expect(state.progress).toEqual({
      expandedEdges: 1,
      queued: 0,
      apiCalls: 5,
      cacheHits: 1,
      elapsedMs: 1200,
    });
    expect(state.phase).toBe("paused");
    expect(state.done).toBe(false);
  });

  test("edge_linked adds a parent once and ignores unknown edges", () => {
    const base = fold([{ type: "snapshot", status: "running", edges: [edge("a")], stats: {} }]);
    const linked = fold(
      [
        { type: "edge_linked", edgeId: "a", parentId: "p1" },
        { type: "edge_linked", edgeId: "a", parentId: "p1" },
        { type: "edge_linked", edgeId: "a", parentId: "p2" },
        { type: "edge_linked", edgeId: "missing", parentId: "p1" },
      ],
      base,
    );
    expect(linked.edges.a?.parents).toEqual(["p1", "p2"]);
    expect(Object.keys(linked.edges)).toEqual(["a"]);
  });

  test("reducing never mutates the previous state", () => {
    const base = fold([{ type: "snapshot", status: "running", edges: [edge("a")], stats: {} }]);
    const before = structuredClone(base);
    fold(
      [
        { type: "edge_linked", edgeId: "a", parentId: "p" },
        { type: "edge_stopped", edgeId: "a", reason: "cycle", detail: null },
      ],
      base,
    );
    expect(base).toEqual(before);
  });

  test("result replaces the streamed state and done finalizes it", () => {
    const streamed = fold([
      { type: "snapshot", status: "running", edges: [edge("a")], stats: {} },
      { type: "edge_added", edge: edge("live-only") },
    ]);
    const final = edge("a", { status: "stopped", stopReason: "no_candidates" });
    const result = {
      status: "completed",
      graph: { addresses: [], edges: [final] },
      stats: {
        expandedEdges: 1,
        apiCalls: 9,
        cacheHits: 3,
        droppedCandidates: 0,
        maxDepthReached: 0,
      },
    } as unknown as AnalysisResult;

    const done = fold(
      [
        { type: "result", result },
        { type: "done", status: "completed" },
      ],
      streamed,
    );
    expect(Object.keys(done.edges)).toEqual(["a"]);
    expect(done.edges.a).toEqual(final);
    expect(done.result).toBe(result);
    expect(done.stats).toEqual(result.stats);
    expect(done.phase).toBe("completed");
    expect(done.done).toBe(true);
  });

  test("an error event is recorded and a reconnect snapshot resets done", () => {
    const failed = fold([
      { type: "snapshot", status: "running", edges: [], stats: {} },
      { type: "error", code: "rate_limited", message: "slow down" },
      { type: "done", status: "failed" },
    ]);
    expect(failed.error).toEqual({ code: "rate_limited", message: "slow down" });
    expect(failed.done).toBe(true);
    const resumed = reduceRunEvent(failed, {
      type: "snapshot",
      status: "running",
      edges: [],
      stats: {},
    });
    expect(resumed.done).toBe(false);
    expect(resumed.error).toBeNull();
  });

  test("a provisional analysis lasts until the result replaces it or a snapshot resets it", () => {
    const analysis = { riskLevel: "medium", flags: [] } as unknown as DerivedAnalysis;
    const live = fold([
      { type: "snapshot", status: "running", edges: [edge("a")], stats: {} },
      { type: "provisional", analysis },
      { type: "edge_added", edge: edge("b") },
    ]);
    expect(live.provisional).toBe(analysis);
    expect(live.phase).toBe("running");
    expect(Object.keys(live.edges)).toEqual(["a", "b"]);

    const reconnected = reduceRunEvent(live, {
      type: "snapshot",
      status: "running",
      edges: [edge("a")],
      stats: {},
    });
    expect(reconnected.provisional).toBeNull();

    const result = {
      status: "completed",
      graph: { addresses: [], edges: [edge("a")] },
      stats: {},
    } as unknown as AnalysisResult;
    const finished = reduceRunEvent(live, { type: "result", result });
    expect(finished.provisional).toBeNull();
    expect(finished.result).toBe(result);
  });
});

describe("sortedEdges", () => {
  test("orders by depth then USD descending, leaving unpriced edges last", () => {
    const state = fold([
      { type: "edge_added", edge: edge("deep", { depth: 2 }) },
      { type: "edge_added", edge: edge("unpriced", { depth: 0 }) },
      { type: "edge_added", edge: edge("mid", { depth: 1 }) },
      { type: "edge_added", edge: edge("low", { depth: 0, usd: 1 }) },
      { type: "edge_added", edge: edge("high", { depth: 0, usd: 9 }) },
    ]);
    expect(sortedEdges(state).map((e) => e.id)).toEqual(["high", "low", "unpriced", "mid", "deep"]);
  });
});
