import type { ChainId, TraceEdge } from "@fot/core/schema";
import { StopReasonText } from "@/components/badges.tsx";
import { AddressLink, type LabelIndex, TxLink } from "@/components/links.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.tsx";
import { assetSymbol, formatAmount, formatTimestamp, formatUsd } from "@/format.ts";
import { cn } from "@/lib/utils.ts";

export function TransfersTab({
  chain,
  edges,
  labels,
  selectedId,
  onSelect,
}: {
  chain: ChainId;
  edges: TraceEdge[];
  labels: LabelIndex;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (edges.length === 0) return <p className="text-sm text-muted-foreground">No transfers yet.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Depth</TableHead>
          <TableHead>From</TableHead>
          <TableHead>To</TableHead>
          <TableHead>Asset</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">USD</TableHead>
          <TableHead>Time</TableHead>
          <TableHead>Tx</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Stop reason</TableHead>
          <TableHead className="text-right">Score</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {edges.map((e) => (
          <TableRow
            key={e.id}
            tabIndex={0}
            aria-selected={e.id === selectedId}
            data-state={e.id === selectedId ? "selected" : undefined}
            className={cn("cursor-pointer")}
            onClick={() => onSelect(e.id)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                onSelect(e.id);
              }
            }}
          >
            <TableCell>{e.depth}</TableCell>
            <TableCell>
              <AddressLink chain={chain} address={e.from} labels={labels} />
            </TableCell>
            <TableCell>
              <AddressLink chain={chain} address={e.to} labels={labels} />
            </TableCell>
            <TableCell>{assetSymbol(e.transfer.asset)}</TableCell>
            <TableCell className="text-right">{formatAmount(e.transfer.amount)}</TableCell>
            <TableCell className="text-right">{formatUsd(e.usd)}</TableCell>
            <TableCell className="whitespace-nowrap">
              {formatTimestamp(e.transfer.timestamp)}
            </TableCell>
            <TableCell onClick={(ev) => ev.stopPropagation()}>
              <TxLink chain={chain} hash={e.transfer.txHash} />
            </TableCell>
            <TableCell>
              <Badge variant="outline">{e.status}</Badge>
            </TableCell>
            <TableCell>
              <StopReasonText reason={e.stopReason} />
            </TableCell>
            <TableCell className="text-right">{e.selection ? e.selection.score : "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
