import { CHAIN_IDS } from "@fot/core/chains";
import type { ChainId } from "@fot/core/schema";
import { type MouseEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { ApiError, api, type InvestigationStatus, type RunSummary } from "@/api.ts";
import { DemoChip, RiskMeter, StatusPill } from "@/components/badges.tsx";
import { EmptyState } from "@/components/empty-state.tsx";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.tsx";
import {
  chainName,
  directionName,
  formatCompactUtc,
  formatUtcMinute,
  shortAddress,
} from "@/format.ts";
import { useAsync } from "@/hooks/use-async.ts";
import { parsePageParam } from "@/page-param.ts";

const PAGE_SIZE = 25;
const ALL = "all";
const STATUSES: InvestigationStatus[] = [
  "completed",
  "cancelled",
  "timed_out",
  "failed",
  "interrupted",
];
const TABLE_SKELETON_KEYS = [
  "table-row-1",
  "table-row-2",
  "table-row-3",
  "table-row-4",
  "table-row-5",
];
const PHONE_SKELETON_KEYS = ["phone-row-1", "phone-row-2", "phone-row-3", "phone-row-4"];

function FilterMenu({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
}) {
  const selectedLabel = options.find((option) => option.value === value)?.label ?? "All";
  const active = value !== ALL;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="default"
          aria-label={`${label} filter: ${selectedLabel}`}
          className={`h-[34px] gap-1.5 rounded-sm px-2.5 type-body-sm ${active ? "border-foreground bg-muted font-semibold" : "border-border-strong"}`}
        >
          <span className="text-muted-foreground">{label}</span>
          <span>{selectedLabel}</span>
          <span aria-hidden="true" className="text-muted-foreground">
            ▾
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function runTitle(run: RunSummary): string {
  return run.title?.trim() || run.id;
}

function seedSummary(run: RunSummary): string {
  const first = run.seeds[0];
  if (!first) return "0";
  const preview = shortAddress(run.chain, first.value);
  return `${run.seeds.length} · ${preview}${run.seeds.length > 1 ? ` +${run.seeds.length - 1}` : ""}`;
}

function RowActions({
  run,
  onDelete,
  desktop,
  alwaysVisible = false,
}: {
  run: RunSummary;
  onDelete(): void;
  desktop: boolean;
  alwaysVisible?: boolean;
}) {
  const active = run.status === "running" || run.status === "paused";
  return (
    <div
      className={`flex items-center justify-end gap-1 transition-opacity ${alwaysVisible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"}`}
    >
      {desktop ? (
        <Button
          asChild
          variant="ghost"
          size="xs"
          onClick={(event) => event.stopPropagation()}
          aria-label={`Open ${runTitle(run)}`}
          className="hidden xl:inline-flex"
        >
          <Link to={`/runs/${run.id}`}>Open</Link>
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={active}
        title={
          active ? "Running or paused investigations cannot be deleted." : "Delete investigation"
        }
        aria-label={`Delete ${runTitle(run)}`}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        className="text-risk-high hover:text-risk-high"
      >
        Delete
      </Button>
    </div>
  );
}

export function HistoryPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get("q") ?? "";
  const chainParam = params.get("chain");
  const statusParam = params.get("status");
  const chain = CHAIN_IDS.find((candidate) => candidate === chainParam);
  const status = STATUSES.find((candidate) => candidate === statusParam);
  const page = parsePageParam(params.get("page"));
  const [qDraft, setQDraft] = useState(q);
  const [deleteTarget, setDeleteTarget] = useState<RunSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [startingDemo, setStartingDemo] = useState(false);

  useEffect(() => setQDraft(q), [q]);

  const update = useCallback(
    (changes: Record<string, string | null>, replace = false) => {
      const next = new URLSearchParams(params);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      if (!("page" in changes)) next.delete("page");
      setParams(next, { replace });
    },
    [params, setParams],
  );

  useEffect(() => {
    if (qDraft.trim() === q) return;
    const timer = window.setTimeout(() => update({ q: qDraft.trim() }, true), 250);
    return () => window.clearTimeout(timer);
  }, [qDraft, q, update]);

  const list = useAsync(
    () =>
      api.listRuns({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        ...(q ? { q } : {}),
        ...(chain ? { chain } : {}),
        ...(status ? { status } : {}),
      }),
    [q, chain, status, page],
  );
  const deleteDetail = useAsync(
    () => (deleteTarget ? api.getRun(deleteTarget.id) : Promise.resolve(null)),
    [deleteTarget?.id],
  );
  const selectedDetail =
    deleteTarget && deleteDetail.data?.id === deleteTarget.id ? deleteDetail.data : null;
  const total = list.data?.total ?? 0;
  const totalAll = list.data?.totalAll ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const items = list.data?.items ?? [];
  const filtered = Boolean(q || chain || status);

  useEffect(() => {
    if (!list.loading && page > 0 && page * PAGE_SIZE >= total && total > 0) {
      update({ page: String(Math.max(0, pageCount - 1)) }, true);
    }
  }, [list.loading, page, total, pageCount, update]);

  const remove = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await api.deleteRun(deleteTarget.id);
      toast.success("Investigation deleted.");
      setDeleteTarget(null);
      list.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Delete failed.");
    } finally {
      setDeleting(false);
    }
  };

  const startDemo = async () => {
    setStartingDemo(true);
    try {
      const demos = await api.demos();
      const demo = demos[0];
      if (!demo) {
        toast.error("No recorded demos are available.");
        return;
      }
      const { runId } = await api.createDemoRun(demo.id);
      navigate(`/runs/${runId}`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not start a demo.");
    } finally {
      setStartingDemo(false);
    }
  };

  // The row click is a mouse convenience; keyboard and screen-reader users open a run through
  // the real link in the title cell.
  const rowProps = (run: RunSummary) => ({
    onClick: (event: MouseEvent<HTMLTableRowElement>) => {
      if ((event.target as HTMLElement).closest("a, button")) return;
      navigate(`/runs/${run.id}`);
    },
    className: "group cursor-pointer hover:bg-muted",
  });

  const emptyAction = (
    <div className="flex flex-wrap justify-center gap-2">
      <Button loading={startingDemo} onClick={() => void startDemo()}>
        ▶ Run a demo
      </Button>
      <Button asChild variant="outline">
        <Link to="/">New investigation</Link>
      </Button>
    </div>
  );

  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);

  return (
    <div className="min-h-[calc(100vh-3rem)] bg-background px-4 py-5 md:px-4 md:py-5 xl:px-8 xl:py-7">
      <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-3.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="type-title">History</h1>
          <p className="type-body-sm text-muted-foreground">
            Past investigations stored on this instance.
          </p>
          <span className="flex-1" />
          <Button asChild size="sm" className="hidden md:inline-flex">
            <Link to="/">+ New investigation</Link>
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-[1_1_100%] md:max-w-[420px] md:flex-1">
            <label htmlFor="history-search" className="sr-only">
              Search title, seed or address
            </label>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 type-body text-muted-foreground"
            >
              ⌕
            </span>
            <Input
              id="history-search"
              value={qDraft}
              onChange={(event) => setQDraft(event.target.value)}
              placeholder="Search title, seed or address"
              className={`h-[34px] rounded-sm border-border-strong pl-8 pr-9 type-body-sm ${q ? "border-foreground shadow-[0_0_0_3px_var(--selection-muted)]" : ""}`}
              aria-label="Search title, seed or address"
            />
            {qDraft ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQDraft("");
                  update({ q: null }, true);
                }}
                className="absolute top-1/2 right-2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                ×
              </button>
            ) : null}
          </div>
          <FilterMenu
            label="Chain"
            value={chain ?? ALL}
            options={[
              { value: ALL, label: "All" },
              ...CHAIN_IDS.map((id) => ({ value: id, label: chainName(id as ChainId) })),
            ]}
            onChange={(value) => update({ chain: value === ALL ? null : value })}
          />
          <FilterMenu
            label="Status"
            value={status ?? ALL}
            options={[
              { value: ALL, label: "All" },
              ...STATUSES.map((value) => ({
                value,
                label: value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()),
              })),
            ]}
            onChange={(value) => update({ status: value === ALL ? null : value })}
          />
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setQDraft("");
                update({ q: null, chain: null, status: null });
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>

        {list.error ? (
          <p role="alert" className="type-body-sm text-destructive">
            {list.error.message}
          </p>
        ) : null}

        {list.loading ? (
          <>
            <div className="hidden overflow-hidden rounded-sm border border-border bg-card md:block">
              <div className="h-8 border-b border-border-strong bg-muted" />
              {TABLE_SKELETON_KEYS.map((key) => (
                <Skeleton key={key} className="h-11 rounded-none border-b border-border" />
              ))}
            </div>
            <div className="flex flex-col overflow-hidden rounded-sm border border-border bg-card md:hidden">
              {PHONE_SKELETON_KEYS.map((key) => (
                <Skeleton key={key} className="h-16 rounded-none border-b border-border" />
              ))}
            </div>
          </>
        ) : list.error ? null : items.length > 0 ? (
          <>
            <div className="hidden overflow-hidden rounded-sm border border-border bg-card md:block">
              <Table className="table-fixed min-w-0">
                <colgroup>
                  <col />
                  <col className="hidden xl:table-column w-[100px]" />
                  <col className="hidden xl:table-column w-[120px]" />
                  <col className="hidden xl:table-column w-[150px]" />
                  <col className="w-[110px] xl:w-[120px]" />
                  <col className="w-[104px] xl:w-[120px]" />
                  <col className="w-[100px] xl:w-[170px]" />
                  <col className="w-11 xl:w-[90px]" />
                </colgroup>
                <TableHeader className="static">
                  <TableRow className="hover:bg-muted">
                    <TableHead>TITLE</TableHead>
                    <TableHead className="hidden xl:table-cell">CHAIN</TableHead>
                    <TableHead className="hidden xl:table-cell">DIRECTION</TableHead>
                    <TableHead className="hidden xl:table-cell">SEEDS</TableHead>
                    <TableHead>STATUS</TableHead>
                    <TableHead>RISK</TableHead>
                    <TableHead sort="descending" className="type-mono-sm text-foreground">
                      CREATED
                    </TableHead>
                    <TableHead aria-label="Actions" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((run) => (
                    <TableRow key={run.id} {...rowProps(run)}>
                      <TableCell className="truncate font-medium">
                        <span className="inline-flex max-w-full items-center gap-2 truncate">
                          <Link
                            to={`/runs/${run.id}`}
                            title={runTitle(run)}
                            className="truncate rounded-xs text-foreground no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {runTitle(run)}
                          </Link>
                          {run.demo ? <DemoChip /> : null}
                        </span>
                      </TableCell>
                      <TableCell className="hidden xl:table-cell">{chainName(run.chain)}</TableCell>
                      <TableCell
                        className="hidden xl:table-cell truncate"
                        title={directionName(run.direction)}
                      >
                        {run.direction === "backward" ? "← Source" : "Destination →"}
                      </TableCell>
                      <TableCell className="hidden xl:table-cell truncate type-mono-sm text-muted-foreground">
                        {seedSummary(run)}
                      </TableCell>
                      <TableCell>
                        <StatusPill status={run.status} live={run.status === "running"} />
                      </TableCell>
                      <TableCell>
                        <RiskMeter level={run.riskLevel} />
                      </TableCell>
                      <TableCell
                        title={run.createdAt}
                        className="type-mono-sm text-muted-foreground xl:whitespace-nowrap"
                      >
                        <span className="xl:hidden">{formatCompactUtc(run.createdAt)}</span>
                        <span className="hidden xl:inline">{formatUtcMinute(run.createdAt)}</span>
                      </TableCell>
                      <TableCell className="px-1">
                        <RowActions run={run} onDelete={() => setDeleteTarget(run)} desktop />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-col overflow-hidden rounded-sm border border-border bg-card md:hidden">
              {items.map((run) => (
                <div
                  key={run.id}
                  className="group relative flex min-h-[60px] flex-col gap-1 border-b border-border px-3.5 py-3 last:border-0 hover:bg-muted"
                >
                  <Link
                    to={`/runs/${run.id}`}
                    aria-label={`Open investigation ${runTitle(run)}`}
                    className="absolute inset-0 z-0 block rounded-sm text-foreground no-underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="sr-only">Open investigation {runTitle(run)}</span>
                  </Link>
                  <div className="pointer-events-none relative z-10 flex flex-col gap-1">
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <span
                        className="inline-flex min-w-0 items-center gap-2 truncate type-body font-medium"
                        title={runTitle(run)}
                      >
                        <span className="truncate">{runTitle(run)}</span>
                        {run.demo ? <DemoChip /> : null}
                      </span>
                      <RiskMeter level={run.riskLevel} short />
                    </div>
                    <div className="flex min-w-0 items-center gap-0.5">
                      <span className="min-w-0 flex-1 truncate type-mono-node text-muted-foreground">
                        {chainName(run.chain)} ·{" "}
                        {run.direction === "backward" ? "source" : "destination"} ·{" "}
                        {run.seeds.length} seed{run.seeds.length === 1 ? "" : "s"}
                      </span>
                      <span className="shrink-0 whitespace-nowrap type-mono-sm text-muted-foreground">
                        {formatCompactUtc(run.createdAt)}
                      </span>
                      <RowActions
                        run={run}
                        onDelete={() => setDeleteTarget(run)}
                        desktop={false}
                        alwaysVisible
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2 type-mono-sm text-muted-foreground">
              <span className="mr-auto">
                {filtered
                  ? `${from}–${to} of ${total} matching · ${totalAll} total`
                  : `${from}–${to} of ${total}`}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => update({ page: String(page - 1) })}
              >
                ‹ Prev
              </Button>
              <span
                aria-current="page"
                className="inline-flex h-7.5 min-w-7.5 items-center justify-center rounded-sm border border-foreground px-2 text-foreground"
              >
                {page + 1}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page + 1 >= pageCount}
                onClick={() => update({ page: String(page + 1) })}
              >
                Next ›
              </Button>
            </div>
          </>
        ) : filtered ? (
          <EmptyState
            glyph={<span className="font-mono text-muted-foreground">⌕</span>}
            title="No investigations match these filters"
            body="Try a different search or clear the filters to see all investigations."
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setQDraft("");
                  update({ q: null, chain: null, status: null });
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            glyph={<span className="font-mono text-muted-foreground">0</span>}
            title="No investigations yet"
            body="Traces you start appear here with their parameters, status and risk level. Run a recorded demo to see a finished one."
            action={emptyAction}
          />
        )}
      </div>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <DialogContent showCloseButton={false} className="gap-0 rounded-md p-0 sm:max-w-[460px]">
          <DialogHeader className="gap-2 px-5 pt-[18px] pb-1.5">
            <DialogTitle className="type-heading">Delete this investigation?</DialogTitle>
            <DialogDescription className="type-body-sm leading-5">
              “{deleteTarget ? runTitle(deleteTarget) : ""}”
              {selectedDetail?.result
                ? ` and its stored result (${selectedDetail.result.graph.addresses.length} addresses, ${selectedDetail.result.graph.edges.length} transfers, ${selectedDetail.result.flags.length} flags)`
                : ""}
              {
                " will be removed from this instance. Exported files and reports you downloaded are not affected."
              }
            </DialogDescription>
          </DialogHeader>
          {deleteTarget ? (
            <div className="mx-5 my-2.5 rounded-sm bg-muted px-3 py-2.5 type-mono-sm leading-5 text-muted-foreground">
              <div className="break-all">run {deleteTarget.id}</div>
              <div>
                {chainName(deleteTarget.chain)} ·{" "}
                {deleteTarget.direction === "backward" ? "← source" : "→ destination"} · created{" "}
                {formatUtcMinute(deleteTarget.createdAt)}
              </div>
            </div>
          ) : null}
          {deleteDetail.error ? (
            <p role="alert" className="px-5 pb-2 type-body-sm text-destructive">
              Counts could not be loaded: {deleteDetail.error.message}
            </p>
          ) : null}
          <DialogFooter className="flex-col gap-2 px-5 pt-2 pb-[18px] sm:flex-row">
            <Button
              type="button"
              variant="outline"
              disabled={deleting}
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={deleting}
              onClick={() => void remove()}
            >
              Delete investigation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
