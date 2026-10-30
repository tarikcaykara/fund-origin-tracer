import { describe, expect, test } from "bun:test";
import { AnalysisResultSchema, DerivedAnalysisSchema } from "../src/schema.ts";
import {
  addr,
  buildEdges,
  FAKE_USDT,
  fakePrices,
  fakeProvider,
  flagIds,
  provisionalAnalysis,
  runAnalysis,
  T0,
  transferRow,
  USDC,
} from "./helpers/analysis-fixtures.ts";

const BINANCE = {
  address: addr(20),
  name: "Binance 1",
  category: "exchange",
  entity: "Binance",
} as const;

/** Two seeds that both lead (via different parents) to the unlabeled address 10. */
function twoSeedGraph() {
  return buildEdges([
    { id: "a", near: addr(1), far: addr(2), amount: 500, seedId: "s1" },
    { id: "b", near: addr(3), far: addr(4), amount: 300, seedId: "s2" },
    { id: "c", near: addr(2), far: addr(10), amount: 480, parents: ["a"], rank: 0, ts: T0 - 100 },
    { id: "d", near: addr(4), far: addr(10), amount: 290, parents: ["b"], rank: 0, ts: T0 - 200 },
    { id: "e", near: addr(10), far: addr(20), amount: 400, parents: ["c"], depth: 2, rank: 0 },
    {
      id: "g",
      near: addr(10),
      far: addr(21),
      amount: 100,
      usd: null,
      parents: ["d"],
      depth: 2,
      stop: "max_depth",
      rank: 1,
    },
  ]);
}

describe("analyze: envelope", () => {
  test("orders edges by depth, seed index, rank and id; result validates against the schema", async () => {
    const edges = twoSeedGraph();
    const shuffled = [...edges].reverse();
    const result = await runAnalysis(shuffled, {
      seedIds: ["s1", "s2"],
      labels: [BINANCE],
    });

    expect(result.graph.edges.map((e) => e.id)).toEqual(["a", "b", "c", "d", "e", "g"]);
    expect(AnalysisResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);

    expect(result.schemaVersion).toBe(1);
    expect(result.runId).toBe("run-1");
    expect(result.status).toBe("completed");
    expect(result.dataSources).toEqual({
      explorer: "etherscan-v2",
      prices: "defillama",
      labelsVersion: "",
      localLabels: true,
      ofacFetchedAt: null,
    });
    expect(result.policy).toEqual({ version: 1, overridden: false });
    expect(result.stats.maxDepthReached).toBe(2);
  });

  test("maps every trace status 1:1 and keeps trace warnings", async () => {
    for (const status of ["completed", "cancelled", "timed_out", "failed"] as const) {
      const r = await runAnalysis(
        buildEdges([{ id: "a", near: addr(1), far: addr(2), seedId: "s1" }]),
        {
          status,
          warnings: [{ code: "prices_unavailable", message: "x" }],
        },
      );
      expect(r.status).toBe(status);
      expect(r.warnings).toEqual([{ code: "prices_unavailable", message: "x" }]);
    }
  });

  test("does not mutate the trace edges", async () => {
    const edges = buildEdges([
      { id: "z", near: addr(1), far: addr(2), seedId: "s1" },
      { id: "y", near: addr(1), far: addr(3), seedId: "s1" },
    ]);
    const before = JSON.stringify(edges);
    await runAnalysis(edges);
    expect(JSON.stringify(edges)).toBe(before);
  });
});

