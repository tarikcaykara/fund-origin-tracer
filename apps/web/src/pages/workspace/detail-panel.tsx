import {
  type AnalysisResult,
  assetId,
  type ChainId,
  type DropReason,
  EXPANDABLE_REASONS,
  type RunParams,
  type TraceEdge,
} from "@fot/core/schema";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { StopTag } from "@/components/badges.tsx";
import { AddressChip, ExplorerLink, type LabelIndex, TxLink } from "@/components/links.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useCopyText } from "@/lib/clipboard.ts";
import {
  assetSymbol,
  formatAmount,
  formatTimestamp,
  formatUsd,
  formatUtcMinute,
  shortAddress,
} from "../../format.ts";
import { buildGraphModel, type GraphModel } from "../../graph-model.ts";
import { CATEGORY_META, STOP_TAGS } from "../../meta.ts";
import { type Selection, selectionKey } from "../../selection.ts";

const DROP_REASONS: DropReason[] = [
  "spoofed_token",
  "zero_value",
  "self_transfer",
  "same_tx",
  "outside_time_window",
  "below_min_usd",
  "unpriced",
  "exceeds_max_branches",
];
const DROP_LABEL: Record<DropReason, string> = {
  spoofed_token: "spoofed token",
  zero_value: "zero value",
  self_transfer: "self",
  same_tx: "same tx",
  outside_time_window: "outside time window",
  below_min_usd: "below min USD",
  unpriced: "unpriced",
  exceeds_max_branches: "branches",
};

/** A refused or failed expand request, shown under that edge's Expand button. */
export interface ExpandError {
  edgeId: string;
  code: string;
  message: string;
}

