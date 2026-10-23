import type { Direction } from "@fot/core/schema";
import type { AddressNodeData, GraphModel } from "./graph-model.ts";

const NODE_WIDTH = 132;
const NODE_HEIGHT = 20;
const DOT_SIZE = 12;

export type GraphLayoutOptions = {
  width: number;
  height: number;
  direction: Direction;
  density: "chips" | "dots";
};

export type GraphColumn = {
  hop: number;
  index: number;
  x: number;
  count: number;
  queued: number;
  failed: number;
};

export type GraphLayout = {
  positions: Map<string, { x: number; y: number }>;
  columns: GraphColumn[];
  nodeWidth: number;
  nodeHeight: number;
};

export function layoutGraph(model: GraphModel, options: GraphLayoutOptions): GraphLayout {
  const { width, height, direction, density } = options;
  const nodeWidth =
    density === "dots"
      ? DOT_SIZE
      : Math.max(112, Math.min(NODE_WIDTH, Math.round(((width - 28) / (model.maxHop + 1)) * 0.9)));
  const nodeHeight = density === "dots" ? DOT_SIZE : NODE_HEIGHT;
  const columnCount = model.maxHop + 1;
  const nodeColumns = Array.from({ length: columnCount }, () => [] as AddressNodeData[]);
  for (const node of model.nodes) {
    const index = direction === "backward" ? model.maxHop - node.hop : node.hop;
    const boundedIndex = Math.max(0, Math.min(model.maxHop, index));
    nodeColumns[boundedIndex]?.push(node);
  }

  const neighbours = new Map<string, Set<string>>();
  for (const group of model.groups) {
    const from = neighbours.get(group.from) ?? new Set<string>();
    from.add(group.to);
    neighbours.set(group.from, from);
    const to = neighbours.get(group.to) ?? new Set<string>();
    to.add(group.from);
    neighbours.set(group.to, to);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const placedRows = new Map<string, number>();
  const paddingX = 14;
  const paddingY = 12;
  const availableHeight = Math.max(nodeHeight, height - paddingY * 2);
  const maxStep = nodeHeight + 16;
  const spacingX = model.maxHop === 0 ? 0 : (width - paddingX * 2 - nodeWidth) / model.maxHop;
  const columns: GraphColumn[] = [];

  for (let index = 0; index < nodeColumns.length; index++) {
    const column = nodeColumns[index] ?? [];
    column.sort((a, b) => {
      let aTotal = 0;
      let aCount = 0;
      for (const address of neighbours.get(a.address) ?? []) {
        const row = placedRows.get(address);
        if (row !== undefined) {
          aTotal += row;
          aCount++;
        }
      }
      let bTotal = 0;
      let bCount = 0;
      for (const address of neighbours.get(b.address) ?? []) {
        const row = placedRows.get(address);
        if (row !== undefined) {
          bTotal += row;
          bCount++;
        }
      }
      const aCenter = aCount > 0 ? aTotal / aCount : Number.POSITIVE_INFINITY;
      const bCenter = bCount > 0 ? bTotal / bCount : Number.POSITIVE_INFINITY;
      return aCenter - bCenter || a.address.localeCompare(b.address);
    });

    const slot = column.length === 0 ? 0 : Math.min(maxStep, availableHeight / column.length);
    const totalHeight = slot * column.length;
    const startY = Math.max(paddingY, (height - totalHeight) / 2);
    const x = model.maxHop === 0 ? (width - nodeWidth) / 2 : paddingX + index * spacingX;
    let queued = 0;
    let failed = 0;
    for (let row = 0; row < column.length; row++) {
      const node = column[row] as AddressNodeData;
      const y = startY + row * slot + Math.max(0, (slot - nodeHeight) / 2);
      positions.set(node.address, { x: Math.round(x), y: Math.round(y) });
      placedRows.set(node.address, y + nodeHeight / 2);
      if (node.queued) queued++;
      if (node.failed) failed++;
    }
    const hop = direction === "backward" ? model.maxHop - index : index;
    columns.push({ hop, index, x: Math.round(x), count: column.length, queued, failed });
  }

  return { positions, columns, nodeWidth, nodeHeight };
}
