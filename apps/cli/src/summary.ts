import type { AnalysisResult } from "@fot/core";

function usd(v: number | null): string {
  return v === null
    ? "n/a"
    : `$${v.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function amount(v: number): string {
  return v.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function iso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

/** Left-aligned text table; the first row is the header. */
function table(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length))) ?? [];
  return rows.map(
    (r) =>
      `  ${r
        .map((cell, c) => cell.padEnd(widths[c] ?? 0))
        .join("  ")
        .trimEnd()}`,
  );
}

/** Human-readable run summary: risk level, flags, exposure, linked wallets, touchpoints, stats. */
export function renderSummary(r: AnalysisResult): string {
  const out: string[] = [];
  const dir = r.direction === "backward" ? "source of funds" : "destination of funds";
  out.push(`Risk level: ${r.riskLevel.toUpperCase()}`);
  out.push(`Run ${r.runId}  ${r.chain}  ${dir}  status=${r.status}`);
  out.push(`Seeds: ${r.seeds.map((s) => `${s.id}=${s.kind}:${s.value}`).join(", ")}`);

  out.push("", `Flags (${r.flags.length}):`);
  if (r.flags.length === 0) out.push("  none");
  for (const f of r.flags) out.push(`  [${f.severity.toUpperCase()}] ${f.title} - ${f.detail}`);

  out.push("", "Exposure by category:");
  const rows = r.exposure.byCategory.map((c) => [
    c.category,
    String(c.direct.count),
    usd(c.direct.usd),
    String(c.indirect.count),
    usd(c.indirect.usd),
    c.indirect.minHops === null ? "-" : String(c.indirect.minHops),
  ]);
  if (rows.length === 0) out.push("  none");
  else {
    out.push(
      ...table([
        ["category", "direct", "direct_usd", "indirect", "indirect_usd", "min_hops"],
        ...rows,
      ]),
    );
  }
  const u = r.exposure.unresolved;
  out.push(
    `  unresolved: ${u.count} edges, ${usd(u.usd)} of ${usd(r.exposure.terminalUsd)} terminal`,
  );

  out.push("", `Linked wallets (${r.convergences.length}):`);
  if (r.convergences.length === 0) out.push("  none");
  else {
    out.push(
      ...table([
        ["address", "role", "kinds", "seeds", "usd"],
        ...r.convergences.map((c) => [
          c.address,
          c.role,
          c.kinds.join("+"),
          c.seedIds.join(","),
          usd(c.usd),
        ]),
      ]),
    );
  }

  out.push("", `Exchange touchpoints (${r.exchangeTouchpoints.length}):`);
  if (r.exchangeTouchpoints.length === 0) out.push("  none");
  else {
    out.push(
      ...table([
        ["kind", "entity", "counterparty", "amount", "usd", "time", "tx"],
        ...r.exchangeTouchpoints.map((t) => [
          t.kind,
          t.entity,
          t.counterparty ?? "-",
          `${amount(t.amount)} ${t.symbol}`,
          usd(t.usd),
          iso(t.timestamp),
          t.txHash,
        ]),
      ]),
    );
  }

  if (r.warnings.length > 0) {
    out.push("", "Warnings:");
    for (const w of r.warnings) out.push(`  ${w.code}: ${w.message}`);
  }

  const s = r.stats;
  out.push(
    "",
    `Stats: expandedEdges=${s.expandedEdges} apiCalls=${s.apiCalls} cacheHits=${s.cacheHits} droppedCandidates=${s.droppedCandidates} maxDepthReached=${s.maxDepthReached}`,
  );
  return `${out.join("\n")}\n`;
}
