import { isZeroAddress, normalizeAddress } from "../chains.ts";
import { isFotError } from "../errors.ts";
import type { RunController } from "../infra/controller.ts";
import { isSpoofed } from "../labels/spoof.ts";
import { priceKey } from "../providers/types.ts";
import {
  assetId,
  type DropReason,
  type LabelCategory,
  type RunParams,
  type Seed,
  type StopReason,
  type TraceEdge,
  type Transfer,
  transferId,
} from "../schema.ts";
import {
  compareScored,
  type DropContext,
  dropReason,
  type ScoreBreakdown,
  type ScoreReference,
  scoreCandidate,
} from "./score.ts";
import type {
  ContinueFrom,
  Emit,
  EngineDeps,
  TraceOutput,
  TraceStats,
  TraceStatus,
} from "./types.ts";

const MAX_SEED_LEGS = 10;
const MAX_DROPPED_KEPT = 30;
const DROP_REASON_ORDER: readonly DropReason[] = [
  "spoofed_token",
  "zero_value",
  "self_transfer",
  "same_tx",
  "outside_time_window",
  "below_min_usd",
  "unpriced",
  "exceeds_max_branches",
];

/**
 * Keeps at most MAX_DROPPED_KEPT drops: first one example per distinct reason (plan order; the
 * best-scored one for exceeds_max_branches), then fills by score desc, then unscored in order.
 * `all` lists exceeds_max_branches in score order, followed by unscored drops in candidate order.
 */
function retainDropped(all: TraceEdge["dropped"]): TraceEdge["dropped"] {
  if (all.length <= MAX_DROPPED_KEPT) return all;
  const chosen = new Set<number>();
  for (const reason of DROP_REASON_ORDER) {
    const i = all.findIndex((d) => d.reason === reason);
    if (i >= 0 && chosen.size < MAX_DROPPED_KEPT) chosen.add(i);
  }
  for (let i = 0; i < all.length && chosen.size < MAX_DROPPED_KEPT; i++) {
    if (all[i]?.score !== null) chosen.add(i);
  }
  for (let i = 0; i < all.length && chosen.size < MAX_DROPPED_KEPT; i++) chosen.add(i);
  const reserved = all.filter((_, i) => chosen.has(i));
  const rank = (d: TraceEdge["dropped"][number]): number => (d.score === null ? 1 : 0);
  return reserved.sort((a, b) => rank(a) - rank(b) || (b.score ?? 0) - (a.score ?? 0));
}
const PROGRESS_INTERVAL_MS = 1000;

const DEFAULT_STOP_CATEGORIES: ReadonlySet<LabelCategory> = new Set([
  "exchange",
  "dex",
  "bridge",
  "mixer",
  "scam",
  "token",
]);
const THROUGH_STOP_CATEGORIES: ReadonlySet<LabelCategory> = new Set(["mixer"]);

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const ENCODER = new TextEncoder();

/** Stable edge id: `e` + 16 hex of FNV-1a 64 over `transferId(transfer)`. */
export function edgeIdFor(transfer: Transfer): string {
  let h = FNV_OFFSET;
  for (const byte of ENCODER.encode(transferId(transfer))) {
    h = BigInt.asUintN(64, (h ^ BigInt(byte)) * FNV_PRIME);
  }
  return `e${h.toString(16).padStart(16, "0")}`;
}

/** Engine-internal bookkeeping per edge; never serialized. */
interface EdgeMeta {
  /** Normalized addresses of the subject chain from the seed down to this edge. */
  path: Set<string>;
  seedIndex: number;
  rank: number;
  seq: number;
}

interface Leg {
  transfer: Transfer;
  usd: number | null;
  swap: TraceEdge["swap"];
}

type SeedOutcome =
  | { kind: "ok"; legs: Leg[] }
  | { kind: "failed"; code: string; message: string }
  | { kind: "skipped" };

interface StopVerdict {
  reason: StopReason;
  detail: string | null;
}

/** Sentinel thrown by `gate()` so an interrupted expansion unwinds without touching the edge. */
class InterruptedError extends Error {}

class MinHeap<T> {
  readonly #items: T[] = [];
  constructor(private readonly less: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.#items.length;
  }

