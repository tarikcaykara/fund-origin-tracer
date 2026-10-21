import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { ApiError, api, CSV_KINDS, exportCsvUrl, exportJsonUrl, type RunDetail } from "@/api.ts";
import { RiskBadge, StatusBadge } from "@/components/badges.tsx";
import { indexAddresses } from "@/components/links.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { chainName, directionName, formatDuration } from "@/format.ts";
import { useAsync } from "@/hooks/use-async.ts";
import { isLivePhase, type RunState, sortedEdges } from "@/run-state.ts";
import { useRunStream } from "@/use-run-stream.ts";
import { EdgeDetail } from "./workspace/edge-detail.tsx";
import { ExposureTab } from "./workspace/exposure.tsx";
import { FlagsTab } from "./workspace/flags.tsx";
import type { Selection } from "./workspace/graph.tsx";
import { AddressDetail, PairDetail } from "./workspace/graph-detail.tsx";
import { LinkedWalletsTab } from "./workspace/linked.tsx";
import { TouchpointsTab } from "./workspace/touchpoints.tsx";
import { TransfersTab } from "./workspace/transfers.tsx";

const GraphTab = lazy(async () => {
  const module = await import("./workspace/graph.tsx");
  return { default: module.GraphTab };
});

function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : "Unexpected error.";
}

function TitleEditor({ run, onSaved }: { run: RunDetail; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const title = run.title ?? run.id;

  const save = async () => {
    setEditing(false);
    const next = draft.trim();
    if (next === (run.title ?? "")) return;
    try {
      await api.patchRun(run.id, { title: next === "" ? null : next });
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        aria-label="Investigation title"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") setEditing(false);
        }}
        className="max-w-xl text-lg"
      />
    );
  }
  return (
    <div className="flex items-center gap-2">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setDraft(run.title ?? "");
          setEditing(true);
        }}
      >
        Edit title
      </Button>
    </div>
  );
}

