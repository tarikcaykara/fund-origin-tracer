import type { AnalysisResult, ChainId, LabelCategory, TraceEdge } from "@fot/core/schema";
import {
  Background,
  Controls,
  type Edge,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Selection } from "@/selection.ts";
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH } from "../../graph-layout.ts";
import {
  buildGraphModel,
  type GraphModel,
  groupId,
  groupLabel,
  type TransferGroupData,
} from "../../graph-model.ts";
import { type AddressFlowNode, AddressNodeView } from "./graph-node.tsx";

const NODE_TYPES = { address: AddressNodeView };
const LAYOUT_THROTTLE_MS = 500;

export function GraphTab(props: {
  chain: ChainId;
  edges: TraceEdge[];
  result: AnalysisResult | null;
  live: boolean;
  selection: Selection | null;
  onSelectEdge: (edgeId: string) => void;
  onSelectAddress: (address: string) => void;
  onSelectPair: (from: string, to: string) => void;
}) {
  const model = useMemo(
    () => buildGraphModel(props.edges, props.result),
    [props.edges, props.result],
  );
  return (
    <ReactFlowProvider>
      <GraphCanvas
        chain={props.chain}
        live={props.live}
        selection={props.selection}
        result={props.result}
        model={model}
        onSelectEdge={props.onSelectEdge}
        onSelectAddress={props.onSelectAddress}
        onSelectPair={props.onSelectPair}
      />
    </ReactFlowProvider>
  );
}

function GraphCanvas({
  chain,
  live,
  selection,
  result,
  model,
  onSelectEdge,
  onSelectAddress,
  onSelectPair,
}: {
  chain: ChainId;
  result: AnalysisResult | null;
  live: boolean;
  selection: Selection | null;
  model: GraphModel;
  onSelectEdge: (edgeId: string) => void;
  onSelectAddress: (address: string) => void;
  onSelectPair: (from: string, to: string) => void;
}) {
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(
    () => new Map(),
  );
  const [canvasElement, setCanvasElement] = useState<HTMLDivElement | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const modelRef = useRef(model);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);
  const userMovedRef = useRef(false);
  const positionsRef = useRef(positions);
  const { fitView } = useReactFlow();

  useEffect(() => {
    modelRef.current = model;
    const run = () => {
      pendingRef.current = null;
      const id = ++seqRef.current;
      layoutGraph(modelRef.current).then(
        (nextPositions) => {
          if (id !== seqRef.current) return;
          setPositions(nextPositions);
          setLayoutError(null);
        },
        (error: unknown) => {
          if (id !== seqRef.current) return;
          setLayoutError(error instanceof Error ? error.message : String(error));
        },
      );
    };

    if (!live) {
      clearTimeout(pendingRef.current ?? undefined);
      pendingRef.current = null;
      run();
    } else if (pendingRef.current === null) {
      pendingRef.current = setTimeout(run, LAYOUT_THROTTLE_MS);
    }
  }, [model, live]);

  // Reset the timer slot too: StrictMode remounts would otherwise never schedule a live layout.
  useEffect(
    () => () => {
      clearTimeout(pendingRef.current ?? undefined);
      pendingRef.current = null;
      seqRef.current++;
    },
    [],
  );

  useEffect(() => {
    positionsRef.current = positions;
    if (userMovedRef.current || positions.size === 0) return;
    requestAnimationFrame(() => void fitView({ padding: 0.15, duration: 200 }));
  }, [positions, fitView]);
  useEffect(() => {
    if (!canvasElement) return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (userMovedRef.current || positionsRef.current.size === 0) return;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        if (userMovedRef.current || positionsRef.current.size === 0) return;
        void fitView({ padding: 0.15, duration: 200 });
      });
    });
    observer.observe(canvasElement);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [canvasElement, fitView]);

  const nodes: AddressFlowNode[] = [];
  for (const node of model.nodes) {
    const position = positions.get(node.address);
    if (!position) continue;
    nodes.push({
      id: node.address,
      type: "address",
      position,
      data: { ...node, chain },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      draggable: false,
      selected: selection?.kind === "address" && selection.address === node.address,
    });
  }

  const edges: Edge<{ group: TransferGroupData }>[] = [];
  for (const group of model.groups) {
    if (!positions.has(group.from) || !positions.has(group.to)) continue;
    const selected =
      (selection?.kind === "edge" && group.edgeIds.includes(selection.edgeId)) ||
      (selection?.kind === "pair" && selection.from === group.from && selection.to === group.to);
    edges.push({
      id: groupId(group.from, group.to),
      source: group.from,
      target: group.to,
      type: "smoothstep",
      label: groupLabel(group),
      markerEnd: { type: MarkerType.ArrowClosed },
      animated: live && group.pending && model.nodes.length <= 400,
      selected,
      style: { strokeWidth: selected ? 2.5 : 1.5 },
      data: { group },
    });
  }

  const categories: LabelCategory[] = [];
  for (const node of model.nodes) {
    const category = node.label?.category;
    if (category && !categories.includes(category)) categories.push(category);
  }

  return (
    <div className="space-y-3">
      {layoutError ? (
        <p className="text-sm text-destructive">Graph layout failed: {layoutError}</p>
      ) : null}
      {model.nodes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {live ? "Waiting for the first transfers…" : "No transfers in this run."}
        </p>
      ) : (
        <div ref={setCanvasElement} className="h-[70vh] min-h-[420px] rounded-md border">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            colorMode="dark"
            nodesDraggable={false}
            nodesConnectable={false}
            onlyRenderVisibleElements={model.nodes.length > 400}
            minZoom={0.05}
            onNodeClick={(_, node) => onSelectAddress(node.id)}
            onEdgeClick={(_, edge) => {
              const group = edge.data?.group;
              if (!group) return;
              const only = group.edgeIds.length === 1 ? group.edgeIds[0] : undefined;
              if (only !== undefined) onSelectEdge(only);
              else onSelectPair(group.from, group.to);
            }}
            onMove={(event) => {
              if (event) userMovedRef.current = true;
            }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}
      {result === null ? (
        <p className="text-xs text-muted-foreground">Labels appear when the run finishes.</p>
      ) : (
        <div className="flex flex-wrap gap-3 text-xs">
          {categories.map((category) => (
            <span key={category} className="inline-flex items-center gap-2">
              <span
                className="size-2.5 rounded-full"
                style={{ background: `var(--category-${category})` }}
              />
              {category}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
