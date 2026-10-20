import { describe, expect, test } from "bun:test";
import { CHAINS } from "../src/chains.ts";
import { edgeIdFor, runTrace } from "../src/engine/trace.ts";
import type { TraceOutput } from "../src/engine/types.ts";
import { FotError } from "../src/errors.ts";
import { RunController } from "../src/infra/controller.ts";
import type { BundledLabelFile } from "../src/labels/files.ts";
import { LabelRegistry } from "../src/labels/registry.ts";
import {
  assetId,
  type LabelCategory,
  type RunParams,
  type TraceEdge,
  type Transfer,
} from "../src/schema.ts";
import { flagIds, runAnalysis } from "./helpers/analysis-fixtures.ts";
import {
  addr,
  EventLog,
  FAKE_USDT,
  FakePrices,
  FakeProvider,
  type FakeProviderOptions,
  mkTransfer,
  mkTx,
  T0,
  txHash,
  USDC,
  USDT,
  WETH,
} from "./helpers/fakes.ts";

/** Yields one macrotask so every microtask-driven continuation can run (no wall-clock wait). */
const settle = () => new Promise<void>((r) => setImmediate(r));
const ZERO = CHAINS.ethereum.zeroAddresses[0] as string;

function params(over: Partial<RunParams> = {}): RunParams {
  return {
    chain: "ethereum",
    direction: "backward",
    seeds: [{ id: "s1", kind: "tx", value: txHash(1) }],
    maxDepth: 10,
    maxBranches: 3,
    maxEdges: 200,
    minUsd: 0,
    traceThroughEntities: false,
    timeoutSec: 600,
    ...over,
  };
}

function labelsOf(
  entries: { address: string; name: string; category: LabelCategory }[] = [],
  sanctioned: string[] = [],
): LabelRegistry {
  const file: BundledLabelFile = {
    chain: "ethereum",
    entries: entries.map((e) => ({
      ...e,
      source: "https://example.org/label",
      verifiedAt: "2026-01-01",
    })),
  };
  return new LabelRegistry([file], null, {
    fetchedAt: null,
    evm: new Set(sanctioned),
    tron: new Set(),
  });
}

interface RunOptions {
  labels?: LabelRegistry;
  prices?: FakePrices;
  controller?: RunController;
  concurrency?: number;
  continueFrom?: Parameters<typeof runTrace>[4];
}

async function run(p: RunParams, provider: FakeProvider, opts: RunOptions = {}) {
  const log = new EventLog();
  const controller = opts.controller ?? new RunController();
  const prices = opts.prices ?? new FakePrices();
  const out = await runTrace(
    p,
    {
      provider,
      prices,
      labels: opts.labels ?? labelsOf(),
      now: () => Date.now(),
      concurrency: opts.concurrency ?? 4,
    },
    controller,
    log.emit,
    opts.continueFrom,
  );
  return { out, log, controller, prices };
}

function edgeBy(out: TraceOutput, pred: (e: TraceEdge) => boolean): TraceEdge {
  const e = out.edges.find(pred);
  if (!e) throw new Error("edge not found");
  return e;
}

const byFar = (out: TraceOutput, far: string) => out.edges.filter((e) => e.far === far);

/** Linear backward chain: addr(n+1) -> addr(n) in tx n, each 100 USDT, 100 s apart. */
function chainTransfers(hops: number): Transfer[] {
  return Array.from({ length: hops }, (_, i) =>
    mkTransfer({ tx: i + 1, from: addr(i + 2), to: addr(i + 1), amount: 100, ts: T0 - i * 100 }),
  );
}

function chainProviderOpts(hops: number): FakeProviderOptions {
  const transfers = chainTransfers(hops);
  return { transfers, txs: [mkTx(txHash(1), [transfers[0] as Transfer])] };
}

function chainProvider(hops: number, over: FakeProviderOptions = {}): FakeProvider {
  const transfers = chainTransfers(hops);
  return new FakeProvider({
    transfers,
    txs: [mkTx(txHash(1), [transfers[0] as Transfer])],
    ...over,
  });
}

describe("edgeIdFor", () => {
  test("is a stable 17-char id that changes with the transfer", () => {
    const t = mkTransfer({ tx: 1, from: addr(2), to: addr(1), amount: 5, ts: T0 });
    expect(edgeIdFor(t)).toMatch(/^e[0-9a-f]{16}$/);
    expect(edgeIdFor(t)).toBe(edgeIdFor({ ...t }));
    expect(edgeIdFor(t)).not.toBe(edgeIdFor({ ...t, amountRaw: "5000001" }));
  });
});

