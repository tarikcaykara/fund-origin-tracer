import { describe, expect, test } from "bun:test";
import type { AnalysisResult, Label, TraceEdge } from "@fot/core/schema";
import { highestValuePath } from "../src/path.ts";

function edge(
  id: string,
  from: string,
  to: string,
  usd: number | null,
  timestamp: number,
  overrides: Partial<TraceEdge> = {},
): TraceEdge {
  return {
    id,
    depth: 0,
    from,
    to,
    far: from,
    near: to,
    transfer: {
      chain: "ethereum",
      txHash: id,
      blockNumber: timestamp,
      timestamp,
      from,
      to,
      asset: { chain: "ethereum", kind: "native" },
      amountRaw: "1",
      amount: 1,
    },
    usd,
    parents: [],
    children: [],
    status: "expanded",
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

function result(address: string, labels: Label[] = []): AnalysisResult {
  return {
    graph: {
      addresses: [
        {
          address,
          labels,
          sanctioned: false,
          isSeedSubject: true,
          seedIds: [],
          inEdgeIds: [],
          outEdgeIds: [],
        },
      ],
      edges: [],
    },
  } as unknown as AnalysisResult;
}

describe("highestValuePath", () => {
  test("chooses the largest-USD incoming edge at each backward step", () => {
    const low = edge("low", "old-low", "seed", 5, 10);
    const high = edge("high", "middle", "seed", 10, 20, { seedId: "s1" });
    const continuation = edge("continuation", "origin", "middle", 3, 30);
    expect(
      highestValuePath([low, high, continuation], null, "backward").map((item) => item.id),
    ).toEqual(["continuation", "high"]);
  });

  test("breaks equal-value ties by the earlier transfer and treats unpriced as zero", () => {
    const later = edge("later", "later-origin", "seed", 5, 20, { seedId: "s1" });
    const unpriced = edge("unpriced", "unpriced-origin", "seed", null, 1);
    const earlier = edge("earlier", "earlier-origin", "seed", 5, 10);
    expect(
      highestValuePath([later, unpriced, earlier], null, "backward").map((item) => item.id),
    ).toEqual(["earlier"]);
    const seeded = edge("unpriced", "unpriced-origin", "seed", null, 1, { seedId: "s1" });
    expect(highestValuePath([seeded], null, "backward").map((item) => item.id)).toEqual([
      "unpriced",
    ]);
  });

  test("stops after detecting a cycle", () => {
    const toSeed = edge("to-seed", "b", "a", 4, 1, { seedId: "s1" });
    const back = edge("back", "a", "b", 3, 2);
    expect(highestValuePath([toSeed, back], null, "backward").map((item) => item.id)).toEqual([
      "back",
      "to-seed",
    ]);
  });

  test("stops at a labelled entity", () => {
    const exchange: Label = {
      name: "Origin",
      category: "exchange",
      entity: "Origin",
      source: "test",
      origin: "bundled",
    };
    const seedLeg = edge("seed", "exchange", "seed", 8, 2, { seedId: "s1" });
    const beyond = edge("beyond", "older", "exchange", 99, 1);
    const analysis = result("seed");
    analysis.graph.addresses.push({
      address: "exchange",
      labels: [exchange],
      sanctioned: false,
      isSeedSubject: false,
      seedIds: [],
      inEdgeIds: [],
      outEdgeIds: [],
    });
    expect(
      highestValuePath([seedLeg, beyond], analysis, "backward").map((item) => item.id),
    ).toEqual(["seed"]);
  });

  test("selects the seed with the greatest total path value", () => {
    const first = edge("first", "x", "seed-a", 4, 1, { seedId: "s1" });
    const second = edge("second", "y", "seed-b", 5, 2, { seedId: "s2" });
    const secondParent = edge("parent", "origin", "y", 8, 3);
    expect(
      highestValuePath([first, second, secondParent], null, "backward").map((item) => item.id),
    ).toEqual(["parent", "second"]);
  });

  test("walks outgoing transfers from the seed for forward traces", () => {
    const first = edge("first", "seed", "middle", 2, 1, {
      seedId: "s1",
      near: "seed",
      far: "middle",
    });
    const second = edge("second", "middle", "origin", 4, 2, { near: "middle", far: "origin" });
    const other = edge("other", "seed", "alternate", 1, 3, { near: "seed", far: "alternate" });
    expect(
      highestValuePath([first, second, other], null, "forward").map((item) => item.id),
    ).toEqual(["first", "second"]);
  });
});
