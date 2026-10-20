import type { Seed, TraceEdge } from "../schema.ts";

/**
 * Which seeds reach which edge: BFS from each seed's edges over `children`. An edge may be reached
 * by several seeds. Seed ids come back in `seeds` order. Type-only imports: safe for the web build.
 */
export function seedReachability(
  edges: readonly TraceEdge[],
  seeds: readonly Pick<Seed, "id">[],
): { edgeSeedIds: Map<string, string[]>; seedOrder: Map<string, number> } {
  const byId = new Map(edges.map((e) => [e.id, e]));
  const seedOrder = new Map(seeds.map((s, i) => [s.id, i]));
  const reached = new Map<string, Set<string>>();
  for (const seed of seeds) {
    const queue = edges.filter((e) => e.seedId === seed.id).map((e) => e.id);
    while (queue.length > 0) {
      const id = queue.pop();
      if (id === undefined) break;
      let set = reached.get(id);
      if (!set) {
        set = new Set();
        reached.set(id, set);
      }
      if (set.has(seed.id)) continue;
      set.add(seed.id);
      for (const childId of byId.get(id)?.children ?? []) queue.push(childId);
    }
  }
  const edgeSeedIds = new Map<string, string[]>();
  for (const [id, set] of reached) {
    edgeSeedIds.set(
      id,
      [...set].sort((a, b) => (seedOrder.get(a) ?? 0) - (seedOrder.get(b) ?? 0)),
    );
  }
  return { edgeSeedIds, seedOrder };
}
