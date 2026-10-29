import { CHAINS, type ChainId, isZeroAddress, normalizeAddress } from "../chains.ts";
import type { Label } from "../schema.ts";
import {
  type BundledLabelFile,
  labelsVersion as computeVersion,
  type LocalLabelFile,
} from "./files.ts";
import type { OfacSet, SdnEntry } from "./ofac.ts";

/** For addresses from a version 1 OFAC snapshot, which named no SDN entry. */
const OFAC_LABEL: Label = {
  name: "OFAC SDN",
  category: "sanctioned",
  source: "https://sanctionssearch.ofac.treas.gov/",
  origin: "ofac",
};

/** OFAC's page for one SDN entry, by uid; it lists the entry's digital currency addresses. */
const SDN_ENTRY_URL = "https://sanctionssearch.ofac.treas.gov/Details.aspx?id=";

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
  /** SDN labels by normalized address, one per entry listing it; built once per OFAC set. */
  readonly #sanctions: Record<"evm" | "tron", Map<string, readonly Label[]>>;

  constructor(
    bundled: readonly BundledLabelFile[],
    local: LocalLabelFile | null,
    ofac: OfacSet | null,
  ) {
    const byUid = new Map<number, Label>();
    const sanctionLabels = (addresses: ReadonlyMap<string, readonly SdnEntry[]> | undefined) =>
      new Map(
        [...(addresses ?? [])].map(([address, listed]) => [
          address,
          listed.length === 0
            ? [OFAC_LABEL]
            : listed.map((entry) => {
                let label = byUid.get(entry.uid);
                if (!label) {
                  label = {
                    name: entry.name,
                    category: "sanctioned",
                    entity: entry.name,
                    programs: entry.programs,
                    source: `${SDN_ENTRY_URL}${entry.uid}`,
                    origin: "ofac",
                  };
                  byUid.set(entry.uid, label);
                }
                return label;
              }),
        ]),
      );
    this.#sanctions = { evm: sanctionLabels(ofac?.evm), tron: sanctionLabels(ofac?.tron) };
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
    return this.#sanctions[CHAINS[chain].kind].has(normalizeAddress(chain, address));
  }

  /**
   * SDN labels first, so every consumer that reads only `labels[0]` shows a sanctions match; then
   * the local or bundled label, then the zero-address label.
   */
  lookup(chain: ChainId, address: string): Label[] {
    const sanctions = this.#sanctions[CHAINS[chain].kind].get(normalizeAddress(chain, address));
    const out: Label[] = [...(sanctions ?? [])];
    const entry = this.#entries.get(this.#key(chain, address));
    if (entry) out.push(entry);
    if (isZeroAddress(chain, address)) out.push(ZERO_LABEL);
    return out;
  }
}
