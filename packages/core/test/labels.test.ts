import { describe, expect, test } from "bun:test";
import type { Transport } from "../src/infra/transport.ts";
import { parseBundledLabelFile, parseLocalLabelFile } from "../src/labels/files.ts";
import { OFAC_KV_KEY, OfacSource, parseSdnXml } from "../src/labels/ofac.ts";
import { LabelRegistry } from "../src/labels/registry.ts";
import { foldSymbol, isSpoofed } from "../src/labels/spoof.ts";
import type { Asset } from "../src/schema.ts";

const USDT_ETH = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const EVM_A = "0x1111111111111111111111111111111111111111";
const EVM_B = "0x2222222222222222222222222222222222222222";
const TRON_A = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

function token(symbol: string, contract: string, chain: Asset["chain"] = "ethereum"): Asset {
  return {
    chain,
    kind: "token",
    contract,
    symbol,
    name: symbol,
    decimals: 6,
    decimalsGuessed: false,
  };
}

describe("spoof", () => {
  test("fold maps homoglyphs and leet", () => {
    expect(foldSymbol("USD\u0422")).toBe("USDT");
    expect(foldSymbol("U5DT")).toBe("USDT");
    expect(foldSymbol("usdt ")).toBe("USDT");
  });
  test("spoofed vs real", () => {
    expect(isSpoofed(token("USD\u0422", EVM_A))).toBe(true);
    expect(isSpoofed(token("U5DT", EVM_A))).toBe(true);
    expect(isSpoofed(token("USDT", USDT_ETH.toUpperCase().replace("0X", "0x")))).toBe(false);
    expect(isSpoofed(token("USDT", EVM_A))).toBe(true);
    expect(isSpoofed(token("PEPE", EVM_A))).toBe(false);
    expect(isSpoofed({ chain: "ethereum", kind: "native" })).toBe(false);
  });

  test("upgraded symbols and tugrik sign", () => {
    const usdt0Arb = "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9";
    // The real Arbitrum USDT0 contract reports "USD₮0": never a spoof.
    expect(isSpoofed(token("USD\u20AE0", usdt0Arb, "arbitrum"))).toBe(false);
    // Look-alikes of the upgraded symbols on other contracts are spoofs.
    expect(isSpoofed(token("USD\u20AE0", EVM_A, "arbitrum"))).toBe(true);
    expect(isSpoofed(token("USDT0", EVM_A, "polygon"))).toBe(true);
    expect(isSpoofed(token("USD\u20AE", EVM_A))).toBe(true);
  });

  test("a canonical contract reporting another canonical symbol is not a spoof", () => {
    const usdcBridgedPolygon = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
    expect(isSpoofed(token("USDC", usdcBridgedPolygon, "polygon"))).toBe(false);
  });
});

const XML = `<sdnEntry>
<id><idType>Digital Currency Address - USDT</idType>
  <idNumber>${EVM_A.toUpperCase().replace("0X", "0x")}</idNumber></id>
<id><idType>Digital Currency Address - TRX</idType><idNumber>${TRON_A}</idNumber></id>
<id><idType>Digital Currency Address - USDT</idType><idNumber>bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh</idNumber></id>
<id><idType>Digital Currency Address - ETH</idType><idNumber>${EVM_A}</idNumber></id>
<id><idType>Passport</idType><idNumber>0x${"3".repeat(40)}</idNumber></id>
</sdnEntry>`;

describe("ofac", () => {
  test("parse classifies by format, dedupes, ignores BTC/other types", () => {
    const r = parseSdnXml(XML);
    expect(r.evm).toEqual([EVM_A]);
    expect(r.tron).toEqual([TRON_A]);
  });

  function memKv() {
    const m = new Map<string, string>();
    return {
      m,
      get: async (k: string) => m.get(k) ?? null,
      set: async (k: string, v: string) => void m.set(k, v),
    };
  }
  const ok: Transport = async () => ({ status: 200, body: XML });
  const fail: Transport = async () => ({ status: 503, body: "" });
  const HOUR = 3_600_000;

  test("fetches, stores, then serves fresh snapshot without fetching", async () => {
    const kv = memKv();
    let calls = 0;
    const t: Transport = async (r) => {
      calls++;
      return ok(r);
    };
    let now = Date.parse("2026-01-01T00:00:00Z");
    const src = new OfacSource({ url: "u", transport: t, kv, now: () => now });
    const first = await src.load();
    expect(first.warning).toBeNull();
    expect(first.set.evm.has(EVM_A)).toBe(true);
    expect(kv.m.has(OFAC_KV_KEY)).toBe(true);
    now += 2 * HOUR;
    await src.load();
    expect(calls).toBe(1);
    now += 25 * HOUR;
    await src.load();
    expect(calls).toBe(2);
  });

  test("stale snapshot kept with warning on failure; empty set when none", async () => {
    const kv = memKv();
    let now = Date.parse("2026-01-01T00:00:00Z");
    await new OfacSource({ url: "u", transport: ok, kv, now: () => now }).load();
    now += 48 * HOUR;
    const r = await new OfacSource({ url: "u", transport: fail, kv, now: () => now }).load();
    expect(r.warning?.code).toBe("ofac_unavailable");
    expect(r.set.tron.has(TRON_A)).toBe(true);
    const r2 = await new OfacSource({
      url: "u",
      transport: fail,
      kv: memKv(),
      now: () => now,
    }).load();
    expect(r2.warning?.code).toBe("ofac_unavailable");
    expect(r2.set.evm.size).toBe(0);
  });
});

