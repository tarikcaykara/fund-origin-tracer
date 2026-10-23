import { isValidAddress, isValidTx } from "@fot/core/chains";
import type { ChainId, Seed } from "@fot/core/schema";

export interface InvalidSeed {
  line: number;
  value: string;
}

export interface SeedLineResult {
  line: number;
  value: string;
  valid: boolean;
  kind?: Seed["kind"];
  reason?: string;
}

export interface ParsedSeeds {
  seeds: { kind: Seed["kind"]; value: string }[];
  /** Kept as the compact invalid-row shape used by existing callers. */
  invalid: InvalidSeed[];
  /** Non-blank input rows, with a classification or a user-facing validation reason. */
  lines: SeedLineResult[];
}

export const MAX_SEEDS = 20;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

function invalidReason(chain: ChainId, value: string): string {
  if (chain !== "tron") {
    if (value.startsWith("0x") && /^[0-9a-fA-F]*$/.test(value.slice(2))) {
      const length = value.slice(2).length;
      return `${length} hex chars, expected 40 or 64`;
    }
    return "invalid characters";
  }

  if (/^[0-9a-f]*$/i.test(value)) {
    return `${value.length} hex chars, expected 64`;
  }
  if (/^T/.test(value)) {
    const suffix = value.slice(1);
    if (suffix.length > 0 && !BASE58.test(suffix)) {
      return "invalid characters (TRON addresses use Base58)";
    }
    return `${value.length} base58 chars, expected 34`;
  }
  if (!BASE58.test(value)) return "invalid characters";
  return "invalid characters (TRON addresses start with T)";
}

/** One seed per non-blank line; each is a transaction hash or an address of `chain`. */
export function parseSeeds(text: string, chain: ChainId): ParsedSeeds {
  const seeds: ParsedSeeds["seeds"] = [];
  const invalid: ParsedSeeds["invalid"] = [];
  const lines: SeedLineResult[] = [];
  const seen = new Map<string, number>();
  let seedNumber = 0;

  text.split(/\r?\n/).forEach((raw, index) => {
    const value = raw.trim();
    if (value === "") return;
    const line = index + 1;
    seedNumber += 1;

    let kind: Seed["kind"] | undefined;
    if (isValidTx(chain, value)) kind = "tx";
    else if (isValidAddress(chain, value)) kind = "address";

    let reason: string | undefined;
    if (seedNumber > MAX_SEEDS) {
      reason = `over the ${MAX_SEEDS}-seed limit`;
    } else if (!kind) {
      reason = invalidReason(chain, value);
    } else {
      const key = chain === "tron" && kind === "address" ? value : value.toLowerCase();
      const firstLine = seen.get(key);
      if (firstLine !== undefined) reason = `duplicate of line ${firstLine}`;
      else {
        seen.set(key, line);
        seeds.push({ kind, value });
      }
    }

    if (reason) invalid.push({ line, value });
    lines.push({
      line,
      value,
      valid: reason === undefined,
      ...(kind === undefined || reason !== undefined ? {} : { kind }),
      ...(reason === undefined ? {} : { reason }),
    });
  });

  return { seeds, invalid, lines };
}
