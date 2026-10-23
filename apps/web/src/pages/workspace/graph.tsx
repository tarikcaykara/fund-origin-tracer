import type { AnalysisResult, ChainId, RunParams, TraceEdge } from "@fot/core/schema";
import { ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { RunPhase } from "../../run-state.ts";
import type { Selection } from "../../selection.ts";
import { GraphCanvas } from "./graph-canvas.tsx";

export function GraphTab({
  chain,
  edges,
  result,
  phase,
  params,
  selection,
  onSelect,
  density = "auto",
}: {
  chain: ChainId;
  edges: TraceEdge[];
  result: AnalysisResult | null;
  phase: RunPhase;
  params: RunParams;
  selection: Selection | null;
  onSelect(sel: Selection | null): void;
  density?: "chips" | "dots" | "auto" | undefined;
}) {
  return (
    <ReactFlowProvider>
      <GraphCanvas
        chain={chain}
        edges={edges}
        result={result}
        phase={phase}
        params={params}
        selection={selection}
        density={density}
        onSelect={onSelect}
      />
    </ReactFlowProvider>
  );
}
