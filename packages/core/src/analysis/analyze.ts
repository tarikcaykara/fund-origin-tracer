import { CHAINS } from "../chains.ts";
import type { TraceOutput } from "../engine/types.ts";
import type { LabelRegistry } from "../labels/registry.ts";
import type { LoadedPolicy } from "../policy/policy.ts";
import type { ExplorerProvider, PriceSource } from "../providers/types.ts";
import type {
  AddressNode,
  AnalysisResult,
  Convergence,
  DerivedAnalysis,
  ExchangeTouchpoint,
  Exposure,
  Label,
  RunParams,
  TraceEdge,
} from "../schema.ts";
import { findConvergences, followUpConvergences } from "./convergence.ts";
import { computeExposure } from "./exposure.ts";
import { evaluateFlags, riskLevelOf } from "./flags.ts";
import { seedReachability } from "./reachability.ts";
import type { AnalysisContext } from "./shared.ts";
import { findTouchpoints } from "./touchpoints.ts";

export interface AnalyzeDeps {
  provider: ExplorerProvider;
  prices: PriceSource;
  signal: AbortSignal;
  runId: string;
  /** ISO timestamps; the caller owns the clock. */
  startedAt: string;
  finishedAt: string;
  ofacFetchedAt: string | null;
}

function sortEdges(
  edges: readonly TraceEdge[],
  edgeSeedIds: ReadonlyMap<string, readonly string[]>,
  seedOrder: ReadonlyMap<string, number>,
): TraceEdge[] {
  const seedIndex = (e: TraceEdge): number => {
    const first = edgeSeedIds.get(e.id)?.[0];
    return first === undefined ? Number.MAX_SAFE_INTEGER : (seedOrder.get(first) ?? 0);
  };
  return [...edges].sort(
    (a, b) =>
      a.depth - b.depth ||
      seedIndex(a) - seedIndex(b) ||
      (a.selection?.rank ?? 0) - (b.selection?.rank ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function buildAddressNodes(
  ctx: AnalysisContext,
  isSanctioned: (address: string) => boolean,
): AddressNode[] {
  interface Draft {
    seedIds: Set<string>;
    subject: boolean;
    inEdgeIds: string[];
    outEdgeIds: string[];
  }
  const drafts = new Map<string, Draft>();
  const draft = (address: string): Draft => {
    let d = drafts.get(address);
    if (!d) {
      d = { seedIds: new Set(), subject: false, inEdgeIds: [], outEdgeIds: [] };
      drafts.set(address, d);
    }
    return d;
  };

  for (const e of ctx.edges) {
    draft(e.from).outEdgeIds.push(e.id);
    draft(e.to).inEdgeIds.push(e.id);
    const far = draft(e.far);
    for (const s of ctx.edgeSeedIds.get(e.id) ?? []) far.seedIds.add(s);
    if (e.seedId !== null) {
      const near = draft(e.near);
      near.subject = true;
      near.seedIds.add(e.seedId);
    }
  }

  return [...drafts].map(([address, d]) => {
    const labels: Label[] = [...ctx.labelsOf(address)];
    return {
      address,
      labels,
      sanctioned: isSanctioned(address) || labels.some((l) => l.category === "sanctioned"),
      isSeedSubject: d.subject,
      seedIds: [...d.seedIds].sort(
        (a, b) => (ctx.seedOrder.get(a) ?? 0) - (ctx.seedOrder.get(b) ?? 0),
      ),
      inEdgeIds: d.inEdgeIds,
      outEdgeIds: d.outEdgeIds,
    };
  });
}

interface Derived {
  ctx: AnalysisContext;
  /** Edges in `ctx` order (depth, seed index, rank, id). */
  edges: TraceEdge[];
  addresses: AddressNode[];
  /** Before the follow-up lookups: `otherCounterparties` is empty. */
  convergences: Convergence[];
  exposure: Exposure;
  exchangeTouchpoints: ExchangeTouchpoint[];
}

/** The synchronous, network-free part shared by `analyze` and `analyzeProvisional`. */
function deriveFromEdges(
  traceEdges: readonly TraceEdge[],
  params: RunParams,
  labels: LabelRegistry,
): Derived {
  const { edgeSeedIds, seedOrder } = seedReachability(traceEdges, params.seeds);
  const edges = sortEdges(traceEdges, edgeSeedIds, seedOrder);

  const labelCache = new Map<string, readonly Label[]>();
  const ctx: AnalysisContext = {
    chain: params.chain,
    direction: params.direction,
    edges,
    edgeById: new Map(edges.map((e) => [e.id, e])),
    edgeSeedIds,
    seedOrder,
    labelsOf: (address) => {
      let cached = labelCache.get(address);
      if (!cached) {
        cached = labels.lookup(params.chain, address);
        labelCache.set(address, cached);
      }
      return cached;
    },
  };

  return {
    ctx,
    edges,
    addresses: buildAddressNodes(ctx, (a) => labels.isSanctioned(params.chain, a)),
    convergences: findConvergences(ctx),
    exposure: computeExposure(ctx),
    exchangeTouchpoints: findTouchpoints(ctx),
  };
}

/**
 * Turns a finished trace into the result envelope: graph, linked wallets (convergences), exposure,
 * exchange touchpoints, policy flags and risk level. Deterministic for a given input apart from
 * the convergence follow-up lookups, which go through `deps.provider`.
 */
export async function analyze(
  trace: TraceOutput,
  params: RunParams,
  labels: LabelRegistry,
  policy: LoadedPolicy,
  deps: AnalyzeDeps,
): Promise<AnalysisResult> {
  const derived = deriveFromEdges(trace.edges, params, labels);
  const { ctx, edges, addresses, exposure, exchangeTouchpoints } = derived;
  const followUp = await followUpConvergences(
    derived.convergences,
    ctx,
    new Set(addresses.map((a) => a.address)),
    { provider: deps.provider, prices: deps.prices, signal: deps.signal },
  );
  const convergences = followUp.convergences;
  const flags = evaluateFlags({
    ctx,
    flags: policy.flags,
    exposure,
    convergences,
    touchpoints: exchangeTouchpoints,
    status: trace.status,
    maxDepthReached: trace.stats.maxDepthReached,
  });

  const warnings: { code: string; message: string }[] = [];
  for (const w of [...trace.warnings, ...followUp.warnings]) {
    if (!warnings.some((x) => x.code === w.code && x.message === w.message)) warnings.push(w);
  }

  return {
    schemaVersion: 1,
    runId: deps.runId,
    chain: params.chain,
    direction: params.direction,
    params,
    seeds: params.seeds,
    startedAt: deps.startedAt,
    finishedAt: deps.finishedAt,
    status: trace.status,
    graph: { addresses, edges },
    convergences,
    exposure,
    exchangeTouchpoints,
    flags,
    riskLevel: riskLevelOf(flags),
    stats: { ...trace.stats },
    warnings,
    dataSources: {
      explorer: CHAINS[params.chain].kind === "tron" ? "tronscan" : "etherscan-v2",
      prices: "defillama",
      labelsVersion: labels.labelsVersion,
      localLabels: labels.hasLocal,
      ofacFetchedAt: deps.ofacFetchedAt,
    },
    policy: { version: policy.version, overridden: policy.overridden },
  };
}

/**
 * `analyze` for a run still in flight: synchronous and network-free. No convergence follow-up
 * (`otherCounterparties` stays empty) and no run outcome (`incomplete_trace` only reflects
 * branches whose data could not be fetched). Pending edges count as transfers, not as stops.
 */
export function analyzeProvisional(
  edges: readonly TraceEdge[],
  params: RunParams,
  labels: LabelRegistry,
  policy: LoadedPolicy,
): DerivedAnalysis {
  const { ctx, addresses, convergences, exposure, exchangeTouchpoints } = deriveFromEdges(
    edges,
    params,
    labels,
  );
  const flags = evaluateFlags({
    ctx,
    flags: policy.flags,
    exposure,
    convergences,
    touchpoints: exchangeTouchpoints,
    status: null,
    // The engine's `maxDepthReached` is the depth of the deepest edge it created.
    maxDepthReached: edges.reduce((max, e) => Math.max(max, e.depth), 0),
  });
  return {
    chain: params.chain,
    direction: params.direction,
    seeds: params.seeds,
    graph: { addresses },
    convergences,
    exposure,
    exchangeTouchpoints,
    flags,
    riskLevel: riskLevelOf(flags),
  };
}
