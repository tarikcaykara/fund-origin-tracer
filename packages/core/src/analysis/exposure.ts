import {
  assetId,
  type Exposure,
  type ExposureEntry,
  type LabelCategory,
  type StopReason,
  StopReasonSchema,
  type TraceEdge,
} from "../schema.ts";
import {
  type AnalysisContext,
  entityOf,
  LABEL_PRIORITY,
  pickExposureLabel,
  sumUsd,
  symbolOf,
} from "./shared.ts";

/** Stop reasons that leave the origin/destination of a branch unknown. */
const UNRESOLVED_REASONS: ReadonlySet<StopReason> = new Set([
  "no_candidates",
  "max_depth",
  "max_edges",
  "timeout",
  "cancelled",
  "fetch_failed",
]);

/** A stopped edge whose far end is unlabeled and whose origin/destination is therefore unknown. */
export function isUnresolvedEdge(ctx: AnalysisContext, edge: TraceEdge): boolean {
  return (
    edge.status === "stopped" &&
    edge.stopReason !== null &&
    UNRESOLVED_REASONS.has(edge.stopReason) &&
    pickExposureLabel(ctx.labelsOf(edge.far)) === null
  );
}

const DIRECT_HOPS = 1;
const TOP_ENTITIES = 20;

function usdOrZero(values: Iterable<number | null>): number {
  return sumUsd(values) ?? 0;
}

/**
 * Labeled counterparties on the traced edges, grouped. One entry per edge whose `far` carries a
 * non-`other` label (most severe label wins). `hops` = depth + 1; hops 1 is direct exposure.
 */
export function computeExposure(ctx: AnalysisContext): Exposure {
  const entries: ExposureEntry[] = [];
  const stoppedExposureUsd: (number | null)[] = [];

  for (const edge of ctx.edges) {
    const label = pickExposureLabel(ctx.labelsOf(edge.far));
    if (!label) continue;
    entries.push({
      category: label.category,
      entity: entityOf(label),
      address: edge.far,
      hops: edge.depth + 1,
      edgeId: edge.id,
      txHash: edge.transfer.txHash,
      assetId: assetId(edge.transfer.asset),
      symbol: symbolOf(edge.transfer.asset),
      amount: edge.transfer.amount,
      usd: edge.usd,
    });
    if (edge.status === "stopped") stoppedExposureUsd.push(edge.usd);
  }

  const byCategory: Exposure["byCategory"] = [];
  for (const category of LABEL_PRIORITY) {
    const inCategory = entries.filter((e) => e.category === category);
    if (inCategory.length === 0) continue;
    const direct = inCategory.filter((e) => e.hops <= DIRECT_HOPS);
    const indirect = inCategory.filter((e) => e.hops > DIRECT_HOPS);
    byCategory.push({
      category,
      direct: { count: direct.length, usd: usdOrZero(direct.map((e) => e.usd)) },
      indirect: {
        count: indirect.length,
        usd: usdOrZero(indirect.map((e) => e.usd)),
        minHops: indirect.length > 0 ? Math.min(...indirect.map((e) => e.hops)) : null,
      },
    });
  }

  const entityGroups = new Map<
    string,
    { entity: string; category: LabelCategory; list: ExposureEntry[] }
  >();
  for (const e of entries) {
    if (e.entity === null) continue;
    const key = `${e.category}|${e.entity}`;
    const group = entityGroups.get(key);
    if (group) group.list.push(e);
    else entityGroups.set(key, { entity: e.entity, category: e.category, list: [e] });
  }
  const byEntity: Exposure["byEntity"] = [...entityGroups.values()]
    .map((g) => ({
      entity: g.entity,
      category: g.category,
      count: g.list.length,
      usd: usdOrZero(g.list.map((e) => e.usd)),
      minHops: Math.min(...g.list.map((e) => e.hops)),
    }))
    .sort((a, b) => b.usd - a.usd || b.count - a.count || a.entity.localeCompare(b.entity))
    .slice(0, TOP_ENTITIES);

  const byReason = Object.fromEntries(
    StopReasonSchema.options.map((r) => [r, { count: 0, usd: 0 }]),
  ) as Record<StopReason, { count: number; usd: number }>;
  let unresolvedCount = 0;
  let unresolvedUsd = 0;
  for (const edge of ctx.edges) {
    if (edge.stopReason === null || !isUnresolvedEdge(ctx, edge)) continue;
    const bucket = byReason[edge.stopReason];
    bucket.count += 1;
    bucket.usd += edge.usd ?? 0;
    unresolvedCount += 1;
    unresolvedUsd += edge.usd ?? 0;
  }

  return {
    entries,
    byCategory,
    byEntity,
    unresolved: { count: unresolvedCount, usd: unresolvedUsd, byReason },
    terminalUsd: usdOrZero(stoppedExposureUsd) + unresolvedUsd,
    unpricedCount: ctx.edges.filter((e) => e.usd === null).length,
  };
}
