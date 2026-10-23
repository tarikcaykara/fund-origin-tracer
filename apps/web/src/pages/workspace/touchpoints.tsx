import type { AnalysisResult, ExchangeTouchpoint } from "@fot/core/schema";
import { useMemo } from "react";
import { toast } from "sonner";
import { CategoryTag } from "@/components/badges.tsx";
import { EmptyState } from "@/components/empty-state.tsx";
import { AddressChip, indexAddresses, TxLink } from "@/components/links.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  formatAmount,
  formatCompactTimestamp,
  formatTimestamp,
  formatUsd,
  fullAddress,
  txUrl,
} from "@/format.ts";
import { CATEGORY_META } from "@/meta.ts";

/** Plain-text block per touchpoint, ready to paste into a freeze or information request. */
export function freezeRequestText(result: AnalysisResult): string {
  const { chain } = result;
  return result.exchangeTouchpoints
    .map((touchpoint: ExchangeTouchpoint) => {
      const deposit = touchpoint.counterparty ?? touchpoint.exchangeAddress;
      return [
        `Exchange: ${touchpoint.entity}`,
        `Exchange address: ${fullAddress(chain, touchpoint.exchangeAddress)}`,
        `${touchpoint.kind === "arrival" ? "Deposit address" : "Recipient address"}: ${fullAddress(chain, deposit)}`,
        `Transaction: ${touchpoint.txHash} (${txUrl(chain, touchpoint.txHash)})`,
        `Amount: ${formatAmount(touchpoint.amount)} ${touchpoint.symbol} (${formatUsd(touchpoint.usd)})`,
        `Time: ${formatTimestamp(touchpoint.timestamp)}`,
      ].join("\n");
    })
    .join("\n\n");
}

function groupByEntity(touchpoints: ExchangeTouchpoint[]): [string, ExchangeTouchpoint[]][] {
  const groups = new Map<string, ExchangeTouchpoint[]>();
  for (const touchpoint of touchpoints) {
    const group = groups.get(touchpoint.entity);
    if (group) group.push(touchpoint);
    else groups.set(touchpoint.entity, [touchpoint]);
  }
  return [...groups.entries()];
}

