import type { RunDetail } from "@/api.ts";
import { Banner } from "@/components/banner.tsx";
import { Button } from "@/components/ui/button.tsx";
import { formatTimeLimit } from "@/format.ts";
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
  const errorText = state.error ? `${state.error.code}: ${state.error.message}` : run.error;
  const timeoutEdges = Object.values(state.edges).filter(
    (edge) => edge.stopReason === "timeout",
  ).length;
  const hasResult = (state.result ?? run.result) !== null;
  const timedOutText = [
    `Stopped at the ${formatTimeLimit(run.params.timeoutSec)} time limit after ${expanded} of ${run.params.maxEdges} edges.`,
    hasResult ? "The analysis covers the transfers found so far." : "",
    timeoutEdges > 0 && !run.demo
      ? `${timeoutEdges} ${timeoutEdges === 1 ? "edge" : "edges"} stopped at the limit; select one and use Expand further to continue it.`
      : "",
    "Retry re-uses cached responses, and a new trace can set a higher time limit under Advanced limits.",
    run.chain === "tron" ? "More keys in TRONSCAN_API_KEYS raise the TRON request rate." : "",
  ]
    .filter(Boolean)
    .join(" ");
  const warnings = [...state.warnings, ...(state.result?.warnings ?? run.result?.warnings ?? [])];
  const warningMap = new Map(
    warnings.map((warning) => [`${warning.code}:${warning.message}`, warning]),
  );
  const showPaused = phase === "paused";
  const showCancelled = phase === "cancelled";
  const showFailed = phase === "failed";
  const showTimedOut = phase === "timed_out";
  if (!showPaused && !showCancelled && !showFailed && !showTimedOut && warningMap.size === 0)
    return null;

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
      {showFailed ? (
        <Banner tone="destructive" tag="✕ Trace failed">
          {errorText ?? "The run ended before the result could be completed."}
          {errorText !== null ? (
            <Button
              variant="link"
              size="sm"
              className="ml-1"
              onClick={() => void copyText(errorText, { title: "Error copied to clipboard" })}
            >
              Copy error
            </Button>
          ) : null}
        </Banner>
      ) : null}
      {showTimedOut ? (
        <Banner tone="warning" tag="✕ Timed out">
          {timedOutText}
          {errorText ? ` ${errorText}` : null}
          <Button variant="link" size="sm" className="ml-1" disabled={busy} onClick={onRerun}>
            Retry with same limits
          </Button>
          {errorText !== null ? (
            <Button
              variant="link"
              size="sm"
              className="ml-1"
              onClick={() => void copyText(errorText, { title: "Error copied to clipboard" })}
            >
              Copy error
            </Button>
          ) : null}
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