describe("analyze: address nodes and seed reachability", () => {
  test("builds nodes with seed subjects, seed ids, edge ids and labels", async () => {
    const result = await runAnalysis(twoSeedGraph(), {
      seedIds: ["s1", "s2"],
      labels: [BINANCE],
      ofac: [addr(21)],
    });
    const node = (a: string) => result.graph.addresses.find((n) => n.address === a);

    expect(node(addr(1))).toMatchObject({
      isSeedSubject: true,
      seedIds: ["s1"],
      inEdgeIds: ["a"],
      outEdgeIds: [],
    });
    expect(node(addr(3))).toMatchObject({ isSeedSubject: true, seedIds: ["s2"] });
    expect(node(addr(10))).toMatchObject({
      isSeedSubject: false,
      seedIds: ["s1", "s2"],
      inEdgeIds: ["e", "g"],
      outEdgeIds: ["c", "d"],
    });
    expect(node(addr(20))?.labels.map((l) => l.name)).toEqual(["Binance 1"]);
    expect(node(addr(21))).toMatchObject({ sanctioned: true });
    expect(node(addr(20))?.sanctioned).toBe(false);
    expect(new Set(result.graph.addresses.map((n) => n.address)).size).toBe(
      result.graph.addresses.length,
    );
  });

  test("a shared edge is reached by every seed that links to it", async () => {
    const edges = buildEdges([
      { id: "a", near: addr(1), far: addr(2), seedId: "s1" },
      { id: "b", near: addr(3), far: addr(4), seedId: "s2" },
      { id: "x", near: addr(2), far: addr(50), parents: ["a", "b"] },
    ]);
    const result = await runAnalysis(edges, { seedIds: ["s1", "s2"] });
    const conv = result.convergences.find((c) => c.address === addr(50));
    expect(conv?.seedIds).toEqual(["s1", "s2"]);
    expect(conv?.kinds).toEqual(["shared_across_seeds"]);
  });
});

describe("analyze: convergence follow-up paging", () => {
  test("the follow-up asks for page 1 only", async () => {
    const provider = fakeProvider();
    await runAnalysis(
      buildEdges([
        { id: "p", near: addr(1), far: addr(2), seedId: "s1", amount: 1 },
        { id: "x", near: addr(2), far: addr(3), parents: ["p"], amount: 5 },
        { id: "y", near: addr(4), far: addr(3), parents: ["p"], amount: 5 },
      ]),
      { provider },
    );
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(provider.calls.every((c) => c.maxPages === 1)).toBe(true);
  });
});

