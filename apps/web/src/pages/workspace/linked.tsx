import type { AnalysisResult, Convergence } from "@fot/core/schema";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state.tsx";
import { AddressChip, TxLink } from "@/components/links.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import {
  assetSymbol,
  formatAmount,
  formatCompactTimestamp,
  formatUsd,
  shortAddress,
} from "@/format.ts";
import { cn } from "@/lib/utils.ts";
import type { Selection } from "@/selection.ts";

function roleLabel(convergence: Convergence, direction: "backward" | "forward"): string {
  if (convergence.role === "common_source" && direction === "backward") return "common funder";
  if (convergence.role === "common_source") return "common source";
  return direction === "backward" ? "common destination" : "common recipient";
}

export function LinkedWalletsTab({
  result,
  onSelect,
  onTraceForward,
}: {
  result: AnalysisResult;
  onSelect: (selection: Selection) => void;
  onTraceForward: (address: string) => void;
}) {
  const { chain, convergences, direction } = result;
  const [filter, setFilter] = useState<"all" | "across" | "within">("all");
  const [openAddress, setOpenAddress] = useState<string | null>(
    () => convergences[0]?.address ?? null,
  );
  const [confirmAddress, setConfirmAddress] = useState<string | null>(null);
  const acrossCount = convergences.filter((entry) =>
    entry.kinds.includes("shared_across_seeds"),
  ).length;
  const withinCount = convergences.filter((entry) =>
    entry.kinds.includes("shared_within_trace"),
  ).length;
  const filtered = convergences.filter((entry) =>
    filter === "all"
      ? true
      : filter === "across"
        ? entry.kinds.includes("shared_across_seeds")
        : entry.kinds.includes("shared_within_trace"),
  );
  const seedLine = result.seeds.map((seed) => seed.id).join(" · ");

  if (convergences.length === 0) {
    return (
      <div className="p-3 md:p-5">
        <EmptyState
          glyph="⧉"
          title="No linked wallets found"
          body={
            result.seeds.length < 2
              ? "Linked wallets need at least two seeds or a shared source within the trace."
              : "No wallet was shared across the seeds or branches in this trace."
          }
        />
      </div>
    );
  }

  return (
    <section className="min-w-0 p-3 md:p-5">
      <div className="flex flex-col gap-2 border-b border-border pb-3 md:flex-row md:items-center">
        <div className="flex flex-wrap gap-2">
          {(["across", "within"] as const).map((value) => {
            const selected = filter === value;
            const label = value === "across" ? "across seeds" : "within trace";
            const count = value === "across" ? acrossCount : withinCount;
            return (
              <button
                type="button"
                key={value}
                aria-pressed={selected}
                onClick={() => setFilter(selected ? "all" : value)}
                className={cn(
                  "inline-flex min-h-11 items-center gap-1.5 rounded-xs border px-2 type-mono-node md:min-h-8",
                  selected
                    ? "border-foreground text-foreground"
                    : "border-border-strong text-muted-foreground",
                )}
              >
                {label} <span>{count}</span>
              </button>
            );
          })}
        </div>
        <p className="type-mono-node text-muted-foreground md:ml-auto">Seeds: {seedLine}</p>
      </div>

      <div className="mt-3 space-y-2">
        {filtered.map((entry) => {
          const opened = openAddress === entry.address;
          const sortedTransfers = [...entry.otherCounterparties].sort(
            (a, b) => b.amount - a.amount,
          );
          const shownTransfers = sortedTransfers.slice(0, 8);
          return (
            <article
              key={`${entry.role}:${entry.address}`}
              className={cn(
                "overflow-hidden rounded-xs border bg-card",
                opened ? "border-selection shadow-[0_0_0_1px_var(--selection)]" : "border-border",
              )}
            >
              <button
                type="button"
                aria-expanded={opened}
                onClick={() => setOpenAddress(opened ? null : entry.address)}
                className="grid min-h-14 w-full grid-cols-[20px_minmax(0,1fr)] items-center gap-2 p-3 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:grid-cols-[20px_minmax(160px,1.2fr)_minmax(160px,1.2fr)_auto_auto]"
              >
                <span aria-hidden="true" className="type-mono-node text-muted-foreground">
                  {opened ? "⌄" : "›"}
                </span>
                <span className="min-w-0">
                  <span className="block truncate type-mono-sm font-semibold" title={entry.address}>
                    {shortAddress(chain, entry.address)}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1.5">
                    <span className="rounded-xs border border-border-strong px-1.5 py-0.5 type-mono-node text-selection">
                      {roleLabel(entry, direction)} ·{" "}
                      {entry.kinds
                        .map((kind) =>
                          kind === "shared_across_seeds" ? "across seeds" : "within trace",
                        )
                        .join(" + ")}
                    </span>
                    {entry.seedIds.map((seedId) => (
                      <span
                        key={seedId}
                        className="rounded-xs bg-muted px-1.5 py-0.5 type-mono-node text-muted-foreground"
                      >
                        {seedId}
                      </span>
                    ))}
                  </span>
                </span>
                <span className="hidden type-mono-node text-muted-foreground md:block">
                  {entry.counterparties.length} in trace · hop ≥{entry.minDepth}
                </span>
                <span className="type-mono-sm">{formatUsd(entry.usd)}</span>
                <span className="hidden type-mono-node text-muted-foreground xl:block">
                  {entry.totals
                    .map((total) => `${formatAmount(total.amount)} ${total.symbol}`)
                    .join(" · ") || "—"}
                </span>
              </button>

              {opened ? (
                <div className="space-y-3 border-t border-border p-3 md:p-4">
                  <div className="flex flex-col gap-1 md:flex-row md:items-baseline md:justify-between">
                    <h3 className="type-heading">
                      {direction === "backward"
                        ? "Who else did this wallet pay"
                        : "Who else paid this wallet"}
                    </h3>
                    <span className="type-mono-node text-muted-foreground">
                      {entry.otherCounterparties.length} outgoing transfers outside the trace ·
                      showing {shownTransfers.length} by amount
                    </span>
                  </div>
                  <p className="type-mono-node text-muted-foreground">
                    Totals:{" "}
                    {entry.totals
                      .map((total) => `${formatAmount(total.amount)} ${total.symbol}`)
                      .join(" · ") || "—"}
                  </p>

                  {shownTransfers.length > 0 ? (
                    <ul className="divide-y divide-border rounded-xs border border-border">
                      {shownTransfers.map((transfer) => (
                        <li
                          key={`${transfer.txHash}:${transfer.from}:${transfer.to}:${transfer.amountRaw}`}
                          className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2 md:grid-cols-[minmax(0,1.2fr)_minmax(95px,.7fr)_minmax(105px,.8fr)_auto] max-md:[&_button]:min-h-11"
                        >
                          <span className="min-w-0 truncate type-mono-sm">
                            <span className="mr-1 type-mono-node text-muted-foreground">→</span>
                            <AddressChip
                              chain={chain}
                              address={direction === "backward" ? transfer.to : transfer.from}
                            />
                          </span>
                          <span className="type-mono-sm">
                            {formatAmount(transfer.amount)} {assetSymbol(transfer.asset)}
                          </span>
                          <span className="type-mono-node text-muted-foreground">
                            {formatCompactTimestamp(transfer.timestamp)}
                          </span>
                          <span className="justify-self-end">
                            <TxLink chain={chain} hash={transfer.txHash} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="type-body-sm text-muted-foreground">
                      No outside-trace transfers were recorded.
                    </p>
                  )}

                  <div className="flex flex-col gap-2 sm:flex-row">
                    {direction === "backward" ? (
                      <Button variant="outline" onClick={() => setConfirmAddress(entry.address)}>
                        Trace forward from {shortAddress(chain, entry.address)}
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      onClick={() =>
                        onSelect({
                          kind: "set",
                          addresses: [entry.address],
                          edgeIds: entry.edgeIds,
                          title: `Linked wallet ${shortAddress(chain, entry.address)}`,
                        })
                      }
                    >
                      Select in graph
                    </Button>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      <Dialog
        open={confirmAddress !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAddress(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start a live trace?</DialogTitle>
            <DialogDescription>
              This starts a new forward investigation from{" "}
              {confirmAddress ? shortAddress(chain, confirmAddress) : "this wallet"} using the same
              limits. It will use the configured explorer API.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAddress(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (confirmAddress) onTraceForward(confirmAddress);
                setConfirmAddress(null);
              }}
            >
              Start live trace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
