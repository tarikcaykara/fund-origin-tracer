import { z } from "zod";
import { EVM_ADDRESS_RE, TRON_ADDRESS_RE } from "../chains.ts";
import type { Transport } from "../infra/transport.ts";

/** One SDN entry that lists at least one EVM or TRON address. */
export interface SdnEntry {
  uid: number;
  /** As OFAC publishes it: `lastName` for entities, `lastName, firstName` for individuals. */
  name: string;
  programs: string[];
}

export interface OfacSet {
  fetchedAt: string | null;
  /**
   * Normalized address → the SDN entries that list it. The lists are empty for addresses loaded
   * from a version 1 snapshot, which stored addresses only.
   */
  evm: Map<string, SdnEntry[]>;
  tron: Map<string, SdnEntry[]>;
}

const SdnEntrySchema = z.object({
  uid: z.number().int(),
  name: z.string(),
  programs: z.array(z.string()),
});

/** Stored form in the SQLite KV and in demo `ofac.json`: addresses reference entries by uid. */
const OfacSnapshotSchema = z.object({
  version: z.literal(2),
  fetchedAt: z.string(),
  entries: z.array(SdnEntrySchema),
  evm: z.record(z.string(), z.array(z.number().int())),
  tron: z.record(z.string(), z.array(z.number().int())),
});
export type OfacSnapshot = z.infer<typeof OfacSnapshotSchema>;

/** Version 1, written before SDN entries were kept: addresses only. Still loads. */
const LegacyOfacSnapshotSchema = z.object({
  fetchedAt: z.string(),
  evm: z.array(z.string()),
  tron: z.array(z.string()),
});

export const OFAC_KV_KEY = "ofac:sdn";

const ENTRY_RE = /<sdnEntry>([\s\S]*?)<\/sdnEntry>/g;
const ADDRESS_RE =
  /<idType>Digital Currency Address - [A-Z0-9]+<\/idType>\s*<idNumber>([^<]+)<\/idNumber>/g;
const PROGRAM_RE = /<program>([^<]*)<\/program>/g;
/** The entry's own uid and name come before these; akas, ids and addresses repeat those tags. */
const HEADER_END_RE = /<(?:sdnType|programList|idList|akaList)>/;
const XML_ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|quot|apos|amp);/g;
const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

function decodeXml(text: string): string {
  return text.replace(XML_ENTITY_RE, (match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
    return XML_ENTITIES[entity] ?? match;
  });
}

function headerField(header: string, tag: string): string | null {
  const value = header.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];
  return value === undefined ? null : decodeXml(value).trim();
}

/**
 * The SDN entries that list EVM or TRON addresses, by normalized address. The currency tag does
 * not identify the chain, so addresses are classified by format; other currencies are ignored.
 */
export function parseSdnXml(text: string): Pick<OfacSet, "evm" | "tron"> {
  const evm = new Map<string, SdnEntry[]>();
  const tron = new Map<string, SdnEntry[]>();
  for (const block of text.matchAll(ENTRY_RE)) {
    const body = block[1] ?? "";
    const headerEnd = body.search(HEADER_END_RE);
    const header = headerEnd === -1 ? body : body.slice(0, headerEnd);
    const uid = headerField(header, "uid");
    const lastName = headerField(header, "lastName");
    if (uid === null || !/^\d+$/.test(uid) || !lastName) continue;
    const firstName = headerField(header, "firstName");
    const entry: SdnEntry = {
      uid: Number(uid),
      name: firstName ? `${lastName}, ${firstName}` : lastName,
      programs: [...body.matchAll(PROGRAM_RE)].map((m) => decodeXml(m[1] ?? "").trim()),
    };
    for (const m of body.matchAll(ADDRESS_RE)) {
      const raw = (m[1] ?? "").trim();
      const isEvm = EVM_ADDRESS_RE.test(raw);
      if (!isEvm && !TRON_ADDRESS_RE.test(raw)) continue;
      const target = isEvm ? evm : tron;
      const address = isEvm ? raw.toLowerCase() : raw;
      const listed = target.get(address);
      if (!listed) target.set(address, [entry]);
      else if (!listed.includes(entry)) listed.push(entry);
    }
  }
  return { evm, tron };
}

export function emptyOfacSet(): OfacSet {
  return { fetchedAt: null, evm: new Map(), tron: new Map() };
}

/** Loads a version 2 snapshot, or a version 1 one whose addresses then carry no entries. */
export function ofacSetFromSnapshot(json: unknown): OfacSet {
  const current = OfacSnapshotSchema.safeParse(json);
  if (current.success) {
    const { fetchedAt, entries, evm, tron } = current.data;
    const byUid = new Map(entries.map((entry) => [entry.uid, entry]));
    const resolve = (index: Record<string, number[]>) =>
      new Map(
        Object.entries(index).map(([address, uids]) => [
          address,
          uids.map((uid) => {
            const entry = byUid.get(uid);
            if (!entry) throw new Error(`Invalid OFAC snapshot: unknown SDN entry ${uid}`);
            return entry;
          }),
        ]),
      );
    return { fetchedAt, evm: resolve(evm), tron: resolve(tron) };
  }
  const legacy = LegacyOfacSnapshotSchema.safeParse(json);
  if (legacy.success) {
    const { fetchedAt, evm, tron } = legacy.data;
    return {
      fetchedAt,
      evm: new Map(evm.map((address) => [address, []])),
      tron: new Map(tron.map((address) => [address, []])),
    };
  }
  throw new Error(
    "Invalid OFAC snapshot: expected {version: 2, fetchedAt, entries[], evm{}, tron{}} or {fetchedAt, evm[], tron[]}",
  );
}

export function ofacSnapshot(set: OfacSet): OfacSnapshot {
  const entries = new Map<number, SdnEntry>();
  const index = (addresses: Map<string, SdnEntry[]>) =>
    Object.fromEntries(
      [...addresses].map(([address, listed]) => {
        for (const entry of listed) entries.set(entry.uid, entry);
        return [address, listed.map((entry) => entry.uid)];
      }),
    );
  const evm = index(set.evm);
  const tron = index(set.tron);
  return { version: 2, fetchedAt: set.fetchedAt ?? "", entries: [...entries.values()], evm, tron };
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
        // A version 1 snapshot names no SDN entry: refresh it now rather than when it ages out.
        const named = ![...set.evm.values(), ...set.tron.values()].some((l) => l.length === 0);
        if (named && Number.isFinite(age) && age >= 0 && age < refreshMs) {
          return { set, warning: null };
        }
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
      const set: OfacSet = {
        fetchedAt: new Date(this.#o.now()).toISOString(),
        ...parseSdnXml(res.body),
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
