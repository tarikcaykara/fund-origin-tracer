import { z } from "zod";
import { CHAIN_IDS, type ChainId } from "./chains.ts";

export const ChainIdSchema = z.enum(CHAIN_IDS);
export type { ChainId };

export const AssetSchema = z.discriminatedUnion("kind", [
  z.object({ chain: ChainIdSchema, kind: z.literal("native") }),
  z.object({
    chain: ChainIdSchema,
    kind: z.literal("token"),
    contract: z.string(),
    symbol: z.string(),
    name: z.string(),
    decimals: z.number().int().min(0),
    decimalsGuessed: z.boolean(),
  }),
]);
export type Asset = z.infer<typeof AssetSchema>;

export function assetId(a: Asset): string {
  return a.kind === "native" ? `${a.chain}:native` : `${a.chain}:${a.contract}`;
}

export const TransferSchema = z.object({
  chain: ChainIdSchema,
  txHash: z.string(),
  blockNumber: z.number().int(),
  timestamp: z.number().int(),
  from: z.string(),
  to: z.string(),
  asset: AssetSchema,
  amountRaw: z.string().regex(/^\d+$/),
  amount: z.number(),
});
export type Transfer = z.infer<typeof TransferSchema>;

export function transferId(t: Transfer): string {
  return `${t.txHash}|${assetId(t.asset)}|${t.from}|${t.to}|${t.amountRaw}`;
}

export const TxDetailSchema = z.object({
  chain: ChainIdSchema,
  hash: z.string(),
  blockNumber: z.number().int(),
  timestamp: z.number().int(),
  from: z.string(),
  to: z.string().nullable(),
  status: z.enum(["success", "failed"]),
  transfers: z.array(TransferSchema),
});
export type TxDetail = z.infer<typeof TxDetailSchema>;

export const SeedSchema = z.object({
  id: z.string().regex(/^s([1-9]|1\d|20)$/),
  kind: z.enum(["tx", "address"]),
  value: z.string().min(1),
});
export type Seed = z.infer<typeof SeedSchema>;

export const DirectionSchema = z.enum(["backward", "forward"]);
export type Direction = z.infer<typeof DirectionSchema>;

export const RunParamsSchema = z.object({
  chain: ChainIdSchema,
  direction: DirectionSchema,
  seeds: z.array(SeedSchema).min(1).max(20),
  maxDepth: z.number().int().min(1).max(50).default(10),
  maxBranches: z.number().int().min(1).max(10).default(3),
  maxEdges: z.number().int().min(10).max(5000).default(200),
  minUsd: z.number().min(0).default(0),
  traceThroughEntities: z.boolean().default(false),
  followUnpriced: z.boolean().default(false),
  timeoutSec: z.number().int().min(10).max(3600).default(600),
});
export type RunParams = z.infer<typeof RunParamsSchema>;

export const LabelCategorySchema = z.enum([
  "exchange",
  "dex",
  "bridge",
  "mixer",
  "sanctioned",
  "scam",
  "defi",
  "token",
  "other",
]);
export type LabelCategory = z.infer<typeof LabelCategorySchema>;

export const LabelSchema = z.object({
  name: z.string(),
  category: LabelCategorySchema,
  entity: z.string().optional(),
  source: z.string(),
  origin: z.enum(["bundled", "local", "ofac"]),
});
export type Label = z.infer<typeof LabelSchema>;

export const DropReasonSchema = z.enum([
  "spoofed_token",
  "zero_value",
  "self_transfer",
  "same_tx",
  "outside_time_window",
  "below_min_usd",
  "unpriced",
  "exceeds_max_branches",
]);
export type DropReason = z.infer<typeof DropReasonSchema>;

