import type { ChainId, TraceEdge } from "@fot/core/schema";
import { LabelList } from "@/components/badges.tsx";
import { AddressLink, type LabelIndex, TxLink } from "@/components/links.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { assetSymbol, formatAmount, formatUsd, fullAddress, shortAddress } from "@/format.ts";

function TransferList({
  chain,
  edges,
  address,
  onSelectEdge,
}: {
  chain: ChainId;
  edges: TraceEdge[];
  address: string;
  onSelectEdge: (edgeId: string) => void;
}) {
  if (edges.length === 0) return <p className="text-sm text-muted-foreground">No transfers.</p>;
  return (
    <ul className="space-y-2">
      {edges.map((edge) => {
        const direction = edge.to === address ? "in" : "out";
        const counterparty = edge.from === address ? edge.to : edge.from;
        return (
          <li key={edge.id} className="flex flex-wrap items-center gap-2">
            <Button variant="link" size="xs" onClick={() => onSelectEdge(edge.id)}>
              {direction} · {formatAmount(edge.transfer.amount)} {assetSymbol(edge.transfer.asset)}{" "}
              · {formatUsd(edge.usd)} · depth {edge.depth}
            </Button>
            <span className="font-mono text-xs" title={counterparty}>
              {shortAddress(chain, counterparty)}
            </span>
            <TxLink chain={chain} hash={edge.transfer.txHash} />
          </li>
        );
      })}
    </ul>
  );
}

export function AddressDetail({
  chain,
  address,
  edges,
  labels,
  convergence,
  onSelectEdge,
  onClose,
}: {
  chain: ChainId;
  address: string;
  edges: TraceEdge[];
  labels: LabelIndex;
  convergence: boolean;
  onSelectEdge: (edgeId: string) => void;
  onClose: () => void;
}) {
  const addressData = labels.get(address);
  const addressLabels = addressData?.labels ?? [];
  const seed = edges.some((edge) => edge.near === address && edge.seedId !== null);
  const transfers = edges.filter((edge) => edge.from === address || edge.to === address);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Address detail</CardTitle>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
          <dt className="text-muted-foreground">Address</dt>
          <dd>
            <AddressLink chain={chain} address={address} labels={labels} />
          </dd>
          <dt className="text-muted-foreground">Full address</dt>
          <dd className="break-all font-mono text-xs">{fullAddress(chain, address)}</dd>
        </dl>
        <div className="flex flex-wrap gap-1">
          {seed ? <Badge variant="secondary">seed</Badge> : null}
          {addressData?.sanctioned ? <Badge variant="destructive">sanctioned</Badge> : null}
          {convergence ? <Badge variant="outline">linked</Badge> : null}
        </div>
        {addressLabels.length > 0 ? (
          <section className="space-y-1">
            <h4 className="font-medium">Labels</h4>
            <LabelList labels={addressLabels} />
          </section>
        ) : null}
        <section className="space-y-1">
          <h4 className="font-medium">Transfers ({transfers.length})</h4>
          <TransferList
            chain={chain}
            edges={transfers}
            address={address}
            onSelectEdge={onSelectEdge}
          />
        </section>
      </CardContent>
    </Card>
  );
}

export function PairDetail({
  chain,
  from,
  to,
  edges,
  labels,
  onSelectEdge,
  onClose,
}: {
  chain: ChainId;
  from: string;
  to: string;
  edges: TraceEdge[];
  labels: LabelIndex;
  onSelectEdge: (edgeId: string) => void;
  onClose: () => void;
}) {
  const pairEdges = edges.filter((edge) => edge.from === from && edge.to === to);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Transfers</CardTitle>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
          <dt className="text-muted-foreground">From</dt>
          <dd>
            <AddressLink chain={chain} address={from} labels={labels} />
          </dd>
          <dt className="text-muted-foreground">To</dt>
          <dd>
            <AddressLink chain={chain} address={to} labels={labels} />
          </dd>
        </dl>
        <TransferList chain={chain} edges={pairEdges} address={from} onSelectEdge={onSelectEdge} />
      </CardContent>
    </Card>
  );
}
