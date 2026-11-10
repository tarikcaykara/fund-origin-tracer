import { expect, test } from "bun:test";
import type { Transfer } from "../src/schema.ts";
import { assetId, RunEventSchema, RunParamsSchema, transferId } from "../src/schema.ts";

const base = {
  chain: "ethereum",
  direction: "backward",
  seeds: [{ id: "s1", kind: "tx", value: `0x${"a".repeat(64)}` }],
};

test("RunParams defaults", () => {
  const p = RunParamsSchema.parse(base);
  expect(p).toMatchObject({
    maxDepth: 10,
    maxBranches: 3,
    maxEdges: 200,
    minUsd: 0,
    traceThroughEntities: false,
    followUnpriced: false,
    timeoutSec: 600,
  });
});

test("RunParams bounds", () => {
  const bad = (o: object) => RunParamsSchema.safeParse({ ...base, ...o }).success;
  expect(bad({ maxDepth: 0 })).toBe(false);
  expect(bad({ maxDepth: 51 })).toBe(false);
  expect(bad({ maxBranches: 11 })).toBe(false);
  expect(bad({ maxEdges: 9 })).toBe(false);
  expect(bad({ maxEdges: 5001 })).toBe(false);
  expect(bad({ minUsd: -1 })).toBe(false);
  expect(bad({ timeoutSec: 9 })).toBe(false);
  expect(bad({ seeds: [] })).toBe(false);
  expect(bad({ seeds: [{ id: "s21", kind: "tx", value: "x" }] })).toBe(false);
  const twenty = Array.from({ length: 21 }, (_, i) => ({
    id: `s${i + 1}`,
    kind: "tx",
    value: "x",
  }));
  expect(bad({ seeds: twenty })).toBe(false);
  expect(bad({ seeds: twenty.slice(0, 20) })).toBe(true);
});

test("asset and transfer ids", () => {
  expect(assetId({ chain: "tron", kind: "native" })).toBe("tron:native");
  const asset = {
    chain: "tron",
    kind: "token",
    contract: "TC",
    symbol: "USDT",
    name: "Tether",
    decimals: 6,
    decimalsGuessed: false,
  } as const;
  expect(assetId(asset)).toBe("tron:TC");
  const t: Transfer = {
    chain: "tron",
    txHash: "h",
    blockNumber: 1,
    timestamp: 2,
    from: "a",
    to: "b",
    asset,
    amountRaw: "5",
    amount: 5e-6,
  };
  // Unrepeated transfers keep their v1.2 id, so stored results still link.
  expect(transferId(t)).toBe("h|tron:TC|a|b|5");
  expect(transferId({ ...t, repeat: 2 })).toBe("h|tron:TC|a|b|5|2");
});

test("RunEvent discriminates on type", () => {
  expect(RunEventSchema.safeParse({ type: "done", status: "completed" }).success).toBe(true);
  expect(RunEventSchema.safeParse({ type: "done", status: "nope" }).success).toBe(false);
  expect(RunEventSchema.safeParse({ type: "unknown" }).success).toBe(false);
});
