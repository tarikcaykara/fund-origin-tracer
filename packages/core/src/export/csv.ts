/**
 * CSV export of an AnalysisResult. UTF-8 with BOM (Excel), CRLF line ends, RFC 4180 quoting and a
 * formula-injection guard. Imported by the web app: depends on schema/chains only.
 *
 * Columns per kind:
 *   edges         depth,from,from_label,to,to_label,asset,amount,usd,timestamp_iso,tx_hash,
 *                 explorer_url,status,stop_reason,score,seed_ids
 *   convergences  role,address,kinds,seed_ids,min_depth,counterparties,edge_count,totals,usd,
 *                 other_counterparties
 *   exposure      category,entity,address,hops,symbol,amount,usd,tx_hash,explorer_url
 *   touchpoints   kind,entity,exchange_address,counterparty,symbol,amount,usd,timestamp_iso,
 *                 tx_hash,explorer_url,depth,seed_ids
 *
 * List-valued cells are joined with ";". Labels are the first label name of the address.
 */
import { seedReachability } from "../analysis/reachability.ts";
import { CHAINS } from "../chains.ts";
import type { AnalysisResult, Asset } from "../schema.ts";

export type CsvKind = "edges" | "convergences" | "exposure" | "touchpoints";

const BOM = "\uFEFF";

type Cell = string | number | null | undefined;

/** Quotes per RFC 4180 and neutralizes spreadsheet formulas (cells starting with = + - @ TAB CR). */
export function escapeCsvCell(value: Cell): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function row(cells: readonly Cell[]): string {
  return cells.map(escapeCsvCell).join(",");
}

function build(header: readonly string[], rows: readonly (readonly Cell[])[]): string {
  return `${BOM}${[header.join(","), ...rows.map(row)].join("\r\n")}\r\n`;
}

function num(n: number, maxFractionDigits: number): string {
  return n.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits: maxFractionDigits,
  });
}

function amount(n: number): string {
  return num(n, 18);
}

function usd(n: number | null): string {
  return n === null ? "" : num(n, 2);
}

function iso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

function symbol(asset: Asset): string {
  return asset.kind === "native" ? CHAINS[asset.chain].nativeSymbol : asset.symbol;
}

export function toCsv(kind: CsvKind, result: AnalysisResult): string {
  const explorer = CHAINS[result.chain];
  const firstLabel = new Map<string, string>();
  for (const node of result.graph.addresses) {
    const label = node.labels[0];
    if (label) firstLabel.set(node.address, label.name);
  }
  const labelOf = (address: string): string => firstLabel.get(address) ?? "";

  switch (kind) {
    case "edges": {
      const { edgeSeedIds } = seedReachability(result.graph.edges, result.seeds);
      return build(
        [
          "depth",
          "from",
          "from_label",
          "to",
          "to_label",
          "asset",
          "amount",
          "usd",
          "timestamp_iso",
          "tx_hash",
          "explorer_url",
          "status",
          "stop_reason",
          "score",
          "seed_ids",
        ],
        result.graph.edges.map((e) => [
          e.depth,
          e.from,
          labelOf(e.from),
          e.to,
          labelOf(e.to),
          symbol(e.transfer.asset),
          amount(e.transfer.amount),
          usd(e.usd),
          iso(e.transfer.timestamp),
          e.transfer.txHash,
          explorer.txUrl(e.transfer.txHash),
          e.status,
          e.stopReason,
          e.selection?.score,
          (edgeSeedIds.get(e.id) ?? []).join(";"),
        ]),
      );
    }
    case "convergences":
      return build(
        [
          "role",
          "address",
          "kinds",
          "seed_ids",
          "min_depth",
          "counterparties",
          "edge_count",
          "totals",
          "usd",
          "other_counterparties",
        ],
        result.convergences.map((c) => [
          c.role,
          c.address,
          c.kinds.join(";"),
          c.seedIds.join(";"),
          c.minDepth,
          c.counterparties.join(";"),
          c.edgeIds.length,
          c.totals.map((t) => `${amount(t.amount)} ${t.symbol}`).join(";"),
          usd(c.usd),
          Array.from(
            new Set(c.otherCounterparties.map((t) => (t.from === c.address ? t.to : t.from))),
          ).join(";"),
        ]),
      );
    case "exposure":
      return build(
        [
          "category",
          "entity",
          "address",
          "hops",
          "symbol",
          "amount",
          "usd",
          "tx_hash",
          "explorer_url",
        ],
        result.exposure.entries.map((e) => [
          e.category,
          e.entity,
          e.address,
          e.hops,
          e.symbol,
          amount(e.amount),
          usd(e.usd),
          e.txHash,
          explorer.txUrl(e.txHash),
        ]),
      );
    case "touchpoints":
      return build(
        [
          "kind",
          "entity",
          "exchange_address",
          "counterparty",
          "symbol",
          "amount",
          "usd",
          "timestamp_iso",
          "tx_hash",
          "explorer_url",
          "depth",
          "seed_ids",
        ],
        result.exchangeTouchpoints.map((t) => [
          t.kind,
          t.entity,
          t.exchangeAddress,
          t.counterparty,
          t.symbol,
          amount(t.amount),
          usd(t.usd),
          iso(t.timestamp),
          t.txHash,
          explorer.txUrl(t.txHash),
          t.depth,
          t.seedIds.join(";"),
        ]),
      );
  }
}
