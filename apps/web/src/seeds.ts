import { isValidAddress, isValidTx } from "@fot/core/chains";
import type { ChainId, Seed } from "@fot/core/schema";

export interface ParsedSeeds {
  seeds: { kind: Seed["kind"]; value: string }[];
  invalid: { line: number; value: string }[];
}

/** One seed per line (blank lines skipped); each is a transaction hash or an address of `chain`. */
export function parseSeeds(text: string, chain: ChainId): ParsedSeeds {
  const seeds: ParsedSeeds["seeds"] = [];
  const invalid: ParsedSeeds["invalid"] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const value = raw.trim();
    if (value === "") return;
    if (isValidTx(chain, value)) seeds.push({ kind: "tx", value });
    else if (isValidAddress(chain, value)) seeds.push({ kind: "address", value });
    else invalid.push({ line: i + 1, value });
  });
  return { seeds, invalid };
}
