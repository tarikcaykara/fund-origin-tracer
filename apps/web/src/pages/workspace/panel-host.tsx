import type { AnalysisResult, ChainId, RunParams, TraceEdge } from "@fot/core/schema";
import type { LabelIndex } from "@/components/links.tsx";
import { ModalLayer } from "@/components/modal-layer.tsx";
import { useBreakpoint } from "@/hooks/use-breakpoint.ts";
import type { Selection } from "@/selection.ts";
import { DetailPanel, type ExpandError, type ExpansionView } from "./detail-panel.tsx";

export function PanelHost({
  chain,
  selection,
  edges,
  result,
  labels,
  params,
  live,
  canExpand,
  expansion,
  expandHint,
  onCancelExpansion,
  expandError,
  expandBlockedReason,
  onExpand,
  onSelect,
  onClose,
  onPrev,
  onNext,
}: {
  chain: ChainId;
  selection: Selection;
  edges: TraceEdge[];
  result: AnalysisResult | null;
  labels: LabelIndex;
  params: RunParams;
  live: boolean;
  canExpand: boolean;
  expansion: ExpansionView | null;
  expandHint?: string | undefined;
  onCancelExpansion: () => void;
  expandError: ExpandError | null;
  expandBlockedReason?: string | undefined;
  onExpand: (edgeId: string) => void;
  onSelect: (selection: Selection | null) => void;
  onClose: () => void;
  onPrev?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
}) {
  const breakpoint = useBreakpoint();
  const phone = breakpoint === "phone";
  const desktop = breakpoint === "desktop";

  const content = (
    <DetailPanel
      chain={chain}
      selection={selection}
      edges={edges}
      result={result}
      labels={labels}
      params={params}
      live={live}
      canExpand={canExpand}
      expansion={expansion}
      expandHint={expandHint}
      onCancelExpansion={onCancelExpansion}
      expandError={expandError}
      expandBlockedReason={expandBlockedReason}
      onExpand={onExpand}
      onSelect={onSelect}
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
      mode={phone ? "full" : desktop ? "docked" : "sheet"}
    />
  );

  if (phone) {
    return (
      <ModalLayer
        label="Selection details"
        onClose={onClose}
        className="fixed inset-0 z-50 flex min-h-0 flex-col bg-card"
      >
        <div className="min-h-0 flex-1 overflow-y-auto">{content}</div>
      </ModalLayer>
    );
  }

  if (desktop) {
    return (
      <aside className="min-h-[740px] min-w-0 border-l border-border bg-card">{content}</aside>
    );
  }

  return (
    <aside
      className="absolute right-0 top-0 z-20 h-full min-h-[680px] w-[var(--sheet-width)] max-w-full border-l border-border-strong bg-card shadow-sheet"
      aria-label="Selection details"
    >
      <div className="h-full overflow-y-auto">{content}</div>
    </aside>
  );
}
