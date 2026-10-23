import type { AnalysisResult, ChainId, Direction, RunParams, TraceEdge } from "@fot/core/schema";
import { useMemo } from "react";
import { assetSymbol, formatAmount, formatUsd, shortAddress } from "../../format.ts";
import { buildGraphModel } from "../../graph-model.ts";
import { highestValuePath } from "../../path.ts";
import type { RunPhase } from "../../run-state.ts";
import type { Selection } from "../../selection.ts";

export function PathView({
  chain,
  edges,
  result,
  phase,
  params,
  onSelect,
}: {
  chain: ChainId;
  edges: TraceEdge[];
  result: AnalysisResult | null;
  phase: RunPhase;
  params: RunParams;
  onSelect(sel: Selection): void;
}) {
  const seedEdge = edges.find((edge) => edge.seedId !== null);
  const direction: Direction =
    result?.direction ??
    (seedEdge ? (seedEdge.near === seedEdge.transfer.from ? "forward" : "backward") : "backward");
  const model = useMemo(
    () => buildGraphModel(edges, result, direction),
    [direction, edges, result],
  );
  const path = useMemo(
    () => highestValuePath(edges, result, direction, params),
    [direction, edges, params, result],
  );
  const addressMap = useMemo(
    () => new Map((result?.graph.addresses ?? []).map((node) => [node.address, node])),
    [result],
  );
  const hopByAddress = useMemo(
    () => new Map(model.nodes.map((node) => [node.address, node.hop])),
    [model.nodes],
  );
  const commonSources = useMemo(
    () =>
      new Set(
        (result?.convergences ?? [])
          .filter((entry) => entry.role === "common_source")
          .map((entry) => entry.address),
      ),
    [result],
  );
  const steps = useMemo(() => {
    const rows: { address: string; edge: TraceEdge; amountEdge: TraceEdge | null; hop: number }[] =
      [];
    for (const edge of path) {
      const address = edge.transfer.from;
      rows.push({
        address,
        edge,
        amountEdge: edge,
        hop: hopByAddress.get(address) ?? edge.depth + (direction === "backward" ? 1 : 0),
      });
    }
    const last = path[path.length - 1];
    if (last) {
      const address = last.transfer.to;
      rows.push({
        address,
        edge: last,
        amountEdge: null,
        hop: hopByAddress.get(address) ?? (direction === "forward" ? last.depth + 1 : 0),
      });
    }
    return rows;
  }, [direction, hopByAddress, path]);
  const live = phase === "running" || phase === "paused" || phase === "connecting";
  const addressCount = result?.graph.addresses.length ?? model.nodes.length;
  const pairCount = model.groups.length;

  return (
    <section className="space-y-4 px-4 py-4" aria-label="Highest-value path">
      <p className="rounded-sm border border-dashed border-border-strong px-3 py-2.5 text-sm leading-relaxed text-muted-foreground">
        {direction === "forward"
          ? "This is the highest-value path from the seed to where the funds went."
          : "This is the highest-value path from the seed back to an exchange."}
      </p>
      {steps.length > 0 ? (
        <ol className="space-y-0">
          {steps.map(({ address, edge, amountEdge, hop }, index) => {
            const node = addressMap.get(address);
            const label = node?.labels[0];
            const commonSource = commonSources.has(address);
            const isSeed =
              node?.isSeedSubject ??
              (direction === "backward" ? index === steps.length - 1 : index === 0);
            const category = node?.sanctioned ? "sanctioned" : label?.category;
            const title = label?.name ?? shortAddress(chain, address);
            const amount = amountEdge
              ? `${formatAmount(amountEdge.transfer.amount)} ${assetSymbol(amountEdge.transfer.asset)}`
              : null;
            return (
              <li
                key={`${address}:${edge?.id ?? "seed"}`}
                className="grid min-h-16 grid-cols-[18px_minmax(0,1fr)] gap-x-3"
              >
                <div className="flex flex-col items-center">
                  <span
                    aria-hidden="true"
                    className={category ? "mt-1 size-3 rounded-[2px]" : "mt-1 size-3 rounded-full"}
                    style={{
                      background: category ? `var(--category-${category})` : "transparent",
                      border: category
                        ? "none"
                        : `1.5px solid ${commonSource || isSeed ? "var(--foreground)" : "var(--muted-foreground)"}`,
                    }}
                  />
                  {index < steps.length - 1 ? (
                    <span className="w-px flex-1 bg-border-strong" />
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => onSelect({ kind: "edge", edgeId: edge.id })}
                  className="flex min-h-14 min-w-0 flex-col items-start gap-0.5 pb-3 text-left"
                >
                  <span
                    className="max-w-full truncate text-sm font-semibold"
                    style={{
                      color: category ? `var(--category-${category})` : "var(--foreground)",
                    }}
                  >
                    {commonSource ? "⧉ " : ""}
                    {title}
                  </span>
                  <span className="type-mono-sm text-muted-foreground">
                    {shortAddress(chain, address)} · hop {hop}
                  </span>
                  {amount ? (
                    <span className="type-mono-sm font-medium">
                      ↓ {amount}{" "}
                      <span className="text-muted-foreground">{formatUsd(amountEdge?.usd)}</span>
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {live ? "Waiting for transfers…" : "No traceable path in this run."}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-0.5 rounded-sm border border-border bg-card p-2.5">
          <strong className="type-mono text-base">{addressCount}</strong>
          <span className="text-xs text-muted-foreground">addresses</span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-sm border border-border bg-card p-2.5">
          <strong className="type-mono text-base">{edges.length}</strong>
          <span className="text-xs text-muted-foreground">transfers · {pairCount} pairs</span>
        </div>
      </div>
    </section>
  );
}
