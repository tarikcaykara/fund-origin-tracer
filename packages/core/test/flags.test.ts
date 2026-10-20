import { describe, expect, test } from "bun:test";
import { FLAG_IDS, loadPolicy, parsePolicyFile } from "../src/policy/policy.ts";
import type { AnalysisResult, TraceEdge } from "../src/schema.ts";
import {
  addr,
  buildEdges,
  type EdgeSpec,
  FAKE_USDT,
  flagIds,
  type LabelSpec,
  runAnalysis,
  type Scenario,
  T0,
  transferRow,
  USDC,
} from "./helpers/analysis-fixtures.ts";

const DAY = 86_400;

async function flags(specs: EdgeSpec[], scenario: Scenario = {}): Promise<string[]> {
  const edges = buildEdges(specs, scenario.direction ?? "backward");
  return flagIds(await runAnalysis(edges, scenario));
}

/** `n` unrelated roots, each from a distinct far address. */
function roots(n: number, extra: Partial<EdgeSpec> = {}, nearAddr = addr(1)): EdgeSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    near: nearAddr,
    far: addr(100 + i),
    seedId: "s1",
    ...extra,
  }));
}

/** Linear chain r0 -> r1 -> ... with explicit amounts; far addresses given by `fars`. */
function chain(fars: number[], amounts: number[], extra: Partial<EdgeSpec> = {}): EdgeSpec[] {
  return fars.map((far, i) => ({
    id: `c${i}`,
    near: i === 0 ? addr(1) : addr(fars[i - 1] as number),
    far: addr(far),
    depth: i,
    amount: amounts[i] ?? 100,
    ...(i === 0 ? { seedId: "s1" } : { parents: [`c${i - 1}`] }),
    ...extra,
  }));
}

describe("flag: sanctioned_exposure", () => {
  test("fires for an OFAC address with evidence, not otherwise", async () => {
    const edges = buildEdges(roots(2));
    const hit = await runAnalysis(edges, { ofac: [addr(100)] });
    const flag = hit.flags.find((f) => f.id === "sanctioned_exposure");
    expect(flag).toMatchObject({ severity: "high" });
    expect(flag?.evidence).toEqual({ addresses: [addr(100)], edgeIds: ["r0"] });
    expect(flag?.detail).toContain("1 sanctioned address");
    expect(hit.riskLevel).toBe("high");
    expect(flagIds(await runAnalysis(edges))).not.toContain("sanctioned_exposure");
  });
});

describe("flags: mixer and scam exposure", () => {
  for (const category of ["mixer", "scam"] as const) {
    const label = (n: number): LabelSpec => ({
      address: addr(n),
      name: `${category} ${n}`,
      category,
    });

    test(`${category}: direct at hop 1, indirect beyond`, async () => {
      const direct = await flags(roots(1), { labels: [label(100)] });
      expect(direct).toContain(`${category}_direct`);
      expect(direct).not.toContain(`${category}_indirect`);

      const indirect = await flags(chain([2, 100], [100, 100]), { labels: [label(100)] });
      expect(indirect).toContain(`${category}_indirect`);
      expect(indirect).not.toContain(`${category}_direct`);
    });

    test(`${category}: directHops moves the boundary`, async () => {
      const policy = {
        version: 1,
        flags: {
          [`${category}_direct`]: { directHops: 2 },
          [`${category}_indirect`]: { directHops: 2 },
        },
      };
      const atTwo = await flags(chain([2, 100], [100, 100]), { labels: [label(100)], policy });
      expect(atTwo).toContain(`${category}_direct`);
      expect(atTwo).not.toContain(`${category}_indirect`);
      const atThree = await flags(chain([2, 3, 100], [100, 100, 100]), {
        labels: [label(100)],
        policy,
      });
      expect(atThree).toContain(`${category}_indirect`);
      expect(atThree).not.toContain(`${category}_direct`);
    });

    test(`${category}: unlabeled graph raises neither`, async () => {
      const ids = await flags(roots(2));
      expect(ids).not.toContain(`${category}_direct`);
      expect(ids).not.toContain(`${category}_indirect`);
    });
  }

  test("severities and wording", async () => {
    const result = await runAnalysis(buildEdges(chain([2, 100], [100, 100])), {
      labels: [{ address: addr(100), name: "Tornado", category: "mixer", entity: "Tornado Cash" }],
    });
    const f = result.flags.find((x) => x.id === "mixer_indirect");
    expect(f?.severity).toBe("medium");
    expect(f?.detail).toContain("Tornado Cash");
    expect(f?.detail).toContain("2 hops");
  });
});