  push(item: T): void {
    const a = this.#items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const cur = a[i] as T;
      const parent = a[p] as T;
      if (!this.less(cur, parent)) break;
      a[i] = parent;
      a[p] = cur;
      i = p;
    }
  }

  pop(): T | undefined {
    const a = this.#items;
    const top = a[0];
    const last = a.pop();
    if (last === undefined || a.length === 0) return top;
    a[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < a.length && this.less(a[l] as T, a[m] as T)) m = l;
      if (r < a.length && this.less(a[r] as T, a[m] as T)) m = r;
      if (m === i) break;
      const tmp = a[i] as T;
      a[i] = a[m] as T;
      a[m] = tmp;
      i = m;
    }
    return top;
  }
}

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Swap detection from a listing/tx transfer pool. For candidate `c` in a backward trace, other
 * transfers of `c`'s tx sent by `c.to` in a different asset mean `c.to` swapped that asset for
 * `c.asset`; forward mirrors it with transfers received by `c.from`. Returns the largest leg.
 *
 * TRON listings are direction-filtered (the pool holds only the requested direction), so the
 * opposite leg is not visible there: swap-through only triggers for seed txs on TRON, where
 * `getTransaction` returns every transfer of the tx.
 */
function detectSwap(c: Transfer, pool: readonly Transfer[], backward: boolean): TraceEdge["swap"] {
  const pivot = normalizeAddress(c.chain, backward ? c.to : c.from);
  const txHash = c.txHash.toLowerCase();
  const cAsset = assetId(c.asset);
  let best: Transfer | null = null;
  for (const r of pool) {
    if (r.txHash.toLowerCase() !== txHash) continue;
    if (assetId(r.asset) === cAsset || r.amount <= 0) continue;
    const side = normalizeAddress(r.chain, backward ? r.from : r.to);
    if (side !== pivot) continue;
    if (best === null || r.amount > best.amount) best = r;
  }
  return best === null ? null : { asset: best.asset, amount: best.amount };
}

