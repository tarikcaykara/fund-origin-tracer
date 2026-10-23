import type { AnalysisResult, ChainId, RunParams, TraceEdge } from "@fot/core/schema";
import {
  Background,
  type Edge,
  type FitViewOptions,
  MarkerType,
  MiniMap,
  type Node,
  ReactFlow,
  useReactFlow,
  useViewport,
} from "@xyflow/react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assetSymbol, formatAmount, formatUsd, shortAddress } from "../../format.ts";
import { type GraphLayout, layoutGraph } from "../../graph-layout.ts";
import {
  type AddressNodeData,
  buildGraphModel,
  type GraphModel,
  groupId,
  selectVisibleEdgeLabels,
  type TransferGroupData,
} from "../../graph-model.ts";
import { useBreakpoint } from "../../hooks/use-breakpoint.ts";
import { CATEGORY_META, STOP_TAGS } from "../../meta.ts";
import type { RunPhase } from "../../run-state.ts";
import { type Selection, selectionKey } from "../../selection.ts";
import { useTheme } from "../../theme.tsx";
import { GraphEdgeView, type GraphFlowEdge } from "./graph-edge.tsx";
import { GraphLegend } from "./graph-legend.tsx";
import { type AddressFlowNode, AddressNodeView } from "./graph-node.tsx";
import { GraphToolbar } from "./graph-toolbar.tsx";

const NODE_TYPES = { address: AddressNodeView };
const EDGE_TYPES = { flow: GraphEdgeView };
const LAYOUT_THROTTLE_MS = 500;
const NEW_NODE_PULSE_MS = 1_400;
const NEW_NODE_BADGE_MS = 2_000;

/** Room a dot's label needs to its right: 16px offset plus up to 11 mono characters. */
const DOT_LABEL_EXTENT_PX = 96;

/**
 * Fit options for `fitView`. Node boxes exclude the labels that dots draw to their right, so in
 * dot density the right padding reserves that width and zoom is capped so it stays accurate.
 */
function fitOptions(density: "chips" | "dots" | "compact", ratio: number): FitViewOptions {
  if (density !== "dots") return { padding: ratio };
  return {
    padding: { top: ratio, bottom: ratio, left: ratio, right: `${DOT_LABEL_EXTENT_PX}px` },
    maxZoom: 1,
  };
}

/** The selection a click on an edge makes: the single transfer, or the pair when several share it. */
function groupSelection(group: TransferGroupData): Selection {
  return group.edgeIds.length === 1
    ? { kind: "edge", edgeId: group.edgeIds[0] as string }
    : { kind: "pair", from: group.from, to: group.to };
}

export function GraphCanvas({
  chain,
  edges,
  result,
  phase,
  params,
  selection,
  density: requestedDensity,
  onSelect,
}: {
  chain: ChainId;
  edges: TraceEdge[];
  result: AnalysisResult | null;
  phase: RunPhase;
  params: RunParams;
  selection: Selection | null;
  density: "chips" | "dots" | "auto";
  onSelect(sel: Selection | null): void;
}) {
  const model = useMemo(
    () => buildGraphModel(edges, result, params.direction),
    [edges, params.direction, result],
  );
  return (
    <GraphCanvasInner
      chain={chain}
      edges={edges}
      phase={phase}
      params={params}
      selection={selection}
      density={requestedDensity}
      onSelect={onSelect}
      model={model}
    />
  );
}

