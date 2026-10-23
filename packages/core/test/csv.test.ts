import { describe, expect, test } from "bun:test";
import { escapeCsvCell, toCsv } from "../src/export/csv.ts";
import type { AnalysisResult } from "../src/schema.ts";
import { addr, buildEdges, runAnalysis, T0 } from "./helpers/analysis-fixtures.ts";

const BOM = "\uFEFF";

/** Minimal RFC 4180 parser, independent of the encoder under test. */
function parseCsv(text: string): string[][] {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && body[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const NASTY = '=HYPERLINK("http://x.test","y"), Inc\nLtd';

async function sample(): Promise<AnalysisResult> {
  const edges = buildEdges([
    { id: "a", near: addr(1), far: addr(2), amount: 1234.5, seedId: "s1", rank: 0, score: 95 },
    {
      id: "b",
      near: addr(3),
      far: addr(4),
      amount: 0.000001,
      usd: null,
      seedId: "s2",
      ts: T0 + 60,
    },
    { id: "c", near: addr(2), far: addr(10), amount: 400, parents: ["a", "b"], stop: "max_depth" },
    { id: "d", near: addr(4), far: addr(10), amount: 100, parents: ["b"] },
    { id: "e", near: addr(1), far: addr(20), amount: 7, seedId: "s1" },
  ]);
  return runAnalysis(edges, {
    seedIds: ["s1", "s2"],
    labels: [
      { address: addr(2), name: NASTY, category: "other" },
      { address: addr(20), name: "Binance 1", category: "exchange", entity: "Binance" },
    ],
  });
}

describe("escapeCsvCell numbers", () => {
  test("finite numbers are emitted as plain numbers, strings still guarded", () => {
    expect(escapeCsvCell(-10)).toBe("-10");
    expect(escapeCsvCell("-10")).toBe("'-10");
  });
});

describe("escapeCsvCell", () => {
  test("neutralizes formula starters with a leading apostrophe", () => {
    for (const s of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) {
      expect(escapeCsvCell(s).replace(/^"|"$/g, "").startsWith("'")).toBe(true);
    }
    expect(escapeCsvCell("a=b")).toBe("a=b");
    expect(escapeCsvCell("USDT")).toBe("USDT");
  });
  test("quotes cells with comma, quote, CR or LF and doubles quotes", () => {
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("l1\nl2")).toBe('"l1\nl2"');
    expect(escapeCsvCell("=a,b")).toBe('"\'=a,b"');
  });
  test("null and undefined are empty", () => {
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
    expect(escapeCsvCell(0)).toBe("0");
  });
});

describe("toCsv", () => {
  test("edges: BOM, CRLF, exact header, one row per edge", async () => {
    const csv = toCsv("edges", await sample());
    expect(
      csv.startsWith(
        `${BOM}depth,from,from_label,to,to_label,asset,amount,usd,timestamp_iso,tx_hash,`,
      ),
    ).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    // Every newline outside quotes is CRLF.
    const unquoted = csv.replace(/"(?:[^"]|"")*"/g, '""');
    expect(unquoted.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([
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
    ]);
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(r).toHaveLength(15);
  });

  test("edges: values, labels, explorer url, seeds and nullable columns", async () => {
    const result = await sample();
    const rows = parseCsv(toCsv("edges", result));
    const byTx = (id: string) => rows.find((r) => r[9] === `0xtx-${id}`) ?? [];

    const a = byTx("a");
    expect(a[0]).toBe("0");
    expect(a[1]).toBe(addr(2));
    // The label is guarded against formula injection and survives comma, quote and newline.
    expect(a[2]).toBe(`'${NASTY}`);
    expect(a[3]).toBe(addr(1));
    expect(a[4]).toBe("");
    expect(a.slice(5, 8)).toEqual(["USDT", "1234.5", "1234.5"]);
    expect(a[8]).toBe(new Date(T0 * 1000).toISOString());
    expect(a[10]).toBe("https://etherscan.io/tx/0xtx-a");
    expect(a.slice(11, 15)).toEqual(["expanded", "", "95", "s1"]);

    const b = byTx("b");
    expect(b[6]).toBe("0.000001");
    expect(b[7]).toBe("");
    expect(b[14]).toBe("s2");

    const c = byTx("c");
    expect(c[11]).toBe("stopped");
    expect(c[12]).toBe("max_depth");
    expect(c[13]).toBe("");
    expect(c[14]).toBe("s1;s2");
    expect(byTx("e")[2]).toBe("Binance 1");
  });

  test("convergences, exposure and touchpoints have their documented columns", async () => {
    const result = await sample();
    const conv = parseCsv(toCsv("convergences", result));
    expect(conv[0]?.join(",")).toBe(
      "role,address,kinds,seed_ids,min_depth,counterparties,edge_count,totals,usd,other_counterparties",
    );
    expect(conv[1]).toEqual([
      "common_source",
      addr(10),
      "shared_across_seeds;shared_within_trace",
      "s1;s2",
      "1",
      `${addr(2)};${addr(4)}`,
      "2",
      "500 USDT",
      "500",
      "",
    ]);

    const exposure = parseCsv(toCsv("exposure", result));
    expect(exposure[0]?.join(",")).toBe(
      "category,entity,address,hops,symbol,amount,usd,tx_hash,explorer_url",
    );
    expect(exposure[1]).toEqual([
      "exchange",
      "Binance",
      addr(20),
      "1",
      "USDT",
      "7",
      "7",
      "0xtx-e",
      "https://etherscan.io/tx/0xtx-e",
    ]);

    const touch = parseCsv(toCsv("touchpoints", result));
    expect(touch[0]?.join(",")).toBe(
      "kind,entity,exchange_address,counterparty,symbol,amount,usd,timestamp_iso,tx_hash,explorer_url,depth,seed_ids",
    );
    expect(touch[1]?.slice(0, 5)).toEqual(["origin", "Binance", addr(20), addr(1), "USDT"]);
    expect(touch[1]?.slice(10)).toEqual(["0", "s1"]);
  });

  test("addresses: one row per graph address with degree and usd sums", async () => {
    const result = await sample();
    const rows = parseCsv(toCsv("addresses", result));
    expect(rows[0]?.join(",")).toBe(
      "address,labels,categories,entities,sanctioned,seed_subject,seed_ids,min_depth,transfers_in,transfers_out,usd_in,usd_out",
    );
    expect(rows.slice(1).map((r) => r[0])).toEqual(result.graph.addresses.map((a) => a.address));
    const binance = rows.find((r) => r[0] === addr(20));
    expect(binance?.slice(1, 6)).toEqual(["Binance 1", "exchange", "Binance", "false", "false"]);
    expect(binance?.slice(8, 10)).toEqual(["0", "1"]);
    expect(binance?.[10]).toBe("");
    expect(binance?.[11]).toBe("7");
  });

  test("empty collections give just the header row", async () => {
    const empty = await runAnalysis([]);
    for (const kind of ["edges", "convergences", "exposure", "touchpoints", "addresses"] as const) {
      const csv = toCsv(kind, empty);
      expect(csv.startsWith(BOM)).toBe(true);
      expect(parseCsv(csv)).toHaveLength(1);
      expect(csv.endsWith("\r\n")).toBe(true);
    }
  });

  test("uses the chain's explorer for tron links", async () => {
    const result = await sample();
    const tron: AnalysisResult = {
      ...result,
      chain: "tron",
      graph: { ...result.graph, edges: result.graph.edges.slice(0, 1) },
    };
    const url = parseCsv(toCsv("edges", tron))[1]?.[10];
    expect(url).toBe("https://tronscan.org/#/transaction/0xtx-a");
  });
});
