import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
} from "@xyflow/react";
import { edgeStrokeWidth, groupLabel, type TransferGroupData } from "../../graph-model.ts";

export type GraphFlowEdge = Edge<
  {
    group: TransferGroupData;
    onPath: boolean;
    showLabel: boolean;
    dimmed: boolean;
  },
  "flow"
>;

export function GraphEdgeView(props: EdgeProps<GraphFlowEdge>) {
  const group = props.data?.group;
  if (!group) return null;
  const onPath = props.data?.onPath ?? false;
  const selected = props.selected ?? false;
  const color = selected || onPath ? "var(--graph-path)" : "var(--graph-edge)";
  const strokeWidth = selected
    ? edgeStrokeWidth(group.usd, true)
    : onPath
      ? 2
      : edgeStrokeWidth(group.usd);
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    curvature: 0.3,
  });
  const labelVisible = props.data?.showLabel ?? false;
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})}
        style={{
          stroke: color,
          strokeWidth,
          strokeDasharray: group.stopped ? "2 3" : undefined,
          opacity: props.data?.dimmed ? 0.25 : 1,
        }}
      />
      {labelVisible ? (
        <EdgeLabelRenderer>
          <span
            className="pointer-events-none absolute z-10 whitespace-nowrap rounded-xs border border-selection px-1.5 py-0.5 type-mono-sm font-semibold"
            style={{
              left: labelX,
              top: labelY - 12,
              transform: "translate(-50%, -100%)",
              background: selected ? "var(--selection)" : "var(--card)",
              color: selected ? "var(--selection-foreground)" : "var(--selection)",
            }}
          >
            {groupLabel(group)}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
