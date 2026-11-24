import type { AddressNode } from "@fot/core/schema";

export type SanctionStatus = "pending" | "sanctioned" | "not_screened" | "not_sanctioned";

/**
 * One address's sanction verdict. Without a loaded OFAC list a clean address is "not screened",
 * never "not sanctioned".
 */
export function sanctionStatus(
  node: Pick<AddressNode, "sanctioned"> | undefined,
  ofacFetchedAt: string | null | undefined,
): SanctionStatus {
  if (!node) return "pending";
  if (node.sanctioned) return "sanctioned";
  return ofacFetchedAt ? "not_sanctioned" : "not_screened";
}