describe("flags: common source", () => {
  test("across seeds only: one edge reached by two seeds", async () => {
    const specs: EdgeSpec[] = [
      { id: "a", near: addr(1), far: addr(2), seedId: "s1" },
      { id: "b", near: addr(3), far: addr(4), seedId: "s2" },
      { id: "x", near: addr(2), far: addr(50), parents: ["a", "b"] },
    ];
    const ids = await flags(specs, { seedIds: ["s1", "s2"] });
    expect(ids).toContain("common_source_across_seeds");
    expect(ids).not.toContain("common_source_within_trace");
  });

  test("within trace only: two nears, one seed", async () => {
    const specs: EdgeSpec[] = [
      { id: "a", near: addr(1), far: addr(2), seedId: "s1" },
      { id: "b", near: addr(1), far: addr(3), seedId: "s1" },
      { id: "c", near: addr(2), far: addr(9), parents: ["a"] },
      { id: "d", near: addr(3), far: addr(9), parents: ["b"] },
    ];
    const ids = await flags(specs);
    expect(ids).toContain("common_source_within_trace");
    expect(ids).not.toContain("common_source_across_seeds");
  });

  test("a far address seen once raises neither", async () => {
    const ids = await flags(roots(3));
    expect(ids).not.toContain("common_source_within_trace");
    expect(ids).not.toContain("common_source_across_seeds");
  });

  test("forward wording uses destination", async () => {
    const edges = buildEdges(
      [
        { id: "a", near: addr(1), far: addr(2), seedId: "s1" },
        { id: "b", near: addr(3), far: addr(2), seedId: "s1" },
      ],
      "forward",
    );
    const r = await runAnalysis(edges, { direction: "forward" });
    expect(r.flags.find((f) => f.id === "common_source_within_trace")?.title).toContain(
      "destination",
    );
  });
});

describe("flag: cycle", () => {
  test("fires on a cycle stop only", async () => {
    expect(
      await flags([{ id: "a", near: addr(1), far: addr(2), seedId: "s1", stop: "cycle" }]),
    ).toContain("cycle");
    expect(
      await flags([{ id: "a", near: addr(1), far: addr(2), seedId: "s1", stop: "max_depth" }]),
    ).not.toContain("cycle");
  });
});

describe("flag: funnel", () => {
  const spaced = (n: number, spanSec: number): EdgeSpec[] =>
    roots(n).map((s, i) => ({ ...s, ts: T0 + Math.round((i * spanSec) / Math.max(1, n - 1)) }));

  test("fires at exactly minSenders within exactly windowSec", async () => {
    expect(await flags(spaced(4, DAY))).toContain("funnel");
  });
  test("does not fire one second outside the window", async () => {
    expect(await flags(spaced(4, DAY + 1))).not.toContain("funnel");
  });
  test("does not fire below minSenders", async () => {
    expect(await flags(spaced(3, 60))).not.toContain("funnel");
  });
  test("repeat senders do not count twice", async () => {
    const specs = roots(4).map((s, i) => ({ ...s, far: addr(100 + (i % 3)) }));
    expect(await flags(specs)).not.toContain("funnel");
  });
  test("finds a dense window inside a longer spread", async () => {
    const specs = roots(6).map((s, i) => ({ ...s, ts: T0 + (i < 4 ? i * 10 : i * 10 * DAY) }));
    expect(await flags(specs)).toContain("funnel");
  });
  test("spread-out senders never share a window", async () => {
    const specs = roots(4).map((s, i) => ({ ...s, ts: T0 + i * (DAY / 2 + 1) }));
    expect(await flags(specs)).not.toContain("funnel");
  });
  test("policy params change the thresholds; detail has the numbers", async () => {
    const policy = { version: 1, flags: { funnel: { minSenders: 3, windowSec: 120 } } };
    const edges = buildEdges(spaced(3, 100));
    const r = await runAnalysis(edges, { policy });
    const f = r.flags.find((x) => x.id === "funnel");
    expect(f?.detail).toContain("3 distinct");
    expect(f?.evidence.edgeIds).toHaveLength(3);
  });
});

