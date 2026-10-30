import type { TraceStatus } from "../engine/types.ts";
import type { ResolvedFlags } from "../policy/policy.ts";
import {
  assetId,
  type Convergence,
  type ExchangeTouchpoint,
  type Exposure,
  type ExposureEntry,
  type Flag,
  type Severity,
  type TraceEdge,
} from "../schema.ts";
import { isUnresolvedEdge } from "./exposure.ts";
import { type AnalysisContext, fmtUsd, sumUsd, symbolOf, unique } from "./shared.ts";

export interface FlagInput {
  ctx: AnalysisContext;
  flags: ResolvedFlags;
  exposure: Exposure;
  convergences: readonly Convergence[];
  touchpoints: readonly ExchangeTouchpoint[];
  /** Null while the run is still in flight (provisional analysis): there is no outcome yet. */
  status: TraceStatus | null;
  maxDepthReached: number;
}

const EVIDENCE_CAP = 50;
const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

function plural(n: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : pluralNoun}`;
}

function evidence(addresses: Iterable<string>, edgeIds: Iterable<string>): Flag["evidence"] {
  return {
    addresses: unique(addresses).slice(0, EVIDENCE_CAP),
    edgeIds: unique(edgeIds).slice(0, EVIDENCE_CAP),
  };
}

function usdSuffix(usd: number | null): string {
  return usd === null ? "" : ` (about ${fmtUsd(usd)})`;
}

function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Risk level: the worst severity among the raised flags (info and low never raise it). */
export function riskLevelOf(flags: readonly Flag[]): "low" | "medium" | "high" {
  if (flags.some((f) => f.severity === "high")) return "high";
  if (flags.some((f) => f.severity === "medium")) return "medium";
  return "low";
}

/**
 * One transfer path per root-to-leaf walk. An address that shows up twice on one path with the
 * same asset and amounts within `tolerance` (relative to the first amount) is a round trip: funds
 * left X, passed through intermediaries and came back. Port of legacy `find_wash_trades`.
 */
export interface RoundTrip {
  address: string;
  symbol: string;
  origin: number;
  returned: number;
  edgeIds: string[];
}

const ROUND_TRIP_STEP_BUDGET = 200_000;

export function findRoundTrips(ctx: AnalysisContext, tolerance: number): RoundTrip[] {
  const hits: RoundTrip[] = [];
  const seenSignatures = new Set<string>();
  let budget = ROUND_TRIP_STEP_BUDGET;

  interface Seen {
    amount: number;
    pathIndex: number;
  }

  const visit = (
    edge: TraceEdge,
    ancestors: ReadonlyMap<string, Seen>,
    path: readonly string[],
    onPath: ReadonlySet<string>,
  ): void => {
    if (budget-- <= 0 || onPath.has(edge.id)) return;
    const nextPath = [...path, edge.id];
    const nextOnPath = new Set(onPath).add(edge.id);
    const next = new Map(ancestors);
    const asset = assetId(edge.transfer.asset);
    const amount = edge.transfer.amount;
    const key = `${edge.far}|${asset}`;
    const origin = ancestors.get(key);
    if (origin && amount > 0 && origin.amount > 0) {
      if (Math.abs(amount - origin.amount) / origin.amount <= tolerance) {
        const signature = `${key}|${origin.amount.toFixed(2)}`;
        if (!seenSignatures.has(signature)) {
          seenSignatures.add(signature);
          hits.push({
            address: edge.far,
            symbol: symbolOf(edge.transfer.asset),
            origin: origin.amount,
            returned: amount,
            edgeIds: nextPath.slice(origin.pathIndex),
          });
        }
      }
    }
    if (amount > 0 && !next.has(key)) next.set(key, { amount, pathIndex: nextPath.length - 1 });
    for (const childId of edge.children) {
      const child = ctx.edgeById.get(childId);
      if (child) visit(child, next, nextPath, nextOnPath);
    }
  };

  for (const root of ctx.edges) {
    if (root.parents.length > 0) continue;
    // The root also carries its near address (the seed subject) with the edge amount.
    const rootKey = `${root.near}|${assetId(root.transfer.asset)}`;
    const start = new Map<string, Seen>();
    if (root.transfer.amount > 0)
      start.set(rootKey, { amount: root.transfer.amount, pathIndex: 0 });
    visit(root, start, [], new Set());
  }
  return hits;
}

interface FunnelHit {
  address: string;
  senders: number;
  edgeIds: string[];
}

/** Addresses on the `near` side of edges from at least `minSenders` distinct `far` addresses inside one window. */
function findFunnels(ctx: AnalysisContext, minSenders: number, windowSec: number): FunnelHit[] {
  const byNear = new Map<string, TraceEdge[]>();
  for (const e of ctx.edges) {
    const list = byNear.get(e.near);
    if (list) list.push(e);
    else byNear.set(e.near, [e]);
  }
  const hits: FunnelHit[] = [];
  for (const [address, edges] of byNear) {
    if (unique(edges.map((e) => e.far)).length < minSenders) continue;
    const sorted = [...edges].sort((a, b) => a.transfer.timestamp - b.transfer.timestamp);
    const counts = new Map<string, number>();
    let left = 0;
    let best: { senders: number; from: number; to: number } | null = null;
    for (let right = 0; right < sorted.length; right++) {
      const r = sorted[right];
      if (!r) continue;
      counts.set(r.far, (counts.get(r.far) ?? 0) + 1);
      while (r.transfer.timestamp - (sorted[left]?.transfer.timestamp ?? 0) > windowSec) {
        const l = sorted[left];
        if (l) {
          const c = (counts.get(l.far) ?? 1) - 1;
          if (c === 0) counts.delete(l.far);
          else counts.set(l.far, c);
        }
        left++;
      }
      if (counts.size >= minSenders && (best === null || counts.size > best.senders)) {
        best = { senders: counts.size, from: left, to: right };
      }
    }
    if (best) {
      hits.push({
        address,
        senders: best.senders,
        edgeIds: sorted.slice(best.from, best.to + 1).map((e) => e.id),
      });
    }
  }
  return hits.sort((a, b) => b.senders - a.senders || a.address.localeCompare(b.address));
}

function describeExposure(entries: readonly ExposureEntry[], noun: string): string {
  const usd = sumUsd(entries.map((e) => e.usd));
  const entities = unique(entries.map((e) => e.entity ?? e.address)).slice(0, 3);
  return `${plural(entries.length, "transfer")} ${entries.length === 1 ? "involves" : "involve"} a ${noun} (${entities.join(", ")})${usdSuffix(usd)}`;
}

/** Evaluates every policy flag against the analysis. Flags set to `off` are skipped. */
export function evaluateFlags(input: FlagInput): Flag[] {
  const { ctx, flags, exposure, convergences, touchpoints } = input;
  const out: Flag[] = [];
  const raise = (
    id: keyof ResolvedFlags,
    title: string,
    detail: string,
    ev: Flag["evidence"],
  ): void => {
    const severity = flags[id].severity;
    if (severity === "off") return;
    out.push({ id, severity, title, detail, evidence: ev });
  };

  // sanctioned_exposure
  const sanctioned = new Set<string>();
  for (const e of ctx.edges) {
    for (const a of [e.from, e.to]) {
      if (ctx.labelsOf(a).some((l) => l.category === "sanctioned")) sanctioned.add(a);
    }
  }
  if (sanctioned.size > 0) {
    const touching = ctx.edges.filter((e) => sanctioned.has(e.from) || sanctioned.has(e.to));
    raise(
      "sanctioned_exposure",
      "Sanctioned address in the trace",
      `${plural(sanctioned.size, "sanctioned address", "sanctioned addresses")} appear in the trace, touching ${plural(touching.length, "transfer")}.`,
      evidence(
        sanctioned,
        touching.map((e) => e.id),
      ),
    );
  }

  // mixer / scam exposure, direct vs indirect
  for (const category of ["mixer", "scam"] as const) {
    const noun = category === "mixer" ? "mixer" : "known scam address";
    const entries = exposure.entries.filter((e) => e.category === category);
    const directId = `${category}_direct` as const;
    const indirectId = `${category}_indirect` as const;
    const directHops = flags[directId].directHops;
    const direct = entries.filter((e) => e.hops <= directHops);
    if (direct.length > 0) {
      raise(
        directId,
        category === "mixer" ? "Direct mixer exposure" : "Direct scam exposure",
        `${describeExposure(direct, noun)} within ${plural(directHops, "hop")} of the seed.`,
        evidence(
          direct.map((e) => e.address),
          direct.map((e) => e.edgeId),
        ),
      );
    }
    const indirectHops = flags[indirectId].directHops;
    const indirect = entries.filter((e) => e.hops > indirectHops);
    if (indirect.length > 0) {
      const minHops = Math.min(...indirect.map((e) => e.hops));
      raise(
        indirectId,
        category === "mixer" ? "Indirect mixer exposure" : "Indirect scam exposure",
        `${describeExposure(indirect, noun)}; the closest is ${plural(minHops, "hop")} from the seed.`,
        evidence(
          indirect.map((e) => e.address),
          indirect.map((e) => e.edgeId),
        ),
      );
    }
  }

  // common source / destination
  const roleWord = ctx.direction === "backward" ? "source" : "destination";
  for (const kind of ["shared_across_seeds", "shared_within_trace"] as const) {
    const hit = convergences.filter((c) => c.kinds.includes(kind));
    if (hit.length === 0) continue;
    const top = hit[0];
    const topText = top
      ? ` Largest: ${shortAddress(top.address)}${usdSuffix(top.usd)} with ${plural(top.counterparties.length, "counterparty", "counterparties")}.`
      : "";
    if (kind === "shared_across_seeds") {
      raise(
        "common_source_across_seeds",
        `Common ${roleWord} across seeds`,
        `${plural(hit.length, "unlabeled address", "unlabeled addresses")} link two or more seeds as a common ${roleWord}.${topText}`,
        evidence(
          hit.map((c) => c.address),
          hit.flatMap((c) => c.edgeIds),
        ),
      );
    } else {
      raise(
        "common_source_within_trace",
        `Common ${roleWord} within the trace`,
        `${plural(hit.length, "unlabeled address", "unlabeled addresses")} appear as the ${roleWord} of transfers to or from two or more different addresses.${topText}`,
        evidence(
          hit.map((c) => c.address),
          hit.flatMap((c) => c.edgeIds),
        ),
      );
    }
  }

  // cycle
  const cycles = ctx.edges.filter((e) => e.stopReason === "cycle");
  if (cycles.length > 0) {
    raise(
      "cycle",
      "Circular flow",
      `${plural(cycles.length, "branch", "branches")} returned to an address already on the same path.`,
      evidence(
        cycles.map((e) => e.far),
        cycles.map((e) => e.id),
      ),
    );
  }

  // funnel
  const { minSenders, windowSec } = flags.funnel;
  if (flags.funnel.severity !== "off") {
    const funnels = findFunnels(ctx, minSenders, windowSec);
    const top = funnels[0];
    if (top) {
      raise(
        "funnel",
        "Funnel address",
        `${shortAddress(top.address)} is linked to ${top.senders} distinct addresses within ${Math.round(windowSec / 3600)} hours${funnels.length > 1 ? `; ${funnels.length - 1} more address${funnels.length === 2 ? "" : "es"} behave the same way` : ""}.`,
        evidence(
          funnels.map((f) => f.address),
          funnels.flatMap((f) => f.edgeIds),
        ),
      );
    }
  }

  // round_trip
  if (flags.round_trip.severity !== "off") {
    const trips = findRoundTrips(ctx, flags.round_trip.tolerance);
    const top = trips[0];
    if (top) {
      raise(
        "round_trip",
        "Round-trip flow",
        `${shortAddress(top.address)} appears twice on one transfer path with matching amounts (${top.origin} and ${top.returned} ${top.symbol}, within ${Math.round(flags.round_trip.tolerance * 100)}%)${trips.length > 1 ? `; ${trips.length - 1} more round trip${trips.length === 2 ? "" : "s"} found` : ""}.`,
        evidence(
          trips.map((t) => t.address),
          trips.flatMap((t) => t.edgeIds),
        ),
      );
    }
  }

  // structuring
  if (flags.structuring.severity !== "off") {
    const { minAddresses, maxUsd } = flags.structuring;
    const edgesByFar = new Map<string, TraceEdge[]>();
    for (const e of ctx.edges) {
      const list = edgesByFar.get(e.far);
      if (list) list.push(e);
      else edgesByFar.set(e.far, [e]);
    }
    const small: TraceEdge[] = [];
    for (const [address, edges] of edgesByFar) {
      const only = edges[0];
      if (edges.length !== 1 || !only) continue;
      if (only.usd === null || only.usd >= maxUsd) continue;
      if (ctx.labelsOf(address).length > 0) continue;
      small.push(only);
    }
    if (small.length >= minAddresses) {
      raise(
        "structuring",
        "Many small one-off transfers",
        `${small.length} unlabeled addresses each appear once with less than ${fmtUsd(maxUsd)}, which can indicate funds split into small amounts.`,
        evidence(
          small.map((e) => e.far),
          small.map((e) => e.id),
        ),
      );
    }
  }

  // long_chain
  const { hops: chainHops } = flags.long_chain;
  if (
    input.maxDepthReached + 1 >= chainHops &&
    !exposure.entries.some((e) => e.hops <= chainHops)
  ) {
    const deepest = ctx.edges.filter((e) => e.depth === input.maxDepthReached);
    raise(
      "long_chain",
      "Long chain without a labeled counterparty",
      `The trace reached ${plural(input.maxDepthReached + 1, "hop")} without meeting any labeled address within ${plural(chainHops, "hop")}.`,
      evidence(
        deepest.map((e) => e.far),
        deepest.map((e) => e.id),
      ),
    );
  }

  // unresolved_majority
  if (exposure.terminalUsd > 0) {
    const share = exposure.unresolved.usd / exposure.terminalUsd;
    if (share > flags.unresolved_majority.share) {
      const unresolved = ctx.edges.filter((e) => isUnresolvedEdge(ctx, e));
      raise(
        "unresolved_majority",
        "Most traced value is unresolved",
        `${Math.round(share * 100)}% of the value at the end of traced branches (${fmtUsd(exposure.unresolved.usd)} of ${fmtUsd(exposure.terminalUsd)}) stops at unlabeled addresses.`,
        evidence(
          unresolved.map((e) => e.far),
          unresolved.map((e) => e.id),
        ),
      );
    }
  }

  // exchange_origin
  const origins = touchpoints.filter((t) => t.kind === "origin");
  if (origins.length > 0) {
    const addresses = new Set(origins.map((t) => t.exchangeAddress));
    const entities = unique(origins.map((t) => t.entity)).slice(0, 3);
    raise(
      "exchange_origin",
      "Funds traced to an exchange",
      `${plural(origins.length, "transfer")} from ${entities.join(", ")} found in the trace; the exchange can identify the account holder.`,
      evidence(
        addresses,
        ctx.edges.filter((e) => addresses.has(e.far)).map((e) => e.id),
      ),
    );
  }

  // spoofed_tokens_ignored
  const spoofEdges = ctx.edges.filter((e) => e.dropped.some((d) => d.reason === "spoofed_token"));
  if (spoofEdges.length > 0) {
    const spoofed = spoofEdges.flatMap((e) =>
      e.dropped.filter((d) => d.reason === "spoofed_token").map((d) => d.transfer),
    );
    raise(
      "spoofed_tokens_ignored",
      "Look-alike tokens ignored",
      `${plural(spoofed.length, "transfer")} of look-alike tokens (for example a fake USDT) on ${plural(spoofEdges.length, "edge")} were ignored.`,
      evidence(
        spoofed.flatMap((t) => (t.asset.kind === "token" ? [t.asset.contract] : [])),
        spoofEdges.map((e) => e.id),
      ),
    );
  }

  // incomplete_trace
  const failed = ctx.edges.filter((e) => e.stopReason === "fetch_failed");
  const ended = input.status !== null && input.status !== "completed";
  if (ended || failed.length > 0) {
    const parts: string[] = [];
    if (ended) parts.push(`the run ended as ${input.status}`);
    if (failed.length > 0) {
      parts.push(
        `${plural(failed.length, "branch", "branches")} stopped because data could not be fetched`,
      );
    }
    raise(
      "incomplete_trace",
      "Trace is incomplete",
      `The result may be partial: ${parts.join(" and ")}.`,
      evidence(
        failed.map((e) => e.far),
        failed.map((e) => e.id),
      ),
    );
  }

  return out.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id),
  );
}
