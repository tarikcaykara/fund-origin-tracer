import { describe, expect, test } from "bun:test";
import { parsePageParam } from "../src/page-param.ts";

describe("parsePageParam", () => {
  test("whole numbers pass through", () => {
    expect(parsePageParam("3")).toBe(3);
    expect(parsePageParam("0")).toBe(0);
  });

  test("fractions truncate so the API never receives a non-integer offset", () => {
    expect(parsePageParam("1.5")).toBe(1);
  });

  test("missing, negative and non-numeric values are the first page", () => {
    expect(parsePageParam(null)).toBe(0);
    expect(parsePageParam("")).toBe(0);
    expect(parsePageParam("-2")).toBe(0);
    expect(parsePageParam("abc")).toBe(0);
    expect(parsePageParam("Infinity")).toBe(0);
  });
});
