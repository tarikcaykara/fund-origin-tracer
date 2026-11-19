import type { AnalysisResult, ChainId, RunParams, TraceEdge } from "@fot/core/schema";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
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
  returnFocus,
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
  /** Focus target on close when the element that opened the panel is gone. */
  returnFocus?: (() => HTMLElement | null) | undefined;
  onPrev?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
}) {
  const breakpoint = useBreakpoint();
  const phone = breakpoint === "phone";
  const desktop = breakpoint === "desktop";
  const hostRef = useRef<HTMLElement>(null);
  // The element focused when the panel opened (a transfer row, a graph node): focus goes back there.
  const opener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    opener.current = document.activeElement;
  }, []);

  // The phone sheet is a ModalLayer, which returns focus itself; there `hostRef` stays empty.
  const close = useCallback(() => {
    const focusInside = hostRef.current?.contains(document.activeElement) ?? false;
    onClose();
    if (!focusInside) return;
    const target =
      opener.current instanceof HTMLElement && opener.current.isConnected
        ? opener.current
        : returnFocus?.();
    target?.focus();
  }, [onClose, returnFocus]);

  useEffect(() => {
    if (phone) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      // Dialogs (the palette, Full graph) close themselves; a field outside the panel keeps its Esc.
      if (target?.closest('[role="dialog"]')) return;
      const inPanel = target !== null && (hostRef.current?.contains(target) ?? false);
      if (!inPanel && target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [phone, close]);

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
      onClose={close}
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
        returnFocus={returnFocus}
        className="fixed inset-0 z-50 flex min-h-0 flex-col bg-card"
      >
        <div className="min-h-0 flex-1 overflow-y-auto">{content}</div>
      </ModalLayer>
    );
  }

  if (desktop) {
    return (
      <aside
        ref={hostRef}
        className="min-h-[740px] min-w-0 border-l border-border bg-card"
        aria-label="Selection details"
      >
        {content}
      </aside>
    );
  }

  return (
    <aside
      ref={hostRef}
      className="absolute right-0 top-0 z-20 h-full min-h-[680px] w-[var(--sheet-width)] max-w-full border-l border-border-strong bg-card shadow-sheet"
      aria-label="Selection details"
    >
      <div className="h-full overflow-y-auto">{content}</div>
    </aside>
  );
}