function GraphCanvasInner({
  chain,
  edges,
  phase,
  params,
  selection,
  density: requestedDensity,
  onSelect,
  model,
}: {
  chain: ChainId;
  edges: TraceEdge[];
  phase: RunPhase;
  params: RunParams;
  selection: Selection | null;
  density: "chips" | "dots" | "auto";
  onSelect(sel: Selection | null): void;
  model: GraphModel;
}) {
  const { resolved } = useTheme();
  const breakpoint = useBreakpoint();
  const viewport = useViewport();
  const { fitView, setViewport, zoomIn, zoomOut } = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingLayout = useRef<number | null>(null);
  const layoutInput = useRef({
    model,
    width: 0,
    height: 560,
    direction: params.direction,
    density: "chips" as "chips" | "dots" | "compact",
  });
  const userMoved = useRef(false);
  const firstSeen = useRef(new Map<string, number>());
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 560 });
  const [layout, setLayout] = useState<GraphLayout | null>(null);
  const [densityOverride, setDensityOverride] = useState<"chips" | "dots" | null>(null);
  const [focusSelection, setFocusSelection] = useState(false);
  const [hoverCandidate, setHoverCandidate] = useState<{
    address: string;
    x: number;
    y: number;
  } | null>(null);
  const [hoveredAddress, setHoveredAddress] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const hoverTimer = useRef<number | null>(null);
  const fittedFocus = useRef("");

  const defaultDensity =
    requestedDensity === "auto"
      ? breakpoint === "tablet" || breakpoint === "phone"
        ? "dots"
        : !userMoved.current
          ? model.nodes.length > 150
            ? "dots"
            : "chips"
          : viewport.zoom >= 0.75
            ? "chips"
            : viewport.zoom < 0.4
              ? "dots"
              : "compact"
      : requestedDensity;
  const density = densityOverride ?? defaultDensity;
  const live = phase === "running" || phase === "paused" || phase === "connecting";
  const running = phase === "running";
  const graphHeight =
    breakpoint === "desktop"
      ? 620
      : breakpoint === "phone"
        ? Math.max(420, Math.min(720, window.innerHeight - 220))
        : 560;
  const focusKey = selectionKey(selection);

  useEffect(() => {
    if (!containerRef.current) return;
    const element = containerRef.current;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setCanvasSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const setHover = useCallback(
    (address: string, x: number, y: number) => {
      if (
        breakpoint !== "desktop" ||
        !window.matchMedia("(hover: hover) and (pointer: fine)").matches
      )
        return;
      setHoverCandidate({ address, x, y });
    },
    [breakpoint],
  );
  const clearHover = useCallback(() => {
    setHoverCandidate(null);
    setHoveredAddress(null);
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
  }, []);

  useEffect(() => {
    if (!hoverCandidate || breakpoint !== "desktop") {
      setHoveredAddress(null);
      return;
    }
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHoveredAddress(hoverCandidate.address), 300);
    return () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    };
  }, [hoverCandidate, breakpoint]);

  useEffect(() => {
    if (phase === "running") {
      const timestamp = Date.now();
      for (const node of model.nodes)
        if (!firstSeen.current.has(node.address)) firstSeen.current.set(node.address, timestamp);
    }
    setNow(Date.now());
  }, [model.nodes, phase]);

  // Tick only while a node is still inside its "new" window, then stop rebuilding the nodes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `model.nodes` re-arms the ticker when new nodes arrive.
  useEffect(() => {
    if (!running) return;
    const hasNewNodes = () => {
      const current = Date.now();
      for (const timestamp of firstSeen.current.values())
        if (current - timestamp < NEW_NODE_BADGE_MS) return true;
      return false;
    };
    if (!hasNewNodes()) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (!hasNewNodes()) window.clearInterval(timer);
    }, 200);
    return () => window.clearInterval(timer);
  }, [running, model.nodes]);

  useEffect(() => {
    layoutInput.current = {
      model,
      width: canvasSize.width,
      height: canvasSize.height,
      direction: params.direction,
      density,
    };
    if (canvasSize.width === 0) return;
    const run = () => {
      pendingLayout.current = null;
      setLayout(
        layoutGraph(layoutInput.current.model, {
          width: layoutInput.current.width,
          height: layoutInput.current.height,
          direction: layoutInput.current.direction,
          density:
            layoutInput.current.density === "compact" ? "chips" : layoutInput.current.density,
        }),
      );
    };
    if (live) {
      if (pendingLayout.current === null)
        pendingLayout.current = window.setTimeout(run, LAYOUT_THROTTLE_MS);
    } else {
      if (pendingLayout.current !== null) window.clearTimeout(pendingLayout.current);
      run();
    }
  }, [canvasSize, density, live, model, params.direction]);

  useEffect(
    () => () => {
      if (pendingLayout.current !== null) window.clearTimeout(pendingLayout.current);
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (userMoved.current || !layout || layout.positions.size === 0) return;
    const frame = requestAnimationFrame(
      () => void fitView({ ...fitOptions(density, 0.12), duration: 180 }),
    );
    return () => cancelAnimationFrame(frame);
  }, [density, fitView, layout]);

  const edgeById = useMemo(() => new Map(edges.map((edge) => [edge.id, edge])), [edges]);
  const highlightedEdgeIds = useMemo(() => {
    const ids = new Set<string>();
    if (selection?.kind === "edge") {
      const pending = [selection.edgeId];
      while (pending.length > 0) {
        const id = pending.pop();
        if (id === undefined || ids.has(id)) continue;
        ids.add(id);
        const edge = edgeById.get(id);
        if (!edge || edge.seedId !== null) continue;
        pending.push(...edge.parents);
      }
    } else if (selection?.kind === "address") {
      for (const edge of edges)
        if (edge.from === selection.address || edge.to === selection.address) ids.add(edge.id);
    } else if (selection?.kind === "pair") {
      for (const edge of edges) {
        if (
          (edge.from === selection.from && edge.to === selection.to) ||
          (edge.from === selection.to && edge.to === selection.from)
        )
          ids.add(edge.id);
      }
    } else if (selection?.kind === "set") {
      for (const id of selection.edgeIds) ids.add(id);
      const addresses = new Set(selection.addresses);
      for (const edge of edges)
        if (addresses.has(edge.from) || addresses.has(edge.to)) ids.add(edge.id);
    }
    return ids;
  }, [edgeById, edges, selection]);

  const highlightedPairIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of model.groups)
      if (group.edgeIds.some((id) => highlightedEdgeIds.has(id)))
        ids.add(groupId(group.from, group.to));
    return ids;
  }, [highlightedEdgeIds, model.groups]);
  const visibleLabelIds = useMemo(
    () =>
      new Set(
        selectVisibleEdgeLabels(model.groups, highlightedPairIds).map((group) =>
          groupId(group.from, group.to),
        ),
      ),
    [highlightedPairIds, model.groups],
  );

  const baseFocusNodes = useMemo(() => {
    const focused = new Set<string>();
    if (selection?.kind === "address") focused.add(selection.address);
    if (selection?.kind === "pair") {
      focused.add(selection.from);
      focused.add(selection.to);
    }
    if (selection?.kind === "set") for (const address of selection.addresses) focused.add(address);
    for (const id of highlightedEdgeIds) {
      const edge = edgeById.get(id);
      if (edge) {
        focused.add(edge.from);
        focused.add(edge.to);
      }
    }
    const expanded = new Set(focused);
    for (const group of model.groups) {
      if (focused.has(group.from)) expanded.add(group.to);
      if (focused.has(group.to)) expanded.add(group.from);
    }
    return expanded;
  }, [edgeById, highlightedEdgeIds, model.groups, selection]);

  const focusEdges = useMemo(
    () =>
      new Set(
        model.groups
          .filter((group) => baseFocusNodes.has(group.from) && baseFocusNodes.has(group.to))
          .map((group) => groupId(group.from, group.to)),
      ),
    [baseFocusNodes, model.groups],
  );
  const effectiveFocus = focusSelection && selection !== null;
  const handleDensityChange = useCallback((value: "chips" | "dots") => {
    userMoved.current = true;
    setDensityOverride(value);
  }, []);
  const fitAll = useCallback(() => {
    userMoved.current = false;
    setFocusSelection(false);
    void fitView({ ...fitOptions(density, 0.12), duration: 200 });
  }, [density, fitView]);
  const focusSelected = useCallback(() => {
    setFocusSelection((current) => !current);
    userMoved.current = true;
  }, []);
  const zoomTo100 = useCallback(() => {
    userMoved.current = true;
    setViewport(
      {
        x: canvasSize.width / 2 + (viewport.x - canvasSize.width / 2) / viewport.zoom,
        y: canvasSize.height / 2 + (viewport.y - canvasSize.height / 2) / viewport.zoom,
        zoom: 1,
      },
      { duration: 180 },
    );
  }, [canvasSize.height, canvasSize.width, setViewport, viewport.x, viewport.y, viewport.zoom]);

  useEffect(() => {
    if (!effectiveFocus || !layout) {
      fittedFocus.current = "";
      return;
    }
    const key = `${focusKey}:${layout.positions.size}`;
    if (fittedFocus.current === key) return;
    fittedFocus.current = key;
    requestAnimationFrame(() => {
      const nodes = [...baseFocusNodes]
        .filter((address) => layout.positions.has(address))
        .map((id) => ({ id }));
      if (nodes.length > 0) void fitView({ nodes, ...fitOptions(density, 0.2), duration: 220 });
    });
  }, [baseFocusNodes, effectiveFocus, density, fitView, layout, focusKey]);

  let firstSeenCount = 0;
  for (const timestamp of firstSeen.current.values())
    if (now - timestamp < NEW_NODE_BADGE_MS) firstSeenCount++;
  const pathNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const edgeId of highlightedEdgeIds) {
      const edge = edgeById.get(edgeId);
      if (edge) {
        ids.add(edge.from);
        ids.add(edge.to);
      }
    }
    return ids;
  }, [edgeById, highlightedEdgeIds]);
  const endpoints = useMemo(() => {
    const ids = new Set<string>();
    if (selection?.kind === "address") ids.add(selection.address);
    if (selection?.kind === "pair") {
      ids.add(selection.from);
      ids.add(selection.to);
    }
    if (selection?.kind === "set") for (const address of selection.addresses) ids.add(address);
    if (selection?.kind === "edge") {
      const edge = edgeById.get(selection.edgeId);
      if (edge) {
        ids.add(edge.from);
        ids.add(edge.to);
      }
    }
    return ids;
  }, [edgeById, selection]);

  const flowNodes = useMemo((): AddressFlowNode[] => {
    if (!layout) return [];
    const nodes: AddressFlowNode[] = [];
    for (const node of model.nodes) {
      const position = layout.positions.get(node.address);
      if (!position) continue;
      const first = firstSeen.current.get(node.address);
      const nodeData: AddressFlowNode["data"] = {
        ...node,
        chain,
        phase,
        density,
        nodeWidth: layout.nodeWidth,
        nodeHeight: layout.nodeHeight,
        onPath: pathNodeIds.has(node.address),
        endpoint: endpoints.has(node.address),
        dimmed: effectiveFocus && !baseFocusNodes.has(node.address),
        isNew: running && first !== undefined && now - first < NEW_NODE_PULSE_MS,
        onHover: setHover,
        onLeave: clearHover,
      };
      nodes.push({
        id: node.address,
        type: "address",
        position,
        data: nodeData,
        width: layout.nodeWidth,
        height: layout.nodeHeight,
        draggable: false,
        selectable: true,
        ariaLabel: `Address ${node.label?.name ?? shortAddress(chain, node.address)}`,
        selected: selection?.kind === "address" && selection.address === node.address,
      });
    }
    return nodes;
  }, [
    baseFocusNodes,
    chain,
    clearHover,
    density,
    effectiveFocus,
    endpoints,
    layout,
    model.nodes,
    now,
    pathNodeIds,
    phase,
    running,
    selection,
    setHover,
  ]);

  const flowEdges = useMemo((): GraphFlowEdge[] => {
    const visible: GraphFlowEdge[] = [];
    for (const group of model.groups) {
      if (!layout?.positions.has(group.from) || !layout.positions.has(group.to)) continue;
      const id = groupId(group.from, group.to);
      const selected =
        (selection?.kind === "edge" && group.edgeIds.includes(selection.edgeId)) ||
        (selection?.kind === "pair" &&
          ((selection.from === group.from && selection.to === group.to) ||
            (selection.from === group.to && selection.to === group.from)));
      const onPath = group.edgeIds.some((edgeId) => highlightedEdgeIds.has(edgeId));
      visible.push({
        id,
        source: group.from,
        target: group.to,
        type: "flow",
        selected,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: selected || onPath ? "var(--graph-path)" : "var(--graph-edge)",
          width: 6,
          height: 6,
        },
        data: {
          group,
          onPath,
          showLabel: visibleLabelIds.has(id),
          dimmed: effectiveFocus && !focusEdges.has(id),
        },
      });
    }
    return visible;
  }, [
    effectiveFocus,
    focusEdges,
    highlightedEdgeIds,
    layout,
    model.groups,
    selection,
    visibleLabelIds,
  ]);

  const graphAddress = hoveredAddress
    ? model.nodes.find((node) => node.address === hoveredAddress)
    : null;
  const hoveredEdges = hoveredAddress
    ? edges.filter((edge) => edge.from === hoveredAddress || edge.to === hoveredAddress)
    : [];
  const largestTransfer = hoveredEdges.reduce<TraceEdge | null>((best, edge) => {
    if (best === null || (edge.usd ?? 0) > (best.usd ?? 0)) return edge;
    return best;
  }, null);
  const tooltipPosition = useMemo(() => {
    if (!hoverCandidate || !containerRef.current) return null;
    const bounds = containerRef.current.getBoundingClientRect();
    return {
      left: Math.max(8, Math.min(bounds.width - 258, hoverCandidate.x - bounds.left + 14)),
      top: Math.max(8, Math.min(bounds.height - 170, hoverCandidate.y - bounds.top + 12)),
    };
  }, [hoverCandidate]);

  const onCanvasKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    // Only the focused React Flow node/edge itself: nested controls keep their own behaviour.
    const target = event.target;
    if (!(target instanceof Element)) return;
    const id = target.getAttribute("data-id");
    if (!id) return;
    if (target.classList.contains("react-flow__node")) {
      event.preventDefault();
      onSelect({ kind: "address", address: id });
    } else if (target.classList.contains("react-flow__edge")) {
      const group = model.groups.find((item) => groupId(item.from, item.to) === id);
      if (!group) return;
      event.preventDefault();
      onSelect(groupSelection(group));
    }
  };

  const pairCount = model.groups.length;
  const layoutColumns = layout?.columns ?? [];
  const stopText = graphAddress?.stopReason
    ? `${STOP_TAGS[graphAddress.stopReason].code} · ${STOP_TAGS[graphAddress.stopReason].text}`
    : null;
  const tooltipLabel = graphAddress?.label;
  const tooltipCategory = tooltipLabel?.category;
  const tooltipColor = tooltipCategory
    ? `var(${CATEGORY_META[tooltipCategory].token})`
    : "var(--muted-foreground)";
  const tooltipName = tooltipLabel?.name ?? "Unlabeled address";
  const tooltipCategoryName = tooltipCategory ? CATEGORY_META[tooltipCategory].label : "Unlabeled";

  return (
    <section className="min-w-0 bg-card" aria-label="Transfer graph">
      <GraphToolbar
        phase={phase}
        newCount={running ? firstSeenCount : 0}
        addressCount={model.nodes.length}
        pairCount={pairCount}
        density={density}
        focused={effectiveFocus}
        canFocus={selection !== null}
        onDensityChange={handleDensityChange}
        onFitAll={fitAll}
        onFocusSelection={focusSelected}
        onZoom100={zoomTo100}
      />
      {density !== "dots" ? (
        <div className="relative h-7 overflow-hidden border-b border-border bg-muted">
          {layoutColumns.map((column) => (
            <div
              key={column.index}
              className="absolute top-0 flex h-7 items-center gap-1.5 whitespace-nowrap type-mono-sm text-muted-foreground"
              style={{
                left: viewport.x + column.x * viewport.zoom,
                width: layout?.nodeWidth ? layout.nodeWidth * viewport.zoom : undefined,
              }}
            >
              <strong className="font-semibold text-foreground">
                {column.hop === 0 ? "SEED" : `HOP ${column.hop}`}
              </strong>
              <span>
                {column.count}
                {column.queued > 0
                  ? phase === "running"
                    ? ` · ${column.queued} queued`
                    : phase === "paused"
                      ? " waiting"
                      : phase === "cancelled"
                        ? " not expanded"
                        : ""
                  : ""}
                {column.failed > 0 ? ` · ${column.failed} failed` : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-leave dismisses the hover tooltip and Enter/Space on a focused React Flow node or edge opens the detail panel; React Flow owns all other canvas interaction. */}
      <div
        ref={containerRef}
        className="relative min-w-0"
        style={{ height: graphHeight, backgroundColor: "var(--graph-canvas)" }}
        onMouseLeave={clearHover}
        onKeyDown={onCanvasKeyDown}
      >
        {model.nodes.length === 0 ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-muted-foreground">
            {live ? "Waiting for the first transfers…" : "No transfers in this run."}
          </div>
        ) : null}
        <ReactFlow
          nodes={flowNodes as Node[]}
          edges={flowEdges as Edge[]}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          colorMode={resolved}
          nodesDraggable={false}
          nodesConnectable={false}
          onlyRenderVisibleElements
          minZoom={0.1}
          maxZoom={2}
          fitView={!userMoved.current}
          onNodeClick={(_, node) => onSelect({ kind: "address", address: node.id })}
          onNodeDoubleClick={(_, node) => {
            onSelect({ kind: "address", address: node.id });
            setFocusSelection(true);
            userMoved.current = true;
          }}
          onEdgeClick={(_, edge) => {
            const group = (edge as GraphFlowEdge).data?.group;
            if (group) onSelect(groupSelection(group));
          }}
          onEdgeDoubleClick={(_, edge) => {
            const group = (edge as GraphFlowEdge).data?.group;
            if (!group) return;
            onSelect(groupSelection(group));
            setFocusSelection(true);
            userMoved.current = true;
          }}
          onPaneClick={() => {
            onSelect(null);
            setFocusSelection(false);
            clearHover();
          }}
          onMove={(event) => {
            if (event !== null) userMoved.current = true;
          }}
          style={{ background: "var(--graph-canvas)" }}
        >
          <Background color="var(--graph-grid)" gap={16} size={1} />
          {density === "dots" ? (
            <MiniMap
              pannable
              zoomable
              nodeColor={(node) => {
                const data = node.data as AddressNodeData;
                return data.label
                  ? `var(${CATEGORY_META[data.label.category].token})`
                  : "var(--border-strong)";
              }}
              maskColor="var(--overlay)"
              style={{ background: "var(--card)" }}
            />
          ) : null}
        </ReactFlow>
        <div className="absolute right-3 top-3 z-20 flex flex-col overflow-hidden rounded-sm border border-border-strong bg-card type-mono font-medium shadow-popover">
          <button
            type="button"
            aria-label="Zoom in"
            className="flex size-[30px] items-center justify-center hover:bg-muted max-md:size-11 max-md:min-h-11"
            onClick={() => {
              userMoved.current = true;
              void zoomIn({ duration: 120 });
            }}
          >
            +
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            className="flex size-[30px] items-center justify-center border-t border-border-strong hover:bg-muted max-md:size-11 max-md:min-h-11"
            onClick={() => {
              userMoved.current = true;
              void zoomOut({ duration: 120 });
            }}
          >
            −
          </button>
          <button
            type="button"
            aria-label="Fit graph"
            className="flex size-[30px] items-center justify-center border-t border-border-strong hover:bg-muted max-md:size-11 max-md:min-h-11"
            onClick={fitAll}
          >
            ⤢
          </button>
        </div>
        {hoveredAddress && graphAddress && tooltipPosition ? (
          <div
            className="pointer-events-none absolute z-30 flex w-[250px] flex-col gap-1.5 rounded-sm border border-border-strong bg-card px-3 py-2.5 text-xs shadow-popover"
            style={tooltipPosition}
          >
            <div
              className="flex items-center gap-1.5 font-semibold"
              style={{ color: tooltipColor }}
            >
              <span aria-hidden="true">
                {tooltipCategory ? CATEGORY_META[tooltipCategory].glyph : "○"}
              </span>
              <span className="min-w-0 truncate">{tooltipName}</span>
              <span className="ml-auto shrink-0 type-mono-sm text-muted-foreground">
                {tooltipCategoryName}
              </span>
            </div>
            <div className="type-mono-sm text-muted-foreground">
              {shortAddress(chain, hoveredAddress)} · {tooltipLabel?.origin ?? "no label"}
            </div>
            {largestTransfer ? (
              <div className="type-mono-sm">
                {formatAmount(largestTransfer.transfer.amount)}{" "}
                {assetSymbol(largestTransfer.transfer.asset)} →{" "}
                {shortAddress(
                  chain,
                  largestTransfer.from === hoveredAddress
                    ? largestTransfer.to
                    : largestTransfer.from,
                )}{" "}
                <span className="text-muted-foreground">{formatUsd(largestTransfer.usd)}</span>
              </div>
            ) : null}
            {stopText ? <div className="text-muted-foreground">{stopText}</div> : null}
            <div className="border-t border-border pt-1.5 text-muted-foreground">
              Click to select · double-click to focus
            </div>
          </div>
        ) : null}
      </div>
      <GraphLegend density={density} />
    </section>
  );
}
