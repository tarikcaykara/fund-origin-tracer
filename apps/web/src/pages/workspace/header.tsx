import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ApiError, api, type RunDetail } from "@/api.ts";
import { DemoChip, RiskChip, StatusPill } from "@/components/badges.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Input } from "@/components/ui/input.tsx";
import { chainName, directionName, formatClock, shortAddress } from "@/format.ts";
import { useBreakpoint } from "@/hooks/use-breakpoint.ts";
import type { RiskLevel } from "@/meta.ts";
import { isLivePhase, type RunPhase, type RunState } from "@/run-state.ts";
import { ExportMenu, ExportSubmenu } from "./export-menu.tsx";
import { NotesDialog } from "./notes-dialog.tsx";

export function WorkspaceHeader({
  run,
  phase,
  state,
  riskLevel,
  onControl,
  onRerun,
  busy,
  onSaved,
}: {
  run: RunDetail;
  phase: RunPhase;
  state: RunState;
  riskLevel: RiskLevel | null;
  onControl: (action: "pause" | "resume" | "cancel") => void;
  onRerun: () => void;
  busy: boolean;
  onSaved: () => void;
}) {
  const phone = useBreakpoint() === "phone";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(run.title ?? "");
  const [savingTitle, setSavingTitle] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const title = run.title ?? run.id;
  const live = isLivePhase(phase) || phase === "connecting";
  // While live (including an expand of a finished run) the stored result is stale and the
  // server refuses exports until the run finishes again.
  const exportResult = state.result ?? (live ? null : run.result);
  const observedEdges = Object.values(state.edges);
  const expanded =
    state.progress?.expandedEdges ??
    state.stats.expandedEdges ??
    observedEdges.filter((edge) => edge.status === "expanded").length;
  // Snapshot stats can predate an in-progress expand, so never let them hide deeper streamed edges.
  const maxDepth = Math.max(
    state.stats.maxDepthReached ?? 0,
    observedEdges.reduce((depth, edge) => Math.max(depth, edge.depth), 0),
  );
  const finishedMs = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.createdAt) : null;
  const elapsed =
    state.progress?.elapsedMs ?? (finishedMs !== null && finishedMs >= 0 ? finishedMs : undefined);
  const streamedCount = state.phase === "connecting" ? null : observedEdges.length;
  const transferCount = live ? streamedCount : (exportResult?.graph.edges.length ?? streamedCount);
  const progress = Math.min(100, (expanded / Math.max(1, run.params.maxEdges)) * 100);
  const showProgress = phase !== "completed";
  // During "Expand further" the counts are run totals; the per-expansion budget and clock live in
  // the detail panel, so the header shows neither `/ maxEdges` nor the elapsed time.
  const expansion = live ? state.expansion : null;
  const expandingFrom = expansion ? state.edges[expansion.edgeId]?.far : undefined;
  const failed = phase === "failed" || phase === "timed_out";
  const saveTitle = async () => {
    try {
      const nextTitle = draft.trim();
      if (nextTitle === (run.title ?? "")) {
        setEditing(false);
        return;
      }
      setSavingTitle(true);
      await api.patchRun(run.id, { title: nextTitle || null });
      setEditing(false);
      onSaved();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not rename investigation.");
    } finally {
      setSavingTitle(false);
    }
  };
  const beginRename = () => {
    setDraft(run.title ?? "");
    setEditing(true);
  };
  const notesButton = (
    <Button variant="outline" size="sm" onClick={() => setNotesOpen(true)}>
      ✎ Notes
    </Button>
  );

  return (
    <>
      <header className="border-b border-border bg-card px-4 py-3 md:px-4 xl:px-5 xl:py-4">
        <div className="mb-2 hidden type-mono-node text-muted-foreground xl:block">
          <Link to="/runs" className="hover:text-foreground">
            Investigations
          </Link>
          <span className="mx-2 text-faint-foreground">/</span>
          <span>{run.id.slice(0, 8)}</span>
        </div>
        <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex min-w-0 items-center gap-2">
              {editing ? (
                <>
                  <Input
                    autoFocus
                    value={draft}
                    aria-label="Investigation title"
                    disabled={savingTitle}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveTitle();
                      }
                      if (event.key === "Escape") {
                        setEditing(false);
                        setDraft(run.title ?? "");
                      }
                    }}
                    className="h-9 max-w-xl text-lg"
                  />
                  <Button size="sm" disabled={savingTitle} onClick={() => void saveTitle()}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={savingTitle}
                    onClick={() => {
                      setEditing(false);
                      setDraft(run.title ?? "");
                    }}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <h1 className="min-w-0 truncate border-b border-dashed border-border-strong pb-0.5 text-lg font-semibold leading-tight tracking-[-.01em] xl:text-[22px]">
                  {title}
                </h1>
              )}
              {!phone && !editing ? (
                <Button variant="ghost" size="sm" onClick={beginRename}>
                  ✎ Rename
                </Button>
              ) : null}
              {phone ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      className="min-h-11 min-w-11"
                      aria-label="Workspace actions"
                    >
                      ⋯
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem className="min-h-11" onSelect={beginRename}>
                      ✎ Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem className="min-h-11" onSelect={() => setNotesOpen(true)}>
                      ✎ Notes
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild className="min-h-11">
                      <Link to={`/runs/${encodeURIComponent(run.id)}/report`}>Open report</Link>
                    </DropdownMenuItem>
                    <ExportSubmenu runId={run.id} result={exportResult} />
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>

            <div className="flex min-w-0 flex-wrap items-center gap-1.5 md:gap-2">
              <StatusPill status={phase} live={phase === "running"} />
              <span className="inline-flex h-[22px] items-center rounded-full border border-border-strong px-2 type-body-sm">
                {chainName(run.chain)}
              </span>
              <span className="inline-flex h-[22px] items-center gap-1 rounded-full border border-border-strong px-2 type-body-sm">
                <span aria-hidden="true">{run.direction === "backward" ? "←" : "→"}</span>
                {directionName(run.direction)}
              </span>
              {run.demo ? <DemoChip label="DEMO" /> : null}
              <span className="min-w-0 max-w-full truncate type-mono-node text-muted-foreground">
                {run.seeds.length} seed{run.seeds.length === 1 ? "" : "s"} · {transferCount ?? "—"}{" "}
                transfers
              </span>
              {!phone ? notesButton : null}
            </div>

            {showProgress ? (
              <div className="max-w-[560px] space-y-1">
                {expansion ? (
                  <div
                    className="h-1 overflow-hidden rounded-full bg-border"
                    role="progressbar"
                    aria-label="Expansion in progress"
                  >
                    <div className="h-full w-full animate-shimmer bg-foreground" />
                  </div>
                ) : (
                  <div
                    className="h-1 overflow-hidden rounded-full bg-border"
                    role="progressbar"
                    aria-label="Run expansion progress"
                    aria-valuemin={0}
                    aria-valuemax={run.params.maxEdges}
                    aria-valuenow={Math.min(expanded, run.params.maxEdges)}
                  >
                    <div className="h-full bg-foreground" style={{ width: `${progress}%` }} />
                  </div>
                )}
                <p className="type-mono-node text-muted-foreground">
                  {expansion
                    ? `${expanded} edges · max depth ${maxDepth} · expanding ${expandingFrom ? shortAddress(run.chain, expandingFrom) : "…"}`
                    : `${expanded} / ${run.params.maxEdges} edges · max depth ${maxDepth} · ${elapsed === undefined ? "—" : formatClock(elapsed)}`}
                </p>
              </div>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2 xl:justify-end">
            {phase === "running" ? (
              <Button disabled={busy} onClick={() => onControl("pause")}>
                ❚❚ Pause
              </Button>
            ) : null}
            {phase === "paused" ? (
              <Button disabled={busy} onClick={() => onControl("resume")}>
                ▶ Resume
              </Button>
            ) : null}
            {phase === "running" || phase === "paused" ? (
              <Button
                variant="destructive-outline"
                disabled={busy}
                onClick={() => onControl("cancel")}
              >
                ■ Cancel
              </Button>
            ) : null}
            {phase === "cancelled" ? (
              <Button variant="outline" disabled={busy} onClick={onRerun}>
                ↻ Re-run with same limits
              </Button>
            ) : null}
            {failed ? (
              <Button disabled={busy} onClick={onRerun}>
                ↻ Retry
              </Button>
            ) : null}
            <RiskChip level={riskLevel} provisional={phase !== "completed" && riskLevel !== null} />
            {!phone ? <ExportMenu runId={run.id} result={exportResult} /> : null}
            {!phone ? (
              <Button asChild>
                <Link to={`/runs/${encodeURIComponent(run.id)}/report`}>Open report</Link>
              </Button>
            ) : null}
          </div>
        </div>
      </header>
      <NotesDialog run={run} open={notesOpen} onOpenChange={setNotesOpen} onSaved={onSaved} />
    </>
  );
}
