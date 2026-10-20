import { EVM_ADDRESS_RE, TRON_ADDRESS_RE } from "../chains.ts";
import type { Transport } from "../infra/transport.ts";

export interface OfacSet {
  fetchedAt: string | null;
  evm: Set<string>;
  tron: Set<string>;
}

export interface OfacSnapshot {
  fetchedAt: string;
  evm: string[];
  tron: string[];
}

export const OFAC_KV_KEY = "ofac:sdn";

const ENTRY_RE =
  /<idType>Digital Currency Address - [A-Z0-9]+<\/idType>\s*<idNumber>([^<]+)<\/idNumber>/g;

export function parseSdnXml(text: string): { evm: string[]; tron: string[] } {
  const evm = new Set<string>();
  const tron = new Set<string>();
  for (const m of text.matchAll(ENTRY_RE)) {
    const addr = (m[1] ?? "").trim();
    if (EVM_ADDRESS_RE.test(addr)) evm.add(addr.toLowerCase());
    else if (TRON_ADDRESS_RE.test(addr)) tron.add(addr);
  }
  return { evm: [...evm], tron: [...tron] };
}

export function emptyOfacSet(): OfacSet {
  return { fetchedAt: null, evm: new Set(), tron: new Set() };
}

export function ofacSetFromSnapshot(json: unknown): OfacSet {
  const s = json as Partial<OfacSnapshot> | null;
  if (!s || typeof s.fetchedAt !== "string" || !Array.isArray(s.evm) || !Array.isArray(s.tron)) {
    throw new Error("Invalid OFAC snapshot: expected {fetchedAt, evm[], tron[]}");
  }
  return { fetchedAt: s.fetchedAt, evm: new Set(s.evm), tron: new Set(s.tron) };
}

export function ofacSnapshot(set: OfacSet): OfacSnapshot {
  return { fetchedAt: set.fetchedAt ?? "", evm: [...set.evm], tron: [...set.tron] };
}

export interface OfacKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface OfacSourceOptions {
  url: string;
  transport: Transport;
  kv: OfacKv;
  now: () => number;
  refreshHours?: number;
}

export interface OfacLoadResult {
  set: OfacSet;
  warning: { code: "ofac_unavailable"; message: string } | null;
}

export class OfacSource {
  readonly #o: OfacSourceOptions;

  constructor(options: OfacSourceOptions) {
    this.#o = options;
  }

  async load(signal?: AbortSignal): Promise<OfacLoadResult> {
    const refreshMs = (this.#o.refreshHours ?? 24) * 3_600_000;
    let stale: OfacSet | null = null;
    const raw = await this.#o.kv.get(OFAC_KV_KEY);
    if (raw) {
      try {
        const set = ofacSetFromSnapshot(JSON.parse(raw));
        const age = this.#o.now() - Date.parse(set.fetchedAt ?? "");
        if (Number.isFinite(age) && age >= 0 && age < refreshMs) return { set, warning: null };
        stale = set;
      } catch {
        stale = null;
      }
    }
    try {
      const res = await this.#o.transport({
        url: this.#o.url,
        ...(signal ? { signal } : {}),
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const parsed = parseSdnXml(res.body);
      const set: OfacSet = {
        fetchedAt: new Date(this.#o.now()).toISOString(),
        evm: new Set(parsed.evm),
        tron: new Set(parsed.tron),
      };
      await this.#o.kv.set(OFAC_KV_KEY, JSON.stringify(ofacSnapshot(set)));
      return { set, warning: null };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        set: stale ?? emptyOfacSet(),
        warning: {
          code: "ofac_unavailable",
          message: `OFAC SDN list unavailable (${reason}); ${
            stale ? "using stale snapshot" : "sanctions screening disabled"
          }`,
        },
      };
    }
  }
}