export const StopReasonSchema = z.enum([
  "entity",
  "sanctioned",
  "mint",
  "no_candidates",
  "cycle",
  "max_depth",
  "max_edges",
  "timeout",
  "cancelled",
  "fetch_failed",
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

/** Stop reasons "Expand further" may continue from. */
export const EXPANDABLE_REASONS: ReadonlySet<StopReason> = new Set<StopReason>([
  "max_depth",
  "max_edges",
  "timeout",
  "cancelled",
  "entity",
]);

const usdSchema = z.number().nullable();

export const TraceEdgeSchema = z.object({
  id: z.string(),
  depth: z.number().int().min(0),
  from: z.string(),
  to: z.string(),
  far: z.string(),
  near: z.string(),
  transfer: TransferSchema,
  usd: usdSchema,
  parents: z.array(z.string()),
  children: z.array(z.string()),
  status: z.enum(["pending", "expanded", "stopped"]),
  stopReason: StopReasonSchema.nullable(),
  stopDetail: z.string().nullable(),
  selection: z
    .object({
      score: z.number(),
      rank: z.number().int(),
      breakdown: z.object({
        asset: z.number(),
        amount: z.number(),
        time: z.number(),
        dust: z.number(),
      }),
    })
    .nullable(),
  swap: z.object({ asset: AssetSchema, amount: z.number() }).nullable(),
  dropped: z
    .array(
      z.object({
        transfer: TransferSchema,
        usd: usdSchema,
        reason: DropReasonSchema,
        score: z.number().nullable(),
      }),
    )
    .max(30),
  droppedTotal: z.number().int().min(0),
  seedId: z.string().nullable(),
});
export type TraceEdge = z.infer<typeof TraceEdgeSchema>;

export const AddressNodeSchema = z.object({
  address: z.string(),
  labels: z.array(LabelSchema),
  sanctioned: z.boolean(),
  isSeedSubject: z.boolean(),
  seedIds: z.array(z.string()),
  inEdgeIds: z.array(z.string()),
  outEdgeIds: z.array(z.string()),
});
export type AddressNode = z.infer<typeof AddressNodeSchema>;

const totalsSchema = z.object({ assetId: z.string(), symbol: z.string(), amount: z.number() });

export const ConvergenceSchema = z.object({
  address: z.string(),
  role: z.enum(["common_source", "common_destination"]),
  kinds: z.array(z.enum(["shared_across_seeds", "shared_within_trace"])),
  seedIds: z.array(z.string()),
  edgeIds: z.array(z.string()),
  counterparties: z.array(z.string()),
  totals: z.array(totalsSchema),
  usd: usdSchema,
  minDepth: z.number().int(),
  otherCounterparties: z.array(TransferSchema),
});
export type Convergence = z.infer<typeof ConvergenceSchema>;

export const ExposureEntrySchema = z.object({
  category: LabelCategorySchema,
  entity: z.string().nullable(),
  address: z.string(),
  hops: z.number().int(),
  edgeId: z.string(),
  txHash: z.string(),
  assetId: z.string(),
  symbol: z.string(),
  amount: z.number(),
  usd: usdSchema,
});
export type ExposureEntry = z.infer<typeof ExposureEntrySchema>;

const countUsd = z.object({ count: z.number().int(), usd: z.number() });

export const ExposureSchema = z.object({
  entries: z.array(ExposureEntrySchema),
  byCategory: z.array(
    z.object({
      category: LabelCategorySchema,
      direct: countUsd,
      indirect: countUsd.extend({ minHops: z.number().int().nullable() }),
    }),
  ),
  byEntity: z.array(
    z.object({
      entity: z.string(),
      category: LabelCategorySchema,
      count: z.number().int(),
      usd: z.number(),
      minHops: z.number().int(),
    }),
  ),
  unresolved: z.object({
    count: z.number().int(),
    usd: z.number(),
    byReason: z.record(StopReasonSchema, countUsd),
  }),
  terminalUsd: z.number(),
  unpricedCount: z.number().int(),
});
export type Exposure = z.infer<typeof ExposureSchema>;

export const ExchangeTouchpointSchema = z.object({
  kind: z.enum(["origin", "arrival"]),
  entity: z.string(),
  exchangeAddress: z.string(),
  counterparty: z.string().nullable(),
  txHash: z.string(),
  assetId: z.string(),
  symbol: z.string(),
  amount: z.number(),
  usd: usdSchema,
  timestamp: z.number().int(),
  depth: z.number().int(),
  seedIds: z.array(z.string()),
});
export type ExchangeTouchpoint = z.infer<typeof ExchangeTouchpointSchema>;

export const SeveritySchema = z.enum(["high", "medium", "low", "info"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FlagSchema = z.object({
  id: z.string(),
  severity: SeveritySchema,
  title: z.string(),
  detail: z.string(),
  evidence: z.object({ addresses: z.array(z.string()), edgeIds: z.array(z.string()) }),
});
export type Flag = z.infer<typeof FlagSchema>;

export const RunStatusSchema = z.enum(["completed", "cancelled", "timed_out", "failed"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const AnalysisResultSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  chain: ChainIdSchema,
  direction: DirectionSchema,
  params: RunParamsSchema,
  seeds: z.array(SeedSchema),
  startedAt: z.string(),
  finishedAt: z.string(),
  status: RunStatusSchema,
  graph: z.object({ addresses: z.array(AddressNodeSchema), edges: z.array(TraceEdgeSchema) }),
  convergences: z.array(ConvergenceSchema),
  exposure: ExposureSchema,
  exchangeTouchpoints: z.array(ExchangeTouchpointSchema),
  flags: z.array(FlagSchema),
  riskLevel: z.enum(["low", "medium", "high"]),
  stats: z.object({
    expandedEdges: z.number().int(),
    apiCalls: z.number().int(),
    cacheHits: z.number().int(),
    droppedCandidates: z.number().int(),
    maxDepthReached: z.number().int(),
  }),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  dataSources: z.object({
    explorer: z.enum(["etherscan-v2", "tronscan"]),
    prices: z.literal("defillama"),
    labelsVersion: z.string(),
    localLabels: z.boolean(),
    ofacFetchedAt: z.string().nullable(),
  }),
  policy: z.object({ version: z.number().int(), overridden: z.boolean() }),
});
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

const statsSchema = z.object({
  expandedEdges: z.number().int(),
  apiCalls: z.number().int(),
  cacheHits: z.number().int(),
  droppedCandidates: z.number().int(),
  maxDepthReached: z.number().int(),
});

export const RunEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), status: z.enum(["running", "paused"]) }),
  z.object({ type: z.literal("edge_added"), edge: TraceEdgeSchema }),
  z.object({ type: z.literal("edge_linked"), edgeId: z.string(), parentId: z.string() }),
  z.object({
    type: z.literal("edge_expanded"),
    edgeId: z.string(),
    selected: z.array(z.string()),
    droppedTotal: z.number().int(),
  }),
  z.object({
    type: z.literal("edge_stopped"),
    edgeId: z.string(),
    reason: StopReasonSchema,
    detail: z.string().nullable(),
  }),
  z.object({
    type: z.literal("progress"),
    expandedEdges: z.number().int(),
    queued: z.number().int(),
    apiCalls: z.number().int(),
    cacheHits: z.number().int(),
    elapsedMs: z.number(),
  }),
  z.object({ type: z.literal("warning"), code: z.string(), message: z.string() }),
  z.object({ type: z.literal("result"), result: AnalysisResultSchema }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
  z.object({ type: z.literal("done"), status: RunStatusSchema }),
  z.object({
    type: z.literal("snapshot"),
    status: z.enum(["running", "paused", "completed", "cancelled", "timed_out", "failed"]),
    edges: z.array(TraceEdgeSchema),
    stats: statsSchema.partial(),
  }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
