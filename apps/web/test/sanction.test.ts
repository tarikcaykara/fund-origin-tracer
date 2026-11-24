import { describe, expect, test } from "bun:test";
import { sanctionStatus } from "../src/sanction.ts";

describe("sanctionStatus", () => {
  test("a clean address without a loaded OFAC list is not screened, never not sanctioned", () => {
    expect(sanctionStatus({ sanctioned: false }, null)).toBe("not_screened");
  });

  test("a clean address with a loaded list is not sanctioned", () => {
    expect(sanctionStatus({ sanctioned: false }, "2026-11-24T00:00:00.000Z")).toBe(
      "not_sanctioned",
    );
  });

  test("a sanctioned label counts without the list (bundled or local labels)", () => {
    expect(sanctionStatus({ sanctioned: true }, null)).toBe("sanctioned");
  });

  test("no node yet is pending", () => {
    expect(sanctionStatus(undefined, null)).toBe("pending");
  });
});