export function DetailPanel({
  chain,
  selection,
  edges,
  result,
  labels,
  params,
  canExpand,
  expanding,
  expandError,
  expandBlockedReason,
  onExpand,
  onSelect,
  onClose,
  onPrev,
  onNext,
  live,
  mode,
}: {
  chain: ChainId;
  selection: Selection;
  edges: TraceEdge[];
  result: AnalysisResult | null;
  labels: LabelIndex;
  params: RunParams;
  canExpand: boolean;
  expanding: boolean;
  /** The last failed expand request; shown inline on its edge. */
  expandError: ExpandError | null;
  /** When set, Expand is disabled and this explains why. */
  expandBlockedReason?: string | undefined;
  onExpand(edgeId: string): void;
  onSelect(sel: Selection | null): void;
  onClose(): void;
  onPrev?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  /** True while the run is streaming: per-candidate drop details are not available yet. */
  live: boolean;
  mode: "docked" | "sheet" | "full";
}) {
  const selectedEdge =
    selection.kind === "edge" ? (edges.find((edge) => edge.id === selection.edgeId) ?? null) : null;
  const pairEdges =
    selection.kind === "pair"
      ? edges.filter((edge) => edge.from === selection.from && edge.to === selection.to)
      : [];
  const graphModel = useMemo(
    () => buildGraphModel(edges, result, params.direction),
    [edges, params.direction, result],
  );
  const title =
    selection.kind === "address"
      ? "ADDRESS"
      : selection.kind === "pair"
        ? "ADDRESS PAIR"
        : selection.kind === "set"
          ? selection.title.toUpperCase()
          : "TRANSFER";
  const funnelAddress =
    selection.kind === "address" &&
    (result?.flags.some(
      (flag) => flag.id === "funnel" && flag.evidence.addresses.includes(selection.address),
    ) ??
      false);
  const isExchangeOrigin =
    selection.kind === "address" &&
    (result?.exchangeTouchpoints.some(
      (point) => point.exchangeAddress === selection.address && point.kind === "origin",
    ) ??
      false);
  const subtitle = selectedEdge
    ? `hop ${selectedEdge.depth}${selectedEdge.status === "stopped" ? " · stopped edge" : " · on selected path"}`
    : selection.kind === "address"
      ? `${isExchangeOrigin ? "exchange origin" : `hop ${graphModel.nodes.find((node) => node.address === selection.address)?.hop ?? 0}`}${funnelAddress ? " · funnel" : ""}`
      : selection.kind === "pair"
        ? `${pairEdges.length} transfers`
        : selection.kind === "set"
          ? `${selection.addresses.length} addresses · ${selection.edgeIds.length} transfers`
          : "";

  return (
    <aside
      className="flex h-full min-h-0 min-w-0 flex-col bg-card text-foreground"
      data-mode={mode}
    >
      {mode === "full" ? (
        <div className="flex justify-center py-2">
          <span className="h-1 w-9 rounded-full bg-border-strong" />
        </div>
      ) : null}
      <header className="sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2.5 md:px-4">
        <div className="min-w-0 flex-1">
          <div className="type-overline">{title}</div>
          {subtitle ? (
            <div className="truncate type-mono-sm text-muted-foreground">{subtitle}</div>
          ) : null}
        </div>
        {onPrev ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Previous selection"
            onClick={onPrev}
          >
            ‹
          </Button>
        ) : null}
        {onNext ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Next selection"
            onClick={onNext}
          >
            ›
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close detail panel"
          onClick={onClose}
        >
          ×
        </Button>
      </header>
      <div key={selectionKey(selection)} className="min-h-0 flex-1 overflow-y-auto">
        {selection.kind === "address" ? (
          <AddressPanel
            chain={chain}
            address={selection.address}
            edges={edges}
            result={result}
            labels={labels}
            graphModel={graphModel}
            onSelect={onSelect}
          />
        ) : null}
        {selection.kind === "pair" ? (
          <PairPanel
            chain={chain}
            from={selection.from}
            to={selection.to}
            edges={pairEdges}
            labels={labels}
            params={params}
            onSelect={onSelect}
            graphModel={graphModel}
          />
        ) : null}
        {selectedEdge ? (
          <TransferPanel
            chain={chain}
            live={live}
            edge={selectedEdge}
            direction={params.direction}
            params={params}
            labels={labels}
            canExpand={canExpand}
            expanding={expanding}
            expandError={expandError}
            expandBlockedReason={expandBlockedReason}
            onExpand={onExpand}
          />
        ) : null}
        {selection.kind === "set" ? (
          <SetPanel chain={chain} selection={selection} onSelect={onSelect} />
        ) : null}
      </div>
    </aside>
  );
}