describe("analyze: convergences", () => {
  test("flags an unlabeled address shared across seeds and within the trace", async () => {
    const result = await runAnalysis(twoSeedGraph(), { seedIds: ["s1", "s2"], labels: [BINANCE] });
    expect(result.convergences).toHaveLength(1);
    expect(result.convergences[0]).toMatchObject({
      address: addr(10),
      role: "common_source",
      kinds: ["shared_across_seeds", "shared_within_trace"],
      seedIds: ["s1", "s2"],
      edgeIds: ["c", "d"],
      counterparties: [addr(2), addr(4)],
      usd: 770,
      minDepth: 1,
    });
    expect(result.convergences[0]?.totals).toEqual([
      {
        assetId: "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7",
        symbol: "USDT",
        amount: 770,
      },
    ]);
  });

  test("within-trace only: two counterparties, one seed; same counterparty twice is not a convergence", async () => {
    const edges = buildEdges([
      { id: "a", near: addr(1), far: addr(2), seedId: "s1" },
      { id: "b", near: addr(1), far: addr(3), seedId: "s1" },
      { id: "c", near: addr(2), far: addr(9), parents: ["a"] },
      { id: "d", near: addr(3), far: addr(9), parents: ["b"] },
      { id: "e", near: addr(3), far: addr(8), parents: ["b"] },
      { id: "f", near: addr(3), far: addr(8), parents: ["b"], amount: 50 },
    ]);
    const result = await runAnalysis(edges);
    expect(result.convergences.map((c) => [c.address, c.kinds])).toEqual([
      [addr(9), ["shared_within_trace"]],
    ]);
  });

  test("labeled addresses (even category other) are never convergences", async () => {
    const edges = buildEdges([
      { id: "a", near: addr(1), far: addr(2), seedId: "s1" },
      { id: "b", near: addr(3), far: addr(2), seedId: "s1" },
    ]);
    const plain = await runAnalysis(edges);
    expect(plain.convergences).toHaveLength(1);
    const labeled = await runAnalysis(edges, {
      labels: [{ address: addr(2), name: "Some contract", category: "other" }],
    });
    expect(labeled.convergences).toHaveLength(0);
  });

  test("forward traces report common destinations and follow incoming transfers", async () => {
    const provider = fakeProvider();
    const edges = buildEdges(
      [
        { id: "a", near: addr(1), far: addr(2), seedId: "s1" },
        { id: "b", near: addr(3), far: addr(2), seedId: "s1" },
      ],
      "forward",
    );
    const result = await runAnalysis(edges, { direction: "forward", provider });
    expect(result.convergences[0]?.role).toBe("common_destination");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({ address: addr(2), direction: "in", window: {} });
  });

  test("follow-up keeps only new counterparties, drops zero/spoofed rows and sorts by usd", async () => {
    const x = addr(10);
    const provider = fakeProvider(() => ({
      truncated: false,
      rows: [
        transferRow({ tx: "t-known", from: x, to: addr(20), amount: 9999 }),
        transferRow({ tx: "t-small", from: x, to: addr(30), amount: 50 }),
        transferRow({ tx: "t-big", from: x, to: addr(31), amount: 900 }),
        transferRow({ tx: "t-zero", from: x, to: addr(32), amount: 0 }),
        transferRow({ tx: "t-spoof", from: x, to: addr(33), amount: 5000, asset: FAKE_USDT }),
        transferRow({ tx: "t-in", from: addr(40), to: x, amount: 700 }),
        transferRow({
          tx: "t-unpriced",
          from: x,
          to: addr(34),
          amount: 1,
          asset: { chain: "ethereum", kind: "native" },
        }),
        transferRow({ tx: "t-usdc", from: x, to: addr(35), amount: 200, asset: USDC }),
      ],
    }));
    const result = await runAnalysis(twoSeedGraph(), {
      seedIds: ["s1", "s2"],
      labels: [BINANCE],
      provider,
      prices: fakePrices(),
    });
    expect(provider.calls[0]).toMatchObject({ address: x, direction: "out", window: {} });
    expect(result.convergences[0]?.otherCounterparties.map((t) => t.txHash)).toEqual([
      "t-big",
      "t-usdc",
      "t-small",
      "t-unpriced",
    ]);
  });

  test("follow-up keeps at most 20 rows and only the top 10 convergences are queried", async () => {
    const specs = [];
    for (let i = 0; i < 12; i++) {
      // Convergence i: far = addr(100+i), two near addresses, usd grows with i.
      specs.push({ id: `p${i}`, near: addr(1), far: addr(200 + i), seedId: "s1", amount: 1 });
      specs.push({
        id: `x${i}`,
        near: addr(200 + i),
        far: addr(100 + i),
        parents: [`p${i}`],
        amount: 10 + i,
      });
      specs.push({
        id: `y${i}`,
        near: addr(300 + i),
        far: addr(100 + i),
        parents: [`p${i}`],
        amount: 10 + i,
      });
    }
    const provider = fakeProvider((q) => ({
      truncated: false,
      rows: Array.from({ length: 30 }, (_, k) =>
        transferRow({
          tx: `${q.address}-${k}`,
          from: q.address,
          to: addr(5000 + k),
          amount: k + 1,
        }),
      ),
    }));
    const result = await runAnalysis(buildEdges(specs), { provider });
    const followed = new Set(provider.calls.map((c) => c.address));
    expect(provider.calls).toHaveLength(10);
    // Highest usd first: i = 11 .. 2 are followed, 1 and 0 are not.
    expect(followed.has(addr(111))).toBe(true);
    expect(followed.has(addr(102))).toBe(true);
    expect(followed.has(addr(101))).toBe(false);
    const top = result.convergences.find((c) => c.address === addr(111));
    expect(top?.otherCounterparties).toHaveLength(20);
    expect(top?.otherCounterparties[0]?.amount).toBe(30);
    expect(result.convergences.find((c) => c.address === addr(100))?.otherCounterparties).toEqual(
      [],
    );
  });

  test("a failing follow-up becomes a warning and never throws", async () => {
    const provider = fakeProvider(() => {
      throw new Error("explorer down");
    });
    const result = await runAnalysis(twoSeedGraph(), {
      seedIds: ["s1", "s2"],
      labels: [BINANCE],
      provider,
    });
    expect(result.convergences[0]?.otherCounterparties).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe("convergence_followup_failed");
    expect(result.warnings[0]?.message).toContain("explorer down");
    expect(() => AnalysisResultSchema.parse(result)).not.toThrow();
  });
});

