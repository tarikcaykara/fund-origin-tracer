import { describe, expect, test } from "bun:test";
import { withUniqueKeys } from "../src/lib/utils.ts";

describe("withUniqueKeys", () => {
  test("repeated base keys get a stable occurrence suffix", () => {
    const rows = withUniqueKeys(["a", "b", "a", "a"], (item) => item);
    expect(rows.map((row) => row.key)).toEqual(["a", "b", "a#1", "a#2"]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(4);
  });
});
