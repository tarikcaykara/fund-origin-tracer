import { describe, expect, test } from "bun:test";
import type {
  AddressNode,
  AnalysisResult,
  Asset,
  Label,
  TraceEdge,
  Transfer,
} from "@fot/core/schema";
import { buildGraphModel, groupLabel } from "../src/graph-model.ts";

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

  test("marks seed and stopped nodes without result metadata", () => {
    const seeded = edge("seed", { near: "A", seedId: "s1" });
    const stopped = edge("stopped", {
      from: "B",
      to: "C",
      far: "C",
      status: "stopped",
      stopReason: "max_depth",
    });
    const model = buildGraphModel([seeded, stopped], null);
    const nodeA = model.nodes.find((node) => node.address === "A");
    const nodeC = model.nodes.find((node) => node.address === "C");

    expect(nodeA).toEqual({
      address: "A",
      label: null,
      sanctioned: false,
      mixer: false,
      convergence: false,
      seed: true,
      stopReason: null,
    });
    expect(nodeC?.stopReason).toBe("max_depth");
  });

  test("uses address labels, sanctioned state, and convergence metadata", () => {
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
    expect(nodeB?.mixer).toBe(true);
    expect(nodeB?.sanctioned).toBe(true);
    expect(nodeC?.convergence).toBe(true);
  });
});
