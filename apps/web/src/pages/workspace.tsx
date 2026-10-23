import type { AnalysisResult, TraceEdge } from "@fot/core/schema";
import { Clock3 } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import type { LiveRunRequest } from "@/api.ts";
import { ApiError, api, type RunDetail } from "@/api.ts";
import { EmptyState } from "@/components/empty-state.tsx";
import { indexAddresses } from "@/components/links.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Tabs, TabsContent } from "@/components/ui/tabs.tsx";
import { chainName } from "@/format.ts";
import { useAsync } from "@/hooks/use-async.ts";
import { useBreakpoint } from "@/hooks/use-breakpoint.ts";
import { isLivePhase, type RunPhase, sortedEdges } from "@/run-state.ts";
import type { Selection } from "@/selection.ts";
import { useRunStream } from "@/use-run-stream.ts";
import { WorkspaceBanners } from "./workspace/banners.tsx";
import { ExposureTab } from "./workspace/exposure.tsx";
import { FlagsTab } from "./workspace/flags.tsx";
import { WorkspaceHeader } from "./workspace/header.tsx";
import { LinkedWalletsTab } from "./workspace/linked.tsx";
import { PanelHost } from "./workspace/panel-host.tsx";
import { WorkspaceTabBar } from "./workspace/tab-bar.tsx";
import { TouchpointsTab } from "./workspace/touchpoints.tsx";
import { TransfersTab } from "./workspace/transfers.tsx";

// Keep the graph canvas in its own async chunk; it is the largest workspace view.
const GraphTab = lazy(async () => {
  const module = await import("./workspace/graph.tsx");
  return { default: module.GraphTab };
});

// Path rendering is also only needed after opening a workspace on a phone.
const PathView = lazy(async () => {
  const module = await import("./workspace/path-view.tsx");
  return { default: module.PathView };
});

function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : error instanceof Error
      ? error.message
      : "Unexpected error.";
}

function transferOrder(a: TraceEdge, b: TraceEdge): number {
  const depth = a.depth - b.depth;
  if (depth !== 0) return depth;
  if (a.usd === null && b.usd !== null) return 1;
  if (a.usd !== null && b.usd === null) return -1;
  if (a.usd !== null && b.usd !== null && a.usd !== b.usd) return b.usd - a.usd;
  return 0;
}

function getVisiblePhase(run: RunDetail, phase: RunPhase): RunPhase {
  if (phase !== "connecting") return phase;
  return run.status === "interrupted" ? "failed" : run.status;
}

function ProvisionalStrip({ phase }: { phase: RunPhase }) {
  if (phase === "completed") return null;
  const copy: Record<Exclude<RunPhase, "completed">, { tag: string; text: string }> = {
    connecting: { tag: "● LIVE", text: "Connecting to the live run stream." },
    running: {
      tag: "● LIVE",
      text: "Provisional · transfers are still arriving; analysis is deferred.",
    },
    paused: {
      tag: "❚❚ PAUSED",
      text: "Provisional · the run is paused; derived analysis is deferred.",
    },
    cancelled: {
      tag: "□ CANCELLED",
      text: "Partial result · analysis reflects the transfers retained before cancellation.",
    },
    failed: {
      tag: "✕ FAILED",
      text: "Partial result · analysis reflects the transfers retained before the run failed.",
    },
    timed_out: {
      tag: "✕ FAILED",
      text: "Partial result · analysis reflects the transfers retained before timeout.",
    },
  };
  const message = copy[phase];
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 bg-selection-muted px-4 py-1.5">
      <span className="type-mono-node font-semibold text-selection">{message.tag}</span>
      <span className="type-body-sm text-selection">{message.text}</span>
    </div>
  );
}

function WaitingForResult() {
  return (
    <div className="p-3 md:p-5">
      <EmptyState
        icon={Clock3}
        title="Available when the run finishes"
        body="Derived analysis is deferred until the trace has a final result."
      />
    </div>
  );
}

function getRerunBody(run: RunDetail): LiveRunRequest {
  return {
    chain: run.chain,
    direction: run.direction,
    seeds: run.seeds.map(({ kind, value }) => ({ kind, value })),
    maxDepth: run.params.maxDepth,
    maxBranches: run.params.maxBranches,
    maxEdges: run.params.maxEdges,
    minUsd: run.params.minUsd,
    traceThroughEntities: run.params.traceThroughEntities,
    followUnpriced: run.params.followUnpriced,
    timeoutSec: run.params.timeoutSec,
  };
}