describe("backward chain", () => {
  test("follows the chain to the end and reports lifecycle events", async () => {
    const provider = chainProvider(4);
    const { out, log } = await run(params(), provider);

    expect(out.status).toBe("completed");
    expect(out.edges.map((e) => e.depth)).toEqual([0, 1, 2, 3]);
    expect(out.edges.map((e) => e.status)).toEqual(["expanded", "expanded", "expanded", "stopped"]);
    expect(out.edges[3]?.stopReason).toBe("no_candidates");
    expect(out.edges[0]).toMatchObject({
      far: addr(2),
      near: addr(1),
      seedId: "s1",
      selection: null,
      parents: [],
      children: [out.edges[1]?.id],
    });
    expect(out.edges[1]?.selection).toMatchObject({ rank: 1, score: 97 });
    expect(out.edges[1]?.parents).toEqual([out.edges[0]?.id as string]);
    expect(out.stats).toMatchObject({ expandedEdges: 4, maxDepthReached: 3, droppedCandidates: 0 });
    expect(out.stats.apiCalls).toBeGreaterThan(0);

    expect(log.of("edge_added")).toHaveLength(4);
    expect(log.of("edge_expanded")).toHaveLength(3);
    expect(log.of("edge_stopped").map((e) => e.reason)).toEqual(["no_candidates"]);
    expect(log.of("progress").length).toBeGreaterThan(0);
    expect(log.of("result")).toHaveLength(0);
    expect(log.of("done")).toHaveLength(0);
  });

  test("emitted edges are snapshots, not live references", async () => {
    const { out, log } = await run(params(), chainProvider(3));
    const added = log.of("edge_added")[0]?.edge as TraceEdge;
    expect(added.status).toBe("pending");
    expect(added.children).toEqual([]);
    expect(out.edges[0]?.children).toHaveLength(1);
  });

  test("forward traces follow outgoing transfers", async () => {
    const t1 = mkTransfer({ tx: 1, from: addr(1), to: addr(2), amount: 100, ts: T0 });
    const t2 = mkTransfer({ tx: 2, from: addr(2), to: addr(3), amount: 100, ts: T0 + 100 });
    const provider = new FakeProvider({ transfers: [t1, t2], txs: [mkTx(txHash(1), [t1])] });
    const { out } = await run(params({ direction: "forward" }), provider);
    expect(out.edges.map((e) => [e.far, e.near])).toEqual([
      [addr(2), addr(1)],
      [addr(3), addr(2)],
    ]);
    expect(provider.listCalls[0]).toMatchObject({ key: addr(2), direction: "out" });
    expect(provider.listCalls[0]?.window).toEqual({ afterTs: T0 });
  });
});