export async function runTrace(
  params: RunParams,
  deps: EngineDeps,
  controller: RunController,
  emit: Emit,
  continueFrom?: ContinueFrom,
): Promise<TraceOutput> {
  const { provider, prices, labels, now } = deps;
  const chain = params.chain;
  const backward = params.direction === "backward";
  const concurrency = Math.max(1, deps.concurrency ?? 4);
  const startedAt = now();
  const norm = (a: string): string => normalizeAddress(chain, a);

  const runAbort = new AbortController();
  const signal = AbortSignal.any([controller.signal, runAbort.signal]);

  const edges: TraceEdge[] = continueFrom ? structuredClone(continueFrom.edges) : [];
  const byId = new Map<string, TraceEdge>(edges.map((e) => [e.id, e]));
  const metas = new Map<string, EdgeMeta>();
  const warnings: TraceOutput["warnings"] = [];
  const state = {
    fatal: null as { code: string; message: string } | null,
    seedsFailed: false,
    expanded: 0,
    dropped: 0,
    seq: 0,
    pricesWarned: false,
    maxDepth: edges.reduce((m, e) => Math.max(m, e.depth), 0),
  };
  let depthLimit = params.maxDepth;
  let targetId: string | null = null;

  const queue = new MinHeap<TraceEdge>((a, b) => {
    const ma = metas.get(a.id) as EdgeMeta;
    const mb = metas.get(b.id) as EdgeMeta;
    if (a.depth !== b.depth) return a.depth < b.depth;
    if (ma.seedIndex !== mb.seedIndex) return ma.seedIndex < mb.seedIndex;
    if (ma.rank !== mb.rank) return ma.rank < mb.rank;
    return ma.seq < mb.seq;
  });

  function warn(code: string, message: string): void {
    warnings.push({ code, message });
    emit({ type: "warning", code, message });
  }

  let truncatedWarned = false;
  function noteTruncated(listing: { truncated: boolean }): void {
    if (!listing.truncated || truncatedWarned) return;
    truncatedWarned = true;
    warn(
      "listing_truncated",
      "At least one address listing hit the page cap; older or newer transfers may be missing. Raise EXPLORER_MAX_PAGES for deeper listings.",
    );
  }

  function raiseFatal(code: string, message: string): void {
    if (state.fatal) return;
    state.fatal = { code, message };
    emit({ type: "error", code, message });
    runAbort.abort();
  }

  function interruption(): StopVerdict {
    if (state.fatal) return { reason: "fetch_failed", detail: state.fatal.code };
    if (controller.cancelReason === "timeout") return { reason: "timeout", detail: null };
    return { reason: "cancelled", detail: null };
  }

  function stopEdge(edge: TraceEdge, reason: StopReason, detail: string | null): void {
    edge.status = "stopped";
    edge.stopReason = reason;
    edge.stopDetail = detail;
    emit({ type: "edge_stopped", edgeId: edge.id, reason, detail });
  }

  function stats(): { apiCalls: number; cacheHits: number } {
    const p = provider.stats();
    const q = prices.stats();
    return { apiCalls: p.apiCalls + q.apiCalls, cacheHits: p.cacheHits + q.cacheHits };
  }

  function emitProgress(): void {
    emit({
      type: "progress",
      expandedEdges: state.expanded,
      queued: queue.size,
      ...stats(),
      elapsedMs: now() - startedAt,
    });
  }

  /** Waits out a pause; throws when the run was cancelled, timed out or aborted. */
  async function gate(): Promise<void> {
    await controller.waitIfPaused();
    if (signal.aborted) throw new InterruptedError();
  }

  /**
   * USD value per transfer (aligned with input) from one batched price lookup; `complete` is
   * false when the lookup failed or returned a warning.
   */
  async function priceAll(
    transfers: readonly Transfer[],
  ): Promise<{ usd: (number | null)[]; complete: boolean }> {
    if (transfers.length === 0) return { usd: [], complete: true };
    await gate();
    const items = new Map<string, { asset: Transfer["asset"]; timestamp: number }>();
    for (const t of transfers) {
      items.set(priceKey(t.asset, t.timestamp), { asset: t.asset, timestamp: t.timestamp });
    }
    let map: Map<string, number | null>;
    let complete = true;
    try {
      const res = await prices.priceMany([...items.values()], signal);
      map = res.prices;
      if (res.warning) {
        complete = false;
        pricesUnavailable(res.warning.message);
      }
    } catch (e) {
      if (signal.aborted || !isFotError(e) || e.fatal) throw e;
      complete = false;
      pricesUnavailable(e.message);
      map = new Map();
    }
    if (signal.aborted) throw new InterruptedError();
    const usd = transfers.map((t) => {
      const p = map.get(priceKey(t.asset, t.timestamp));
      return p === undefined || p === null ? null : t.amount * p;
    });
    return { usd, complete };
  }

  function pricesUnavailable(message: string): void {
    if (state.pricesWarned) return;
    state.pricesWarned = true;
    warn("prices_unavailable", message);
  }

  function enqueue(edge: TraceEdge, meta: Omit<EdgeMeta, "seq">): void {
    metas.set(edge.id, { ...meta, seq: state.seq++ });
    queue.push(edge);
  }

  function newEdge(
    transfer: Transfer,
    depth: number,
    init: Pick<TraceEdge, "usd" | "swap" | "selection" | "seedId" | "parents">,
  ): TraceEdge {
    const edge: TraceEdge = {
      id: edgeIdFor(transfer),
      depth,
      from: transfer.from,
      to: transfer.to,
      far: backward ? transfer.from : transfer.to,
      near: backward ? transfer.to : transfer.from,
      transfer,
      usd: init.usd,
      parents: init.parents,
      children: [],
      status: "pending",
      stopReason: null,
      stopDetail: null,
      selection: init.selection,
      swap: init.swap,
      dropped: [],
      droppedTotal: 0,
      seedId: init.seedId,
    };
    edges.push(edge);
    byId.set(edge.id, edge);
    if (depth > state.maxDepth) state.maxDepth = depth;
    emit({ type: "edge_added", edge: structuredClone(edge) });
    return edge;
  }

  // ---------------------------------------------------------------- seeds

  async function loadSeed(seed: Seed): Promise<Leg[]> {
    if (seed.kind === "tx") {
      const tx = await provider.getTransaction(seed.value, signal);
      const candidates = tx.transfers.filter(
        (t) => t.amount > 0 && !isZeroAddress(chain, t.from) && !isZeroAddress(chain, t.to),
      );
      const { usd } = await priceAll(candidates);
      const legs = candidates.map((transfer, i) => ({
        transfer,
        usd: usd[i] ?? null,
        swap: detectSwap(transfer, tx.transfers, backward),
      }));
      // Array.prototype.sort is stable, so equal usd keeps input order.
      legs.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
      return legs.slice(0, MAX_SEED_LEGS);
    }

    const address = norm(seed.value);
    const listing = await provider.listTransfers({
      address: seed.value,
      direction: backward ? "in" : "out",
      window: {},
      signal,
    });
    noteTruncated(listing);
    const seen = new Set<string>();
    const rows = listing.rows.filter((t) => {
      if ((backward ? norm(t.to) : norm(t.from)) !== address) return false;
      if (
        t.amountRaw.replace(/0/g, "") === "" ||
        norm(t.from) === norm(t.to) ||
        isSpoofed(t.asset)
      ) {
        return false;
      }
      const id = transferId(t);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const { usd } = await priceAll(rows);
    const legs = rows.map((transfer, i) => ({
      transfer,
      usd: usd[i] ?? null,
      swap: detectSwap(transfer, listing.rows, backward),
    }));
    legs.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || b.transfer.timestamp - a.transfer.timestamp);
    return legs.slice(0, params.maxBranches);
  }

  async function seedPhase(): Promise<void> {
    const outcomes = await mapPool<Seed, SeedOutcome>(params.seeds, concurrency, async (seed) => {
      try {
        await gate();
        return { kind: "ok", legs: await loadSeed(seed) };
      } catch (e) {
        if (isFotError(e) && e.fatal) {
          raiseFatal(e.code, e.message);
          return { kind: "skipped" };
        }
        if (signal.aborted || e instanceof InterruptedError) return { kind: "skipped" };
        if (isFotError(e)) return { kind: "failed", code: e.code, message: e.message };
        raiseFatal("internal_error", e instanceof Error ? e.message : String(e));
        return { kind: "skipped" };
      }
    });

    let failed = 0;
    params.seeds.forEach((seed, seedIndex) => {
      const outcome = outcomes[seedIndex] as SeedOutcome;
      if (outcome.kind === "skipped") return;
      if (outcome.kind === "failed") {
        failed++;
        warn(
          `seed_failed:${seed.id}`,
          `Seed ${seed.id} could not be loaded (${outcome.code}): ${outcome.message}`,
        );
        return;
      }
      if (outcome.legs.length === 0) {
        warn(`seed_empty:${seed.id}`, `Seed ${seed.id} has no traceable transfers.`);
        return;
      }
      outcome.legs.forEach((leg, i) => {
        if (byId.has(edgeIdFor(leg.transfer))) {
          warn(
            `seed_duplicate:${seed.id}`,
            `Seed ${seed.id} repeats a transfer of an earlier seed.`,
          );
          return;
        }
        const edge = newEdge(leg.transfer, 0, {
          usd: leg.usd,
          swap: leg.swap,
          selection: null,
          seedId: seed.id,
          parents: [],
        });
        const near = backward ? leg.transfer.to : leg.transfer.from;
        enqueue(edge, { path: new Set([norm(near)]), seedIndex, rank: i + 1 });
      });
    });
    if (failed === params.seeds.length) {
      state.seedsFailed = true;
      emit({ type: "error", code: "seeds_failed", message: "Every seed failed to load." });
    }
  }

  // ----------------------------------------------------------- continue

  function prepareContinuation(c: ContinueFrom): void {
    const target = byId.get(c.edgeId);
    if (!target) throw new Error(`continueFrom: edge ${c.edgeId} not found`);
    // `near` of every edge on the first-parent chain equals the subject of its parent, plus the
    // seed edge's own near/address, which is exactly the path set of the original run.
    const path = new Set<string>();
    let cur: TraceEdge | undefined = target;
    let root: TraceEdge = target;
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      path.add(norm(cur.near));
      root = cur;
      const parentId: string | undefined = cur.parents[0];
      cur = parentId === undefined ? undefined : byId.get(parentId);
    }
    const seedIndex = Math.max(
      0,
      params.seeds.findIndex((s) => s.id === root.seedId),
    );
    target.status = "pending";
    target.stopReason = null;
    target.stopDetail = null;
    targetId = target.id;
    depthLimit = target.depth + c.maxDepth;
    enqueue(target, { path, seedIndex, rank: target.selection?.rank ?? 1 });
  }

  // ----------------------------------------------------------- scheduler

  function precheck(edge: TraceEdge): StopVerdict | null {
    const meta = metas.get(edge.id) as EdgeMeta;
    if (isZeroAddress(chain, edge.far)) return { reason: "mint", detail: null };
    const farLabels = labels.lookup(chain, edge.far);
    const sanctionedLabel = farLabels.find((l) => l.category === "sanctioned");
    if (labels.isSanctioned(chain, edge.far) || sanctionedLabel) {
      return { reason: "sanctioned", detail: sanctionedLabel?.name ?? null };
    }
    if (edge.swap === null) {
      const through =
        params.traceThroughEntities ||
        (edge.id === targetId && continueFrom !== undefined && continueFrom.throughEntities);
      const stopSet = through ? THROUGH_STOP_CATEGORIES : DEFAULT_STOP_CATEGORIES;
      const hit = farLabels.find((l) => stopSet.has(l.category));
      if (hit) return { reason: "entity", detail: hit.name };
      if (meta.path.has(norm(edge.far))) return { reason: "cycle", detail: null };
    }
    if (edge.depth >= depthLimit) return { reason: "max_depth", detail: null };
    if (state.expanded >= params.maxEdges) return { reason: "max_edges", detail: null };
    return null;
  }

  async function expandEdge(edge: TraceEdge): Promise<void> {
    const meta = metas.get(edge.id) as EdgeMeta;
    const swapThrough = edge.swap !== null;
    const subject = edge.swap ? edge.near : edge.far;
    const reference: ScoreReference = edge.swap
      ? {
          asset: edge.swap.asset,
          amount: edge.swap.amount,
          usd: null,
          timestamp: edge.transfer.timestamp,
        }
      : {
          asset: edge.transfer.asset,
          amount: edge.transfer.amount,
          usd: edge.usd,
          timestamp: edge.transfer.timestamp,
        };
    const t = edge.transfer.timestamp;

    await gate();
    const listing = await provider.listTransfers({
      address: subject,
      direction: backward ? "in" : "out",
      window: backward ? { beforeTs: t } : { afterTs: t },
      signal,
    });
    noteTruncated(listing);
    const subjectNorm = norm(subject);
    const seen = new Set<string>();
    const rows = listing.rows.filter((r) => {
      if ((backward ? norm(r.to) : norm(r.from)) !== subjectNorm) return false;
      const id = transferId(r);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const { usd, complete } = await priceAll(rows);

    const ctx: DropContext = {
      direction: params.direction,
      edgeTxHash: edge.transfer.txHash,
      refTimestamp: t,
      minUsd: params.minUsd,
      followUnpriced: params.followUnpriced,
      pricesComplete: complete,
    };
    const refAssetId = assetId(reference.asset);
    type Scored = {
      transfer: Transfer;
      usd: number | null;
      score: number;
      breakdown: ScoreBreakdown;
    };
    const scored: Scored[] = [];
    const unscoredDrops: TraceEdge["dropped"] = [];
    rows.forEach((transfer, i) => {
      const value = usd[i] ?? null;
      const reason = dropReason(transfer, value, ctx);
      if (reason !== null) {
        unscoredDrops.push({ transfer, usd: value, reason, score: null });
        return;
      }
      // Swap-through only follows the swapped-for asset; other assets are skipped silently.
      if (swapThrough && assetId(transfer.asset) !== refAssetId) return;
      scored.push({ transfer, usd: value, ...scoreCandidate(reference, transfer, value) });
    });
    scored.sort((a, b) => compareScored(a, b, t));
    const selected = scored.slice(0, params.maxBranches);
    const droppedAll: TraceEdge["dropped"] = [
      ...scored.slice(params.maxBranches).map((c) => ({
        transfer: c.transfer,
        usd: c.usd,
        reason: "exceeds_max_branches" as const,
        score: c.score,
      })),
      ...unscoredDrops,
    ];

    if (signal.aborted) throw new InterruptedError();

    edge.dropped = retainDropped(droppedAll);
    edge.droppedTotal = droppedAll.length;
    state.dropped += droppedAll.length;

    if (selected.length === 0) {
      stopEdge(edge, "no_candidates", listing.truncated ? "listing_truncated" : null);
      return;
    }

    const childIds: string[] = [];
    const childPath = new Set(meta.path);
    childPath.add(subjectNorm);
    selected.forEach((cand, i) => {
      const id = edgeIdFor(cand.transfer);
      childIds.push(id);
      const existing = byId.get(id);
      if (existing) {
        if (!existing.parents.includes(edge.id)) existing.parents.push(edge.id);
        emit({ type: "edge_linked", edgeId: id, parentId: edge.id });
        return;
      }
      const child = newEdge(cand.transfer, edge.depth + 1, {
        usd: cand.usd,
        swap: detectSwap(cand.transfer, listing.rows, backward),
        selection: { score: cand.score, rank: i + 1, breakdown: cand.breakdown },
        seedId: null,
        parents: [edge.id],
      });
      enqueue(child, { path: childPath, seedIndex: meta.seedIndex, rank: i + 1 });
    });
    edge.children = childIds;
    edge.status = "expanded";
    emit({
      type: "edge_expanded",
      edgeId: edge.id,
      selected: childIds,
      droppedTotal: edge.droppedTotal,
    });
  }

  async function expandGuarded(edge: TraceEdge): Promise<void> {
    try {
      await expandEdge(edge);
    } catch (e) {
      if (isFotError(e) && e.fatal) {
        raiseFatal(e.code, e.message);
        stopEdge(edge, "fetch_failed", e.code);
      } else if (signal.aborted || e instanceof InterruptedError) {
        const v = interruption();
        stopEdge(edge, v.reason, v.detail);
      } else if (isFotError(e)) {
        stopEdge(edge, "fetch_failed", e.code);
      } else {
        raiseFatal("internal_error", e instanceof Error ? e.message : String(e));
        stopEdge(edge, "fetch_failed", "internal_error");
      }
    }
  }

  async function schedule(): Promise<void> {
    const inflight = new Set<Promise<void>>();
    while (!signal.aborted) {
      while (inflight.size < concurrency && queue.size > 0) {
        await controller.waitIfPaused();
        if (signal.aborted) break;
        const edge = queue.pop();
        if (!edge) break;
        const verdict = precheck(edge);
        if (verdict) {
          stopEdge(edge, verdict.reason, verdict.detail);
          continue;
        }
        // Reserve before the first await so `maxEdges` is exact under concurrency.
        state.expanded++;
        const p: Promise<void> = expandGuarded(edge).finally(() => {
          inflight.delete(p);
        });
        inflight.add(p);
      }
      if (inflight.size === 0) {
        if (queue.size === 0) break;
        continue;
      }
      await Promise.race(inflight);
    }
    await Promise.all(inflight);
    // Anything still queued was cut off by cancel, timeout or a fatal error.
    for (let edge = queue.pop(); edge; edge = queue.pop()) {
      const v = interruption();
      stopEdge(edge, v.reason, v.detail);
    }
  }

  // ---------------------------------------------------------------- run

  const timer = setTimeout(() => controller.cancel("timeout"), params.timeoutSec * 1000);
  const progressTimer = setInterval(emitProgress, PROGRESS_INTERVAL_MS);
  try {
    if (continueFrom) prepareContinuation(continueFrom);
    else await seedPhase();
    await schedule();
  } finally {
    clearTimeout(timer);
    clearInterval(progressTimer);
  }
  emitProgress();

  let status: TraceStatus;
  if (state.fatal || state.seedsFailed) status = "failed";
  else if (controller.cancelReason === "timeout") status = "timed_out";
  else if (controller.cancelReason === "cancelled") status = "cancelled";
  else status = "completed";

  const traceStats: TraceStats = {
    expandedEdges: state.expanded,
    ...stats(),
    droppedCandidates: state.dropped,
    maxDepthReached: state.maxDepth,
  };
  return { edges, stats: traceStats, status, warnings };
}
