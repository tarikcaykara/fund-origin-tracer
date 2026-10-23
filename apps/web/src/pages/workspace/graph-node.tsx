import type { ChainId } from "@fot/core/schema";
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import type { MouseEvent } from "react";
import { cn } from "@/lib/utils.ts";
import { shortAddress } from "../../format.ts";
import type { AddressNodeData } from "../../graph-model.ts";
import { CATEGORY_META, STOP_TAGS } from "../../meta.ts";
import type { RunPhase } from "../../run-state.ts";

export type AddressFlowNode = Node<
  AddressNodeData & {
    chain: ChainId;
    phase: RunPhase;
    density: "chips" | "dots" | "compact";
    nodeWidth: number;
    nodeHeight: number;
    onPath: boolean;
    endpoint: boolean;
    dimmed: boolean;
    isNew: boolean;
    onHover(address: string, x: number, y: number): void;
    onLeave(): void;
  },
  "address"
>;

export function AddressNodeView({ data, selected }: NodeProps<AddressFlowNode>) {
  const category = data.sanctioned ? "sanctioned" : (data.label?.category ?? null);
  const categoryMeta = category ? CATEGORY_META[category] : null;
  const color = categoryMeta ? `var(${categoryMeta.token})` : "var(--foreground)";
  const pending = data.queued;
  const failed = data.failed || data.stopReason === "fetch_failed";
  const tag = failed
    ? "✕ FAIL"
    : pending
      ? data.phase === "running" || data.phase === "connecting"
        ? "QUEUED"
        : data.phase === "paused"
          ? "PAUSED"
          : "—"
      : data.seed
        ? "SEED"
        : `${data.commonSource ? "⧉" : ""}${data.stopReason ? STOP_TAGS[data.stopReason].code : ""}`;
  const dimOpacity = data.dimmed ? 0.25 : pending && data.phase === "cancelled" ? 0.45 : 1;
  const onPointerEnter = (event: MouseEvent<HTMLDivElement>) => {
    data.onHover(data.address, event.clientX, event.clientY);
  };
  const visibleTag = data.density === "chips" ? tag : "";
  const fullLabel = data.label?.name ?? shortAddress(data.chain, data.address);
  const labelText =
    data.density === "compact" && fullLabel.length > 14 ? `${fullLabel.slice(0, 13)}…` : fullLabel;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover-only tooltip trigger; React Flow owns the node role, focus and click handling.
    <div
      className={cn("relative cursor-pointer", data.density === "dots" && "overflow-visible")}
      style={{ width: data.nodeWidth, height: data.nodeHeight, opacity: dimOpacity }}
      onMouseEnter={onPointerEnter}
      onMouseLeave={data.onLeave}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="!size-px !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0"
      />
      {data.density === "dots" ? (
        <>
          <span
            role="img"
            aria-label={data.label?.name ?? shortAddress(data.chain, data.address)}
            className={cn(
              "absolute left-0 top-0 size-3",
              category ? "rounded-[2px]" : "rounded-full",
              data.isNew && "animate-stream-pulse",
            )}
            style={{
              background:
                data.seed || selected || data.endpoint
                  ? "var(--selection)"
                  : category
                    ? color
                    : "transparent",
              border:
                category || data.seed || selected || data.endpoint
                  ? "none"
                  : "1.5px solid var(--muted-foreground)",
              boxShadow: data.onPath ? "0 0 0 1.5px var(--selection)" : undefined,
              animation: data.isNew ? "stream-pulse 1400ms var(--ease-out) 1" : undefined,
            }}
          />
          {data.label || data.seed || selected || data.endpoint ? (
            <span
              className="absolute left-4 top-0 max-w-28 truncate bg-background px-0.5 type-mono-node"
              style={{ color }}
            >
              {data.label
                ? data.label.name.length > 11
                  ? `${data.label.name.slice(0, 10)}…`
                  : data.label.name
                : shortAddress(data.chain, data.address)}
            </span>
          ) : null}
        </>
      ) : (
        <div
          className={cn(
            "flex h-full w-full items-center gap-1 overflow-hidden rounded-xs px-1.5 type-mono-node",
            data.isNew && "animate-stream-pulse",
          )}
          style={{
            color,
            background:
              selected || data.endpoint
                ? "var(--selection-muted)"
                : pending
                  ? "transparent"
                  : "var(--graph-node)",
            border: failed
              ? "1.5px solid var(--risk-high)"
              : data.onPath
                ? "1.5px solid var(--selection)"
                : pending
                  ? "1px dashed var(--border-strong)"
                  : data.seed
                    ? "1px solid var(--foreground)"
                    : category
                      ? `1px solid ${color}`
                      : "1px solid var(--border-strong)",
            fontWeight: data.seed ? 600 : 500,
          }}
        >
          {categoryMeta ? (
            <span aria-hidden="true" className="shrink-0 text-[9px]">
              {categoryMeta.glyph}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate">{labelText}</span>
          {visibleTag ? (
            <span
              className="shrink-0 text-[9px] font-semibold tracking-wide"
              style={{ color: failed ? "var(--risk-high)" : "var(--muted-foreground)" }}
            >
              {visibleTag}
            </span>
          ) : null}
        </div>
      )}
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="!size-px !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0"
      />
    </div>
  );
}