function NotesEditor({ run, onSaved }: { run: RunDetail; onSaved: () => void }) {
  const [draft, setDraft] = useState(run.notes ?? "");
  const [savedNotes, setSavedNotes] = useState(run.notes ?? "");
  const dirty = draft !== savedNotes;
  const save = async () => {
    try {
      await api.patchRun(run.id, { notes: draft === "" ? null : draft });
      setSavedNotes(draft);
      toast.success("Notes saved.");
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <details className="rounded-md border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Notes{savedNotes ? " (has notes)" : ""}
      </summary>
      <div className="mt-3 space-y-2">
        <Textarea
          value={draft}
          rows={4}
          aria-label="Investigation notes"
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button size="sm" disabled={!dirty} onClick={() => void save()}>
          Save notes
        </Button>
      </div>
    </details>
  );
}

function ProgressText({ state }: { state: RunState }) {
  const p = state.progress;
  const stats = state.stats;
  const expanded = p?.expandedEdges ?? stats.expandedEdges ?? 0;
  const apiCalls = p?.apiCalls ?? stats.apiCalls ?? 0;
  const cacheHits = p?.cacheHits ?? stats.cacheHits ?? 0;
  return (
    <span className="text-sm text-muted-foreground">
      {Object.keys(state.edges).length} transfers · {expanded} expanded
      {p ? ` · ${p.queued} queued` : ""} · {apiCalls} API calls · {cacheHits} cache hits
      {p ? ` · ${formatDuration(p.elapsedMs)}` : ""}
    </span>
  );
}

const RESULT_PENDING = (
  <p className="text-sm text-muted-foreground">Available when the run finishes.</p>
);

export function WorkspacePage() {
  const { id = "" } = useParams();
  const { state, restart } = useRunStream(id);
  const detail = useAsync(() => api.getRun(id), [id]);
  const [tab, setTab] = useState("graph");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [expanding, setExpanding] = useState(false);
  const [busy, setBusy] = useState(false);

  // Refresh the row (status, risk level, finish time) once the stream is done.
  const { reload } = detail;
  useEffect(() => {
    if (state.done) reload();
  }, [state.done, reload]);

  useEffect(() => {
    if (state.done) setExpanding(false);
  }, [state.done]);

  const run = detail.data;
  const result = state.result;
  const edges = useMemo(() => sortedEdges(state), [state]);
  const labels = useMemo(() => indexAddresses(result?.graph.addresses), [result]);
  const live = isLivePhase(state.phase);
  const chain = run?.chain ?? result?.chain;
  const selectedEdge = selection?.kind === "edge" ? (state.edges[selection.edgeId] ?? null) : null;
  const hasSelection =
    selectedEdge !== null || selection?.kind === "address" || selection?.kind === "pair";

  if (detail.error && !run) {
    return (
      <div className="space-y-3">
        <p className="text-destructive">{detail.error.message}</p>
        <Link to="/runs" className="underline">
          Back to history
        </Link>
      </div>
    );
  }
  if (!run || !chain) return <Skeleton className="h-40 w-full" />;

  const control = async (action: "pause" | "resume" | "cancel") => {
    setBusy(true);
    try {
      await api[action](id);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const expand = async () => {
    if (!selectedEdge) return;
    setExpanding(true);
    try {
      await api.expand(id, selectedEdge.id);
      restart();
    } catch (e) {
      toast.error(errorMessage(e));
      setExpanding(false);
    }
  };

  const selectEdge = (edgeId: string) => {
    setSelection({ kind: "edge", edgeId });
    setTab("graph");
  };

  const riskLevel = result?.riskLevel ?? run.riskLevel;
  const warnings = [...state.warnings, ...(result?.warnings ?? [])];
  const seen = new Set<string>();
  const uniqueWarnings = warnings.filter((w) => {
    const key = `${w.code}:${w.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return (
    <div className="space-y-5">
      <header className="space-y-3">
        <TitleEditor run={run} onSaved={reload} />
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={state.phase} />
          <RiskBadge level={riskLevel} />
          <Badge variant="outline">{chainName(chain)}</Badge>
          <Badge variant="outline">{directionName(run.direction)}</Badge>
          {run.demo ? <Badge variant="secondary">demo</Badge> : null}
          <ProgressText state={state} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {state.phase === "running" ? (
            <Button variant="outline" disabled={busy} onClick={() => void control("pause")}>
              Pause
            </Button>
          ) : null}
          {state.phase === "paused" ? (
            <Button variant="outline" disabled={busy} onClick={() => void control("resume")}>
              Resume
            </Button>
          ) : null}
          {live ? (
            <Button variant="outline" disabled={busy} onClick={() => void control("cancel")}>
              Cancel
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={!result}>
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem asChild>
                <a href={exportJsonUrl(id)} download>
                  Full result (JSON)
                </a>
              </DropdownMenuItem>
              {CSV_KINDS.map(({ kind, label }) => (
                <DropdownMenuItem key={kind} asChild>
                  <a href={exportCsvUrl(id, kind)} download>
                    {label}
                  </a>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" asChild>
            <Link to={`/runs/${id}/report`}>Open report</Link>
          </Button>
        </div>
        <NotesEditor run={run} onSaved={reload} />
      </header>

      {state.error ? (
        <p className="rounded-md border border-destructive p-3 text-sm text-destructive">
          {state.error.code}: {state.error.message}
        </p>
      ) : null}
      {uniqueWarnings.length > 0 ? (
        <ul className="space-y-1 rounded-md border p-3 text-sm">
          {uniqueWarnings.map((w) => (
            <li key={`${w.code}:${w.message}`}>
              <Badge variant="secondary">{w.code}</Badge> {w.message}
            </li>
          ))}
        </ul>
      ) : null}

      <div className={hasSelection ? "grid gap-4 lg:grid-cols-[1fr_28rem]" : undefined}>
        <Tabs value={tab} onValueChange={setTab} className="min-w-0">
          <TabsList className="!h-auto flex-wrap [&_[role=tab]]:!h-auto">
            <TabsTrigger value="graph">Graph</TabsTrigger>
            <TabsTrigger value="transfers">Transfers ({edges.length})</TabsTrigger>
            <TabsTrigger value="exposure">Exposure</TabsTrigger>
            <TabsTrigger value="linked">
              Linked wallets{result ? ` (${result.convergences.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="touchpoints">
              Exchange touchpoints{result ? ` (${result.exchangeTouchpoints.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="flags">
              Flags{result ? ` (${result.flags.length})` : ""}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="graph" className="pt-4">
            <Suspense
              fallback={
                <div className="flex h-[70vh] min-h-[420px] items-center justify-center rounded-md border">
                  <p className="text-sm text-muted-foreground">Loading graph…</p>
                </div>
              }
            >
              <GraphTab
                chain={chain}
                edges={edges}
                result={result}
                live={live}
                selection={selection}
                onSelectEdge={(edgeId) => setSelection({ kind: "edge", edgeId })}
                onSelectAddress={(address) => setSelection({ kind: "address", address })}
                onSelectPair={(from, to) => setSelection({ kind: "pair", from, to })}
              />
            </Suspense>
          </TabsContent>
          <TabsContent value="transfers" className="pt-4">
            <TransfersTab
              chain={chain}
              edges={edges}
              labels={labels}
              selectedId={selection?.kind === "edge" ? selection.edgeId : null}
              onSelect={(edgeId) => setSelection({ kind: "edge", edgeId })}
            />
          </TabsContent>
          <TabsContent value="exposure" className="pt-4">
            {result ? <ExposureTab result={result} /> : RESULT_PENDING}
          </TabsContent>
          <TabsContent value="linked" className="pt-4">
            {result ? <LinkedWalletsTab result={result} /> : RESULT_PENDING}
          </TabsContent>
          <TabsContent value="touchpoints" className="pt-4">
            {result ? <TouchpointsTab result={result} /> : RESULT_PENDING}
          </TabsContent>
          <TabsContent value="flags" className="pt-4">
            {result ? <FlagsTab result={result} onSelectEdge={selectEdge} /> : RESULT_PENDING}
          </TabsContent>
        </Tabs>

        {hasSelection ? (
          <aside>
            {selectedEdge ? (
              <EdgeDetail
                chain={chain}
                edge={selectedEdge}
                labels={labels}
                canExpand={state.done && result !== null}
                expanding={expanding}
                onExpand={() => void expand()}
                onClose={() => setSelection(null)}
              />
            ) : selection?.kind === "address" ? (
              <AddressDetail
                chain={chain}
                address={selection.address}
                edges={edges}
                labels={labels}
                convergence={
                  result?.convergences.some((entry) => entry.address === selection.address) ?? false
                }
                onSelectEdge={(edgeId) => setSelection({ kind: "edge", edgeId })}
                onClose={() => setSelection(null)}
              />
            ) : selection?.kind === "pair" ? (
              <PairDetail
                chain={chain}
                from={selection.from}
                to={selection.to}
                edges={edges}
                labels={labels}
                onSelectEdge={(edgeId) => setSelection({ kind: "edge", edgeId })}
                onClose={() => setSelection(null)}
              />
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
