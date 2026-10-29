import { type AnalyzeDeps, analyze } from "../../src/analysis/analyze.ts";
import type { TraceOutput, TraceStatus } from "../../src/engine/types.ts";
import type { SdnEntry } from "../../src/labels/ofac.ts";
import { LabelRegistry } from "../../src/labels/registry.ts";
import { loadPolicy } from "../../src/policy/policy.ts";
import type {
  ExplorerProvider,
  ListTransfersQuery,
  ListTransfersResult,
  PriceRequest,
  PriceResult,
  PriceSource,
} from "../../src/providers/types.ts";
import { priceKey } from "../../src/providers/types.ts";
import {
  type AnalysisResult,
  type Asset,
  assetId,
  type Direction,
  type LabelCategory,
  RunParamsSchema,
  type Seed,
  type StopReason,
  type TraceEdge,
  type Transfer,
} from "../../src/schema.ts";

export const T0 = 1_700_000_000;

export function addr(n: number): string {
  return `0x${n.toString(16).padStart(40, "0")}`;
}

export const USDT: Asset = {
  chain: "ethereum",
  kind: "token",
  contract: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  symbol: "USDT",
  name: "Tether USD",
  decimals: 6,
  decimalsGuessed: false,
};
export const USDC: Asset = {
  ...USDT,
  contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  symbol: "USDC",
  name: "USD Coin",
};
export const ETH: Asset = { chain: "ethereum", kind: "native" };
/** Cyrillic "Т": a look-alike of USDT on a non-canonical contract. */
export const FAKE_USDT: Asset = { ...USDT, contract: addr(0xfa4e), symbol: "USD\u0422" };

export interface EdgeSpec {
  id: string;
  /** Counterparty being followed (the unknown end). */
  far: string;
  /** Subject side of the edge. */
  near: string;
  depth?: number;
  amount?: number;
  /** Defaults to `amount` (a stablecoin). Pass null for unpriced. */
  usd?: number | null;
  ts?: number;
  asset?: Asset;
  /** Parent edge ids; children are filled in automatically. */
  parents?: string[];
  seedId?: string;
  /** Stop reason for the edge; edges without children default to `no_candidates`. */
  stop?: StopReason;
  rank?: number;
  score?: number;
  dropped?: TraceEdge["dropped"];
}

/** Builds linked edges. Backward: from = far, to = near. Forward: from = near, to = far. */
export function buildEdges(specs: EdgeSpec[], direction: Direction = "backward"): TraceEdge[] {
  const childrenOf = new Map<string, string[]>();
  for (const s of specs) {
    for (const p of s.parents ?? []) childrenOf.set(p, [...(childrenOf.get(p) ?? []), s.id]);
  }
  return specs.map((s): TraceEdge => {
    const asset = s.asset ?? USDT;
    const amount = s.amount ?? 100;
    const from = direction === "backward" ? s.far : s.near;
    const to = direction === "backward" ? s.near : s.far;
    const children = childrenOf.get(s.id) ?? [];
    const stopped = s.stop !== undefined || children.length === 0;
    const transfer: Transfer = {
      chain: "ethereum",
      txHash: `0xtx-${s.id}`,
      blockNumber: 1,
      timestamp: s.ts ?? T0,
      from,
      to,
      asset,
      amountRaw: String(Math.round(amount * 1e6)),
      amount,
    };
    return {
      id: s.id,
      depth: s.depth ?? (s.parents && s.parents.length > 0 ? 1 : 0),
      from,
      to,
      far: s.far,
      near: s.near,
      transfer,
      usd: s.usd === undefined ? amount : s.usd,
      parents: s.parents ?? [],
      children,
      status: stopped ? "stopped" : "expanded",
      stopReason: stopped ? (s.stop ?? "no_candidates") : null,
      stopDetail: null,
      selection:
        s.rank === undefined && s.score === undefined
          ? null
          : {
              score: s.score ?? 0,
              rank: s.rank ?? 0,
              breakdown: { asset: 0, amount: 0, time: 0, dust: 0 },
            },
      swap: null,
      dropped: s.dropped ?? [],
      droppedTotal: s.dropped?.length ?? 0,
      seedId: s.seedId ?? null,
    };
  });
}

export function seeds(...ids: string[]): Seed[] {
  return ids.map((id) => ({ id, kind: "tx", value: `0xseed-${id}` }));
}

export interface LabelSpec {
  address: string;
  name: string;
  category: LabelCategory;
  entity?: string;
}

