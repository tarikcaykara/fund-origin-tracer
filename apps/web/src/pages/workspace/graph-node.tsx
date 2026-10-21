import type { ChainId } from "@fot/core/schema";
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { CircleStopIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.tsx";
import { fullAddress, shortAddress } from "@/format.ts";
import { cn } from "@/lib/utils.ts";
import { NODE_HEIGHT, NODE_WIDTH } from "../../graph-layout.ts";
import type { AddressNodeData } from "../../graph-model.ts";

export type AddressFlowNode = Node<AddressNodeData & { chain: ChainId }, "address">;

export function AddressNodeView({ data, selected }: NodeProps<AddressFlowNode>) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border bg-card px-2.5 py-1.5 text-card-foreground shadow-sm",
        selected && "ring-2 ring-ring",
        data.sanctioned && "border-2 border-destructive",
      )}
      style={{
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        ...(data.sanctioned || !data.label
          ? {}
          : { borderColor: `var(--cat-${data.label.category})` }),
      }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="truncate font-mono text-xs" title={fullAddress(data.chain, data.address)}>
        {shortAddress(data.chain, data.address)}
      </div>
      {data.label ? (
        <div
          className="truncate text-xs font-medium"
          style={{ color: `var(--cat-${data.label.category})` }}
          title={`${data.label.category} · ${data.label.source}`}
        >
          {data.label.name}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {data.seed ? (
          <Badge variant="secondary" className="h-4 px-1 text-[10px]">
            seed
          </Badge>
        ) : null}
        {data.sanctioned ? (
          <Badge variant="destructive" className="h-4 px-1 text-[10px]">
            sanctioned
          </Badge>
        ) : null}
        {data.mixer ? (
          <Badge variant="outline" className="h-4 px-1 text-[10px]">
            mixer
          </Badge>
        ) : null}
        {data.convergence ? (
          <Badge variant="outline" className="h-4 px-1 text-[10px]">
            linked
          </Badge>
        ) : null}
        {data.stopReason ? (
          <Badge variant="outline" className="h-4 px-1 text-[10px]">
            <CircleStopIcon className="size-3" />
            {data.stopReason.replace("_", " ")}
          </Badge>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