describe("analyze: exposure", () => {
  const mixer = { name: "Tornado 0.1 ETH", category: "mixer", entity: "Tornado Cash" } as const;

  test("direct vs indirect hops, label priority, category other excluded, entity fallback", async () => {
    const edges = buildEdges([
      { id: "m1", near: addr(1), far: addr(100), depth: 0, amount: 100, seedId: "s1" },
      { id: "m2", near: addr(1), far: addr(101), depth: 2, amount: 50, seedId: "s1" },
      { id: "m3", near: addr(1), far: addr(101), depth: 4, amount: 25, seedId: "s1", ts: T0 + 5 },
      { id: "sx", near: addr(1), far: addr(102), depth: 1, amount: 10, seedId: "s1" },
      { id: "ot", near: addr(1), far: addr(103), depth: 0, amount: 7, seedId: "s1" },
      { id: "dx", near: addr(1), far: addr(104), depth: 0, amount: 3, seedId: "s1" },
    ]);
    const result = await runAnalysis(edges, {
      bundled: [
        { address: addr(102), name: "Exchange hot wallet", category: "exchange", entity: "Acme" },
      ],
      ofac: [addr(102)],
      labels: [
        { address: addr(100), ...mixer },
        { address: addr(101), ...mixer },
        { address: addr(103), name: "Misc contract", category: "other" },
        { address: addr(104), name: "Uniswap Router", category: "dex" },
      ],
    });

    const entry = (id: string) => result.exposure.entries.find((e) => e.edgeId === id);
    expect(entry("m1")).toMatchObject({
      category: "mixer",
      entity: "Tornado Cash",
      hops: 1,
      usd: 100,
    });
    expect(entry("m2")?.hops).toBe(3);
    expect(entry("sx")?.category).toBe("sanctioned");
    expect(entry("ot")).toBeUndefined();
    expect(entry("dx")).toMatchObject({ category: "dex", entity: "Uniswap Router" });

    const cat = (c: string) => result.exposure.byCategory.find((x) => x.category === c);
    expect(cat("mixer")).toEqual({
      category: "mixer",
      direct: { count: 1, usd: 100 },
      indirect: { count: 2, usd: 75, minHops: 3 },
    });
    expect(cat("dex")?.indirect.minHops).toBeNull();
    expect(cat("other")).toBeUndefined();

    expect(result.exposure.byEntity[0]).toEqual({
      entity: "Tornado Cash",
      category: "mixer",
      count: 3,
      usd: 175,
      minHops: 1,
    });
    expect(result.exposure.byEntity.map((e) => e.entity)).toEqual([
      "Tornado Cash",
      "OFAC SDN",
      "Uniswap Router",
    ]);
  });

  test("unresolved counts only stopped edges with unlabeled far and an open-ended reason", async () => {
    const edges = buildEdges([
      { id: "r0", near: addr(1), far: addr(2), seedId: "s1", amount: 100, stop: "max_depth" },
      { id: "r1", near: addr(1), far: addr(3), seedId: "s1", amount: 40, stop: "no_candidates" },
      { id: "r2", near: addr(1), far: addr(4), seedId: "s1", amount: 30, stop: "cycle" },
      { id: "r3", near: addr(1), far: addr(5), seedId: "s1", amount: 20, stop: "mint" },
      {
        id: "r4",
        near: addr(1),
        far: addr(6),
        seedId: "s1",
        amount: 10,
        stop: "max_depth",
        usd: null,
      },
      { id: "r5", near: addr(1), far: addr(7), seedId: "s1", amount: 5, stop: "max_depth" },
      { id: "r6", near: addr(1), far: addr(8), seedId: "s1", amount: 60, stop: "entity" },
    ]);
    const result = await runAnalysis(edges, {
      labels: [
        { address: addr(7), name: "Router", category: "dex" },
        { address: addr(8), name: "Kraken", category: "exchange", entity: "Kraken" },
      ],
    });
    const u = result.exposure.unresolved;
    expect(u.count).toBe(3);
    expect(u.usd).toBe(140);
    expect(u.byReason.max_depth).toEqual({ count: 2, usd: 100 });
    expect(u.byReason.no_candidates).toEqual({ count: 1, usd: 40 });
    expect(u.byReason.cycle).toEqual({ count: 0, usd: 0 });
    // Exposure on stopped edges (dex 5 + exchange 60) counts toward terminal value too.
    expect(result.exposure.terminalUsd).toBe(140 + 5 + 60);
    expect(result.exposure.unpricedCount).toBe(1);
  });

  test("byEntity is capped at 20 entries, highest usd first", async () => {
    const specs = Array.from({ length: 25 }, (_, i) => ({
      id: `e${i}`,
      near: addr(1),
      far: addr(100 + i),
      seedId: "s1",
      amount: i + 1,
    }));
    const labels = specs.map((_s, i) => ({
      address: addr(100 + i),
      name: `Entity ${i}`,
      category: "exchange" as const,
    }));
    const result = await runAnalysis(buildEdges(specs), { labels });
    expect(result.exposure.byEntity).toHaveLength(20);
    expect(result.exposure.byEntity[0]?.entity).toBe("Entity 24");
    expect(result.exposure.byEntity[19]?.entity).toBe("Entity 5");
  });
});

