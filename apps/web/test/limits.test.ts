import { describe, expect, test } from "bun:test";
import { firstLimitError } from "../src/limits.ts";

const valid = { maxDepth: 6, maxBranches: 3, maxEdges: 200, minUsd: 0 };

describe("firstLimitError", () => {
  test("accepts the defaults and the bounds", () => {
    expect(firstLimitError(valid)).toBeNull();
    expect(
      firstLimitError({ maxDepth: 50, maxBranches: 10, maxEdges: 5000, minUsd: 0.01 }),
    ).toBeNull();
  });

  test("names the first invalid limit", () => {
    expect(firstLimitError({ ...valid, maxDepth: Number.NaN })).toBe(
      "Max depth must be a whole number from 1 to 50.",
    );
    expect(firstLimitError({ ...valid, maxBranches: 11 })).toBe(
      "Max branches must be a whole number from 1 to 10.",
    );
    expect(firstLimitError({ ...valid, maxEdges: 9 })).toBe(
      "Max edges must be a whole number from 10 to 5000.",
    );
    expect(firstLimitError({ ...valid, minUsd: -1 })).toBe("Min USD must be 0 or more.");
  });

  test("rejects fractions, which the server's integer limits refuse", () => {
    expect(firstLimitError({ ...valid, maxDepth: 2.5 })).not.toBeNull();
  });
});
