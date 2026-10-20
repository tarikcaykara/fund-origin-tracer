import { type ChainId, EXPANDABLE_REASONS, type TraceEdge } from "@fot/core/schema";
import { StopReasonText } from "@/components/badges.tsx";
import { AddressLink, type LabelIndex, TxLink } from "@/components/links.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { assetSymbol, formatAmount, formatTimestamp, formatUsd } from "@/format.ts";

export function EdgeDetail({
  chain,
  edge,
  labels,
  canExpand,
  expanding,
  onExpand,
  onClose,
}: {
  chain: ChainId;
  edge: TraceEdge;
  labels: LabelIndex;
  /** The run is finished, so a stopped edge may be continued. */
  canExpand: boolean;
  expanding: boolean;
  onExpand: () => void;
  onClose: () => void;
}) {
  const expandable =
    edge.status === "stopped" &&
    edge.stopReason !== null &&
    EXPANDABLE_REASONS.has(edge.stopReason);
  const t = edge.transfer;
  const farLabels = labels.get(edge.far)?.labels ?? [];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Transfer detail</CardTitle>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
          <dt className="text-muted-foreground">From</dt>
          <dd>
            <AddressLink chain={chain} address={edge.from} labels={labels} />
          </dd>
          <dt className="text-muted-foreground">To</dt>
          <dd>
            <AddressLink chain={chain} address={edge.to} labels={labels} />
          </dd>
          <dt className="text-muted-foreground">Followed</dt>
          <dd>
            <AddressLink chain={chain} address={edge.far} labels={labels} />
          </dd>
          <dt className="text-muted-foreground">Amount</dt>
          <dd>
            {formatAmount(t.amount)} {assetSymbol(t.asset)} ({formatUsd(edge.usd)})
          </dd>
          <dt className="text-muted-foreground">Time</dt>
          <dd>{formatTimestamp(t.timestamp)}</dd>
          <dt className="text-muted-foreground">Transaction</dt>
          <dd>
            <TxLink chain={chain} hash={t.txHash} />
          </dd>
          <dt className="text-muted-foreground">Depth</dt>
          <dd>
            {edge.depth}
            {edge.seedId ? ` · seed ${edge.seedId}` : ""}
          </dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{edge.status}</Badge>
            {edge.stopReason ? <StopReasonText reason={edge.stopReason} /> : null}
            {edge.stopDetail ? (
              <span className="text-muted-foreground">{edge.stopDetail}</span>
            ) : null}
          </dd>
        </dl>

        {farLabels.length > 0 ? (
          <section className="space-y-1">
            <h4 className="font-medium">Labels on the followed address</h4>
            <ul className="space-y-1">
              {farLabels.map((l) => (
                <li key={`${l.origin}:${l.name}`}>
                  <Badge variant="outline">{l.category}</Badge> {l.name}{" "}
                  <span className="text-xs text-muted-foreground">
                    {l.origin} · {l.source}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="space-y-1">
          <h4 className="font-medium">Why selected</h4>
          {edge.selection ? (
            <>
              <p>
                Rank {edge.selection.rank} among candidates, score {edge.selection.score}.
              </p>
              <table className="w-full">
                <tbody>
                  <tr>
                    <td className="text-muted-foreground">Same asset</td>
                    <td className="text-right">{edge.selection.breakdown.asset}</td>
                  </tr>
                  <tr>
                    <td className="text-muted-foreground">Amount proximity</td>
                    <td className="text-right">{edge.selection.breakdown.amount}</td>
                  </tr>
                  <tr>
                    <td className="text-muted-foreground">Time proximity</td>
                    <td className="text-right">{edge.selection.breakdown.time}</td>
                  </tr>
                  <tr>
                    <td className="text-muted-foreground">Dust penalty</td>
                    <td className="text-right">{edge.selection.breakdown.dust}</td>
                  </tr>
                </tbody>
              </table>
            </>
          ) : (
            <p className="text-muted-foreground">Seed transfer: chosen by the investigator.</p>
          )}
          {edge.swap ? (
            <p>
              Swap-through: received {formatAmount(edge.swap.amount)} {assetSymbol(edge.swap.asset)}{" "}
              in the same transaction.
            </p>
          ) : null}
        </section>

        <section className="space-y-1">
          <h4 className="font-medium">
            Dropped candidates ({edge.droppedTotal}
            {edge.dropped.length < edge.droppedTotal ? `, showing ${edge.dropped.length}` : ""})
          </h4>
          {edge.dropped.length === 0 ? (
            <p className="text-muted-foreground">None.</p>
          ) : (
            <ul className="space-y-1.5">
              {edge.dropped.map((d) => (
                <li
                  key={`${d.transfer.txHash}:${d.transfer.from}:${d.transfer.to}:${d.transfer.amountRaw}:${d.reason}`}
                  className="flex flex-wrap items-center gap-2"
                >
                  <Badge variant="secondary">{d.reason.replaceAll("_", " ")}</Badge>
                  <span>
                    {formatAmount(d.transfer.amount)} {assetSymbol(d.transfer.asset)} ·{" "}
                    {formatUsd(d.usd)}
                    {d.score !== null ? ` · score ${d.score}` : ""}
                  </span>
                  <TxLink chain={chain} hash={d.transfer.txHash} />
                </li>
              ))}
            </ul>
          )}
        </section>

        {expandable ? (
          <Button disabled={!canExpand || expanding} onClick={onExpand}>
            {expanding ? "Expanding…" : "Expand further"}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
