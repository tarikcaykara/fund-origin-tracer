import type { AnalysisResult } from "@fot/core/schema";
import { AddressLink, indexAddresses, TxLink } from "@/components/links.tsx";
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

export function LinkedWalletsTab({ result }: { result: AnalysisResult }) {
  const { chain, convergences } = result;
  const labels = indexAddresses(result.graph.addresses);
  if (convergences.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No unlabeled address was shared across seeds or branches.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {convergences.map((c) => (
        <details key={`${c.role}:${c.address}`} className="rounded-md border p-4">
          <summary className="flex cursor-pointer flex-wrap items-center gap-3">
            <AddressLink chain={chain} address={c.address} labels={labels} />
            <Badge variant="outline">
              {c.role === "common_source" ? "common source" : "common destination"}
            </Badge>
            {c.kinds.map((k) => (
              <Badge key={k} variant="secondary">
                {k.replaceAll("_", " ")}
              </Badge>
            ))}
            <span className="text-sm text-muted-foreground">
              {c.counterparties.length} counterpart{c.counterparties.length === 1 ? "y" : "ies"} ·{" "}
              {formatUsd(c.usd)} · seeds {c.seedIds.join(", ") || "—"} · min depth {c.minDepth}
            </span>
          </summary>
          <div className="mt-4 space-y-4">
            <p className="text-sm">
              Totals:{" "}
              {c.totals.map((t) => `${formatAmount(t.amount)} ${t.symbol}`).join(", ") || "—"}
            </p>
            <div className="space-y-2">
              <h4 className="text-sm font-medium">
                Other counterparties ({c.otherCounterparties.length})
              </h4>
              {c.otherCounterparties.length === 0 ? (
                <p className="text-sm text-muted-foreground">None recorded.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>From</TableHead>
                      <TableHead>To</TableHead>
                      <TableHead>Asset</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead>Tx</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {c.otherCounterparties.map((t) => (
                      <TableRow
                        key={`${t.txHash}:${t.from}:${t.to}:${t.amountRaw}:${assetSymbol(t.asset)}`}
                      >
                        <TableCell>
                          <AddressLink chain={chain} address={t.from} labels={labels} />
                        </TableCell>
                        <TableCell>
                          <AddressLink chain={chain} address={t.to} labels={labels} />
                        </TableCell>
                        <TableCell>{assetSymbol(t.asset)}</TableCell>
                        <TableCell className="text-right">{formatAmount(t.amount)}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {formatTimestamp(t.timestamp)}
                        </TableCell>
                        <TableCell>
                          <TxLink chain={chain} hash={t.txHash} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}
