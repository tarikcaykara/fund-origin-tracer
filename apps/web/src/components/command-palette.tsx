import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api, type RunList } from "@/api.ts";
import { DemoChip, SeverityTag, StatusPill } from "@/components/badges.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.tsx";
import {
  assetSymbol,
  chainName,
  formatAmount,
  formatCompactUtc,
  runTitle,
  shortAddress,
  shortHash,
} from "@/format.ts";
import { useAsync } from "@/hooks/use-async.ts";
import {
  createPaletteIndex,
  flagSelection,
  groupHeading,
  normalizeQuery,
  PALETTE_MIN_QUERY,
  PALETTE_RUN_DEBOUNCE_MS,
  PALETTE_RUN_LIMIT,
  searchPalette,
} from "@/palette.ts";
import { usePaletteSource } from "@/palette-context.tsx";

const HINT_CLASS = "px-2 py-3 type-body-sm text-muted-foreground";
const STATUS_CLASS = "px-2 py-1.5 type-body-sm text-muted-foreground";

function PaletteBody({
  onPick,
  onClose,
}: {
  onPick: (action: () => void) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  const [runQuery, setRunQuery] = useState(trimmed);
  const source = usePaletteSource();
  const navigate = useNavigate();

  useEffect(() => {
    if (trimmed === runQuery) return;
    const timer = window.setTimeout(() => setRunQuery(trimmed), PALETTE_RUN_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [trimmed, runQuery]);

  const index = useMemo(() => (source ? createPaletteIndex(source) : null), [source]);
  const normalized = normalizeQuery(query);
  const matches = useMemo(
    () => (index ? searchPalette(index, normalized) : null),
    [index, normalized],
  );
  const runs = useAsync<RunList | null>(
    () =>
      normalizeQuery(runQuery).length >= PALETTE_MIN_QUERY
        ? api.listRuns({ q: runQuery, limit: PALETTE_RUN_LIMIT })
        : Promise.resolve(null),
    [runQuery],
  );

  const searching = normalized.length >= PALETTE_MIN_QUERY;
  // Until the debounced query has loaded, the run results belong to an earlier query.
  const runsPending = runs.loading || runQuery !== trimmed;
  const runItems = runsPending ? [] : (runs.data?.items ?? []);
  const localCount = matches
    ? matches.addresses.items.length + matches.transfers.items.length + matches.flags.items.length
    : 0;
  const noMatches =
    searching && localCount === 0 && !runsPending && !runs.error && runItems.length === 0;

  return (
    <Command shouldFilter={false} loop label="Search">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search address, tx or label"
          aria-label="Search"
        />
        <kbd className="hidden rounded-[3px] border border-border-strong px-1 font-mono text-[11px] font-medium text-muted-foreground md:inline">
          Esc
        </kbd>
        <Button variant="ghost" size="sm" className="md:hidden" onClick={onClose}>
          Cancel
        </Button>
      </div>
      <CommandList>
        {!searching ? (
          <p className={HINT_CLASS}>
            {source
              ? "Search this run's addresses, transfers and flags, and saved runs. Type at least 2 characters."
              : "Search saved runs by title, notes, seed or id. Type at least 2 characters."}
          </p>
        ) : null}
        {source && matches && matches.addresses.items.length > 0 ? (
          <CommandGroup
            heading={groupHeading(
              "Addresses",
              matches.addresses.items.length,
              matches.addresses.total,
            )}
          >
            {matches.addresses.items.map((node) => {
              const label = node.labels[0];
              return (
                <CommandItem
                  key={node.address}
                  value={`address:${node.address}`}
                  onSelect={() =>
                    onPick(() => source.select({ kind: "address", address: node.address }))
                  }
                >
                  <span className="shrink-0 type-mono-sm">
                    {shortAddress(source.chain, node.address)}
                  </span>
                  {label ? (
                    <span className="min-w-0 truncate text-muted-foreground">{label.name}</span>
                  ) : null}
                  {node.sanctioned ? (
                    <span className="ml-auto shrink-0 type-mono-node text-destructive">⊘ SDN</span>
                  ) : node.isSeedSubject ? (
                    <span className="ml-auto shrink-0 type-mono-node text-muted-foreground">
                      SEED
                    </span>
                  ) : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}
        {source && matches && matches.transfers.items.length > 0 ? (
          <CommandGroup
            heading={groupHeading(
              "Transfers",
              matches.transfers.items.length,
              matches.transfers.total,
            )}
          >
            {matches.transfers.items.map((edge) => (
              <CommandItem
                key={edge.id}
                value={`edge:${edge.id}`}
                onSelect={() => onPick(() => source.select({ kind: "edge", edgeId: edge.id }))}
              >
                <span className="shrink-0 type-mono-sm">{shortHash(edge.transfer.txHash)}</span>
                <span className="min-w-0 truncate text-muted-foreground">
                  {`${shortAddress(source.chain, edge.from)} → ${shortAddress(source.chain, edge.to)}`}
                </span>
                <span className="ml-auto shrink-0 whitespace-nowrap type-mono-sm">
                  {`${formatAmount(edge.transfer.amount)} ${assetSymbol(edge.transfer.asset)}`}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {source && matches && matches.flags.items.length > 0 ? (
          <CommandGroup
            heading={groupHeading("Flags", matches.flags.items.length, matches.flags.total)}
          >
            {matches.flags.items.map((flag) => (
              <CommandItem
                key={flag.id}
                value={`flag:${flag.id}`}
                onSelect={() => onPick(() => source.select(flagSelection(flag)))}
              >
                <SeverityTag severity={flag.severity} />
                <span className="min-w-0 truncate">{flag.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {searching && runsPending ? <p className={STATUS_CLASS}>Searching saved runs…</p> : null}
        {searching && !runsPending && runs.error ? (
          <p className={`${STATUS_CLASS} text-destructive`}>
            {`Run search failed: ${runs.error.message}`}
          </p>
        ) : null}
        {searching && !runs.error && runs.data && runItems.length > 0 ? (
          <CommandGroup heading={groupHeading("Runs", runItems.length, runs.data.total)}>
            {runItems.map((run) => (
              <CommandItem
                key={run.id}
                value={`run:${run.id}`}
                onSelect={() => onPick(() => navigate(`/runs/${encodeURIComponent(run.id)}`))}
              >
                <span className="min-w-0 truncate">{runTitle(run)}</span>
                {run.demo ? <DemoChip /> : null}
                <span className="shrink-0 whitespace-nowrap type-mono-node text-muted-foreground">
                  {`${chainName(run.chain)} · ${formatCompactUtc(run.createdAt)}`}
                </span>
                <span className="ml-auto shrink-0">
                  <StatusPill status={run.status} />
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {noMatches ? <p className={HINT_CLASS}>{`No matches for “${trimmed}”.`}</p> : null}
      </CommandList>
    </Command>
  );
}

/** ⌘K search over the open run (addresses, transfers, flags) and saved runs. */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Set by a pick so closing does not move focus back to the trigger (it would leave the
  // phone detail sheet, which focuses itself on mount).
  const picked = useRef(false);
  const pick = useCallback(
    (action: () => void) => {
      picked.current = true;
      onOpenChange(false);
      action();
    },
    [onOpenChange],
  );
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex flex-col gap-0 overflow-hidden bg-popover p-0 text-popover-foreground md:top-[12vh] md:max-w-[560px] md:translate-y-0 max-md:top-0 max-md:h-dvh max-md:max-h-none max-md:overflow-hidden max-md:rounded-none"
        onCloseAutoFocus={(event) => {
          if (picked.current) event.preventDefault();
          picked.current = false;
        }}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Search addresses, transfers and flags of the open run, and saved runs.
        </DialogDescription>
        <PaletteBody onPick={pick} onClose={close} />
      </DialogContent>
    </Dialog>
  );
}