export function TouchpointsTab({ result }: { result: AnalysisResult }) {
  const { chain, direction, exchangeTouchpoints } = result;
  const labels = useMemo(() => indexAddresses(result.graph.addresses), [result.graph.addresses]);
  const primaryKind = direction === "backward" ? "origin" : "arrival";
  const otherKind = primaryKind === "origin" ? "arrival" : "origin";
  const primary = exchangeTouchpoints.filter((touchpoint) => touchpoint.kind === primaryKind);
  const other = exchangeTouchpoints.filter((touchpoint) => touchpoint.kind === otherKind);
  const heading = direction === "backward" ? "Origin exchange wallets" : "Arrival exchange wallets";
  const helper =
    direction === "backward"
      ? "Where traced funds left an exchange; the exchange can identify the account holder."
      : "Where traced funds arrived at an exchange; the exchange can identify the receiving account.";
  const otherHeading =
    otherKind === "arrival" ? "Arrival exchange wallets" : "Origin exchange wallets";

  const groups = useMemo(() => groupByEntity(primary), [primary]);
  const otherGroups = useMemo(() => groupByEntity(other), [other]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(freezeRequestText(result));
      const exchangeWallets = new Set(
        exchangeTouchpoints.map((touchpoint) => touchpoint.exchangeAddress),
      );
      const entities = [...new Set(exchangeTouchpoints.map((touchpoint) => touchpoint.entity))];
      toast.success("⧉ Copied freeze-request list", {
        description: `${exchangeWallets.size} exchange wallets · ${entities.join(", ") || "No exchange entities"}`,
      });
    } catch {
      toast.error("Clipboard is not available.");
    }
  };

  const labelProps = (address: string) => {
    const name = labels.get(address)?.labels[0]?.name;
    return name ? { label: name } : {};
  };
  const renderGroups = (items: [string, ExchangeTouchpoint[]][]) =>
    items.map(([entity, records]) => {
      const wallets = new Set(records.map((record) => record.exchangeAddress));
      const priced = records.filter((record) => record.usd !== null);
      const usd =
        priced.length === records.length
          ? priced.reduce((sum, record) => sum + (record.usd ?? 0), 0)
          : null;
      const counterpartyLabel = records[0]?.kind === "origin" ? "TO" : "FROM";
      return (
        <section key={entity} className="overflow-hidden rounded-xs border border-border bg-card">
          <header className="flex flex-wrap items-center gap-2 bg-muted px-3 py-2">
            <CategoryTag category="exchange" label={entity} />
            <span className="type-mono-node text-muted-foreground">
              {records.length} transfers · {wallets.size} wallets
            </span>
            <span className="ml-auto type-mono-sm">{formatUsd(usd)}</span>
          </header>
          <div className="hidden grid-cols-[minmax(110px,1.1fr)_minmax(110px,1.1fr)_minmax(100px,1fr)_76px_52px_minmax(105px,.9fr)_minmax(80px,.8fr)] gap-2 border-b border-border px-3 py-1.5 type-overline text-muted-foreground xl:grid">
            <span>EXCHANGE</span>
            <span>{counterpartyLabel}</span>
            <span>AMOUNT</span>
            <span className="text-right">USD</span>
            <span>HOP</span>
            <span>TIME UTC</span>
            <span>TX</span>
          </div>
          <ul className="divide-y divide-border">
            {records.map((touchpoint) => (
              <li
                key={`${touchpoint.kind}:${touchpoint.txHash}:${touchpoint.exchangeAddress}:${touchpoint.assetId}:${touchpoint.amount}`}
                className="grid min-w-0 grid-cols-1 gap-2 px-3 py-3 type-body-sm md:grid-cols-3 xl:grid-cols-[minmax(110px,1.1fr)_minmax(110px,1.1fr)_minmax(100px,1fr)_76px_52px_minmax(105px,.9fr)_minmax(80px,.8fr)] xl:items-center max-md:[&_button]:min-h-11"
              >
                <div className="min-w-0">
                  <span className="block type-overline text-muted-foreground xl:hidden">
                    EXCHANGE
                  </span>
                  <AddressChip
                    chain={chain}
                    address={touchpoint.exchangeAddress}
                    {...labelProps(touchpoint.exchangeAddress)}
                  />
                </div>
                <div className="min-w-0">
                  <span className="block type-overline text-muted-foreground xl:hidden">
                    {counterpartyLabel}
                  </span>
                  {touchpoint.counterparty ? (
                    <AddressChip
                      chain={chain}
                      address={touchpoint.counterparty}
                      {...labelProps(touchpoint.counterparty)}
                    />
                  ) : (
                    "—"
                  )}
                </div>
                <div className="type-mono-sm">
                  <span className="block type-overline text-muted-foreground xl:hidden">
                    AMOUNT
                  </span>
                  {formatAmount(touchpoint.amount)} {touchpoint.symbol}
                </div>
                <div className="type-mono-sm xl:text-right">
                  <span className="block type-overline text-muted-foreground xl:hidden">USD</span>
                  {formatUsd(touchpoint.usd)}
                </div>
                <div className="type-mono-node">
                  <span className="mr-1 type-overline text-muted-foreground xl:hidden">HOP</span>
                  {touchpoint.depth}
                </div>
                <div className="type-mono-node text-muted-foreground">
                  <span className="block type-overline text-muted-foreground xl:hidden">
                    TIME UTC
                  </span>
                  {formatCompactTimestamp(touchpoint.timestamp)}
                </div>
                <div className="xl:justify-self-end">
                  <span className="mr-1 type-overline text-muted-foreground xl:hidden">TX</span>
                  <TxLink chain={chain} hash={touchpoint.txHash} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      );
    });

  return (
    <section className="min-w-0">
      <header className="flex flex-col gap-3 border-b border-border bg-card px-3 py-3 md:flex-row md:items-center md:px-5">
        <div className="min-w-0">
          <h2 className="type-heading">{heading}</h2>
          <p className="type-body-sm text-muted-foreground">{helper}</p>
        </div>
        <Button className="min-h-8 md:ml-auto" onClick={() => void copy()}>
          ⧉ Copy freeze-request list
        </Button>
      </header>
      <div className="space-y-3 p-3 md:p-5">
        {groups.length > 0 ? (
          renderGroups(groups)
        ) : (
          <EmptyState
            glyph="■"
            title={`No ${heading.toLocaleLowerCase()} found`}
            body={
              direction === "backward"
                ? "No labelled exchange wallet was reached at the origin of this trace."
                : "No labelled exchange wallet was reached at the destination of this trace."
            }
          />
        )}
        {other.length > 0 ? (
          <div className="space-y-3">{renderGroups(otherGroups)}</div>
        ) : (
          <div className="rounded-xs border border-dashed border-border-strong p-3">
            <div className="flex items-center gap-2 type-body-sm font-medium">
              <span aria-hidden="true" style={{ color: `var(${CATEGORY_META.exchange.token})` }}>
                ■
              </span>
              <span>{otherHeading} · 0</span>
            </div>
            <p className="mt-1 type-body-sm text-muted-foreground">
              {otherKind === "arrival"
                ? "Arrival exchanges are shown on destination-of-funds traces."
                : "Origin exchanges are shown on source-of-funds traces."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