describe("candidate selection and drops", () => {
  test("keeps the best-scoring candidates, drops the rest with their score", async () => {
    const seed = mkTransfer({ tx: 1, from: addr(2), to: addr(1), amount: 100, ts: T0 });
    const exact = mkTransfer({ tx: 2, from: addr(10), to: addr(2), amount: 100, ts: T0 - 20 });
    const close = mkTransfer({ tx: 3, from: addr(11), to: addr(2), amount: 97, ts: T0 - 20 });
    const far = mkTransfer({ tx: 4, from: addr(12), to: addr(2), amount: 100, ts: T0 - 5000 });
    const provider = new FakeProvider({
      transfers: [seed, exact, close, far],
      txs: [mkTx(txHash(1), [seed])],
    });
    const { out } = await run(params({ maxBranches: 2, maxDepth: 1 }), provider);

    const root = out.edges[0] as TraceEdge;
    expect(root.children).toHaveLength(2);
    const picked = root.children.map((id) => edgeBy(out, (e) => e.id === id));
    expect(picked.map((e) => e.far)).toEqual([addr(10), addr(11)]);
    expect(picked.map((e) => e.selection?.rank)).toEqual([1, 2]);
    expect(picked[0]?.selection?.breakdown).toEqual({ asset: 50, amount: 25, time: 30, dust: 0 });
    expect(root.droppedTotal).toBe(1);
    expect(root.dropped).toEqual([
      { transfer: far, usd: 100, reason: "exceeds_max_branches", score: 50 + 25 + 7 },
    ]);
    expect(out.stats.droppedCandidates).toBe(1);
  });

  test("retains one example of every drop reason even when scored drops fill the cap", async () => {
    const seed = mkTransfer({ tx: 1, from: addr(2), to: addr(1), amount: 100, ts: T0 });
    const excess = Array.from({ length: 100 }, (_, i) =>
      mkTransfer({ tx: 100 + i, from: addr(100 + i), to: addr(2), amount: 100, ts: T0 - 10 - i }),
    );
    const spoof = mkTransfer({
      tx: 500,
      from: addr(500),
      to: addr(2),
      amount: 100,
      ts: T0 - 10,
      asset: FAKE_USDT,
    });
    const provider = new FakeProvider({
      transfers: [seed, ...excess, spoof],
      txs: [mkTx(txHash(1), [seed])],
    });
    const { out } = await run(params({ maxBranches: 1, maxDepth: 1 }), provider);
    const root = out.edges[0] as TraceEdge;
    expect(root.droppedTotal).toBe(100);
    expect(root.dropped).toHaveLength(30);
    expect(root.dropped.some((d) => d.reason === "spoofed_token")).toBe(true);
    expect(root.dropped.filter((d) => d.reason === "exceeds_max_branches")[0]?.score).toBe(
      Math.max(...root.dropped.map((d) => d.score ?? -1)),
    );
    const result = await runAnalysis(out.edges, {});
    expect(flagIds(result)).toContain("spoofed_tokens_ignored");
  });

  test("applies drop reasons in order and records every dropped candidate", async () => {
    const Y = addr(2);
    const seed = mkTransfer({ tx: 1, from: Y, to: addr(1), amount: 100, ts: T0 });
    const rows = {
      same_tx: mkTransfer({ tx: 1, from: addr(20), to: Y, amount: 5, ts: T0 }),
      self_transfer: mkTransfer({ tx: 3, from: Y, to: Y, amount: 5, ts: T0 - 10 }),
      zero_value: mkTransfer({ tx: 4, from: addr(21), to: Y, amount: 0, ts: T0 - 10 }),
      spoofed_token: mkTransfer({
        tx: 5,
        from: addr(22),
        to: Y,
        amount: 100,
        ts: T0 - 10,
        asset: FAKE_USDT,
      }),
      outside_time_window: mkTransfer({ tx: 6, from: addr(23), to: Y, amount: 100, ts: T0 + 100 }),
      unpriced: mkTransfer({ tx: 7, from: addr(24), to: Y, amount: 100, ts: T0 - 10, asset: WETH }),
      below_min_usd: mkTransfer({ tx: 8, from: addr(25), to: Y, amount: 5, ts: T0 - 10 }),
    };
    const ok = mkTransfer({ tx: 9, from: addr(26), to: Y, amount: 100, ts: T0 - 10 });
    const provider = new FakeProvider({
      transfers: [seed, ...Object.values(rows), ok],
      txs: [mkTx(txHash(1), [seed])],
      windowSlackSec: 600,
    });
    const { out } = await run(params({ minUsd: 10, maxDepth: 1 }), provider);

    const root = out.edges[0] as TraceEdge;
    expect(root.droppedTotal).toBe(7);
    const reasonByTx = new Map(root.dropped.map((d) => [d.transfer.txHash, d.reason] as const));
    for (const [reason, t] of Object.entries(rows)) {
      expect(reasonByTx.get(t.txHash)).toBe(reason as keyof typeof rows);
    }
    expect(root.dropped.every((d) => d.score === null)).toBe(true);
    expect(root.children).toHaveLength(1);
    expect(edgeBy(out, (e) => e.id === root.children[0]).transfer.txHash).toBe(ok.txHash);
  });

  test("caps stored drops at 30 but counts all of them, scored drops first", async () => {
    const seed = mkTransfer({ tx: 1, from: addr(2), to: addr(1), amount: 100, ts: T0 });
    const junk = Array.from({ length: 40 }, (_, i) =>
      mkTransfer({ tx: 100 + i, from: addr(100 + i), to: addr(2), amount: 0, ts: T0 - 10 }),
    );
    const extra = mkTransfer({ tx: 50, from: addr(50), to: addr(2), amount: 100, ts: T0 - 4000 });
    const best = mkTransfer({ tx: 51, from: addr(51), to: addr(2), amount: 100, ts: T0 - 10 });
    const provider = new FakeProvider({
      transfers: [seed, ...junk, extra, best],
      txs: [mkTx(txHash(1), [seed])],
    });
    const { out } = await run(params({ maxBranches: 1, maxDepth: 1 }), provider);
    const root = out.edges[0] as TraceEdge;
    expect(root.droppedTotal).toBe(41);
    expect(root.dropped).toHaveLength(30);
    expect(root.dropped[0]?.reason).toBe("exceeds_max_branches");
    expect(root.dropped[1]?.reason).toBe("zero_value");
  });

  test("prices every candidate with one batched lookup per expansion", async () => {
    const provider = chainProvider(3);
    const { prices, out } = await run(params(), provider);
    // 1 seed-leg lookup + one per expansion that had rows to price.
    expect(prices.calls).toBeLessThanOrEqual(1 + out.stats.expandedEdges);
    expect(out.edges[0]?.usd).toBe(100);
  });

  test("a price outage yields null usd and a single prices_unavailable warning", async () => {
    const prices = new FakePrices();
    prices.failWith = { code: "prices_unavailable", message: "defillama down" };
    const { out, log } = await run(params(), chainProvider(3), { prices });
    expect(out.status).toBe("completed");
    expect(out.edges.every((e) => e.usd === null)).toBe(true);
    expect(out.warnings.filter((w) => w.code === "prices_unavailable")).toHaveLength(1);
    expect(log.of("warning").filter((w) => w.code === "prices_unavailable")).toHaveLength(1);
  });
});

describe("truncated listings", () => {
  test("no_candidates on a truncated listing says so; one run-level warning", async () => {
    const provider = chainProvider(1, { truncated: true });
    const { out, log } = await run(params(), provider);
    const root = out.edges[0] as TraceEdge;
    expect(root.stopReason).toBe("no_candidates");
    expect(root.stopDetail).toBe("listing_truncated");
    expect(out.warnings.filter((w) => w.code === "listing_truncated")).toHaveLength(1);
    expect(log.of("warning").filter((w) => w.code === "listing_truncated")).toHaveLength(1);
  });

  test("an untruncated dead end has no detail and no warning", async () => {
    const { out } = await run(params(), chainProvider(1));
    expect(out.edges[0]?.stopDetail).toBeNull();
    expect(out.warnings.some((w) => w.code === "listing_truncated")).toBe(false);
  });
});