export function WorkspacePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { state, firstSeen, restart } = useRunStream(id);
  const detail = useAsync(() => api.getRun(id), [id]);
  const health = useAsync(() => api.health(), []);
  const [tab, setTab] = useState("graph");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [expanding, setExpanding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fullGraph, setFullGraph] = useState(false);
  const phone = useBreakpoint() === "phone";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` resets per-run UI state on navigation.
  useEffect(() => {
    setTab("graph");
    setSelection(null);
    setExpanding(false);
    setBusy(false);
    setFullGraph(false);
  }, [id]);

  const { reload } = detail;
  useEffect(() => {
    if (state.done) reload();
  }, [state.done, reload]);
  useEffect(() => {
    if (state.done) setExpanding(false);
  }, [state.done]);
  useEffect(() => {
    if (!fullGraph && !(phone && selection !== null)) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (phone && selection !== null) setSelection(null);
      else setFullGraph(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [fullGraph, phone, selection]);

  const run = detail.data?.id === id ? detail.data : null;
  const result: AnalysisResult | null = state.result ?? run?.result ?? null;
  const edges = useMemo(() => {
    const streamed = sortedEdges(state);
    if (state.result || !result || streamed.length > 0) return streamed;
    return [...result.graph.edges].sort(transferOrder);
  }, [result, state]);
  const labels = useMemo(() => indexAddresses(result?.graph.addresses), [result]);
  const phase = run ? getVisiblePhase(run, state.phase) : state.phase;
  const live = isLivePhase(phase) || phase === "connecting";
  const riskLevel = result?.riskLevel ?? run?.riskLevel ?? null;
  const selectedEdge =
    selection?.kind === "edge"
      ? (edges.find((edge) => edge.id === selection.edgeId) ?? null)
      : null;
  const canExpand = state.done && result !== null && selectedEdge !== null;
  const selectedEdgeIndex = selectedEdge
    ? edges.findIndex((edge) => edge.id === selectedEdge.id)
    : -1;

  const control = useCallback(
    async (action: "pause" | "resume" | "cancel") => {
      setBusy(true);
      try {
        await api[action](id);
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  const rerun = useCallback(async () => {
    if (
      !run ||
      phase === "running" ||
      phase === "paused" ||
      phase === "connecting" ||
      phase === "completed"
    )
      return;
    setBusy(true);
    try {
      const next = run.demo
        ? await api.createDemoRun(run.demo)
        : await api.createRun(getRerunBody(run));
      navigate(`/runs/${encodeURIComponent(next.runId)}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [navigate, phase, run]);

  const expand = useCallback(
    async (edgeId: string) => {
      setExpanding(true);
      try {
        await api.expand(id, edgeId);
        restart();
      } catch (error) {
        toast.error(errorMessage(error));
        setExpanding(false);
      }
    },
    [id, restart],
  );

  const onClosePanel = useCallback(() => setSelection(null), []);
  const onPanelSelect = useCallback((next: Selection | null) => setSelection(next), []);
  const selectInGraph = useCallback((next: Selection) => {
    setSelection(next);
    setTab("graph");
  }, []);
  const edgeStep = useCallback(
    (direction: -1 | 1) => {
      if (selection?.kind !== "edge") return;
      const index = edges.findIndex((edge) => edge.id === selection.edgeId);
      const next = edges[index + direction];
      if (next) setSelection({ kind: "edge", edgeId: next.id });
    },
    [edges, selection],
  );
  const previousEdge = useCallback(() => edgeStep(-1), [edgeStep]);
  const nextEdge = useCallback(() => edgeStep(1), [edgeStep]);
  const onExpand = useCallback(
    (edgeId: string) => {
      void expand(edgeId);
    },
    [expand],
  );
  const traceForward = useCallback(
    async (address: string) => {
      if (!run) return;
      setBusy(true);
      try {
        const next = await api.createRun({
          chain: run.chain,
          direction: "forward",
          seeds: [{ kind: "address", value: address }],
          maxDepth: run.params.maxDepth,
          maxBranches: run.params.maxBranches,
          maxEdges: run.params.maxEdges,
          minUsd: run.params.minUsd,
          traceThroughEntities: run.params.traceThroughEntities,
          followUnpriced: run.params.followUnpriced,
          timeoutSec: run.params.timeoutSec,
        });
        navigate(`/runs/${encodeURIComponent(next.runId)}`);
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [navigate, run],
  );

  if (!run && detail.loading) return <Skeleton className="m-4 h-40 w-[calc(100%-2rem)]" />;
  if (detail.error && !run) {
    return (
      <div className="space-y-3 p-4">
        <p className="text-destructive">{detail.error.message}</p>
        <Link to="/runs" className="underline">
          Back to history
        </Link>
      </div>
    );
  }
  if (!run) return <Skeleton className="m-4 h-40 w-[calc(100%-2rem)]" />;

  const pathGraph = (
    <Suspense
      fallback={<div className="p-5 type-body-sm text-muted-foreground">Loading path…</div>}
    >
      <PathView
        chain={run.chain}
        edges={edges}
        result={result}
        phase={phase}
        onSelect={setSelection}
      />
    </Suspense>
  );
  const graph = (
    <Suspense
      fallback={
        <div className="flex min-h-[420px] items-center justify-center type-body-sm text-muted-foreground">
          Loading graph…
        </div>
      }
    >
      <GraphTab
        chain={run.chain}
        edges={edges}
        result={result}
        phase={phase}
        params={run.params}
        density={phone && fullGraph ? "dots" : undefined}
        selection={selection}
        onSelect={setSelection}
      />
    </Suspense>
  );

  const healthData = health.data;
  const expandBlockedReason = healthData?.demoOnly
    ? "This instance only serves recorded demo scenarios, so expanding is disabled."
    : healthData && healthData.chains[run.chain] !== "ready"
      ? `${chainName(run.chain)} is not ready (API key missing), so expanding is disabled.`
      : undefined;
  const expandNote = run.demo
    ? "This run is a recorded demo: expanding calls the live explorer API."
    : undefined;

  const panel = selection ? (
    <PanelHost
      chain={run.chain}
      selection={selection}
      edges={edges}
      result={result}
      labels={labels}
      params={run.params}
      canExpand={canExpand}
      expanding={expanding}
      expandNote={expandNote}
      expandBlockedReason={expandBlockedReason}
      onExpand={onExpand}
      onSelect={onPanelSelect}
      onClose={onClosePanel}
      onPrev={selectedEdgeIndex > 0 ? previousEdge : undefined}
      onNext={selectedEdgeIndex >= 0 && selectedEdgeIndex < edges.length - 1 ? nextEdge : undefined}
    />
  ) : null;

  return (
    <div className="min-w-0 flex-1">
      <WorkspaceHeader
        key={run.id}
        run={run}
        phase={phase}
        state={state}
        riskLevel={riskLevel}
        onControl={(action) => void control(action)}
        onRerun={() => void rerun()}
        busy={busy}
        onSaved={detail.reload}
      />
      <WorkspaceBanners
        run={run}
        phase={phase}
        state={state}
        onControl={(action) => void control(action)}
        onRerun={() => void rerun()}
        busy={busy}
      />

      <Tabs value={tab} onValueChange={setTab} className="min-w-0 gap-0">
        <WorkspaceTabBar edgeCount={edges.length} result={result} />
        <div
          className={
            selection
              ? "relative min-h-[680px] min-w-0 xl:grid xl:min-h-[740px] xl:grid-cols-[minmax(0,1fr)_var(--panel-width)]"
              : "relative min-w-0"
          }
        >
          <div className="min-w-0">
            <TabsContent value="graph" className="min-w-0">
              <ProvisionalStrip phase={phase} />
              {phone ? (
                <div>
                  <div className="flex items-center justify-between border-b border-border px-4 py-2">
                    <h2 className="type-heading">Path</h2>
                    <Button variant="outline" size="sm" onClick={() => setFullGraph(true)}>
                      Full graph
                    </Button>
                  </div>
                  {pathGraph}
                </div>
              ) : (
                graph
              )}
            </TabsContent>
            <TabsContent value="transfers" className="min-w-0">
              <ProvisionalStrip phase={phase} />
              <TransfersTab
                key={run.id}
                chain={run.chain}
                edges={edges}
                labels={labels}
                selectedId={selection?.kind === "edge" ? selection.edgeId : null}
                onSelect={(edgeId) => setSelection({ kind: "edge", edgeId })}
                phase={phase}
                firstSeen={firstSeen}
              />
            </TabsContent>
            <TabsContent value="exposure" className="min-w-0">
              <ProvisionalStrip phase={phase} />
              {result && !live ? <ExposureTab result={result} /> : <WaitingForResult />}
            </TabsContent>
            <TabsContent value="linked" className="min-w-0">
              <ProvisionalStrip phase={phase} />
              {result && !live ? (
                <LinkedWalletsTab
                  key={run.id}
                  result={result}
                  onSelect={selectInGraph}
                  onTraceForward={(address) => void traceForward(address)}
                />
              ) : (
                <WaitingForResult />
              )}
            </TabsContent>
            <TabsContent value="touchpoints" className="min-w-0">
              <ProvisionalStrip phase={phase} />
              {result && !live ? <TouchpointsTab result={result} /> : <WaitingForResult />}
            </TabsContent>
            <TabsContent value="flags" className="min-w-0">
              <ProvisionalStrip phase={phase} />
              {result && !live ? (
                <FlagsTab result={result} onSelect={selectInGraph} />
              ) : (
                <WaitingForResult />
              )}
            </TabsContent>
          </div>
          {panel}
        </div>
      </Tabs>

      {fullGraph ? (
        <div className="fixed inset-0 z-40 flex min-h-0 flex-col bg-background">
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-4">
            <h2 className="type-heading">Full graph</h2>
            <Button variant="outline" size="sm" onClick={() => setFullGraph(false)}>
              × Close
            </Button>
          </header>
          <div className="min-h-0 flex-1">{graph}</div>
        </div>
      ) : null}
    </div>
  );
}
