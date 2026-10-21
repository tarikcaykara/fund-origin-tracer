import type { AddressNode, AnalysisResult, Label, StopReason, TraceEdge } from "@fot/core/schema";
import { assetId } from "@fot/core/schema";
import { assetSymbol, formatAmount } from "./format.ts";

export type AddressNodeData = {
  address: string;
  label: Label | null;
  sanctioned: boolean;
  mixer: boolean;
  convergence: boolean;
  seed: boolean;
  stopReason: StopReason | null;
};

export type TransferGroupData = {
  from: string;
  to: string;
  edgeIds: string[];
  totals: { assetId: string; symbol: string; amount: number }[];
  usd: number | null;
  pending: boolean;
};

export type GraphModel = { nodes: AddressNodeData[]; groups: TransferGroupData[] };

export function groupId(from: string, to: string): string {
  return `${from}->${to}`;
}

export function buildGraphModel(
  edges: readonly TraceEdge[],
  result: Pick<AnalysisResult, "graph" | "convergences"> | null,
): GraphModel {
  const addresses = new Map<string, AddressNodeData>();
  const groups = new Map<string, TransferGroupData>();
  const resultAddresses = new Map<string, AddressNode>();
  const convergences = new Set((result?.convergences ?? []).map((entry) => entry.address));
  const stoppedAddresses = new Set<string>();
  for (const node of result?.graph.addresses ?? []) resultAddresses.set(node.address, node);

  const addAddress = (address: string) => {
    if (addresses.has(address)) return;
    const node = resultAddresses.get(address);
    addresses.set(address, {
      address,
      label: node?.labels[0] ?? null,
      sanctioned: node?.sanctioned ?? false,
      mixer: node?.labels.some((label) => label.category === "mixer") ?? false,
      convergence: convergences.has(address),
      seed: false,
      stopReason: null,
    });
  };

  for (const edge of edges) {
    addAddress(edge.from);
    addAddress(edge.to);

    if (edge.seedId !== null) {
      const seedNode = addresses.get(edge.near);
      if (seedNode) seedNode.seed = true;
    }

    if (edge.status === "stopped" && !stoppedAddresses.has(edge.far)) {
      const stoppedNode = addresses.get(edge.far);
      if (stoppedNode) stoppedNode.stopReason = edge.stopReason;
      stoppedAddresses.add(edge.far);
    }

    const id = groupId(edge.from, edge.to);
    let group = groups.get(id);
    if (!group) {
      group = {
        from: edge.from,
        to: edge.to,
        edgeIds: [],
        totals: [],
        usd: null,
        pending: false,
      };
      groups.set(id, group);
    }

    group.edgeIds.push(edge.id);
    group.pending ||= edge.status === "pending";
    if (edge.usd !== null) group.usd = (group.usd ?? 0) + edge.usd;

    const idForAsset = assetId(edge.transfer.asset);
    let total = group.totals.find((entry) => entry.assetId === idForAsset);
    if (!total) {
      total = { assetId: idForAsset, symbol: assetSymbol(edge.transfer.asset), amount: 0 };
      group.totals.push(total);
    }
    total.amount += edge.transfer.amount;
  }

  return { nodes: [...addresses.values()], groups: [...groups.values()] };
}

export function groupLabel(group: TransferGroupData): string {
  if (group.totals.length >= 2) return `${group.edgeIds.length}× · ${group.totals.length} assets`;
  const total = group.totals[0];
  if (!total) return `${group.edgeIds.length}× · 0 assets`;
  const label = `${formatAmount(total.amount)} ${total.symbol}`;
  return group.edgeIds.length >= 2 ? `${group.edgeIds.length}× · ${label}` : label;
}