describe("flag: round_trip", () => {
  test("address returns with an amount within tolerance (boundary inclusive)", async () => {
    // Address 1 is the seed subject (amount 100) and reappears 3 hops later.
    const back = chain([2, 3, 1], [100, 100, 103]);
    expect(await flags(back)).toContain("round_trip");
  });
  test("outside tolerance does not fire", async () => {
    expect(await flags(chain([2, 3, 1], [100, 100, 103.1]))).not.toContain("round_trip");
  });
  test("tolerance is policy-driven", async () => {
    const policy = { version: 1, flags: { round_trip: { tolerance: 0.1 } } };
    expect(await flags(chain([2, 3, 1], [100, 100, 103.1]), { policy })).toContain("round_trip");
  });
  test("detects a loop in the middle of a path, with the loop edges as evidence", async () => {
    const edges = buildEdges(chain([2, 3, 4, 3], [100, 50, 50, 51]));
    const r = await runAnalysis(edges);
    const f = r.flags.find((x) => x.id === "round_trip");
    expect(f?.evidence.addresses).toEqual([addr(3)]);
    expect(f?.evidence.edgeIds).toEqual(["c1", "c2", "c3"]);
  });
  test("a different asset on the way back is not a round trip", async () => {
    const specs = chain([2, 3, 1], [100, 100, 100]).map((s, i) =>
      i === 2 ? { ...s, asset: USDC } : s,
    );
    expect(await flags(specs)).not.toContain("round_trip");
  });
  test("the same address on two different branches is not a round trip", async () => {
    const specs: EdgeSpec[] = [
      { id: "r", near: addr(1), far: addr(2), seedId: "s1", amount: 100 },
      { id: "x", near: addr(2), far: addr(5), parents: ["r"], amount: 100, depth: 1 },
      { id: "y", near: addr(2), far: addr(6), parents: ["r"], amount: 100, depth: 1 },
      { id: "x2", near: addr(5), far: addr(7), parents: ["x"], amount: 100, depth: 2 },
      { id: "y2", near: addr(6), far: addr(7), parents: ["y"], amount: 100, depth: 2 },
    ];
    expect(await flags(specs)).not.toContain("round_trip");
  });
  test("a returning amount far from the origin amount does not fire", async () => {
    expect(await flags(chain([2, 3, 1], [100, 100, 50]))).not.toContain("round_trip");
  });
});

describe("flag: structuring", () => {
  const smalls = (n: number, usd: number): EdgeSpec[] => roots(n, { amount: usd });

  test("fires at minAddresses small one-off addresses, not below", async () => {
    expect(await flags(smalls(5, 50))).toContain("structuring");
    expect(await flags(smalls(4, 50))).not.toContain("structuring");
  });
  test("maxUsd boundary is exclusive", async () => {
    expect(await flags(smalls(5, 99.99))).toContain("structuring");
    expect(await flags(smalls(5, 100))).not.toContain("structuring");
  });
  test("addresses with several transfers, unpriced edges and labeled addresses do not count", async () => {
    const withRepeat = [
      ...smalls(4, 50),
      { id: "dup1", near: addr(1), far: addr(300), amount: 10 },
      { id: "dup2", near: addr(1), far: addr(300), amount: 10 },
    ];
    expect(await flags(withRepeat)).not.toContain("structuring");
    expect(await flags(roots(5, { usd: null }))).not.toContain("structuring");
    expect(
      await flags(smalls(5, 50), {
        labels: [{ address: addr(100), name: "Known", category: "other" }],
      }),
    ).not.toContain("structuring");
  });
});

describe("flag: long_chain", () => {
  test("fires when depth reaches `hops` without labeled exposure", async () => {
    expect(await flags(chain([2, 3, 4, 5, 6], [], {}))).toContain("long_chain");
    expect(await flags(chain([2, 3, 4, 5], [], {}))).not.toContain("long_chain");
  });
  test("labeled exposure within the hop limit suppresses it; beyond it does not", async () => {
    const dex: LabelSpec = { address: addr(4), name: "Router", category: "dex" };
    expect(await flags(chain([2, 3, 4, 5, 6], []), { labels: [dex] })).not.toContain("long_chain");
    const late: LabelSpec = { address: addr(7), name: "Router", category: "dex" };
    expect(await flags(chain([2, 3, 4, 5, 6, 7], []), { labels: [late] })).toContain("long_chain");
  });
});

describe("flag: unresolved_majority", () => {
  const split = (unresolvedUsd: number, resolvedUsd: number): EdgeSpec[] => [
    {
      id: "u",
      near: addr(1),
      far: addr(2),
      seedId: "s1",
      amount: unresolvedUsd,
      stop: "no_candidates",
    },
    { id: "l", near: addr(1), far: addr(3), seedId: "s1", amount: resolvedUsd, stop: "entity" },
  ];
  const exchange: LabelSpec = { address: addr(3), name: "Kraken", category: "exchange" };

  test("fires strictly above the share", async () => {
    expect(await flags(split(51, 49), { labels: [exchange] })).toContain("unresolved_majority");
  });
  test("exactly at the share does not fire", async () => {
    expect(await flags(split(50, 50), { labels: [exchange] })).not.toContain("unresolved_majority");
  });
  test("no terminal value, no flag", async () => {
    expect(await flags(roots(1, { usd: null, stop: "no_candidates" }))).not.toContain(
      "unresolved_majority",
    );
  });
});