describe("per-edge stop checks", () => {
  const Y = addr(2);
  const EXCH = addr(30);
  const MIXER = addr(31);
  const SANC = addr(32);
  const seed = mkTransfer({ tx: 1, from: Y, to: addr(1), amount: 100, ts: T0 });
  const incoming = [
    mkTransfer({ tx: 2, from: ZERO, to: Y, amount: 100, ts: T0 - 10 }),
    mkTransfer({ tx: 3, from: SANC, to: Y, amount: 100, ts: T0 - 20 }),
    mkTransfer({ tx: 4, from: EXCH, to: Y, amount: 100, ts: T0 - 30 }),
    mkTransfer({ tx: 5, from: MIXER, to: Y, amount: 100, ts: T0 - 40 }),
  ];
  const labels = () =>
    labelsOf(
      [
        { address: EXCH, name: "Acme Exchange", category: "exchange" },
        { address: MIXER, name: "Acme Mixer", category: "mixer" },
      ],
      [SANC],
    );
  const provider = () =>
    new FakeProvider({ transfers: [seed, ...incoming], txs: [mkTx(txHash(1), [seed])] });

  test("mint, sanctioned and entity stops, with details", async () => {
    const { out } = await run(params({ maxBranches: 10 }), provider(), { labels: labels() });
    const stop = (far: string) => {
      const e = edgeBy(out, (x) => x.far === far);
      return [e.status, e.stopReason, e.stopDetail];
    };
    expect(stop(ZERO)).toEqual(["stopped", "mint", null]);
    expect(stop(SANC)[1]).toBe("sanctioned");
    expect(stop(EXCH)).toEqual(["stopped", "entity", "Acme Exchange"]);
    expect(stop(MIXER)).toEqual(["stopped", "entity", "Acme Mixer"]);
    expect(out.stats.expandedEdges).toBe(1);
  });

  test("traceThroughEntities only stops at mixers; sanctioned still wins", async () => {
    const p = provider();
    const { out } = await run(params({ maxBranches: 10, traceThroughEntities: true }), p, {
      labels: labels(),
    });
    expect(edgeBy(out, (x) => x.far === EXCH).stopReason).toBe("no_candidates");
    expect(edgeBy(out, (x) => x.far === MIXER).stopReason).toBe("entity");
    expect(edgeBy(out, (x) => x.far === SANC).stopReason).toBe("sanctioned");
    expect(p.listCalls.map((c) => c.key)).toContain(EXCH);
  });

  test("depth limit stops edges at maxDepth", async () => {
    const { out } = await run(params({ maxDepth: 2 }), chainProvider(6));
    expect(out.edges.map((e) => e.depth)).toEqual([0, 1, 2]);
    expect(out.edges[2]).toMatchObject({ status: "stopped", stopReason: "max_depth" });
  });
});

describe("cycle detection is per path", () => {
  test("the same address reached through two branches is not a cycle", async () => {
    const A = addr(1);
    const [B1, B2, D, E] = [addr(2), addr(3), addr(4), addr(5)];
    const l1 = mkTransfer({ tx: 1, from: B1, to: A, amount: 100, ts: T0 });
    const l2 = mkTransfer({ tx: 1, from: B2, to: A, amount: 80, ts: T0 });
    const d1 = mkTransfer({ tx: 3, from: D, to: B1, amount: 100, ts: T0 - 100 });
    const d2 = mkTransfer({ tx: 4, from: D, to: B2, amount: 80, ts: T0 - 200 });
    const e1 = mkTransfer({ tx: 5, from: E, to: D, amount: 500, ts: T0 - 1000 });
    const provider = new FakeProvider({
      transfers: [l1, l2, d1, d2, e1],
      txs: [mkTx(txHash(1), [l1, l2])],
    });
    const { out } = await run(params(), provider);

    expect(out.edges.some((e) => e.stopReason === "cycle")).toBe(false);
    const viaD = byFar(out, D);
    expect(viaD).toHaveLength(2);
    expect(viaD.every((e) => e.status === "expanded")).toBe(true);
    expect(provider.listCalls.filter((c) => c.key === D)).toHaveLength(2);
  });

  test("two branches selecting the same transfer link instead of duplicating", async () => {
    const A = addr(1);
    const [B1, B2, D, E] = [addr(2), addr(3), addr(4), addr(5)];
    const l1 = mkTransfer({ tx: 1, from: B1, to: A, amount: 100, ts: T0 });
    const l2 = mkTransfer({ tx: 1, from: B2, to: A, amount: 80, ts: T0 });
    const d1 = mkTransfer({ tx: 3, from: D, to: B1, amount: 100, ts: T0 - 100 });
    const d2 = mkTransfer({ tx: 4, from: D, to: B2, amount: 80, ts: T0 - 200 });
    const e1 = mkTransfer({ tx: 5, from: E, to: D, amount: 500, ts: T0 - 1000 });
    const provider = new FakeProvider({
      transfers: [l1, l2, d1, d2, e1],
      txs: [mkTx(txHash(1), [l1, l2])],
    });
    const { out, log } = await run(params(), provider);

    const shared = out.edges.filter((e) => e.far === E);
    expect(shared).toHaveLength(1);
    const [viaB1, viaB2] = byFar(out, D);
    expect(shared[0]?.parents).toEqual([viaB1?.id as string, viaB2?.id as string]);
    expect(viaB1?.children).toEqual([shared[0]?.id as string]);
    expect(viaB2?.children).toEqual([shared[0]?.id as string]);
    expect(log.of("edge_linked")).toEqual([
      { type: "edge_linked", edgeId: shared[0]?.id as string, parentId: viaB2?.id as string },
    ]);
    expect(provider.listCalls.filter((c) => c.key === E)).toHaveLength(1);
    expect(new Set(out.edges.map((e) => e.id)).size).toBe(out.edges.length);
  });

  test("a genuine loop on one path is a cycle", async () => {
    const [A, B, C] = [addr(1), addr(2), addr(3)];
    const t1 = mkTransfer({ tx: 1, from: B, to: A, amount: 100, ts: T0 });
    const t2 = mkTransfer({ tx: 2, from: C, to: B, amount: 100, ts: T0 - 100 });
    const t3 = mkTransfer({ tx: 3, from: A, to: C, amount: 100, ts: T0 - 200 });
    const provider = new FakeProvider({ transfers: [t1, t2, t3], txs: [mkTx(txHash(1), [t1])] });
    const { out } = await run(params(), provider);
    expect(out.edges.map((e) => e.far)).toEqual([B, C, A]);
    expect(out.edges[2]).toMatchObject({ status: "stopped", stopReason: "cycle", depth: 2 });
  });
});

