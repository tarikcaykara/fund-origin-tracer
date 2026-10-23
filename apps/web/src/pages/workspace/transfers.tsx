import type { ChainId, TraceEdge } from "@fot/core/schema";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useState } from "react";
import { StopTag } from "@/components/badges.tsx";
import { AddressChip, type LabelIndex, TxLink } from "@/components/links.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.tsx";
import {
  assetSymbol,
  formatAmount,
  formatCompactTimestamp,
  formatUsd,
  shortAddress,
} from "@/format.ts";
import { useBreakpoint } from "@/hooks/use-breakpoint.ts";
import { cn } from "@/lib/utils.ts";
import type { RunPhase } from "@/run-state.ts";

type Filter = "all" | "expanded" | "stopped";

function getSearchText(edge: TraceEdge, labels: LabelIndex): string {
  const labelText = [edge.from, edge.to]
    .flatMap((address) => labels.get(address)?.labels.map((label) => label.name) ?? [])
    .join(" ");
  return [
    edge.from,
    edge.to,
    edge.transfer.txHash,
    assetSymbol(edge.transfer.asset),
    edge.transfer.asset.kind === "token" ? edge.transfer.asset.contract : "",
    labelText,
  ]
    .join(" ")
    .toLocaleLowerCase();
}

function TransferStatus({ edge }: { edge: TraceEdge }) {
  if (edge.status === "stopped") return <StopTag reason={edge.stopReason} />;
  return (
    <span
      className={cn(
        "type-mono-node",
        edge.status === "expanded" ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {edge.status}
    </span>
  );
}

export function TransfersTab({
  chain,
  edges,
  labels,
  selectedId,
  onSelect,
  phase,
  firstSeen,
}: {
  chain: ChainId;
  edges: TraceEdge[];
  labels: LabelIndex;
  selectedId: string | null;
  onSelect: (id: string) => void;
  phase: RunPhase;
  firstSeen: Readonly<Record<string, number>>;
}) {
  const breakpoint = useBreakpoint();
  const phone = breakpoint === "phone";
  const wide = breakpoint === "desktop";
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(0);
  const [mobileCount, setMobileCount] = useState(20);
  const [now, setNow] = useState(Date.now());

  const matched = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return edges.filter((edge) => !query || getSearchText(edge, labels).includes(query));
  }, [edges, labels, search]);
  const counts = useMemo(
    () => ({
      all: matched.length,
      expanded: matched.filter((edge) => edge.status === "expanded").length,
      stopped: matched.filter((edge) => edge.status === "stopped").length,
    }),
    [matched],
  );
  const filtered = useMemo(
    () =>
      matched.filter((edge) =>
        filter === "all"
          ? true
          : filter === "expanded"
            ? edge.status === "expanded"
            : edge.status === "stopped",
      ),
    [filter, matched],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the search and filter inputs reset pagination.
  useEffect(() => {
    setPage(0);
    setMobileCount(20);
  }, [search, filter]);

  useEffect(() => {
    if (phase !== "running") return;
    const hasNewEdges = edges.some((edge) => {
      const added = firstSeen[edge.id] ?? 0;
      return added > 0 && Date.now() - added < 2000;
    });
    if (!hasNewEdges) return;
    const timer = window.setInterval(() => setNow(Date.now()), 300);
    return () => window.clearInterval(timer);
  }, [edges, firstSeen, phase]);

  const isNew = (edge: TraceEdge) => {
    const added = firstSeen[edge.id] ?? 0;
    return phase === "running" && added > 0 && now - added < 2000;
  };
  const pageSize = 22;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const mobileRows = filtered.slice(0, mobileCount);
  const rangeStart = filtered.length === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = Math.min(filtered.length, (page + 1) * pageSize);

  const rowClassName = (edge: TraceEdge) =>
    cn(
      "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      selectedId === edge.id || isNew(edge)
        ? "bg-selection-muted shadow-[inset_3px_0_0_var(--selection)]"
        : "",
    );
  const rowEvents = (edge: TraceEdge) => ({
    tabIndex: 0,
    "aria-selected": selectedId === edge.id,
    selected: selectedId === edge.id || isNew(edge),
    onClick: () => onSelect(edge.id),
    onKeyDown: (event: ReactKeyboardEvent<HTMLTableRowElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect(edge.id);
      }
    },
  });

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      {(["all", "expanded", "stopped"] as const).map((value) => (
        <button
          type="button"
          key={value}
          aria-pressed={filter === value}
          onClick={() => setFilter(value)}
          className={cn(
            "inline-flex min-h-11 items-center gap-1.5 rounded-xs border px-2 type-mono-node capitalize md:min-h-8",
            filter === value
              ? "border-foreground text-foreground"
              : "border-border-strong text-muted-foreground hover:bg-muted",
          )}
        >
          {value} <span>{counts[value]}</span>
        </button>
      ))}
    </div>
  );

  return (
    <section className="min-w-0">
      <div className="flex flex-col gap-2 border-b border-border bg-card px-3 py-2 md:flex-row md:items-center md:px-4">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="⌕ Filter by address, tx or asset"
          aria-label="Filter transfers by address, transaction or asset"
          className="h-8 w-full md:max-w-[300px]"
        />
        {controls}
        <span className="type-mono-node text-muted-foreground md:ml-auto">
          sorted by hop ↑ then USD ↓
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="m-4 rounded-xs border border-dashed border-border-strong p-5 text-center">
          <p className="type-heading">No transfers match</p>
          <p className="mt-1 type-body-sm text-muted-foreground">
            {edges.length === 0
              ? "Transfers will appear as the trace runs."
              : "Try another search or filter."}
          </p>
        </div>
      ) : phone ? (
        <div className="space-y-2 p-3">
          {mobileRows.map((edge) => (
            <article
              key={edge.id}
              className={cn(
                "overflow-hidden rounded-xs border border-border bg-card",
                (selectedId === edge.id || isNew(edge)) &&
                  "border-selection bg-selection-muted shadow-[inset_3px_0_0_var(--selection)]",
              )}
            >
              <button
                type="button"
                aria-pressed={selectedId === edge.id}
                onClick={() => onSelect(edge.id)}
                className="block min-h-11 w-full p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="type-overline">HOP {edge.depth}</span>
                  <span className="type-mono-sm">{formatUsd(edge.usd)}</span>
                </span>
                <span
                  className="mt-2 block truncate type-mono-sm"
                  title={`${edge.from} → ${edge.to}`}
                >
                  {shortAddress(chain, edge.from)}{" "}
                  <span className="px-1 text-muted-foreground">→</span>
                  {shortAddress(chain, edge.to)}
                </span>
                <span className="mt-1 flex flex-wrap items-baseline gap-x-2 type-body-sm">
                  <span className="type-amount">{formatAmount(edge.transfer.amount)}</span>
                  <span className="text-muted-foreground">{assetSymbol(edge.transfer.asset)}</span>
                  <span className="ml-auto type-mono-node text-muted-foreground">
                    {formatCompactTimestamp(edge.transfer.timestamp)} UTC
                  </span>
                </span>
              </button>
              <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 type-mono-node text-muted-foreground max-md:[&_button]:min-h-11 max-md:[&_a]:inline-flex max-md:[&_a]:min-h-11 max-md:[&_a]:items-center">
                <TransferStatus edge={edge} />
                <TxLink chain={chain} hash={edge.transfer.txHash} />
              </div>
            </article>
          ))}
          {mobileRows.length < filtered.length ? (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setMobileCount((count) => count + 20)}
            >
              Load 20 more
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <Table density="dense" className="min-w-[720px]">
            <TableHeader className="sticky top-0 z-[1]">
              <TableRow>
                <TableHead sort="ascending">HOP</TableHead>
                {wide ? <TableHead>TIME UTC</TableHead> : null}
                <TableHead>{wide ? "FROM" : "FROM → TO"}</TableHead>
                {wide ? <TableHead>TO</TableHead> : null}
                <TableHead>AMOUNT</TableHead>
                <TableHead sort="descending" className="text-right">
                  USD
                </TableHead>
                {wide ? <TableHead className="text-right">SCORE</TableHead> : null}
                <TableHead>STATUS</TableHead>
                {wide ? <TableHead>TX</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((edge) => (
                <TableRow
                  key={edge.id}
                  {...rowEvents(edge)}
                  className={rowClassName(edge)}
                  selected={selectedId === edge.id || isNew(edge)}
                >
                  <TableCell className="type-mono-node">{edge.depth}</TableCell>
                  {wide ? (
                    <TableCell className="whitespace-nowrap type-mono-node text-muted-foreground">
                      {formatCompactTimestamp(edge.transfer.timestamp)}
                    </TableCell>
                  ) : null}
                  <TableCell className="type-mono-sm">
                    <AddressChip chain={chain} address={edge.from} />
                    {!wide ? <span className="px-1 text-muted-foreground">→</span> : null}
                    {!wide ? <AddressChip chain={chain} address={edge.to} /> : null}
                  </TableCell>
                  {wide ? (
                    <TableCell className="type-mono-sm">
                      <AddressChip chain={chain} address={edge.to} />
                    </TableCell>
                  ) : null}
                  <TableCell className="whitespace-nowrap type-mono-sm">
                    {formatAmount(edge.transfer.amount)} {assetSymbol(edge.transfer.asset)}
                  </TableCell>
                  <TableCell className="text-right type-mono-sm">{formatUsd(edge.usd)}</TableCell>
                  {wide ? (
                    <TableCell className="text-right type-mono-node">
                      {edge.selection ? edge.selection.score.toFixed(2) : "—"}
                    </TableCell>
                  ) : null}
                  <TableCell>
                    <TransferStatus edge={edge} />
                  </TableCell>
                  {wide ? (
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      <TxLink chain={chain} hash={edge.transfer.txHash} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <footer className="flex items-center justify-between gap-3 border-t border-border px-4 py-2 type-mono-node">
            <span>
              {rangeStart}–{rangeEnd} of {filtered.length}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page === 0}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
              >
                ‹ Prev
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page + 1 >= pageCount}
                onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
              >
                Next ›
              </Button>
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
