import { isSpoofed } from "../labels/spoof.ts";
import type { ExplorerProvider, PriceSource } from "../providers/types.ts";
import { priceKey } from "../providers/types.ts";
import { assetId, type Convergence, type TraceEdge, type Transfer, transferId } from "../schema.ts";
import { type AnalysisContext, compareUsdDesc, sumUsd, symbolOf, unique } from "./shared.ts";

const FOLLOW_UP_TOP = 10;
const FOLLOW_UP_KEEP = 20;

/**
 * Unlabeled addresses that sit at the `far` end of several traced transfers. They are common
 * sources (backward) or common destinations (forward) either across seeds or within one trace.
 * `otherCounterparties` stays empty until `followUpConvergences` fills it.
 */
export function findConvergences(ctx: AnalysisContext): Convergence[] {
  const byFar = new Map<string, TraceEdge[]>();
  for (const edge of ctx.edges) {
    const list = byFar.get(edge.far);
    if (list) list.push(edge);
    else byFar.set(edge.far, [edge]);
  }

  const out: Convergence[] = [];
  for (const [address, edges] of byFar) {
    if (ctx.labelsOf(address).length > 0) continue;

    const seedIds = new Set<string>();
    for (const e of edges) for (const s of ctx.edgeSeedIds.get(e.id) ?? []) seedIds.add(s);
    const orderedSeeds = [...seedIds].sort(
      (a, b) => (ctx.seedOrder.get(a) ?? 0) - (ctx.seedOrder.get(b) ?? 0),
    );
    const counterparties = unique(edges.map((e) => e.near));

    const kinds: Convergence["kinds"] = [];
    if (orderedSeeds.length >= 2) kinds.push("shared_across_seeds");
    if (counterparties.length >= 2) kinds.push("shared_within_trace");
    if (kinds.length === 0) continue;

    const totals = new Map<string, { assetId: string; symbol: string; amount: number }>();
    for (const e of edges) {
      const id = assetId(e.transfer.asset);
      const t = totals.get(id);
      if (t) t.amount += e.transfer.amount;
      else
        totals.set(id, {
          assetId: id,
          symbol: symbolOf(e.transfer.asset),
          amount: e.transfer.amount,
        });
    }

    out.push({
      address,
      role: ctx.direction === "backward" ? "common_source" : "common_destination",
      kinds,
      seedIds: orderedSeeds,
      edgeIds: edges.map((e) => e.id),
      counterparties,
      totals: [...totals.values()],
      usd: sumUsd(edges.map((e) => e.usd)),
      minDepth: Math.min(...edges.map((e) => e.depth)),
      otherCounterparties: [],
    });
  }

  return out.sort(
    (a, b) =>
      compareUsdDesc(a.usd, b.usd) || a.minDepth - b.minDepth || a.address.localeCompare(b.address),
  );
}

export interface FollowUpDeps {
  provider: ExplorerProvider;
  prices: PriceSource;
  signal: AbortSignal;
}

export interface FollowUpOutcome {
  convergences: Convergence[];
  warnings: { code: string; message: string }[];
}

/**
 * "Who else did this funder pay?" For the top convergences by usd, list the common address's
 * other transfers (backward: its outgoing, forward: its incoming) and keep those whose
 * counterparty is not already part of the trace. Never throws: a failure becomes a warning.
 */
export async function followUpConvergences(
  convergences: readonly Convergence[],
  ctx: AnalysisContext,
  knownAddresses: ReadonlySet<string>,
  deps: FollowUpDeps,
): Promise<FollowUpOutcome> {
  const warnings: { code: string; message: string }[] = [];
  const result = convergences.map((c) => ({ ...c }));
  const direction = ctx.direction === "backward" ? "out" : "in";

  for (const conv of result.slice(0, FOLLOW_UP_TOP)) {
    if (deps.signal.aborted) {
      warnings.push({
        code: "convergence_followup_failed",
        message: `Follow-up for ${conv.address} skipped: run was aborted.`,
      });
      break;
    }
    try {
      const listing = await deps.provider.listTransfers({
        address: conv.address,
        direction,
        window: {},
        signal: deps.signal,
      });
      const seen = new Set<string>();
      const rows: { transfer: Transfer; counterparty: string }[] = [];
      for (const t of listing.rows) {
        const counterparty =
          direction === "out"
            ? t.from === conv.address
              ? t.to
              : null
            : t.to === conv.address
              ? t.from
              : null;
        if (counterparty === null || counterparty === conv.address) continue;
        if (knownAddresses.has(counterparty)) continue;
        if (t.amountRaw === "0" || isSpoofed(t.asset)) continue;
        const id = transferId(t);
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push({ transfer: t, counterparty });
      }

      const priced = await deps.prices.priceMany(
        rows.map((r) => ({ asset: r.transfer.asset, timestamp: r.transfer.timestamp })),
        deps.signal,
      );
      if (priced.warning && !warnings.some((w) => w.code === priced.warning?.code)) {
        warnings.push(priced.warning);
      }
      const scored = rows.map((r) => {
        const price = priced.prices.get(priceKey(r.transfer.asset, r.transfer.timestamp));
        return { transfer: r.transfer, usd: price == null ? null : price * r.transfer.amount };
      });
      scored.sort(
        (a, b) => compareUsdDesc(a.usd, b.usd) || b.transfer.timestamp - a.transfer.timestamp,
      );
      conv.otherCounterparties = scored.slice(0, FOLLOW_UP_KEEP).map((s) => s.transfer);
    } catch (err) {
      warnings.push({
        code: "convergence_followup_failed",
        message: `Follow-up for ${conv.address} failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return { convergences: result, warnings };
}