describe("swap-through", () => {
  const U = addr(1);
  const ROUTER = addr(40);
  const V = addr(41);

  function swapFixture() {
    const received = mkTransfer({ tx: 1, from: ROUTER, to: U, amount: 0.6, ts: T0, asset: WETH });
    const sent = mkTransfer({ tx: 1, from: U, to: ROUTER, amount: 1200, ts: T0, asset: USDT });
    const funding = mkTransfer({ tx: 2, from: V, to: U, amount: 1200, ts: T0 - 60, asset: USDT });
    const otherAsset = mkTransfer({
      tx: 3,
      from: addr(42),
      to: U,
      amount: 0.1,
      ts: T0 - 60,
      asset: WETH,
    });
    const provider = new FakeProvider({
      transfers: [received, sent, funding, otherAsset],
      bothDirections: true,
    });
    const prices = new FakePrices({ [assetId(USDT)]: 1, [assetId(WETH)]: 2000 });
    const labels = labelsOf([{ address: ROUTER, name: "Acme Router", category: "dex" }]);
    return { provider, prices, labels };
  }

  test("a DEX-labeled far continues through the swapper with the swapped-for asset", async () => {
    const { provider, prices, labels } = swapFixture();
    const { out } = await run(
      params({ seeds: [{ id: "s1", kind: "address", value: U }], maxBranches: 1 }),
      provider,
      { prices, labels },
    );

    const seedEdge = out.edges[0] as TraceEdge;
    expect(seedEdge).toMatchObject({ far: ROUTER, near: U, status: "expanded", stopReason: null });
    expect(seedEdge.swap?.amount).toBe(1200);
    expect(seedEdge.swap?.asset).toEqual(USDT);

    // The expansion listed the swapper (U), not the router.
    expect(provider.listCalls.map((c) => c.key)).toEqual([U, U, V]);
    const child = out.edges[1] as TraceEdge;
    expect(child.far).toBe(V);
    expect(child.transfer.asset).toEqual(USDT);
    expect(child.selection?.breakdown.amount).toBe(25);
    // The unrelated WETH inflow is skipped silently; only the same-tx row is recorded as a drop.
    expect(seedEdge.dropped.map((d) => d.reason)).toEqual(["same_tx"]);
  });

  test("without a swap the same DEX far stops as an entity", async () => {
    const received = mkTransfer({ tx: 1, from: ROUTER, to: U, amount: 0.5, ts: T0, asset: WETH });
    const provider = new FakeProvider({ transfers: [received], bothDirections: true });
    const { out } = await run(
      params({ seeds: [{ id: "s1", kind: "address", value: U }] }),
      provider,
      { labels: labelsOf([{ address: ROUTER, name: "Acme Router", category: "dex" }]) },
    );
    expect(out.edges[0]).toMatchObject({
      stopReason: "entity",
      stopDetail: "Acme Router",
      swap: null,
    });
  });

  test("tx seeds detect the swap from the tx's other transfers", async () => {
    const received = mkTransfer({ tx: 1, from: ROUTER, to: U, amount: 0.5, ts: T0, asset: WETH });
    const sent = mkTransfer({ tx: 1, from: U, to: ROUTER, amount: 1000, ts: T0, asset: USDT });
    const provider = new FakeProvider({
      transfers: [received, sent],
      txs: [mkTx(txHash(1), [received, sent])],
    });
    const { out } = await run(params({ maxDepth: 1 }), provider);
    expect(edgeBy(out, (e) => e.far === ROUTER).swap?.asset).toEqual(USDT);
    expect(edgeBy(out, (e) => e.far === U).swap?.asset).toEqual(WETH);
  });
});