export interface Scenario {
  direction?: Direction;
  seedIds?: string[];
  status?: TraceStatus;
  labels?: LabelSpec[];
  /** Addresses on the OFAC list, without SDN entries: they get the constant `OFAC SDN` label. */
  ofac?: string[];
  /** Addresses on the OFAC list with the SDN entries that list them. */
  sdn?: Record<string, SdnEntry[]>;
  /** Bundled (not local) labels, so a local/ofac label can be stacked on the same address. */
  bundled?: LabelSpec[];
  policy?: unknown | null;
  maxDepthReached?: number;
  warnings?: { code: string; message: string }[];
  provider?: ExplorerProvider;
  prices?: PriceSource;
  signal?: AbortSignal;
}

export function registryFor(s: Scenario): LabelRegistry {
  const bundled = s.bundled?.length
    ? [
        {
          chain: "ethereum" as const,
          entries: s.bundled.map((l) => ({
            address: l.address,
            name: l.name,
            category: l.category,
            ...(l.entity ? { entity: l.entity } : {}),
            source: "https://example.com/source",
            verifiedAt: "2026-01-01",
          })),
        },
      ]
    : [];
  const local = s.labels?.length
    ? { entries: s.labels.map((l) => ({ chain: "ethereum" as const, ...l })) }
    : null;
  const ofac =
    s.ofac || s.sdn
      ? {
          fetchedAt: "2026-10-20T00:00:00.000Z",
          evm: new Map<string, SdnEntry[]>([
            ...(s.ofac ?? []).map((address): [string, SdnEntry[]] => [address, []]),
            ...Object.entries(s.sdn ?? {}),
          ]),
          tron: new Map(),
        }
      : null;
  return new LabelRegistry(bundled, local, ofac);
}

export interface FakeProvider extends ExplorerProvider {
  calls: ListTransfersQuery[];
}

/** Provider whose `listTransfers` is answered by `handler`; `getTransaction` is never expected. */
export function fakeProvider(
  handler: (q: ListTransfersQuery) => ListTransfersResult | Promise<ListTransfersResult> = () => ({
    rows: [],
    truncated: false,
  }),
): FakeProvider {
  const calls: ListTransfersQuery[] = [];
  return {
    chain: "ethereum",
    calls,
    getTransaction: () => Promise.reject(new Error("getTransaction not expected")),
    listTransfers: async (q) => {
      calls.push(q);
      return handler(q);
    },
    stats: () => ({ apiCalls: calls.length, cacheHits: 0 }),
  };
}

/** Prices by assetId; unknown assets are unpriced. */
export function fakePrices(
  byAsset: Record<string, number> = { [assetId(USDT)]: 1, [assetId(USDC)]: 1 },
): PriceSource {
  return {
    priceMany: async (items: PriceRequest[]): Promise<PriceResult> => {
      const prices = new Map<string, number | null>();
      for (const i of items)
        prices.set(priceKey(i.asset, i.timestamp), byAsset[assetId(i.asset)] ?? null);
      return { prices, warning: null };
    },
    stats: () => ({ apiCalls: 0, cacheHits: 0 }),
  };
}

export function transferRow(init: {
  tx: string;
  from: string;
  to: string;
  amount: number;
  ts?: number;
  asset?: Asset;
}): Transfer {
  const amount = init.amount;
  return {
    chain: "ethereum",
    txHash: init.tx,
    blockNumber: 1,
    timestamp: init.ts ?? T0 + 1000,
    from: init.from,
    to: init.to,
    asset: init.asset ?? USDT,
    amountRaw: String(Math.round(amount * 1e6)),
    amount,
  };
}

export async function runAnalysis(edges: TraceEdge[], s: Scenario = {}): Promise<AnalysisResult> {
  const direction = s.direction ?? "backward";
  const params = RunParamsSchema.parse({
    chain: "ethereum",
    direction,
    seeds: seeds(...(s.seedIds ?? ["s1"])),
  });
  const maxDepth = s.maxDepthReached ?? edges.reduce((m, e) => Math.max(m, e.depth), 0);
  const trace: TraceOutput = {
    edges,
    status: s.status ?? "completed",
    warnings: s.warnings ?? [],
    stats: {
      expandedEdges: edges.length,
      apiCalls: 3,
      cacheHits: 1,
      droppedCandidates: 0,
      maxDepthReached: maxDepth,
    },
  };
  const deps: AnalyzeDeps = {
    provider: s.provider ?? fakeProvider(),
    prices: s.prices ?? fakePrices(),
    signal: s.signal ?? new AbortController().signal,
    runId: "run-1",
    startedAt: "2026-10-20T10:00:00.000Z",
    finishedAt: "2026-10-20T10:00:05.000Z",
    ofacFetchedAt: s.ofac || s.sdn ? "2026-10-20T00:00:00.000Z" : null,
  };
  return analyze(trace, params, registryFor(s), loadPolicy(s.policy ?? null), deps);
}

export function flagIds(result: AnalysisResult): string[] {
  return result.flags.map((f) => f.id);
}
