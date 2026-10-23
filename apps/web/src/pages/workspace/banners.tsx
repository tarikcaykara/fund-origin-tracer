import type { RunDetail } from "@/api.ts";
import { Banner } from "@/components/banner.tsx";
import { Button } from "@/components/ui/button.tsx";
import { copyText } from "@/lib/clipboard.ts";
import type { RunPhase, RunState } from "@/run-state.ts";

export function WorkspaceBanners({
  run,
  phase,
  state,
  onControl,
  onRerun,
  busy,
}: {
  run: RunDetail;
  phase: RunPhase;
  state: RunState;
  onControl: (action: "resume") => void;
  onRerun: () => void;
  busy: boolean;
}) {
  const cancelledEdges = Object.values(state.edges).filter(
    (edge) => edge.stopReason === "cancelled",
  ).length;
  const expanded =
    state.progress?.expandedEdges ??
    state.stats.expandedEdges ??
    Object.values(state.edges).filter((edge) => edge.status === "expanded").length;
  const queued =
    state.progress?.queued ??
    Object.values(state.edges).filter((edge) => edge.status === "pending").length;
  const errorText = state.error
    ? `${state.error.code}: ${state.error.message}`
    : (run.error ?? "The run ended before the result could be completed.");
  const warnings = [...state.warnings, ...(state.result?.warnings ?? run.result?.warnings ?? [])];
  const warningMap = new Map(
    warnings.map((warning) => [`${warning.code}:${warning.message}`, warning]),
  );
  const showPaused = phase === "paused";
  const showCancelled = phase === "cancelled";
  const showError = phase === "failed" || phase === "timed_out";
  if (!showPaused && !showCancelled && !showError && warningMap.size === 0) return null;

  return (
    <div className="space-y-1 border-b border-border">
      {showPaused ? (
        <Banner tone="warning" tag="❚❚ Paused">
          No API calls are made while paused. {queued} edges remain queued.
          <Button
            variant="link"
            size="sm"
            className="ml-1"
            disabled={busy}
            onClick={() => onControl("resume")}
          >
            Resume
          </Button>
        </Banner>
      ) : null}
      {showCancelled ? (
        <Banner tone="neutral" tag="□ Cancelled">
          Cancelled after {expanded} of {run.params.maxEdges} maximum edges. Partial results are
          kept; {cancelledEdges} edges carry the cancelled stop reason and {queued} remain queued.
          <Button variant="link" size="sm" className="ml-1" disabled={busy} onClick={onRerun}>
            Re-run with same limits
          </Button>
        </Banner>
      ) : null}
      {showError ? (
        <Banner tone="destructive" tag={phase === "timed_out" ? "✕ Timed out" : "✕ Trace failed"}>
          {errorText}
          <Button
            variant="link"
            size="sm"
            className="ml-1"
            onClick={() => void copyText(errorText, { title: "Error copied to clipboard" })}
          >
            Copy error
          </Button>
        </Banner>
      ) : null}
      {[...warningMap.values()].map((warning) => (
        <Banner key={`${warning.code}:${warning.message}`} tone="warning" tag={warning.code}>
          {warning.message}
        </Banner>
      ))}
    </div>
  );
}
