import { describe, expect, test } from "bun:test";
import { formatUsd, isoTime, shortAddress } from "../src/format.ts";
import { parseSeeds } from "../src/seeds.ts";

describe("shortAddress", () => {
  test("checksums EVM addresses before shortening", () => {
    expect(shortAddress("ethereum", "0xdac17f958d2ee523a2206206994597c13d831ec7")).toBe(
      "0xdAC1…1ec7",
    );
  });

  test("leaves TRON addresses unchanged apart from shortening", () => {
    expect(shortAddress("tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe("TR7NHq…Lj6t");
  });
});

describe("formatting", () => {
  test("usd and iso time", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(isoTime(0)).toBe("1970-01-01T00:00:00Z");
  });
});

describe("parseSeeds", () => {
  const tx = `0x${"a".repeat(64)}`;
  const address = `0x${"b".repeat(40)}`;

  test("classifies lines and reports invalid ones by line number", () => {
    const parsed = parseSeeds(`${tx}\n\n${address}\nnope`, "ethereum");
    expect(parsed.seeds).toEqual([
      { kind: "tx", value: tx },
      { kind: "address", value: address },
    ]);
    expect(parsed.invalid).toEqual([{ line: 4, value: "nope" }]);
  });

  test("a TRON hash has no 0x prefix", () => {
    expect(parseSeeds("a".repeat(64), "tron").seeds).toEqual([
      { kind: "tx", value: "a".repeat(64) },
    ]);
    expect(parseSeeds(tx, "tron").invalid).toHaveLength(1);
  });
});