describe("seeds", () => {
  test("address seed ranks by usd and keeps maxBranches", async () => {
    const S = addr(1);
    const rows = [
      mkTransfer({ tx: 1, from: addr(10), to: S, amount: 50, ts: T0 - 10 }),
      mkTransfer({ tx: 2, from: addr(11), to: S, amount: 900, ts: T0 - 500 }),
      mkTransfer({ tx: 3, from: addr(12), to: S, amount: 300, ts: T0 - 20 }),
      mkTransfer({ tx: 4, from: addr(13), to: S, amount: 300, ts: T0 - 10 }),
      mkTransfer({ tx: 5, from: addr(14), to: S, amount: 1, ts: T0, asset: FAKE_USDT }),
    ];
    const provider = new FakeProvider({ transfers: rows });
    const { out } = await run(
      params({ seeds: [{ id: "s1", kind: "address", value: S }], maxBranches: 3, maxDepth: 1 }),
      provider,
    );
    const seeds = out.edges.filter((e) => e.depth === 0);
    // 900 first, then the two 300s with the newest first.
    expect(seeds.map((e) => e.far)).toEqual([addr(11), addr(13), addr(12)]);
    expect(seeds.every((e) => e.seedId === "s1" && e.selection === null)).toBe(true);
    expect(provider.listCalls[0]?.window).toEqual({});
  });

  test("tx seed legs: at most 10, usd desc, zero-address legs excluded", async () => {
    const legs = Array.from({ length: 12 }, (_, i) =>
      mkTransfer({ tx: 1, from: addr(10 + i), to: addr(1), amount: 10 + i, ts: T0 }),
    );
    const mint = mkTransfer({ tx: 1, from: ZERO, to: addr(1), amount: 999, ts: T0 });
    const provider = new FakeProvider({ txs: [mkTx(txHash(1), [mint, ...legs])] });
    const { out } = await run(params({ maxDepth: 1 }), provider);
    const seeds = out.edges.filter((e) => e.depth === 0);
    expect(seeds).toHaveLength(10);
    expect(seeds.map((e) => e.transfer.amount)).toEqual([21, 20, 19, 18, 17, 16, 15, 14, 13, 12]);
  });

  test("a missing seed warns and the other seeds still run", async () => {
    const provider = chainProvider(2);
    const { out, log } = await run(
      params({
        seeds: [
          { id: "s1", kind: "tx", value: txHash(1) },
          { id: "s2", kind: "tx", value: txHash(999) },
        ],
      }),
      provider,
    );
    expect(out.status).toBe("completed");
    expect(out.warnings.map((w) => w.code)).toEqual(["seed_failed:s2"]);
    expect(log.of("warning").map((w) => w.code)).toEqual(["seed_failed:s2"]);
    expect(out.edges.length).toBeGreaterThan(0);
    expect(out.edges.every((e) => e.seedId === null || e.seedId === "s1")).toBe(true);
  });

  test("a provider_error on one seed warns and the run continues", async () => {
    const provider = new FakeProvider({
      ...chainProviderOpts(2),
      errors: { [txHash(2)]: new FotError("provider_error", "unexpected result shape") },
    });
    const { out } = await run(
      params({
        seeds: [
          { id: "s1", kind: "tx", value: txHash(1) },
          { id: "s2", kind: "tx", value: txHash(2) },
        ],
      }),
      provider,
    );
    expect(out.status).toBe("completed");
    expect(out.warnings.map((w) => w.code)).toEqual(["seed_failed:s2"]);
  });

  test("a failed tx counts as a seed failure; all seeds failed means failed", async () => {
    const provider = new FakeProvider({
      errors: { [txHash(1)]: new FotError("tx_failed", "reverted") },
      txs: [mkTx(txHash(1), [])],
    });
    const { out, log } = await run(params(), provider);
    expect(out.status).toBe("failed");
    expect(out.edges).toEqual([]);
    expect(out.warnings[0]?.code).toBe("seed_failed:s1");
    expect(log.of("error")[0]?.code).toBe("seeds_failed");
  });
});

describe("limits", () => {
  /** Ternary tree of incoming transfers four levels deep below addr(1). */
  function wideTree(over: FakeProviderOptions = {}): FakeProvider {
    const transfers: Transfer[] = [];
    let nextAddr = 2;
    let nextTx = 2;
    const grow = (parent: number, level: number, ts: number): void => {
      if (level > 4) return;
      for (let k = 0; k < 3; k++) {
        const child = nextAddr++;
        transfers.push(
          mkTransfer({
            tx: nextTx++,
            from: addr(child),
            to: addr(parent),
            amount: 100,
            ts: ts - 100,
          }),
        );
        grow(child, level + 1, ts - 100);
      }
    };
    const seed = mkTransfer({ tx: 1, from: addr(1), to: addr(1000), amount: 100, ts: T0 });
    grow(1, 1, T0);
    return new FakeProvider({
      transfers: [seed, ...transfers],
      txs: [mkTx(txHash(1), [seed])],
      ...over,
    });
  }

  test("maxEdges is exact with 4 expansions in flight", async () => {
    let inflight = 0;
    let peak = 0;
    const provider = wideTree({
      onCall: async (call) => {
        if (call.kind !== "list") return;
        inflight++;
        peak = Math.max(peak, inflight);
        await settle();
        inflight--;
      },
    });

    const { out } = await run(params({ maxEdges: 10 }), provider, { concurrency: 4 });
    expect(out.status).toBe("completed");
    expect(out.stats.expandedEdges).toBe(10);
    expect(provider.listCalls).toHaveLength(10);
    expect(peak).toBe(4);
    expect(out.edges.some((e) => e.stopReason === "max_edges")).toBe(true);
    expect(out.edges.filter((e) => e.status === "pending")).toEqual([]);
    expect(out.edges.filter((e) => e.status === "expanded")).toHaveLength(10);
  });

  test("maxDepth and maxEdges both stop edges without extra provider calls", async () => {
    const provider = wideTree();
    const { out } = await run(params({ maxDepth: 2, maxEdges: 3 }), provider, { concurrency: 1 });
    expect(out.stats.expandedEdges).toBe(3);
    expect(provider.listCalls).toHaveLength(3);
    expect(new Set(out.edges.filter((e) => e.stopReason).map((e) => e.stopReason))).toEqual(
      new Set(["max_depth", "max_edges"]),
    );
  });
});

