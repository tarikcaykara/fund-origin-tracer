import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import { type GraphModel, groupId } from "./graph-model.ts";

export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 76;

const elk = new ELK();
const LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.spacing.nodeNodeBetweenLayers": "96",
  "elk.spacing.nodeNode": "32",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
};

export async function layoutGraph(
  model: GraphModel,
): Promise<Map<string, { x: number; y: number }>> {
  const graph: ElkNode = {
    id: "root",
    layoutOptions: LAYOUT_OPTIONS,
    children: model.nodes.map((node) => ({
      id: node.address,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: model.groups.map((group) => ({
      id: groupId(group.from, group.to),
      sources: [group.from],
      targets: [group.to],
    })),
  };
  const layout = await elk.layout(graph);
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of layout.children ?? []) {
    if (node.x !== undefined && node.y !== undefined) {
      positions.set(node.id, { x: node.x, y: node.y });
    }
  }
  return positions;
}