describe("analyze: exchange touchpoints", () => {
  test("backward exchange edges are origins with the near address as counterparty", async () => {
    const edges = buildEdges([
      { id: "a", near: addr(1), far: addr(20), seedId: "s1", amount: 100, ts: T0 },
      { id: "b", near: addr(2), far: addr(20), seedId: "s1", amount: 900, ts: T0 + 60, depth: 1 },
      { id: "c", near: addr(3), far: addr(4), seedId: "s1" },
    ]);
    const result = await runAnalysis(edges, { labels: [BINANCE] });
    expect(result.exchangeTouchpoints.map((t) => [t.kind, t.usd, t.counterparty])).toEqual([
      ["origin", 900, addr(2)],
      ["origin", 100, addr(1)],
    ]);
    expect(result.exchangeTouchpoints[0]).toMatchObject({
      entity: "Binance",
      exchangeAddress: addr(20),
      symbol: "USDT",
      timestamp: T0 + 60,
      depth: 1,
      seedIds: ["s1"],
    });
  });

  test("forward exchange edges are arrivals; non-exchange labels are ignored", async () => {
    const edges = buildEdges(
      [
        { id: "a", near: addr(1), far: addr(20), seedId: "s1" },
        { id: "b", near: addr(1), far: addr(21), seedId: "s1" },
      ],
      "forward",
    );
    const result = await runAnalysis(edges, {
      direction: "forward",
      labels: [BINANCE, { address: addr(21), name: "Router", category: "dex" }],
    });
    expect(result.exchangeTouchpoints).toHaveLength(1);
    expect(result.exchangeTouchpoints[0]).toMatchObject({ kind: "arrival", counterparty: addr(1) });
  });
});

describe("analyzeProvisional", () => {
  test("equals the derived part of analyze for a completed run whose follow-ups find nothing", async () => {
    const scenario = { seedIds: ["s1", "s2"], labels: [BINANCE], ofac: [addr(21)] };
    const edges = twoSeedGraph();
    const final = await runAnalysis(edges, scenario);
    // The fixture exercises every derived section, so equality below is not vacuous.
    expect(final.convergences).toHaveLength(1);
    expect(final.exchangeTouchpoints).toHaveLength(1);
    expect(final.riskLevel).toBe("high");

    const provisional = provisionalAnalysis(edges, scenario);
    expect(provisional).toEqual({
      chain: final.chain,
      direction: final.direction,
      seeds: final.seeds,
      graph: { addresses: final.graph.addresses },
      convergences: final.convergences,
      exposure: final.exposure,
      exchangeTouchpoints: final.exchangeTouchpoints,
      flags: final.flags,
      riskLevel: final.riskLevel,
    });
    expect(DerivedAnalysisSchema.parse(JSON.parse(JSON.stringify(provisional)))).toEqual(
      provisional,
    );
  });

  test("raises incomplete_trace only for failed fetches: a run in flight has no outcome yet", async () => {
    const clean = buildEdges([{ id: "a", near: addr(1), far: addr(2), seedId: "s1" }]);
    expect(flagIds(await runAnalysis(clean, { status: "cancelled" }))).toContain(
      "incomplete_trace",
    );
    expect(flagIds(provisionalAnalysis(clean))).not.toContain("incomplete_trace");

    const failed = buildEdges([
      { id: "a", near: addr(1), far: addr(2), seedId: "s1" },
      { id: "b", near: addr(1), far: addr(3), seedId: "s1", stop: "fetch_failed" },
    ]);
    const flag = provisionalAnalysis(failed).flags.find((f) => f.id === "incomplete_trace");
    expect(flag?.detail).toBe(
      "The result may be partial: 1 branch stopped because data could not be fetched.",
    );
  });
});