describe("flag: exchange_origin", () => {
  const binance: LabelSpec = {
    address: addr(2),
    name: "Binance",
    category: "exchange",
    entity: "Binance",
  };
  test("fires for backward origins only", async () => {
    expect(await flags(roots(1, { far: addr(2) }), { labels: [binance] })).toContain(
      "exchange_origin",
    );
    expect(
      await flags(roots(1, { far: addr(2) }), { labels: [binance], direction: "forward" }),
    ).not.toContain("exchange_origin");
  });
});

describe("flag: spoofed_tokens_ignored", () => {
  const dropped = (reason: "spoofed_token" | "zero_value"): TraceEdge["dropped"] => [
    {
      transfer: transferRow({ tx: "t", from: addr(9), to: addr(1), amount: 1, asset: FAKE_USDT }),
      usd: null,
      reason,
      score: null,
    },
  ];
  test("fires when a spoofed token was dropped, with the contract as evidence", async () => {
    const edges = buildEdges([
      { id: "a", near: addr(1), far: addr(2), seedId: "s1", dropped: dropped("spoofed_token") },
    ]);
    const r = await runAnalysis(edges);
    const f = r.flags.find((x) => x.id === "spoofed_tokens_ignored");
    expect(f).toMatchObject({ severity: "info" });
    expect(f?.evidence).toEqual({
      addresses: [FAKE_USDT.kind === "token" ? FAKE_USDT.contract : ""],
      edgeIds: ["a"],
    });
  });
  test("other drop reasons do not", async () => {
    expect(
      await flags([
        { id: "a", near: addr(1), far: addr(2), seedId: "s1", dropped: dropped("zero_value") },
      ]),
    ).not.toContain("spoofed_tokens_ignored");
  });
});

describe("flag: incomplete_trace", () => {
  const one: EdgeSpec[] = [{ id: "a", near: addr(1), far: addr(2), seedId: "s1" }];
  test("non-completed status and fetch failures fire it; a clean run does not", async () => {
    expect(await flags(one, { status: "cancelled" })).toContain("incomplete_trace");
    expect(await flags(one, { status: "timed_out" })).toContain("incomplete_trace");
    expect(
      await flags([{ ...one[0], id: "a", near: addr(1), far: addr(2), stop: "fetch_failed" }]),
    ).toContain("incomplete_trace");
    expect(await flags(one)).not.toContain("incomplete_trace");
  });
});

