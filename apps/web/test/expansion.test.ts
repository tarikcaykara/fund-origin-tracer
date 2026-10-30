import { describe, expect, test } from "bun:test";
import { expansionProgress } from "../src/expansion.ts";

const base = { expandedEdges: 4, apiCalls: 28, cacheHits: 4 };
const progress = (expandedEdges: number, queued: number, apiCalls: number, cacheHits: number) => ({
  expandedEdges,
  queued,
  apiCalls,
  cacheHits,
  elapsedMs: 2100,
});

describe("expansionProgress", () => {
  test("counts only this expansion: run totals minus the totals before it", () => {
    expect(expansionProgress({ edgeId: "e", maxDepth: 1, base }, progress(5, 0, 33, 6))).toEqual({
      edges: 1,
      queued: 0,
      apiCalls: 5,
      cacheHits: 2,
      elapsedMs: 2100,
      ratio: null,
    });
  });

  test("starts at zero before the first progress event and never goes negative", () => {
    expect(expansionProgress({ edgeId: "e", maxDepth: 1, base }, null)).toEqual({
      edges: 0,
      queued: 0,
      apiCalls: 0,
      cacheHits: 0,
      elapsedMs: 0,
      ratio: null,
    });
    // A stale progress from before the expansion (lower totals) must not show negative counts.
    expect(
      expansionProgress({ edgeId: "e", maxDepth: 1, base }, progress(2, 0, 10, 1)),
    ).toMatchObject({ edges: 0, apiCalls: 0, cacheHits: 0 });
  });

  test("one hop is indeterminate; deeper expansions report expanded / (expanded + queued)", () => {
    expect(expansionProgress({ edgeId: "e", maxDepth: 1, base }, progress(5, 3, 30, 4)).ratio).toBe(
      null,
    );
    expect(expansionProgress({ edgeId: "e", maxDepth: 3, base }, progress(7, 3, 40, 4)).ratio).toBe(
      0.5,
    );
    expect(expansionProgress({ edgeId: "e", maxDepth: 3, base }, progress(4, 0, 28, 4)).ratio).toBe(
      0,
    );
  });
});
