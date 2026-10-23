import { describe, expect, test } from "bun:test";
import { parseSeeds } from "../src/seeds.ts";

describe("parseSeeds", () => {
  const evmTx = `0x${"a".repeat(64)}`;
  const evmAddress = `0x${"b".repeat(40)}`;
  const tronTx = "c".repeat(64);
  const tronAddress = `T${"A".repeat(33)}`;

  test("accepts transaction hashes and addresses for each chain kind", () => {
    for (const chain of ["ethereum", "polygon", "arbitrum"] as const) {
      expect(parseSeeds(`${evmTx}\n${evmAddress}`, chain).lines).toEqual([
        { line: 1, value: evmTx, valid: true, kind: "tx" },
        { line: 2, value: evmAddress, valid: true, kind: "address" },
      ]);
    }

    expect(parseSeeds(`${tronTx}\n${tronAddress}`, "tron").lines).toEqual([
      { line: 1, value: tronTx, valid: true, kind: "tx" },
      { line: 2, value: tronAddress, valid: true, kind: "address" },
    ]);
  });

  test("explains wrong EVM and TRON lengths", () => {
    expect(parseSeeds(`0x${"a".repeat(39)}`, "ethereum").lines[0]?.reason).toBe(
      "39 hex chars, expected 40 or 64",
    );
    expect(parseSeeds(`0x${"A".repeat(39)}`, "ethereum").lines[0]?.reason).toBe(
      "39 hex chars, expected 40 or 64",
    );
    expect(parseSeeds(`T${"A".repeat(32)}`, "tron").lines[0]?.reason).toBe(
      "33 base58 chars, expected 34",
    );
    expect(parseSeeds("a".repeat(63), "tron").lines[0]?.reason).toBe("63 hex chars, expected 64");
  });

  test("reports invalid characters", () => {
    expect(parseSeeds(`0x${"a".repeat(38)}g`, "ethereum").lines[0]?.reason).toBe(
      "invalid characters",
    );
    expect(parseSeeds(`T${"A".repeat(32)}0`, "tron").lines[0]?.reason).toBe(
      "invalid characters (TRON addresses use Base58)",
    );
  });

  test("detects EVM duplicates without regard to hex case", () => {
    const parsed = parseSeeds(
      `${evmAddress}\n${evmAddress.toUpperCase().replace("0X", "0x")}`,
      "ethereum",
    );
    expect(parsed.seeds).toEqual([{ kind: "address", value: evmAddress }]);
    expect(parsed.lines[1]).toMatchObject({
      valid: false,
      reason: "duplicate of line 1",
    });
  });

  test("rejects non-blank seeds after the 20-seed limit", () => {
    const values = Array.from(
      { length: 21 },
      (_, index) => `0x${index.toString(16).padStart(64, "0")}`,
    );
    const parsed = parseSeeds(values.join("\n"), "ethereum");
    const overLimitValue = values[20];
    if (overLimitValue === undefined) throw new Error("Expected a 21st seed");
    expect(parsed.seeds).toHaveLength(20);
    expect(parsed.invalid).toEqual([{ line: 21, value: overLimitValue }]);
    expect(parsed.lines[20]).toMatchObject({ valid: false, reason: "over the 20-seed limit" });
  });

  test("ignores blank lines while retaining original line numbers", () => {
    const parsed = parseSeeds(`\n${evmTx}\n  \n${evmAddress}\n`, "ethereum");
    expect(parsed.seeds).toEqual([
      { kind: "tx", value: evmTx },
      { kind: "address", value: evmAddress },
    ]);
    expect(parsed.lines.map((line) => line.line)).toEqual([2, 4]);
    expect(parsed.invalid).toEqual([]);
  });
});
