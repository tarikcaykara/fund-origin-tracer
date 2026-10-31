import { describe, expect, test } from "bun:test";
import type { AddressNode, Asset, Flag, Label, TraceEdge } from "@fot/core/schema";
import {
  createPaletteIndex,
  flagSelection,
  isPaletteShortcut,
  normalizeQuery,
  PALETTE_GROUP_LIMIT,
  type PaletteRunData,
  searchPalette,
} from "../src/palette.ts";

const native: Asset = { chain: "ethereum", kind: "native" };

function edge(id: string, from: string, to: string, txHash = `0x${id}`): TraceEdge {
  return {
    id,
    depth: 0,
    from,
    to,
    far: from,
    near: to,
    transfer: {
      chain: "ethereum",
      txHash,
      blockNumber: 1,
      timestamp: 1,
      from,
      to,
      asset: native,
      amountRaw: "1",
      amount: 1,
    },
    usd: null,
    parents: [],
    children: [],
    status: "pending",
    stopReason: null,
    stopDetail: null,
    selection: null,
    swap: null,
    dropped: [],
    droppedTotal: 0,
    seedId: null,
  };
}

function addressNode(address: string, labels: Label[] = []): AddressNode {
  return {
    address,
    labels,
    sanctioned: false,
    isSeedSubject: false,
    seedIds: [],
    inEdgeIds: [],
    outEdgeIds: [],
  };
}

function label(name: string, entity?: string): Label {
  return { name, category: "exchange", entity, source: "test", origin: "local" };
}

function flag(
  id: string,
  severity: Flag["severity"],
  title: string,
  addresses: string[] = [],
): Flag {
  return { id, severity, title, detail: "", evidence: { addresses, edgeIds: [] } };
}

function search(data: Partial<PaletteRunData>, raw: string) {
  const index = createPaletteIndex({ addresses: [], edges: [], flags: [], ...data });
  return searchPalette(index, normalizeQuery(raw));
}

const binance = "0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";
const alice = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const bob = "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0";

describe("searchPalette", () => {
  test("searches nothing below two normalized characters", () => {
    const data = {
      addresses: [addressNode(alice)],
      edges: [edge("e1", alice, bob)],
      flags: [flag("rule", "high", "a rule")],
    };
    for (const raw of ["", " a "]) {
      expect(search(data, raw)).toEqual({
        addresses: { total: 0, items: [] },
        transfers: { total: 0, items: [] },
        flags: { total: 0, items: [] },
      });
    }
  });

  test("finds an address by entity and its transfers by label name, case-insensitively", () => {
    const exchange = addressNode(binance, [label("Binance 14", "Binance")]);
    const result = search(
      {
        addresses: [addressNode(alice), exchange, addressNode(bob)],
        edges: [edge("in", alice, binance), edge("other", alice, bob), edge("out", binance, bob)],
      },
      "BINANCE",
    );
    expect(result.addresses.items).toEqual([exchange]);
    expect(result.transfers.items.map((item) => item.id)).toEqual(["in", "out"]);
  });

  test("ranks an exact address first, then address prefixes, then substring matches", () => {
    const contains = addressNode("0x1111", [label("Cluster 0xab12cd")]);
    const prefix = addressNode("0xab12cdef");
    const exact = addressNode("0xab12cd");
    const addresses = [contains, prefix, exact];
    expect(search({ addresses }, "0xab12cd").addresses.items).toEqual([exact, prefix, contains]);
    expect(search({ addresses }, "0xab12").addresses.items).toEqual([prefix, exact, contains]);
  });

  test("finds a transfer by a mixed-case tx hash prefix", () => {
    const hash = "0xe7f7c8ab90e7f7c8ab90e7f7c8ab90e7f7c8ab90e7f7c8ab90e7f7c8ab90abcd";
    const edges = [edge("other", alice, bob), edge("seed", alice, bob, hash)];
    const result = search({ edges }, "0xE7F7C8AB");
    expect(result.transfers.items.map((item) => item.id)).toEqual(["seed"]);
  });

  test("finds flags by evidence address and lists them by severity", () => {
    const flags = [
      flag("info_rule", "info", "Info rule"),
      flag("high_rule", "high", "High rule", [bob]),
      flag("low_rule", "low", "Low rule"),
    ];
    expect(search({ flags }, bob).flags.items.map((item) => item.id)).toEqual(["high_rule"]);
    expect(search({ flags }, "rule").flags.items.map((item) => item.id)).toEqual([
      "high_rule",
      "low_rule",
      "info_rule",
    ]);
  });

  test("caps a group at the limit and reports the total, in rank then input order", () => {
    const edges = [
      ...Array.from({ length: 7 }, (_, i) => edge(`e${i}`, alice, bob, `0xbatch${i}`)),
      edge("exact", alice, bob, "0xbatch"),
    ];
    const result = search({ edges }, "0xbatch");
    expect(result.transfers.total).toBe(8);
    expect(result.transfers.items).toHaveLength(PALETTE_GROUP_LIMIT);
    expect(result.transfers.items.map((item) => item.id)).toEqual([
      "exact",
      "e0",
      "e1",
      "e2",
      "e3",
      "e4",
    ]);
  });
});

describe("isPaletteShortcut", () => {
  const key = (k: string, modifiers: Partial<KeyboardEvent> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  });

  test("accepts ⌘K and Ctrl+K on every platform", () => {
    expect(isPaletteShortcut(key("k", { metaKey: true }))).toBe(true);
    expect(isPaletteShortcut(key("k", { ctrlKey: true }))).toBe(true);
    expect(isPaletteShortcut(key("K", { ctrlKey: true }))).toBe(true);
  });

  test("rejects K without a modifier, with Shift or Alt, and other keys", () => {
    expect(isPaletteShortcut(key("k"))).toBe(false);
    expect(isPaletteShortcut(key("k", { metaKey: true, shiftKey: true }))).toBe(false);
    expect(isPaletteShortcut(key("k", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPaletteShortcut(key("j", { metaKey: true }))).toBe(false);
  });
});

describe("flagSelection", () => {
  test("selects the flag's evidence with duplicate addresses removed", () => {
    const selection = flagSelection({
      ...flag("rule", "high", "Mixer exposure", [alice, bob, alice]),
      evidence: { addresses: [alice, bob, alice], edgeIds: ["e1", "e2"] },
    });
    expect(selection).toEqual({
      kind: "set",
      addresses: [alice, bob],
      edgeIds: ["e1", "e2"],
      title: "Mixer exposure",
    });
  });
});
