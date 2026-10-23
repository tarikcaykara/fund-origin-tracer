import type {
  AddressNode,
  AnalysisResult,
  Direction,
  Label,
  StopReason,
  TraceEdge,
} from "@fot/core/schema";
import { assetId } from "@fot/core/schema";
import { assetSymbol, formatAmount } from "./format.ts";

export type AddressNodeData = {
  address: string;
  label: Label | null;
  sanctioned: boolean;
  commonSource: boolean;
  seed: boolean;
  hop: number;
  stopReason: StopReason | null;
  queued: boolean;
  failed: boolean;
};

export type TransferGroupData = {
  from: string;
  to: string;
  edgeIds: string[];
  totals: { assetId: string; symbol: string; amount: number }[];
  usd: number | null;
  pending: boolean;
  stopped: boolean;
};

export type GraphModel = {
  nodes: AddressNodeData[];
  groups: TransferGroupData[];
  maxHop: number;
  direction: Direction;
};

export function groupId(from: string, to: string): string {
  return `${from}->${to}`;
}

export function buildGraphModel(
  edges: readonly TraceEdge[],
  result: Pick<AnalysisResult, "graph" | "convergences"> | null,
  direction: Direction = "backward",
): GraphModel {
  const addresses = new Map<string, AddressNodeData>();
  const groups = new Map<string, TransferGroupData>();
  const resultAddresses = new Map<string, AddressNode>();
  const commonSources = new Set(
    (result?.convergences ?? [])
      .filter((entry) => entry.role === "common_source")
      .map((entry) => entry.address),
  );
  for (const node of result?.graph.addresses ?? []) {
    resultAddresses.set(node.address, node);
    addresses.set(node.address, {
      address: node.address,
      label: node.labels[0] ?? null,
      sanctioned: node.sanctioned,
      commonSource: commonSources.has(node.address),
      seed: node.isSeedSubject,
      hop: node.isSeedSubject ? 0 : Number.POSITIVE_INFINITY,
      stopReason: null,
      queued: false,
      failed: false,
    });
  }

  const addAddress = (address: string, hop: number): AddressNodeData => {
    let node = addresses.get(address);
    if (!node) {
      const metadata = resultAddresses.get(address);
      node = {
        address,
        label: metadata?.labels[0] ?? null,
        sanctioned: metadata?.sanctioned ?? false,
        commonSource: commonSources.has(address),
        seed: metadata?.isSeedSubject ?? false,
        hop: metadata?.isSeedSubject ? 0 : hop,
        stopReason: null,
        queued: false,
        failed: false,
      };
      addresses.set(address, node);
    }
    if (node.seed) node.hop = 0;
    else node.hop = Math.min(node.hop, hop);
    return node;
  };

  for (const edge of edges) {
    const near = addAddress(edge.near, edge.depth);
    const far = addAddress(edge.far, edge.depth + 1);
    if (edge.seedId !== null) near.seed = true;
    if (edge.status === "stopped") far.stopReason ??= edge.stopReason;
    if (edge.status === "pending") far.queued = true;
    if (edge.stopReason === "fetch_failed") far.failed = true;

    const fromNode = addAddress(edge.from, edge.depth + (edge.from === edge.far ? 1 : 0));
    const toNode = addAddress(edge.to, edge.depth + (edge.to === edge.far ? 1 : 0));
    if (edge.seedId !== null) {
      if (edge.near === edge.from) fromNode.seed = true;
      if (edge.near === edge.to) toNode.seed = true;
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
        stopped: false,
      };
      groups.set(id, group);
    }
    group.edgeIds.push(edge.id);
    group.pending ||= edge.status === "pending";
    group.stopped ||= edge.status === "stopped";
    if (edge.usd !== null) group.usd = (group.usd ?? 0) + edge.usd;

    const idForAsset = assetId(edge.transfer.asset);
    let total = group.totals.find((entry) => entry.assetId === idForAsset);
    if (!total) {
      total = { assetId: idForAsset, symbol: assetSymbol(edge.transfer.asset), amount: 0 };
      group.totals.push(total);
    }
    total.amount += edge.transfer.amount;
  }

  const nodes = [...addresses.values()];
  for (const node of nodes) if (!Number.isFinite(node.hop)) node.hop = 0;
  return {
    nodes,
    groups: [...groups.values()],
    maxHop: nodes.reduce((max, node) => Math.max(max, node.hop), 0),
    direction,
  };
}

export function groupLabel(group: TransferGroupData): string {
  if (group.totals.length >= 2) return `${group.edgeIds.length}× · ${group.totals.length} assets`;
  const total = group.totals[0];
  if (!total) return `${group.edgeIds.length}× · 0 assets`;
  const label = `${formatAmount(total.amount)} ${total.symbol}`;
  return group.edgeIds.length >= 2 ? `${group.edgeIds.length}× · ${label}` : label;
}

export function edgeStrokeWidth(usd: number | null, selected = false): number {
  const width =
    usd === null
      ? 1
      : usd < 1_000
        ? 1
        : usd < 10_000
          ? 1.5
          : usd < 100_000
            ? 2
            : usd < 1_000_000
              ? 3
              : 4;
  return selected ? Math.max(3, width + 1) : width;
}

export function selectVisibleEdgeLabels(
  groups: readonly TransferGroupData[],
  highlightedIds: ReadonlySet<string>,
  limit = 5,
): TransferGroupData[] {
  return groups
    .filter((group) => highlightedIds.has(groupId(group.from, group.to)))
    .sort(
      (a, b) =>
        (b.usd ?? 0) - (a.usd ?? 0) || groupId(a.from, a.to).localeCompare(groupId(b.from, b.to)),
    )
    .slice(0, limit);
}