describe("policy", () => {
  const mixerDirect: EdgeSpec[] = roots(1);
  const mixerLabel: LabelSpec = { address: addr(100), name: "Tornado", category: "mixer" };

  test("severity off removes the flag", async () => {
    const policy = { version: 1, flags: { mixer_direct: { severity: "off" } } };
    const on = await runAnalysis(buildEdges(mixerDirect), { labels: [mixerLabel] });
    const off = await runAnalysis(buildEdges(mixerDirect), { labels: [mixerLabel], policy });
    expect(flagIds(on)).toContain("mixer_direct");
    expect(flagIds(off)).not.toContain("mixer_direct");
    expect(off.policy).toEqual({ version: 1, overridden: true });
  });

  test("severity overrides drive the risk level", async () => {
    const edges = () =>
      buildEdges([
        { id: "a", near: addr(1), far: addr(2), seedId: "s1" },
        { id: "b", near: addr(1), far: addr(3), seedId: "s1" },
        { id: "c", near: addr(2), far: addr(9), parents: ["a"] },
        { id: "d", near: addr(3), far: addr(9), parents: ["b"] },
      ]);
    const base = await runAnalysis(edges());
    expect(base.riskLevel).toBe("low");
    const raised = await runAnalysis(edges(), {
      policy: { version: 1, flags: { common_source_within_trace: { severity: "high" } } },
    });
    expect(raised.riskLevel).toBe("high");
    expect(raised.flags.find((f) => f.id === "common_source_within_trace")?.severity).toBe("high");
  });

  test("risk level mapping: info/low -> low, medium -> medium, any high -> high", async () => {
    const level = async (
      specs: EdgeSpec[],
      s: Scenario = {},
    ): Promise<AnalysisResult["riskLevel"]> => (await runAnalysis(buildEdges(specs), s)).riskLevel;
    const exchange: LabelSpec = { address: addr(2), name: "Binance", category: "exchange" };
    expect(await level([{ id: "a", near: addr(1), far: addr(9), seedId: "s1" }])).toBe("low");
    // info only
    expect(await level(roots(1, { far: addr(2) }), { labels: [exchange] })).toBe("low");
    // low only (structuring)
    const spread = roots(5, { amount: 10 }).map((s, i) => ({ ...s, ts: T0 + i * 2 * DAY }));
    const small = await runAnalysis(buildEdges(spread));
    expect(small.flags.map((f) => f.id)).toContain("structuring");
    expect(small.flags.every((f) => f.severity === "low")).toBe(true);
    expect(small.riskLevel).toBe("low");
    // medium (cycle)
    expect(
      await level([{ id: "a", near: addr(1), far: addr(2), seedId: "s1", stop: "cycle" }]),
    ).toBe("medium");
    // high wins over medium
    expect(
      await level([{ id: "a", near: addr(1), far: addr(2), seedId: "s1", stop: "cycle" }], {
        ofac: [addr(2)],
      }),
    ).toBe("high");
  });

  test("flags are sorted by severity, then id", async () => {
    const edges = buildEdges([
      { id: "a", near: addr(1), far: addr(2), seedId: "s1", stop: "cycle" },
      { id: "b", near: addr(1), far: addr(3), seedId: "s1" },
    ]);
    const r = await runAnalysis(edges, {
      ofac: [addr(2)],
      labels: [{ address: addr(3), name: "Binance", category: "exchange" }],
    });
    expect(r.flags.map((f) => `${f.severity}:${f.id}`)).toEqual([
      "high:sanctioned_exposure",
      "medium:cycle",
      "info:exchange_origin",
    ]);
  });

  test("every flag has a title, a numeric detail and evidence arrays", async () => {
    const r = await runAnalysis(
      buildEdges([{ id: "a", near: addr(1), far: addr(2), seedId: "s1", stop: "cycle" }]),
      {
        ofac: [addr(2)],
      },
    );
    for (const f of r.flags) {
      expect(f.title.length).toBeGreaterThan(0);
      expect(f.detail).toMatch(/\d/);
      expect(Array.isArray(f.evidence.addresses)).toBe(true);
      expect(Array.isArray(f.evidence.edgeIds)).toBe(true);
    }
  });

  describe("policy files", () => {
    test("defaults cover all 16 flags with the planned parameters", () => {
      const p = loadPolicy(null);
      expect(FLAG_IDS).toHaveLength(16);
      expect(p).toMatchObject({ version: 1, overridden: false });
      expect(p.flags.funnel).toEqual({ severity: "medium", minSenders: 4, windowSec: 86400 });
      expect(p.flags.round_trip.tolerance).toBe(0.03);
      expect(p.flags.structuring).toEqual({ severity: "low", minAddresses: 5, maxUsd: 100 });
      expect(p.flags.long_chain.hops).toBe(5);
      expect(p.flags.unresolved_majority.share).toBe(0.5);
      expect(p.flags.mixer_direct.directHops).toBe(1);
    });

    test("override merges per setting onto the defaults", () => {
      const p = loadPolicy({
        version: 1,
        flags: { funnel: { minSenders: 6 }, cycle: { severity: "off" } },
      });
      expect(p.overridden).toBe(true);
      expect(p.flags.funnel).toEqual({ severity: "medium", minSenders: 6, windowSec: 86400 });
      expect(p.flags.cycle.severity).toBe("off");
      expect(p.flags.round_trip.tolerance).toBe(0.03);
    });

    test("an unknown flag id is rejected and named", () => {
      expect(() =>
        parsePolicyFile({ version: 1, flags: { not_a_flag: { severity: "high" } } }),
      ).toThrow(/flags.*not_a_flag/);
      expect(() => loadPolicy({ version: 1, flags: { not_a_flag: { severity: "high" } } })).toThrow(
        /not_a_flag/,
      );
    });

    test("bad severity, unknown setting and bad version name the path", () => {
      expect(() =>
        parsePolicyFile({ version: 1, flags: { cycle: { severity: "critical" } } }),
      ).toThrow(/flags\.cycle\.severity/);
      expect(() => parsePolicyFile({ version: 1, flags: { cycle: { bogus: 1 } } })).toThrow(
        /flags\.cycle.*bogus/,
      );
      expect(() => parsePolicyFile({ version: 1, flags: { funnel: { minSenders: 0 } } })).toThrow(
        /flags\.funnel\.minSenders/,
      );
      expect(() => parsePolicyFile({ version: 2 })).toThrow(/version/);
    });
  });
});
