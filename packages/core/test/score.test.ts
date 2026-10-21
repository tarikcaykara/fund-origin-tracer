import { describe, expect, test } from "bun:test";
import {
  amountPoints,
  compareScored,
  dropReason,
  dustPoints,
  scoreCandidate,
  timePoints,
} from "../src/engine/score.ts";
import { addr, FAKE_USDT, mkTransfer, NATIVE_ETH, T0, USDC, USDT, WETH } from "./helpers/fakes.ts";

describe("amountPoints", () => {
  test("tier boundaries are strict upper bounds", () => {
    expect(amountPoints(0)).toBe(25);
    expect(amountPoints(0.99e-4)).toBe(25);
    expect(amountPoints(1e-4)).toBe(18);
    expect(amountPoints(0.0099)).toBe(18);
    expect(amountPoints(0.01)).toBe(12);
    expect(amountPoints(0.0499)).toBe(12);
    expect(amountPoints(0.05)).toBe(6);
    expect(amountPoints(0.0999)).toBe(6);
    expect(amountPoints(0.1)).toBe(2);
    expect(amountPoints(0.4999)).toBe(2);
    expect(amountPoints(0.5)).toBe(0);
    expect(amountPoints(10)).toBe(0);
  });
});

describe("timePoints", () => {
  test("tier boundaries on absolute difference", () => {
    expect(timePoints(0)).toBe(30);
    expect(timePoints(59)).toBe(30);
    expect(timePoints(-59)).toBe(30);
    expect(timePoints(60)).toBe(22);
    expect(timePoints(299)).toBe(22);
    expect(timePoints(300)).toBe(15);
    expect(timePoints(3599)).toBe(15);
    expect(timePoints(3600)).toBe(7);
    expect(timePoints(86399)).toBe(7);
    expect(timePoints(86400)).toBe(2);
    expect(timePoints(604799)).toBe(2);
    expect(timePoints(604800)).toBe(0);
    expect(timePoints(-604800)).toBe(0);
  });
});

describe("dustPoints", () => {
  test("usd decides when priced, units otherwise", () => {
    expect(dustPoints(0.99, 1_000_000)).toBe(-10);
    expect(dustPoints(1, 0)).toBe(0);
    expect(dustPoints(null, 0.0009)).toBe(-10);
    expect(dustPoints(null, 0.001)).toBe(0);
  });
});

describe("scoreCandidate", () => {
  const ref = { asset: USDT, amount: 100, usd: 100, timestamp: T0 };

  test("same asset, near-identical amount, same second adds up to the maximum", () => {
    const c = mkTransfer({ tx: 2, from: addr(2), to: addr(1), amount: 100, ts: T0 - 10 });
    expect(scoreCandidate(ref, c, 100)).toEqual({
      score: 105,
      breakdown: { asset: 50, amount: 25, time: 30, dust: 0 },
    });
  });

  test("different asset: no asset points; amount compared via usd when both known", () => {
    const c = mkTransfer({
      tx: 2,
      from: addr(2),
      to: addr(1),
      amount: 0.05,
      ts: T0 - 70,
      asset: WETH,
    });
    const s = scoreCandidate(ref, c, 99.5);
    expect(s.breakdown).toEqual({ asset: 0, amount: 18, time: 22, dust: 0 });
    expect(scoreCandidate(ref, c, null).breakdown.amount).toBe(0);
    expect(scoreCandidate({ ...ref, usd: null }, c, 99.5).breakdown.amount).toBe(0);
  });

  test("dust is penalised and unpriced amounts fall back to units", () => {
    const c = mkTransfer({
      tx: 2,
      from: addr(2),
      to: addr(1),
      amount: 0.5,
      ts: T0 - 4000,
      asset: NATIVE_ETH,
    });
    expect(scoreCandidate(ref, c, 0.5).breakdown.dust).toBe(-10);
    expect(scoreCandidate(ref, c, null).breakdown.dust).toBe(0);
    expect(scoreCandidate(ref, { ...c, amount: 0.0005 }, null).breakdown.dust).toBe(-10);
  });

  test("candidates after the edge are scored on absolute distance", () => {
    const c = mkTransfer({ tx: 2, from: addr(2), to: addr(1), amount: 100, ts: T0 + 3 });
    expect(scoreCandidate(ref, c, 100).breakdown.time).toBe(30);
  });
});

