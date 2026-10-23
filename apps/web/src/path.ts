import type { AnalysisResult, Direction, RunParams, TraceEdge } from "@fot/core/schema";

/**
 * Returns the highest-USD greedy path in display order (origin → seed backward, seed → origin
 * forward). Edge depths are 0-based, so a run holds up to `maxDepth + 1` edges per path; edges
 * added by "Expand further" may sit deeper, so the walk is bounded by the deepest edge too.
 */
export function highestValuePath(
  edges: readonly TraceEdge[],
  result: AnalysisResult | null,
  direction: Direction,
  params: Pick<RunParams, "maxDepth" | "traceThroughEntities">,
): TraceEdge[] {
  const deepest = edges.reduce((depth, edge) => Math.max(depth, edge.depth), 0);
  const stepLimit = Math.max(params.maxDepth, deepest) + 1;
  if (edges.length === 0) return [];

  const addresses = new Map((result?.graph.addresses ?? []).map((node) => [node.address, node]));
  const seeds = new Set<string>();
  for (const node of result?.graph.addresses ?? []) if (node.isSeedSubject) seeds.add(node.address);
  for (const edge of edges) if (edge.seedId !== null) seeds.add(edge.near);
  if (seeds.size === 0) return [];

  const incoming = new Map<string, TraceEdge[]>();
  const outgoing = new Map<string, TraceEdge[]>();
  for (const edge of edges) {
    const into = incoming.get(edge.transfer.to) ?? [];
    into.push(edge);
    incoming.set(edge.transfer.to, into);
    const from = outgoing.get(edge.transfer.from) ?? [];
    from.push(edge);
    outgoing.set(edge.transfer.from, from);
  }

  let best: TraceEdge[] = [];
  let bestTotal = Number.NEGATIVE_INFINITY;
  let bestSeed = "";
  for (const seed of [...seeds].sort()) {
    let current = seed;
    let total = 0;
    const visited = new Set([seed]);
    const walked: TraceEdge[] = [];

    for (let step = 0; step < stepLimit; step++) {
      // Entity labels end the walk like the engine's `entity` stop, unless the run traced through
      // entities. The seed itself is the start of the trace, never a stop.
      if (step > 0 && !params.traceThroughEntities) {
        const currentLabels = addresses.get(current)?.labels ?? [];
        if (
          currentLabels.some(
            (label) =>
              label.category === "exchange" ||
              (label.entity !== undefined && label.entity.length > 0),
          )
        )
          break;
      }

      const candidates = direction === "backward" ? incoming.get(current) : outgoing.get(current);
      let selected: TraceEdge | null = null;
      for (const edge of candidates ?? []) {
        if (selected === null) {
          selected = edge;
          continue;
        }
        const value = edge.usd ?? 0;
        const selectedValue = selected.usd ?? 0;
        if (
          value > selectedValue ||
          (value === selectedValue && edge.transfer.timestamp < selected.transfer.timestamp) ||
          (value === selectedValue &&
            edge.transfer.timestamp === selected.transfer.timestamp &&
            edge.id < selected.id)
        )
          selected = edge;
      }
      if (!selected) break;

      walked.push(selected);
      total += selected.usd ?? 0;
      const next = direction === "backward" ? selected.transfer.from : selected.transfer.to;
      if (visited.has(next)) break;
      visited.add(next);
      current = next;
      if (selected.stopReason !== null) break;
    }

    if (direction === "backward") walked.reverse();
    if (total > bestTotal || (total === bestTotal && (bestSeed === "" || seed < bestSeed))) {
      best = walked;
      bestTotal = total;
      bestSeed = seed;
    }
  }

  return best;
}
