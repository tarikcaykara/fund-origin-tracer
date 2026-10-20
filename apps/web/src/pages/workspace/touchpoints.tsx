import type { AnalysisResult, ExchangeTouchpoint } from "@fot/core/schema";
import { toast } from "sonner";
import { AddressLink, indexAddresses, TxLink } from "@/components/links.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.tsx";
import { formatAmount, formatTimestamp, formatUsd, fullAddress, txUrl } from "@/format.ts";

/** Plain-text block per touchpoint, ready to paste into a freeze or information request. */
export function freezeRequestText(result: AnalysisResult): string {
  const { chain } = result;
  const blocks = result.exchangeTouchpoints.map((t: ExchangeTouchpoint) => {
    const deposit = t.counterparty ?? t.exchangeAddress;
    return [
      `Exchange: ${t.entity}`,
      `Exchange address: ${fullAddress(chain, t.exchangeAddress)}`,
      `${t.kind === "arrival" ? "Deposit address" : "Recipient address"}: ${fullAddress(chain, deposit)}`,
      `Transaction: ${t.txHash} (${txUrl(chain, t.txHash)})`,
      `Amount: ${formatAmount(t.amount)} ${t.symbol} (${formatUsd(t.usd)})`,
      `Time: ${formatTimestamp(t.timestamp)}`,
    ].join("\n");
  });
  return blocks.join("\n\n");
}

export function TouchpointsTab({ result }: { result: AnalysisResult }) {
  const { chain, exchangeTouchpoints } = result;
  const labels = indexAddresses(result.graph.addresses);
  if (exchangeTouchpoints.length === 0) {
    return <p className="text-sm text-muted-foreground">No exchange was reached.</p>;
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(freezeRequestText(result));
      toast.success("Freeze-request list copied.");
    } catch {
      toast.error("Clipboard is not available.");
    }
  };
  return (
    <div className="space-y-3">
      <Button variant="outline" onClick={() => void copy()}>
        Copy freeze-request list
      </Button>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Kind</TableHead>
            <TableHead>Exchange</TableHead>
            <TableHead>Exchange address</TableHead>
            <TableHead>Counterparty</TableHead>
            <TableHead>Tx</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">USD</TableHead>
            <TableHead>Time</TableHead>
            <TableHead className="text-right">Depth</TableHead>
            <TableHead>Seeds</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {exchangeTouchpoints.map((t) => (
            <TableRow key={`${t.kind}:${t.txHash}:${t.exchangeAddress}:${t.assetId}:${t.amount}`}>
              <TableCell>
                <Badge variant="outline">{t.kind}</Badge>
              </TableCell>
              <TableCell>{t.entity}</TableCell>
              <TableCell>
                <AddressLink chain={chain} address={t.exchangeAddress} labels={labels} />
              </TableCell>
              <TableCell>
                {t.counterparty ? (
                  <AddressLink chain={chain} address={t.counterparty} labels={labels} />
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell>
                <TxLink chain={chain} hash={t.txHash} />
              </TableCell>
              <TableCell className="text-right">
                {formatAmount(t.amount)} {t.symbol}
              </TableCell>
              <TableCell className="text-right">{formatUsd(t.usd)}</TableCell>
              <TableCell className="whitespace-nowrap">{formatTimestamp(t.timestamp)}</TableCell>
              <TableCell className="text-right">{t.depth}</TableCell>
              <TableCell>{t.seedIds.join(", ") || "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
