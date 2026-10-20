import { CHAIN_IDS } from "@fot/core/chains";
import type { ChainId } from "@fot/core/schema";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { ApiError, api, type InvestigationStatus } from "@/api.ts";
import { RiskBadge, StatusBadge } from "@/components/badges.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.tsx";
import { chainName, directionName, relativeTime } from "@/format.ts";
import { useAsync } from "@/hooks/use-async.ts";

const PAGE_SIZE = 20;
const ALL = "all";
const STATUSES: InvestigationStatus[] = [
  "running",
  "completed",
  "cancelled",
  "timed_out",
  "failed",
  "interrupted",
];

export function HistoryPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const chainParam = params.get("chain");
  const statusParam = params.get("status");
  const chain = CHAIN_IDS.find((c) => c === chainParam);
  const status = STATUSES.find((s) => s === statusParam);
  const page = Math.max(0, Number(params.get("page") ?? 0) || 0);
  const [qDraft, setQDraft] = useState(q);

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

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    if (!("page" in changes)) next.delete("page");
    setParams(next);
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this investigation? This cannot be undone.")) return;
    try {
      await api.deleteRun(id);
      toast.success("Investigation deleted.");
      list.reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Delete failed.");
    }
  };

  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">History</h1>

      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          update({ q: qDraft.trim() });
        }}
      >
        <Input
          value={qDraft}
          onChange={(e) => setQDraft(e.target.value)}
          placeholder="Search title, notes, seeds, id"
          aria-label="Search"
          className="w-72"
        />
        <Button type="submit" variant="outline">
          Search
        </Button>
        <Select value={chain ?? ALL} onValueChange={(v) => update({ chain: v === ALL ? null : v })}>
          <SelectTrigger aria-label="Chain filter" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All chains</SelectItem>
            {CHAIN_IDS.map((c) => (
              <SelectItem key={c} value={c}>
                {chainName(c as ChainId)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={status ?? ALL}
          onValueChange={(v) => update({ status: v === ALL ? null : v })}
        >
          <SelectTrigger aria-label="Status filter" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s.replace("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </form>

      {list.error ? <p className="text-sm text-destructive">{list.error.message}</p> : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Chain</TableHead>
            <TableHead>Direction</TableHead>
            <TableHead>Seeds</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Risk</TableHead>
            <TableHead>Created</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {(list.data?.items ?? []).map((run) => (
            <TableRow key={run.id}>
              <TableCell>
                <Link to={`/runs/${run.id}`} className="underline underline-offset-2">
                  {run.title ?? run.id}
                </Link>
                {run.demo ? <span className="ml-2 text-xs text-muted-foreground">demo</span> : null}
              </TableCell>
              <TableCell>{chainName(run.chain)}</TableCell>
              <TableCell>{directionName(run.direction)}</TableCell>
              <TableCell>{run.seeds.length}</TableCell>
              <TableCell>
                <StatusBadge status={run.status} />
              </TableCell>
              <TableCell>
                <RiskBadge level={run.riskLevel} />
              </TableCell>
              <TableCell title={run.createdAt}>{relativeTime(run.createdAt)}</TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={run.status === "running" || run.status === "paused"}
                  onClick={() => void remove(run.id)}
                >
                  Delete
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {list.data && list.data.items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-muted-foreground">
                No investigations yet.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {total} investigation{total === 1 ? "" : "s"} · page {page + 1} of {pageCount}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => update({ page: String(page - 1) })}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page + 1 >= pageCount}
            onClick={() => update({ page: String(page + 1) })}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