describe("pause, cancel and failures", () => {
  test("pause stops new provider requests and resume continues", async () => {
    const controller = new RunController();
    const provider = chainProvider(6, {
      onCall: (call) => {
        if (call.kind === "list" && provider.calls.length === 2) controller.pause();
      },
    });
    let settled = false;
    const running = run(params(), provider, { controller, concurrency: 2 }).then((r) => {
      settled = true;
      return r;
    });

    await settle();
    const frozen = provider.calls.length;
    expect(controller.status).toBe("paused");
    expect(settled).toBe(false);
    await settle();
    expect(provider.calls.length).toBe(frozen);

    controller.resume();
    const { out } = await running;
    expect(out.status).toBe("completed");
    expect(provider.listCalls).toHaveLength(6);
    expect(out.edges.map((e) => e.depth)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  for (const [reason, status, stop] of [
    ["cancelled", "cancelled", "cancelled"],
    ["timeout", "timed_out", "timeout"],
  ] as const) {
    test(`${reason} marks pending and in-flight edges ${stop}`, async () => {
      const controller = new RunController();
      const tree = Array.from({ length: 3 }, (_, i) =>
        mkTransfer({ tx: 10 + i, from: addr(20 + i), to: addr(2), amount: 100, ts: T0 - 10 - i }),
      );
      const seed = mkTransfer({ tx: 1, from: addr(2), to: addr(1), amount: 100, ts: T0 });
      const provider = new FakeProvider({
        transfers: [seed, ...tree],
        txs: [mkTx(txHash(1), [seed])],
        onCall: (call) => {
          if (call.kind === "list" && call.key === addr(2)) return;
          if (call.kind === "list") controller.cancel(reason);
        },
      });
      const { out } = await run(params(), provider, { controller, concurrency: 1 });
      expect(out.status).toBe(status);
      expect(out.edges.filter((e) => e.status === "pending")).toEqual([]);
      const cancelled = out.edges.filter((e) => e.stopReason === stop);
      expect(cancelled.length).toBeGreaterThanOrEqual(2);
      // The first expansion succeeded and keeps its children.
      expect(out.edges[0]?.status).toBe("expanded");
    });
  }

  test("a fatal provider error fails the run and stops everything else", async () => {
    const A = addr(1);
    const l1 = mkTransfer({ tx: 1, from: addr(2), to: A, amount: 100, ts: T0 });
    const l2 = mkTransfer({ tx: 1, from: addr(3), to: A, amount: 90, ts: T0 });
    const provider = new FakeProvider({
      transfers: [l1, l2],
      txs: [mkTx(txHash(1), [l1, l2])],
      errors: {
        [addr(2)]: new FotError("chain_requires_paid_plan", "Free API access is not supported", {
          fatal: true,
        }),
      },
    });
    const { out, log } = await run(params(), provider, { concurrency: 1 });
    expect(out.status).toBe("failed");
    expect(log.of("error")).toEqual([
      {
        type: "error",
        code: "chain_requires_paid_plan",
        message: "Free API access is not supported",
      },
    ]);
    expect(out.edges.map((e) => [e.status, e.stopReason, e.stopDetail])).toEqual([
      ["stopped", "fetch_failed", "chain_requires_paid_plan"],
      ["stopped", "fetch_failed", "chain_requires_paid_plan"],
    ]);
    expect(provider.listCalls).toHaveLength(1);
  });

  test("a non-fatal provider error stops one edge and the run continues", async () => {
    const A = addr(1);
    const l1 = mkTransfer({ tx: 1, from: addr(2), to: A, amount: 100, ts: T0 });
    const l2 = mkTransfer({ tx: 1, from: addr(3), to: A, amount: 90, ts: T0 });
    const next = mkTransfer({ tx: 2, from: addr(4), to: addr(3), amount: 90, ts: T0 - 10 });
    const provider = new FakeProvider({
      transfers: [l1, l2, next],
      txs: [mkTx(txHash(1), [l1, l2])],
      errors: { [addr(2)]: new FotError("provider_error", "boom") },
    });
    const { out } = await run(params(), provider);
    expect(out.status).toBe("completed");
    expect(edgeBy(out, (e) => e.far === addr(2))).toMatchObject({
      stopReason: "fetch_failed",
      stopDetail: "provider_error",
    });
    expect(edgeBy(out, (e) => e.far === addr(4)).depth).toBe(1);
  });
});

describe("continueFrom", () => {
  test("re-expands a max_depth edge with a relative depth budget and appends edges", async () => {
    const provider = chainProvider(8);
    const first = await run(params({ maxDepth: 2 }), provider);
    const target = first.out.edges[2] as TraceEdge;
    expect(target).toMatchObject({ depth: 2, stopReason: "max_depth" });
    const before = structuredClone(first.out.edges);

    const second = await run(params({ maxDepth: 2 }), chainProvider(8), {
      continueFrom: {
        edges: first.out.edges,
        edgeId: target.id,
        maxDepth: 2,
        throughEntities: false,
      },
    });

    expect(second.out.status).toBe("completed");
    // The caller's edges are not mutated; the output starts with the previous edges.
    expect(first.out.edges).toEqual(before);
    expect(second.out.edges.slice(0, 3).map((e) => e.id)).toEqual(before.map((e) => e.id));
    expect(second.out.edges.map((e) => e.depth)).toEqual([0, 1, 2, 3, 4]);
    expect(second.out.edges[2]).toMatchObject({ status: "expanded", stopReason: null });
    expect(second.out.edges[2]?.children).toEqual([second.out.edges[3]?.id as string]);
    expect(second.out.edges[4]).toMatchObject({ stopReason: "max_depth" });
    // Only expansions of this call are counted.
    expect(second.out.stats.expandedEdges).toBe(2);
    expect(second.log.of("edge_added")).toHaveLength(2);
  });

  test("an entity-stopped edge can be traced through for that edge only", async () => {
    const [A, X, Y, Z] = [addr(1), addr(2), addr(3), addr(4)];
    const t1 = mkTransfer({ tx: 1, from: X, to: A, amount: 100, ts: T0 });
    const t2 = mkTransfer({ tx: 2, from: Y, to: X, amount: 100, ts: T0 - 100 });
    const t3 = mkTransfer({ tx: 3, from: Z, to: Y, amount: 100, ts: T0 - 200 });
    const make = () => new FakeProvider({ transfers: [t1, t2, t3], txs: [mkTx(txHash(1), [t1])] });
    const labels = labelsOf([
      { address: X, name: "Acme Exchange", category: "exchange" },
      { address: Z, name: "Other Exchange", category: "exchange" },
    ]);

    const first = await run(params(), make(), { labels });
    expect(first.out.edges).toHaveLength(1);
    expect(first.out.edges[0]).toMatchObject({ stopReason: "entity", stopDetail: "Acme Exchange" });

    const second = await run(params(), make(), {
      labels,
      continueFrom: {
        edges: first.out.edges,
        edgeId: first.out.edges[0]?.id as string,
        maxDepth: 5,
        throughEntities: true,
      },
    });
    expect(second.out.edges.map((e) => [e.far, e.stopReason])).toEqual([
      [X, null],
      [Y, null],
      [Z, "entity"],
    ]);
    expect(second.out.edges[0]?.status).toBe("expanded");
  });

  test("the path of the continued edge is rebuilt so loops are still caught", async () => {
    const [A, B, C] = [addr(1), addr(2), addr(3)];
    const t1 = mkTransfer({ tx: 1, from: B, to: A, amount: 100, ts: T0 });
    const t2 = mkTransfer({ tx: 2, from: C, to: B, amount: 100, ts: T0 - 100 });
    const t3 = mkTransfer({ tx: 3, from: A, to: C, amount: 100, ts: T0 - 200 });
    const make = () => new FakeProvider({ transfers: [t1, t2, t3], txs: [mkTx(txHash(1), [t1])] });
    const first = await run(params({ maxDepth: 1 }), make());
    expect(first.out.edges.map((e) => e.stopReason)).toEqual([null, "max_depth"]);

    const second = await run(params({ maxDepth: 1 }), make(), {
      continueFrom: {
        edges: first.out.edges,
        edgeId: first.out.edges[1]?.id as string,
        maxDepth: 3,
        throughEntities: false,
      },
    });
    expect(second.out.edges.map((e) => [e.far, e.stopReason])).toEqual([
      [B, null],
      [C, null],
      [A, "cycle"],
    ]);
  });
});

describe("asset scoring", () => {
  test("USDC and USDT are different assets for scoring", async () => {
    const seed = mkTransfer({ tx: 1, from: addr(2), to: addr(1), amount: 100, ts: T0 });
    const same = mkTransfer({ tx: 2, from: addr(10), to: addr(2), amount: 100, ts: T0 - 10 });
    const other = mkTransfer({
      tx: 3,
      from: addr(11),
      to: addr(2),
      amount: 100,
      ts: T0 - 10,
      asset: USDC,
    });
    const provider = new FakeProvider({
      transfers: [seed, same, other],
      txs: [mkTx(txHash(1), [seed])],
    });
    const { out } = await run(params({ maxBranches: 2, maxDepth: 1 }), provider);
    const kids = out.edges.filter((e) => e.depth === 1);
    expect(kids.map((e) => e.far)).toEqual([addr(10), addr(11)]);
    expect(kids.map((e) => e.selection?.breakdown.asset)).toEqual([50, 0]);
    // Different asset: amounts compared through usd (both 100).
    expect(kids[1]?.selection?.breakdown.amount).toBe(25);
  });
});
