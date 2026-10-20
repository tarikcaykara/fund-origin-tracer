import { CHAINS, type ChainId, isZeroAddress, normalizeAddress } from "../chains.ts";
import type { Label } from "../schema.ts";
import {
  type BundledLabelFile,
  labelsVersion as computeVersion,
  type LocalLabelFile,
} from "./files.ts";
import type { OfacSet } from "./ofac.ts";

const OFAC_LABEL: Label = {
  name: "OFAC SDN",
  category: "sanctioned",
  source: "https://sanctionssearch.ofac.treas.gov/",
  origin: "ofac",
};

const ZERO_LABEL: Label = {
  name: "Mint/Burn (zero address)",
  category: "token",
  source: "protocol",
  origin: "bundled",
};

export class LabelRegistry {
  readonly labelsVersion: string;
  readonly hasLocal: boolean;
  readonly #entries = new Map<string, Label>();
  readonly #ofac: OfacSet | null;

  constructor(
    bundled: readonly BundledLabelFile[],
    local: LocalLabelFile | null,
    ofac: OfacSet | null,
  ) {
    this.#ofac = ofac;
    this.labelsVersion = computeVersion(bundled);
    this.hasLocal = local !== null && local.entries.length > 0;
    for (const file of bundled) {
      for (const e of file.entries) {
        this.#entries.set(this.#key(file.chain, e.address), {
          name: e.name,
          category: e.category,
          ...(e.entity !== undefined ? { entity: e.entity } : {}),
          source: e.source,
          origin: "bundled",
        });
      }
    }
    for (const e of local?.entries ?? []) {
      this.#entries.set(this.#key(e.chain, e.address), {
        name: e.name,
        category: e.category,
        ...(e.entity !== undefined ? { entity: e.entity } : {}),
        source: "local",
        origin: "local",
      });
    }
  }

  #key(chain: ChainId, address: string): string {
    return `${chain}|${normalizeAddress(chain, address)}`;
  }

  isSanctioned(chain: ChainId, address: string): boolean {
    if (!this.#ofac) return false;
    const a = normalizeAddress(chain, address);
    return (CHAINS[chain].kind === "evm" ? this.#ofac.evm : this.#ofac.tron).has(a);
  }

  lookup(chain: ChainId, address: string): Label[] {
    const out: Label[] = [];
    const entry = this.#entries.get(this.#key(chain, address));
    if (entry) out.push(entry);
    if (this.isSanctioned(chain, address)) out.push(OFAC_LABEL);
    if (isZeroAddress(chain, address)) out.push(ZERO_LABEL);
    return out;
  }
}
