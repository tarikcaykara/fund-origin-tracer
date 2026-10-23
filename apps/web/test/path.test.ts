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

const PARAMS = { maxDepth: 6, traceThroughEntities: false };

const exchangeLabel: Label = {
  name: "Origin",
  category: "exchange",
  entity: "Origin",
  source: "test",
  origin: "bundled",
};

function labelled(analysis: AnalysisResult, address: string, isSeedSubject = false) {
  analysis.graph.addresses.push({
    address,
    labels: [exchangeLabel],
    sanctioned: false,
    isSeedSubject,
    seedIds: [],
    inEdgeIds: [],
    outEdgeIds: [],
  });
}

function pathIds(
  edges: TraceEdge[],
  analysis: AnalysisResult | null,
  direction: "backward" | "forward",
  params: Parameters<typeof highestValuePath>[3] = PARAMS,
): string[] {
  return highestValuePath(edges, analysis, direction, params).map((item) => item.id);
}

describe("highestValuePath", () => {
  test("chooses the largest-USD incoming edge at each backward step", () => {
    const low = edge("low", "old-low", "seed", 5, 10);
    const high = edge("high", "middle", "seed", 10, 20, { seedId: "s1" });
    const continuation = edge("continuation", "origin", "middle", 3, 30);
    expect(pathIds([low, high, continuation], null, "backward")).toEqual(["continuation", "high"]);
  });

  test("breaks equal-value ties by the earlier transfer and treats unpriced as zero", () => {
    const later = edge("later", "later-origin", "seed", 5, 20, { seedId: "s1" });
    const unpriced = edge("unpriced", "unpriced-origin", "seed", null, 1);
    const earlier = edge("earlier", "earlier-origin", "seed", 5, 10);
    expect(pathIds([later, unpriced, earlier], null, "backward")).toEqual(["earlier"]);
    const seeded = edge("unpriced", "unpriced-origin", "seed", null, 1, { seedId: "s1" });
    expect(pathIds([seeded], null, "backward")).toEqual(["unpriced"]);
  });

  test("stops after detecting a cycle", () => {
    const toSeed = edge("to-seed", "b", "a", 4, 1, { seedId: "s1" });
    const back = edge("back", "a", "b", 3, 2);
    expect(pathIds([toSeed, back], null, "backward")).toEqual(["back", "to-seed"]);
  });

  test("stops at a labelled entity", () => {
    const seedLeg = edge("seed", "exchange", "seed", 8, 2, { seedId: "s1" });
    const beyond = edge("beyond", "older", "exchange", 99, 1);
    const analysis = result("seed");
    labelled(analysis, "exchange");
    expect(pathIds([seedLeg, beyond], analysis, "backward")).toEqual(["seed"]);
  });

  test("continues past a labelled entity when the run traced through entities", () => {
    const seedLeg = edge("seed", "exchange", "seed", 8, 2, { seedId: "s1" });
    const beyond = edge("beyond", "older", "exchange", 99, 1);
    const analysis = result("seed");
    labelled(analysis, "exchange");
    expect(
      pathIds([seedLeg, beyond], analysis, "backward", { maxDepth: 6, traceThroughEntities: true }),
    ).toEqual(["beyond", "seed"]);
  });

  test("a labelled seed address does not end the path before it starts", () => {
    const first = edge("first", "seed", "middle", 2, 1, {
      seedId: "s1",
      near: "seed",
      far: "middle",
    });
    const second = edge("second", "middle", "origin", 4, 2, { near: "middle", far: "origin" });
    const analysis = result("elsewhere");
    labelled(analysis, "seed", true);
    expect(pathIds([first, second], analysis, "forward")).toEqual(["first", "second"]);
  });

  test("walks chains longer than twelve edges up to the run's depth", () => {
    const chain: TraceEdge[] = [];
    for (let index = 0; index < 15; index++) {
      chain.push(
        edge(`e${index}`, `n${index + 1}`, `n${index}`, 1, index, {
          depth: index,
          ...(index === 0 ? { seedId: "s1" } : {}),
        }),
      );
    }
    const ids = pathIds(chain, null, "backward", { maxDepth: 20, traceThroughEntities: false });
    expect(ids).toHaveLength(15);
    expect(ids[0]).toBe("e14");
    expect(ids.at(-1)).toBe("e0");
  });

  test("selects the seed with the greatest total path value", () => {
    const first = edge("first", "x", "seed-a", 4, 1, { seedId: "s1" });
    const second = edge("second", "y", "seed-b", 5, 2, { seedId: "s2" });
    const secondParent = edge("parent", "origin", "y", 8, 3);
    expect(pathIds([first, second, secondParent], null, "backward")).toEqual(["parent", "second"]);
  });

  test("walks outgoing transfers from the seed for forward traces", () => {
    const first = edge("first", "seed", "middle", 2, 1, {
      seedId: "s1",
      near: "seed",
      far: "middle",
    });
    const second = edge("second", "middle", "origin", 4, 2, { near: "middle", far: "origin" });
    const other = edge("other", "seed", "alternate", 1, 3, { near: "seed", far: "alternate" });
    expect(pathIds([first, second, other], null, "forward")).toEqual(["first", "second"]);
  });
});