describe("compareScored", () => {
  test("score desc, then time distance asc", () => {
    const near = mkTransfer({ tx: 2, from: addr(2), to: addr(1), amount: 1, ts: T0 - 10 });
    const far = mkTransfer({ tx: 3, from: addr(3), to: addr(1), amount: 1, ts: T0 - 900 });
    const rows = [
      { score: 50, transfer: far },
      { score: 50, transfer: near },
      { score: 70, transfer: far },
    ];
    rows.sort((a, b) => compareScored(a, b, T0));
    expect(rows.map((r) => [r.score, r.transfer.txHash === near.txHash])).toEqual([
      [70, false],
      [50, true],
      [50, false],
    ]);
  });
});

describe("dropReason", () => {
  const base = {
    direction: "backward" as const,
    edgeTxHash: "0xedge",
    refTimestamp: T0,
    minUsd: 0,
    followUnpriced: false,
    pricesComplete: true,
  };
  const row = (over: Partial<Parameters<typeof mkTransfer>[0]> = {}) =>
    mkTransfer({ tx: 9, from: addr(2), to: addr(1), amount: 100, ts: T0 - 10, ...over });

  test("a clean candidate is kept", () => {
    expect(dropReason(row(), 100, base)).toBeNull();
  });

  test("same_tx wins over every other condition (case-insensitive)", () => {
    const t = row({
      tx: "0xEDGE",
      from: addr(1),
      to: addr(1),
      amount: 0,
      asset: FAKE_USDT,
      ts: T0 + 99,
    });
    expect(dropReason(t, null, { ...base, minUsd: 10 })).toBe("same_tx");
  });

  test("self_transfer wins over zero_value, spoofed, window and usd", () => {
    const t = row({ from: addr(1), to: addr(1), amount: 0, asset: FAKE_USDT, ts: T0 + 99 });
    expect(dropReason(t, null, { ...base, minUsd: 10 })).toBe("self_transfer");
  });

  test("zero_value wins over spoofed, window and usd", () => {
    const t = row({ amount: 0, asset: FAKE_USDT, ts: T0 + 99 });
    expect(dropReason(t, null, { ...base, minUsd: 10 })).toBe("zero_value");
  });

  test("spoofed_token wins over window and usd", () => {
    const t = row({ asset: FAKE_USDT, ts: T0 + 99 });
    expect(dropReason(t, null, { ...base, minUsd: 10 })).toBe("spoofed_token");
    expect(dropReason(row({ asset: USDC }), 100, base)).toBeNull();
  });

  test("outside_time_window uses a 5 s tolerance in the trace direction", () => {
    expect(dropReason(row({ ts: T0 + 5 }), 100, base)).toBeNull();
    expect(dropReason(row({ ts: T0 + 6 }), 100, base)).toBe("outside_time_window");
    const fwd = { ...base, direction: "forward" as const };
    expect(dropReason(row({ ts: T0 - 5 }), 100, fwd)).toBeNull();
    expect(dropReason(row({ ts: T0 - 6 }), 100, fwd)).toBe("outside_time_window");
    // The other side of the window is unbounded.
    expect(dropReason(row({ ts: T0 - 10_000_000 }), 100, base)).toBeNull();
  });

  test("outside_time_window wins over the usd checks", () => {
    expect(dropReason(row({ ts: T0 + 60 }), null, { ...base, minUsd: 10 })).toBe(
      "outside_time_window",
    );
  });

  test("unpriced is dropped by default and kept with followUnpriced; minUsd > 0 always drops it", () => {
    expect(dropReason(row(), null, base)).toBe("unpriced");
    expect(dropReason(row(), null, { ...base, followUnpriced: true })).toBeNull();
    expect(dropReason(row(), null, { ...base, followUnpriced: true, minUsd: 10 })).toBe("unpriced");
    expect(dropReason(row(), 9.99, { ...base, minUsd: 10 })).toBe("below_min_usd");
    expect(dropReason(row(), 10, { ...base, minUsd: 10 })).toBeNull();
    // Priced dust is not a drop at minUsd 0.
    expect(dropReason(row(), 0.5, base)).toBeNull();
  });

  test("a failed price lookup suspends the default unpriced drop, not minUsd", () => {
    expect(dropReason(row(), null, { ...base, pricesComplete: false })).toBeNull();
    expect(dropReason(row(), null, { ...base, pricesComplete: false, minUsd: 10 })).toBe(
      "unpriced",
    );
  });
});