describe("registry", () => {
  const bundled = [
    parseBundledLabelFile({
      chain: "ethereum",
      entries: [
        {
          address: EVM_A,
          name: "Hot 1",
          category: "exchange",
          entity: "X",
          source: "https://example.com/a",
          verifiedAt: "2026-02-03",
        },
      ],
    }),
    parseBundledLabelFile({
      chain: "tron",
      entries: [
        {
          address: TRON_A,
          name: "T",
          category: "token",
          source: "https://example.com/t",
          verifiedAt: "2026-05-01",
        },
      ],
    }),
  ];

  test("local replaces bundled for same chain+address (case-insensitive EVM)", () => {
    const local = parseLocalLabelFile({
      entries: [
        {
          chain: "ethereum",
          address: EVM_A.toUpperCase().replace("0X", "0x"),
          name: "Mine",
          category: "scam",
        },
      ],
    });
    const reg = new LabelRegistry(bundled, local, null);
    expect(reg.hasLocal).toBe(true);
    expect(reg.lookup("ethereum", EVM_A)).toEqual([
      { name: "Mine", category: "scam", source: "local", origin: "local" },
    ]);
    expect(reg.lookup("polygon", EVM_A)).toEqual([]);
    expect(reg.labelsVersion).toBe("2026-05-01");
  });

  test("bundled label, OFAC label, zero address", () => {
    const ofac = { fetchedAt: "x", evm: new Set([EVM_A, EVM_B]), tron: new Set<string>() };
    const reg = new LabelRegistry(bundled, null, ofac);
    const labels = reg.lookup("ethereum", EVM_A);
    expect(labels.map((l) => l.origin)).toEqual(["bundled", "ofac"]);
    expect(labels[0]?.entity).toBe("X");
    expect(reg.isSanctioned("ethereum", EVM_B)).toBe(true);
    expect(reg.isSanctioned("tron", EVM_B)).toBe(false);
    expect(reg.lookup("ethereum", `0x${"0".repeat(40)}`)[0]?.name).toBe("Mint/Burn (zero address)");
    expect(reg.lookup("tron", "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb")[0]?.category).toBe("token");
  });
});

describe("file validation", () => {
  const entry = {
    address: EVM_A,
    name: "n",
    category: "dex",
    source: "https://example.com",
    verifiedAt: "2026-01-01",
  };
  test("rejects duplicate and uppercase EVM addresses naming the path", () => {
    expect(() => parseBundledLabelFile({ chain: "ethereum", entries: [entry, entry] })).toThrow(
      /entries\.1\.address.*duplicate/,
    );
    expect(() =>
      parseBundledLabelFile({
        chain: "ethereum",
        entries: [{ ...entry, address: `0x${"A".repeat(40)}` }],
      }),
    ).toThrow(/entries\.0\.address/);
  });
  test("rejects bad source and date", () => {
    expect(() =>
      parseBundledLabelFile({ chain: "ethereum", entries: [{ ...entry, source: "nope" }] }),
    ).toThrow(/source/);
    expect(() =>
      parseBundledLabelFile({ chain: "ethereum", entries: [{ ...entry, verifiedAt: "1/2/26" }] }),
    ).toThrow(/verifiedAt/);
  });
  test("local file rejects wrong-format address", () => {
    expect(() =>
      parseLocalLabelFile({
        entries: [{ chain: "tron", address: EVM_A, name: "n", category: "other" }],
      }),
    ).toThrow(/entries\.0\.address/);
  });
});
