import { assetId, type ExchangeTouchpoint } from "../schema.ts";
import { type AnalysisContext, compareUsdDesc, entityOf, symbolOf } from "./shared.ts";

/**
 * Edges whose `far` is a labeled exchange: where the traced funds came from (backward, `origin`)
 * or where they arrived (forward, `arrival`). `counterparty` is the address on the near side; for
 * arrivals this is the probable deposit address.
 */
export function findTouchpoints(ctx: AnalysisContext): ExchangeTouchpoint[] {
  const kind = ctx.direction === "backward" ? "origin" : "arrival";
  const out: ExchangeTouchpoint[] = [];
  for (const edge of ctx.edges) {
    const label = ctx.labelsOf(edge.far).find((l) => l.category === "exchange");
    if (!label) continue;
    out.push({
      kind,
      entity: entityOf(label),
      exchangeAddress: edge.far,
      counterparty: edge.near,
      txHash: edge.transfer.txHash,
      assetId: assetId(edge.transfer.asset),
      symbol: symbolOf(edge.transfer.asset),
      amount: edge.transfer.amount,
      usd: edge.usd,
      timestamp: edge.transfer.timestamp,
      depth: edge.depth,
      seedIds: [...(ctx.edgeSeedIds.get(edge.id) ?? [])],
    });
  }
  return out.sort(
    (a, b) => compareUsdDesc(a.usd, b.usd) || a.depth - b.depth || a.txHash.localeCompare(b.txHash),
  );
}
