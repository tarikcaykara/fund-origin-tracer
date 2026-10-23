import { describe, expect, test } from "bun:test";
import type {
  AddressNode,
  AnalysisResult,
  Asset,
  Label,
  TraceEdge,
  Transfer,
} from "@fot/core/schema";
import { layoutGraph } from "../src/graph-layout.ts";
import {
  buildGraphModel,
  edgeStrokeWidth,
  groupId,
  groupLabel,
  selectVisibleEdgeLabels,
} from "../src/graph-model.ts";

const native: Asset = { chain: "ethereum", kind: "native" };
const token: Asset = {
  chain: "ethereum",
  kind: "token",
  contract: "0x0000000000000000000000000000000000000001",
  symbol: "TOK",
  name: "Token",
  decimals: 18,
  decimalsGuessed: false,
};

function transfer(from: string, to: string, asset: Transfer["asset"], amount: number): Transfer {
  return {
    chain: "ethereum",
    txHash: `tx-${from}-${to}`,
    blockNumber: 1,
    timestamp: 1,
    from,
    to,
    asset,
    amountRaw: "1",
    amount,
  };
}

function edge(id: string, overrides: Partial<TraceEdge> = {}): TraceEdge {
  const from = "A";
  const to = "B";
  return {
    id,
    depth: 0,
    from,
    to,
    far: from,
    near: to,
    transfer: transfer(from, to, native, 1),
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

function addressNode(address: string, labels: Label[] = [], sanctioned = false): AddressNode {
  return {
    address,
    labels,
    sanctioned,
    isSeedSubject: false,
    seedIds: [],
    inEdgeIds: [],
    outEdgeIds: [],
  };
}

const mixerLabel: Label = {
  name: "Mixer",
  category: "mixer",
  source: "test",
  origin: "local",
};

describe("buildGraphModel", () => {
  test("groups transfers by address pair and aggregates per-asset totals", () => {
    const first = edge("e1", {
      from: "A",
      to: "B",
      transfer: transfer("A", "B", native, 1),
      usd: 100,
    });
    const second = edge("e2", {
      from: "A",
      to: "B",
      transfer: transfer("A", "B", token, 5),
      usd: null,
    });
    const third = edge("e3", {
      from: "B",
      to: "C",
      transfer: transfer("B", "C", native, 1),
      usd: null,
    });
    const model = buildGraphModel([first, second, third], null);
    const ab = model.groups.find((group) => group.from === "A" && group.to === "B");
    const bc = model.groups.find((group) => group.from === "B" && group.to === "C");

    expect(model.groups).toHaveLength(2);
    expect(ab?.edgeIds).toHaveLength(2);
    expect(ab?.totals).toHaveLength(2);
    expect(ab?.usd).toBe(100);
    expect(ab ? groupLabel(ab) : null).toBe("2× · 2 assets");
    expect(bc?.usd).toBeNull();
    expect(bc ? groupLabel(bc) : null).toBe("1 ETH");
  });

  test("marks seed, stop, and queued node states", () => {
    const seeded = edge("seed", {
      from: "B",
      to: "A",
      near: "A",
      far: "B",
      transfer: transfer("B", "A", native, 1),
      seedId: "s1",
    });
    const stopped = edge("stopped", {
      from: "B",
      to: "C",
      far: "C",
      near: "B",
      status: "stopped",
      stopReason: "max_depth",
      depth: 1,
    });
    const model = buildGraphModel([seeded, stopped], null);
    const nodeA = model.nodes.find((node) => node.address === "A");
    const nodeB = model.nodes.find((node) => node.address === "B");
    const nodeC = model.nodes.find((node) => node.address === "C");

    expect(nodeA).toEqual({
      address: "A",
      label: null,
      sanctioned: false,
      commonSource: false,
      seed: true,
      hop: 0,
      stopReason: null,
      queued: false,
      failed: false,
    });
    expect(nodeB?.hop).toBe(1);
    expect(nodeB?.queued).toBe(true);
    expect(nodeC?.hop).toBe(2);
    expect(nodeC?.stopReason).toBe("max_depth");
  });

  test("uses address labels, sanctioned state, and common-source metadata", () => {
    const edgeAB = edge("e1", { from: "A", to: "B" });
    const edgeBC = edge("e2", { from: "B", to: "C" });
    const result: Pick<AnalysisResult, "graph" | "convergences"> = {
      graph: {
        addresses: [addressNode("B", [mixerLabel], true)],
        edges: [edgeAB, edgeBC],
      },
      convergences: [
        {
          address: "C",
          role: "common_source",
          kinds: ["shared_across_seeds"],
          seedIds: ["s1", "s2"],
          edgeIds: ["e1", "e2"],
          counterparties: ["A", "B"],
          totals: [],
          usd: null,
          minDepth: 0,
          otherCounterparties: [],
        },
      ],
    };
    const model = buildGraphModel([edgeAB, edgeBC], result);
    const nodeB = model.nodes.find((node) => node.address === "B");
    const nodeC = model.nodes.find((node) => node.address === "C");

    expect(nodeB?.label).toEqual(mixerLabel);
    expect(nodeB?.sanctioned).toBe(true);
    expect(nodeC?.commonSource).toBe(true);
  });
  test("assigns hop columns and places the seed on the direction-appropriate side", () => {
    const backwardEdges = [
      edge("seed", { from: "B", to: "A", near: "A", far: "B", depth: 0, seedId: "s1" }),
      edge("outer", { from: "C", to: "B", near: "B", far: "C", depth: 1 }),
    ];
    const backward = buildGraphModel(backwardEdges, null, "backward");
    const backwardLayout = layoutGraph(backward, {
      width: 600,
      height: 400,
      direction: "backward",
      density: "chips",
    });
    expect(backward.nodes.find((node) => node.address === "A")?.hop).toBe(0);
    expect(backwardLayout.positions.get("A")?.x).toBeGreaterThan(
      backwardLayout.positions.get("C")?.x ?? 0,
    );

    const forwardEdges = [
      edge("forward", { from: "A", to: "B", near: "A", far: "B", depth: 0, seedId: "s1" }),
    ];
    const forward = buildGraphModel(forwardEdges, null, "forward");
    const forwardLayout = layoutGraph(forward, {
      width: 600,
      height: 400,
      direction: "forward",
      density: "chips",
    });
    expect(forwardLayout.positions.get("A")?.x).toBeLessThan(
      forwardLayout.positions.get("B")?.x ?? 0,
    );
  });

  test("uses USD buckets for edge thickness including unpriced edges", () => {
    expect(
      [null, 999, 1_000, 10_000, 100_000, 1_000_000].map((value) => edgeStrokeWidth(value)),
    ).toEqual([1, 1, 1.5, 2, 3, 4]);
    expect(edgeStrokeWidth(1_000, true)).toBe(3);
    expect(edgeStrokeWidth(1_000_000, true)).toBe(5);
  });

  test("limits edge labels to the five highest-value highlighted pairs", () => {
    const edges = Array.from({ length: 6 }, (_, index) =>
      edge(`e${index}`, {
        from: `from-${index}`,
        to: `to-${index}`,
        usd: index * 10,
      }),
    );
    const groups = buildGraphModel(edges, null).groups;
    const ids = new Set(groups.map((group) => groupId(group.from, group.to)));
    expect(selectVisibleEdgeLabels(groups, ids).map((group) => group.usd)).toEqual([
      50, 40, 30, 20, 10,
    ]);
  });
});