function AddressPanel({
  chain,
  address,
  edges,
  result,
  labels,
  graphModel,
  onSelect,
}: {
  chain: ChainId;
  address: string;
  edges: TraceEdge[];
  result: AnalysisResult | null;
  labels: LabelIndex;
  graphModel: GraphModel;
  onSelect(sel: Selection | null): void;
}) {
  const [showAll, setShowAll] = useState(false);
  const node = labels.get(address);
  const nodeLabels = node?.labels ?? [];
  const graphNode = graphModel.nodes.find((item) => item.address === address);
  const stopReason = graphNode?.stopReason ?? null;
  const funnel = result?.flags.find(
    (flag) => flag.id === "funnel" && flag.evidence.addresses.includes(address),
  );
  const touchpoint = result?.exchangeTouchpoints.find(
    (point) => point.exchangeAddress === address && point.kind === "origin",
  );
  const transfers = edges
    .filter((edge) => edge.from === address || edge.to === address)
    .slice()
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || a.transfer.timestamp - b.transfer.timestamp);
  const visible = showAll ? transfers : transfers.slice(0, 6);
  const sources = result?.dataSources;
  const localLabels = sources?.localLabels ? "loaded" : "none";
  const fetched = sources?.ofacFetchedAt ? formatUtcMinute(sources.ofacFetchedAt) : "not fetched";

  return (
    <>
      <section className="space-y-3 border-b border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <AddressChip chain={chain} address={address} />{" "}
          <ExplorerLink chain={chain} kind="address" value={address} />
        </div>
        <code className="block break-all type-mono-sm text-faint-foreground">{address}</code>
        <div className="flex flex-wrap gap-1.5 type-mono-sm">
          <PanelBadge>hop {graphNode?.hop ?? 0}</PanelBadge>
          {stopReason ? (
            <span className="inline-flex items-center gap-1">
              <StopTag reason={stopReason} /> stopped:{" "}
              {STOP_TAGS[stopReason].text.replace(/^Stopped: /, "")}
            </span>
          ) : null}
          {funnel ? <PanelBadge color="var(--risk-medium)">◆ funnel flag</PanelBadge> : null}
          {node ? (
            node.sanctioned ? (
              <PanelBadge color="var(--risk-high)">⊘ sanctioned</PanelBadge>
            ) : (
              <PanelBadge color="var(--risk-low)">○ not sanctioned</PanelBadge>
            )
          ) : (
            <PanelBadge>Sanction status pending</PanelBadge>
          )}
        </div>
        <div className="space-y-1.5">
          <h3 className="type-body font-semibold">Labels</h3>
          {nodeLabels.length > 0 ? (
            nodeLabels.map((label) => {
              const programs = label.programs?.length
                ? `${label.programs.length === 1 ? "program" : "programs"} ${label.programs.join(", ")} · `
                : "";
              const provenance =
                label.origin === "ofac"
                  ? `${programs}OFAC SDN${sources?.ofacFetchedAt ? ` fetched ${fetched}` : ""}`
                  : `${label.origin} labels ${sources?.labelsVersion ?? "unknown version"}`;
              return (
                <div
                  key={`${label.origin}:${label.name}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1 rounded-sm border border-border p-2 text-xs"
                >
                  <span
                    className="font-semibold"
                    style={{ color: `var(--category-${label.category})` }}
                  >
                    {CATEGORY_META[label.category].glyph} {label.name}
                  </span>
                  <span className="type-mono-sm text-muted-foreground">
                    {CATEGORY_META[label.category].label}
                  </span>
                  <span className="col-span-2 type-mono-sm text-muted-foreground">
                    entity {label.entity ?? "—"} · {provenance}
                  </span>
                  {/^https?:\/\//.test(label.source) ? (
                    <a
                      className="col-span-2 break-all type-mono-sm text-link underline-offset-2 hover:underline"
                      href={label.source}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      source: {label.source} ↗
                    </a>
                  ) : (
                    <span className="col-span-2 break-all type-mono-sm text-muted-foreground">
                      source: {label.source}
                    </span>
                  )}
                </div>
              );
            })
          ) : sources ? (
            <p className="rounded-sm border border-dashed border-border-strong p-2 text-xs leading-relaxed text-muted-foreground">
              No label. Checked bundled labels ({sources.labelsVersion}), local labels (
              {localLabels}) and OFAC SDN (
              {sources.ofacFetchedAt ? `fetched ${fetched}` : "not fetched"}): no match.
            </p>
          ) : (
            <p className="rounded-sm border border-dashed border-border-strong p-2 text-xs leading-relaxed text-muted-foreground">
              No label provenance is available yet.
            </p>
          )}
          {funnel ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{funnel.detail}</p>
          ) : touchpoint ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Exchange origin: {touchpoint.entity} is listed in Exchange touchpoints.
            </p>
          ) : null}
        </div>
      </section>
      <section>
        <div className="flex items-baseline justify-between gap-2 px-4 pb-2 pt-3">
          <h3 className="text-[13px] font-semibold">Transfers in this trace</h3>
          <span className="type-mono-sm text-muted-foreground">{transfers.length} · by USD ↓</span>
        </div>
        {visible.length > 0 ? (
          <ul className="px-4">
            {visible.map((edge) => {
              const counterparty = edge.from === address ? edge.to : edge.from;
              const arrow = edge.transfer.to === address ? "←" : "→";
              return (
                <li key={edge.id} className="border-b border-border">
                  <button
                    type="button"
                    aria-label={`Select transfer ${shortAddress(chain, edge.transfer.from)} to ${shortAddress(chain, edge.transfer.to)}`}
                    onClick={() => onSelect({ kind: "edge", edgeId: edge.id })}
                    className="grid min-h-11 w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-1.5 py-1.5 text-left type-mono-sm hover:bg-muted"
                  >
                    <span aria-hidden="true" className="text-muted-foreground">
                      {arrow}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate">
                        {shortAddress(chain, counterparty)}{" "}
                        {edge.stopReason && counterparty === edge.far ? (
                          <span
                            title={STOP_TAGS[edge.stopReason].text}
                            className="rounded-xs border border-border-strong px-1 text-[9px]"
                          >
                            {STOP_TAGS[edge.stopReason].code}
                          </span>
                        ) : null}
                      </span>
                      <time className="block text-[10.5px] text-faint-foreground">
                        {formatTimestamp(edge.transfer.timestamp)}
                      </time>
                    </span>
                    <span className="text-right">
                      {formatAmount(edge.transfer.amount)} {assetSymbol(edge.transfer.asset)}
                      <span className="block text-[10.5px] text-muted-foreground">
                        {formatUsd(edge.usd)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-4 pb-4 text-sm text-muted-foreground">No transfers in this trace.</p>
        )}
        {transfers.length > 6 && !showAll ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="mx-2 mt-1"
            onClick={() => setShowAll(true)}
          >
            Show all {transfers.length} transfers
          </Button>
        ) : null}
      </section>
    </>
  );
}

function PairPanel({
  chain,
  from,
  to,
  edges,
  labels,
  params,
  onSelect,
  graphModel,
}: {
  chain: ChainId;
  from: string;
  to: string;
  edges: TraceEdge[];
  labels: LabelIndex;
  params: RunParams;
  onSelect(sel: Selection | null): void;
  graphModel: GraphModel;
}) {
  const { copied, copy } = useCopyText();
  const totals = new Map<string, { symbol: string; amount: number }>();
  let priced = 0;
  let unpriced = 0;
  for (const edge of edges) {
    const id = assetId(edge.transfer.asset);
    const total = totals.get(id) ?? { symbol: assetSymbol(edge.transfer.asset), amount: 0 };
    total.amount += edge.transfer.amount;
    totals.set(id, total);
    if (edge.usd === null) unpriced++;
    else priced += edge.usd;
  }
  const aggregate = [...totals.values()];
  const amountText =
    aggregate.length > 1
      ? `${edges.length}× · ${aggregate.length} assets`
      : `${edges.length}× · ${formatAmount(aggregate[0]?.amount ?? 0)} ${aggregate[0]?.symbol ?? "assets"}`;
  const ids = edges.map((edge) => edge.id);
  const fromLabel = labels.get(from)?.labels[0];
  const toLabel = labels.get(to)?.labels[0];
  const copyHashes = () =>
    copy(edges.map((edge) => edge.transfer.txHash).join("\n"), {
      title: "⧉ Copied tx hashes",
      subtitle: `${edges.length} transaction${edges.length === 1 ? "" : "s"}`,
    });

  return (
    <>
      <section className="space-y-3 border-b border-border p-4">
        <div className="grid grid-cols-[minmax(0,1fr)_20px_minmax(0,1fr)] items-center gap-1.5">
          {[
            { address: from, label: fromLabel },
            { address: to, label: toLabel },
          ].map((item) => (
            <div
              key={item.address}
              className="min-w-0 rounded-sm border p-2"
              style={{
                gridColumn: item.address === from ? "1" : "3",
                borderColor: item.label
                  ? `var(--category-${item.label.category})`
                  : "var(--border-strong)",
              }}
            >
              <div
                className="truncate text-xs font-semibold"
                style={{
                  color: item.label
                    ? `var(--category-${item.label.category})`
                    : "var(--muted-foreground)",
                }}
              >
                {item.label
                  ? `${CATEGORY_META[item.label.category].glyph} ${item.label.name}`
                  : "unlabeled"}
              </div>
              <AddressChip chain={chain} address={item.address} />
              <div className="truncate text-[10.5px] text-muted-foreground">
                hop {graphModel.nodes.find((node) => node.address === item.address)?.hop ?? 0}
                {graphModel.nodes.find((node) => node.address === item.address)?.seed
                  ? " · SEED"
                  : ""}
              </div>
            </div>
          ))}
          <span className="col-start-2 row-start-1 text-center text-selection">→</span>
        </div>
        <div className="flex flex-wrap items-baseline gap-2">
          <strong className="type-amount">{amountText}</strong>
          <span className="type-mono-sm text-muted-foreground">
            {formatUsd(unpriced < edges.length ? priced : null)}
            {unpriced > 0 ? ` · ${unpriced} unpriced, not in the USD total` : ""}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Transfers from {shortAddress(chain, from)} to {shortAddress(chain, to)} in this trace.
          {edges.some((edge) => edge.stopReason === "entity") && !params.traceThroughEntities
            ? " Each stopped at the labelled entity because trace through entities is off."
            : ""}
        </p>
      </section>
      {edges.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse type-mono-sm">
            <thead>
              <tr className="text-left text-faint-foreground">
                <th className="px-4 py-2 font-normal">time · tx</th>
                <th className="px-2 py-2 text-right font-normal">amount</th>
                <th className="px-4 py-2 text-right font-normal">score</th>
              </tr>
            </thead>
            <tbody>
              {edges.map((edge) => (
                <tr key={edge.id} className="border-t border-border hover:bg-muted">
                  <td className="px-4 py-1.5">
                    <button
                      type="button"
                      aria-label={`Select transfer ${shortAddress(chain, edge.transfer.from)} to ${shortAddress(chain, edge.transfer.to)}`}
                      onClick={() => onSelect({ kind: "edge", edgeId: edge.id })}
                      className="min-h-11 text-left"
                    >
                      <time className="block">{formatTimestamp(edge.transfer.timestamp)}</time>
                    </button>
                    <TxLink chain={chain} hash={edge.transfer.txHash} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {formatAmount(edge.transfer.amount)} {assetSymbol(edge.transfer.asset)}
                    <span className="block text-muted-foreground">{formatUsd(edge.usd)}</span>
                  </td>
                  <td className="px-4 py-1.5 text-right">{edge.selection?.score ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          No transfers between this pair in the trace.
        </p>
      )}
      <div className="flex flex-wrap gap-2 p-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onSelect({ kind: "set", addresses: [from, to], edgeIds: ids, title: "Address pair" })
          }
        >
          Select both addresses
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void copyHashes()}>
          {copied ? "✓ Copied tx hashes" : "⧉ Copy tx hashes"}
        </Button>
      </div>
    </>
  );
}

function TransferPanel({
  chain,
  edge,
  direction,
  params,
  labels,
  canExpand,
  expanding,
  expandError,
  expandBlockedReason,
  onExpand,
  live,
}: {
  chain: ChainId;
  edge: TraceEdge;
  direction: RunParams["direction"];
  params: RunParams;
  labels: LabelIndex;
  canExpand: boolean;
  expanding: boolean;
  expandError: ExpandError | null;
  expandBlockedReason: string | undefined;
  live: boolean;
  onExpand(edgeId: string): void;
}) {
  const [dropFilter, setDropFilter] = useState<DropReason | "all">("all");
  const [showMore, setShowMore] = useState(false);
  // Live runs stream only drop totals; per-candidate details arrive with the final result.
  const candidatesPending = live && edge.status !== "pending" && edge.dropped.length === 0;
  const transfer = edge.transfer;
  const breakdown = edge.selection
    ? [
        {
          key: "asset",
          label: "asset",
          value: edge.selection.breakdown.asset,
          color: "var(--selection)",
        },
        {
          key: "amount",
          label: "amount",
          value: edge.selection.breakdown.amount,
          color: "color-mix(in srgb, var(--selection) 72%, transparent)",
        },
        {
          key: "time",
          label: "time",
          value: edge.selection.breakdown.time,
          color: "color-mix(in srgb, var(--selection) 48%, transparent)",
        },
        {
          key: "dust",
          label: "dust",
          value: edge.selection.breakdown.dust,
          color: "var(--risk-high)",
        },
      ]
    : [];
  const positiveBreakdownTotal = breakdown.reduce(
    (total, factor) => total + Math.max(0, factor.value),
    0,
  );
  const rankNote = edge.selection
    ? `Rank ${edge.selection.rank} among candidates`
    : "Seed transfer";
  const stopped = edge.status === "stopped" && edge.stopReason !== null;
  const canContinue = edge.stopReason !== null && EXPANDABLE_REASONS.has(edge.stopReason);
  const droppedCountFor = (reason: DropReason): number =>
    edge.droppedByReason?.[reason] ?? edge.dropped.filter((item) => item.reason === reason).length;
  const dropped =
    dropFilter === "all" ? edge.dropped : edge.dropped.filter((item) => item.reason === dropFilter);
  const orderedDropped = dropped.slice().sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const visibleDropped = showMore ? orderedDropped : orderedDropped.slice(0, 6);
  const remainingDropped = Math.max(0, orderedDropped.length - visibleDropped.length);
  const fromLabel = labels.get(transfer.from)?.labels[0]?.name;
  const toLabel = labels.get(transfer.to)?.labels[0]?.name;
  const followed = edge.far;
  const statusText = edge.stopReason
    ? STOP_TAGS[edge.stopReason].text
    : edge.status === "pending"
      ? "Waiting to expand"
      : "Expanded";
  const statusNote = stopped
    ? (edge.stopDetail ?? statusText)
    : edge.status === "expanded"
      ? `${direction === "backward" ? "←" : "→"} ${edge.children.length} ${direction === "backward" ? "earlier" : "later"} transfers followed`
      : "Queued for expansion";

  return (
    <>
      <section className="space-y-3 border-b border-border p-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <strong className="type-amount">{formatAmount(transfer.amount)}</strong>
          <span className="font-mono text-sm font-semibold">{assetSymbol(transfer.asset)}</span>
          <span className="type-mono-sm text-muted-foreground">{formatUsd(edge.usd)}</span>
        </div>
        <div className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 type-mono-sm">
          <span className="text-muted-foreground">from</span>
          <AddressChip
            chain={chain}
            address={transfer.from}
            {...(fromLabel ? { label: fromLabel } : {})}
          />
          <ExplorerLink chain={chain} kind="address" value={transfer.from} />
          <span className="text-muted-foreground">to</span>
          <AddressChip
            chain={chain}
            address={transfer.to}
            {...(toLabel ? { label: toLabel } : {})}
          />
          <ExplorerLink chain={chain} kind="address" value={transfer.to} />
        </div>
        <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">Followed</dt>
          <dd className="min-w-0 break-all type-mono-sm">
            {shortAddress(chain, followed)}{" "}
            <span className="text-muted-foreground">({direction})</span>
          </dd>
          <dt className="text-muted-foreground">Time</dt>
          <dd className="type-mono-sm">{formatTimestamp(transfer.timestamp)}</dd>
          <dt className="text-muted-foreground">Transaction</dt>
          <dd>
            <TxLink chain={chain} hash={transfer.txHash} />
          </dd>
          <dt className="text-muted-foreground">Depth</dt>
          <dd className="type-mono-sm">{edge.depth}</dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd className="flex flex-wrap items-center gap-1.5">
            <span className="type-mono-sm font-medium">{statusText}</span>
            {stopped ? <StopTag reason={edge.stopReason} /> : null}
            <span className="text-muted-foreground">{statusNote}</span>
          </dd>
        </dl>
      </section>
      {stopped ? (
        <StoppedSection
          edge={edge}
          params={params}
          canExpand={canExpand && canContinue && expandBlockedReason === undefined}
          expanding={expanding}
          expandError={expandError}
          expandBlockedReason={expandBlockedReason}
          onExpand={onExpand}
        />
      ) : null}
      <section className="space-y-2.5 border-b border-border p-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-[13px] font-semibold">Why selected</h3>
          <span className="text-xs text-muted-foreground">{rankNote}</span>
          <span className="ml-auto type-mono font-semibold">{edge.selection?.score ?? "—"}</span>
          <span className="type-mono-sm text-muted-foreground">score</span>
        </div>
        {breakdown.length > 0 ? (
          <>
            <div
              className="flex h-2 overflow-hidden rounded-xs bg-muted"
              role="img"
              aria-label="Score contribution breakdown"
            >
              {breakdown.map((factor) => (
                <span
                  key={factor.key}
                  title={`${factor.label}: ${factor.value}`}
                  style={{
                    width: `${positiveBreakdownTotal > 0 ? (Math.max(0, factor.value) / positiveBreakdownTotal) * 100 : 0}%`,
                    background: factor.color,
                    borderRight: "1px solid var(--card)",
                  }}
                />
              ))}
            </div>
            {breakdown.map((factor) => (
              <div
                key={factor.key}
                className="grid grid-cols-[minmax(0,1fr)_minmax(60px,120px)_28px] items-center gap-2 text-xs"
              >
                <span>{factor.label}</span>
                <span className="flex h-1 overflow-hidden rounded-full bg-muted">
                  <span
                    style={{
                      width: `${Math.min(100, Math.max(0, factor.value * 2))}%`,
                      background: "var(--foreground)",
                    }}
                  />
                </span>
                <span className="text-right type-mono-sm">{factor.value}</span>
              </div>
            ))}
          </>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Per-factor breakdown is stored for selected transfers only.
          </p>
        )}
      </section>
      <section className="space-y-2 border-b border-border p-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-[13px] font-semibold">Dropped candidates</h3>
          <span className="type-mono-sm text-muted-foreground">
            {candidatesPending
              ? `${edge.droppedTotal} so far`
              : `${edge.droppedTotal} · ${edge.dropped.length} stored`}
          </span>
        </div>
        {candidatesPending ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Candidate details are available when the run finishes.
          </p>
        ) : edge.droppedTotal === 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {edge.status === "expanded"
              ? "No candidates were dropped."
              : "No candidates were evaluated: this edge was not expanded."}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 type-mono-sm">
              <FilterButton
                active={dropFilter === "all"}
                onClick={() => {
                  setDropFilter("all");
                  setShowMore(false);
                }}
              >
                all {edge.droppedTotal}
              </FilterButton>
              {DROP_REASONS.filter(
                (reason) => (edge.droppedByReason?.[reason] ?? droppedCountFor(reason)) > 0,
              ).map((reason) => {
                const count = droppedCountFor(reason);
                const sampleLabel =
                  edge.droppedByReason?.[reason] === undefined
                    ? ` of ${edge.dropped.length} stored`
                    : "";
                return (
                  <FilterButton
                    key={reason}
                    active={dropFilter === reason}
                    onClick={() => {
                      setDropFilter(reason);
                      setShowMore(false);
                    }}
                  >
                    {DROP_LABEL[reason]} {count}
                    {sampleLabel}
                  </FilterButton>
                );
              })}
            </div>
            {visibleDropped.length > 0 ? (
              <ul className="divide-y divide-border border-t border-border">
                {visibleDropped.map((candidate) => {
                  const counterparty =
                    candidate.transfer.from === edge.far
                      ? candidate.transfer.to
                      : candidate.transfer.from;
                  return (
                    <li
                      key={`${candidate.transfer.txHash}:${candidate.transfer.from}:${candidate.transfer.to}:${candidate.transfer.amountRaw}:${candidate.reason}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto_30px] gap-1 py-1.5 type-mono-sm"
                    >
                      <span className="min-w-0">
                        <span className="block truncate">
                          {formatAmount(candidate.transfer.amount)}{" "}
                          {assetSymbol(candidate.transfer.asset)}{" "}
                          <span className="text-muted-foreground">{formatUsd(candidate.usd)}</span>
                        </span>
                        <span className="block truncate text-[10.5px] text-muted-foreground">
                          {shortAddress(chain, counterparty)} · {DROP_LABEL[candidate.reason]}
                        </span>
                      </span>
                      <span className="self-center rounded-xs bg-muted px-1 py-0.5 text-[10.5px] text-muted-foreground">
                        {DROP_LABEL[candidate.reason]}
                      </span>
                      <span className="self-center text-right">{candidate.score ?? "—"}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No stored candidates for this reason.</p>
            )}
            {remainingDropped > 0 ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="px-0"
                onClick={() => setShowMore(true)}
              >
                Show {remainingDropped} more stored candidates
              </Button>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}

function StoppedSection({
  edge,
  params,
  canExpand,
  expanding,
  expandError,
  expandBlockedReason,
  onExpand,
}: {
  edge: TraceEdge;
  params: RunParams;
  canExpand: boolean;
  expanding: boolean;
  expandError: ExpandError | null;
  expandBlockedReason: string | undefined;
  onExpand(edgeId: string): void;
}) {
  if (edge.stopReason === null) return null;
  const detail = edge.stopDetail ?? STOP_TAGS[edge.stopReason].text;
  const continuation = params.direction === "backward" ? "earlier" : "later";
  return (
    <section className="space-y-2.5 border-b border-border bg-muted px-4 py-3.5">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <StopTag reason={edge.stopReason} />
        <span>Stopped: {detail.replace(/^Stopped: /, "")}</span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {shortAddress(edge.transfer.chain, edge.far)} was not expanded. Expanding fetches its{" "}
        {continuation} transfers and follows up to {params.maxBranches} more branches with the same
        limits ({params.maxDepth} max depth; tracing through entities is{" "}
        {params.traceThroughEntities ? "on" : "off"}).
      </p>
      {EXPANDABLE_REASONS.has(edge.stopReason) ? (
        expanding ? (
          <div className="space-y-2">
            <Button type="button" disabled loading>
              Expanding…
            </Button>
            <div className="space-y-1.5 pt-1">
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Button type="button" disabled={!canExpand} onClick={() => onExpand(edge.id)}>
              Expand further {params.direction === "backward" ? "←" : "→"} 1 hop
            </Button>
            {expandBlockedReason ? (
              <p className="text-xs text-destructive-muted-foreground">{expandBlockedReason}</p>
            ) : null}
            {expandError?.edgeId === edge.id ? (
              <p role="alert" className="text-xs text-destructive-muted-foreground">
                <span className="font-mono">{expandError.code}</span>: {expandError.message}
              </p>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  );
}

function SetPanel({
  chain,
  selection,
  onSelect,
}: {
  chain: ChainId;
  selection: Extract<Selection, { kind: "set" }>;
  onSelect(sel: Selection | null): void;
}) {
  return (
    <section className="space-y-3 p-4">
      <div className="flex flex-wrap gap-2">
        {selection.addresses.map((address) => (
          <AddressChip key={address} chain={chain} address={address} />
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        {selection.addresses.length} addresses · {selection.edgeIds.length} transfers
      </p>
      <Button type="button" variant="outline" onClick={() => onSelect(null)}>
        Clear
      </Button>
    </section>
  );
}

function PanelBadge({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <span
      className="rounded-xs border px-1.5 py-0.5 type-mono-sm"
      style={{
        borderColor: color ?? "var(--border-strong)",
        color: color ?? "var(--muted-foreground)",
      }}
    >
      {children}
    </span>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-11 rounded-xs border px-1.5 py-1 md:min-h-6 ${active ? "border-foreground text-foreground" : "border-border-strong text-muted-foreground"}`}
    >
      {children}
    </button>
  );
}
