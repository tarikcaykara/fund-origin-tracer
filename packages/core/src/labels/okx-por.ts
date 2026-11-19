import { type Hex, keccak256, recoverMessageAddress, toBytes } from "viem";
import type { ChainId } from "../chains.ts";
import type { BundledLabelEntry, BundledLabelFile } from "./files.ts";

/** OKX's reserve snapshots (https://www.okx.com/proof-of-reserves/download) are zipped CSVs here. */
export const OKX_POR_SNAPSHOT_URL_RE =
  /^https:\/\/static\.okx\.com\/cdn\/okx\/por\/chain\/por_csv_\w+\.zip$/;

/**
 * Snapshot `Network` values that are imported, and their chains. The Ethereum and TRON lists
 * include deposit addresses (tens and hundreds of thousands) and are too large to bundle.
 */
export const OKX_POR_NETWORKS: Readonly<Record<string, ChainId>> = {
  ARBITRUM: "arbitrum",
  POLYGON: "polygon",
};

export type OkxPorEntity = "OKX" | "Okcoin";

const ENTITY_BY_MESSAGE: Readonly<Record<string, OkxPorEntity>> = {
  "I am an OKX address": "OKX",
  "I am an Okcoin address": "Okcoin",
};

export interface OkxPorAddress {
  chain: ChainId;
  /** Lowercase. */
  address: string;
  entity: OkxPorEntity;
}

interface Columns {
  network: number;
  address: number;
  message: number;
  signature1: number;
  signature2: number;
  owner1: number;
  owner2: number;
}

/** Column positions from the address section's header, or null for any other line. */
function columnsOf(fields: readonly string[]): Columns | null {
  const columns = {
    network: fields.indexOf("Network"),
    address: fields.indexOf("address"),
    message: fields.indexOf("message"),
    signature1: fields.indexOf("signature1"),
    signature2: fields.indexOf("signature2"),
    owner1: fields.indexOf("EOA1"),
    owner2: fields.indexOf("EOA2"),
  };
  return Object.values(columns).includes(-1) ? null : columns;
}

/**
 * The lowercase address that signed an OKX EVM row. OKX signs `keccak256(message)` as a 32-byte
 * personal message (`HashEvmCoinTypeMsg` in github.com/okx/proof-of-reserves), not the message
 * text, so `personal_sign` over the text never verifies.
 */
async function signerOf(message: string, signature: string): Promise<string | null> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  const signer = await recoverMessageAddress({
    message: { raw: keccak256(toBytes(message)) },
    signature: signature as Hex,
  }).catch(() => null);
  return signer?.toLowerCase() ?? null;
}

/**
 * Reads the address section of an OKX reserves CSV and keeps the rows on `networks`. Every row is
 * verified as OKX's VerifyAddress tool does: by its own signature, or for a contract wallet by the
 * signatures of its owners (`EOA1` with `signature1`, `EOA2` with `signature2`); here every listed
 * owner must verify. Returns one entry per chain and address, sorted. Throws on a row that does not
 * verify, a message other than OKX's or Okcoin's, an address listed for both, or a file without
 * the address header, so nothing unverified is ever labeled.
 */
export async function readOkxPor(
  lines: Iterable<string> | AsyncIterable<string>,
  networks: Readonly<Record<string, ChainId>> = OKX_POR_NETWORKS,
): Promise<OkxPorAddress[]> {
  let columns: Columns | null = null;
  const found = new Map<string, OkxPorAddress>();
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    const fields = line.split(",");
    if (columns === null) {
      columns = columnsOf(fields);
      continue;
    }
    const network = fields[columns.network] ?? "";
    // Own keys only: a plain object also answers "constructor" and other prototype names.
    const chain = Object.hasOwn(networks, network) ? networks[network] : undefined;
    if (chain === undefined) continue;
    const address = (fields[columns.address] ?? "").toLowerCase();
    const where = `OKX reserves CSV line ${lineNumber}: ${address} on ${network}`;
    const message = fields[columns.message] ?? "";
    const entity = Object.hasOwn(ENTITY_BY_MESSAGE, message)
      ? ENTITY_BY_MESSAGE[message]
      : undefined;
    if (entity === undefined) throw new Error(`${where}: unknown message "${message}"`);

    const signers = [
      [fields[columns.owner1] ?? "", fields[columns.signature1] ?? ""],
      [fields[columns.owner2] ?? "", fields[columns.signature2] ?? ""],
    ].filter(([owner]) => owner !== "");
    if (signers.length === 0) signers.push([address, fields[columns.signature1] ?? ""]);
    for (const [owner = "", signature = ""] of signers) {
      if ((await signerOf(message, signature)) !== owner.toLowerCase()) {
        throw new Error(`${where}: the signature of ${owner} does not verify`);
      }
    }

    const key = `${chain}:${address}`;
    const listed = found.get(key);
    if (listed !== undefined && listed.entity !== entity) {
      throw new Error(`${where}: listed for both ${listed.entity} and ${entity}`);
    }
    found.set(key, { chain, address, entity });
  }
  if (columns === null) {
    throw new Error(
      "OKX reserves CSV: no address header (Network, address, message, signature1, signature2, EOA1, EOA2)",
    );
  }
  return [...found.values()].sort((a, b) =>
    a.chain === b.chain ? (a.address < b.address ? -1 : 1) : a.chain < b.chain ? -1 : 1,
  );
}

export interface OkxPorMerge {
  file: BundledLabelFile;
  added: number;
  updated: number;
  /** Addresses already labeled for the same entity from another source, left as they were. */
  kept: string[];
}

/**
 * Merges verified addresses into a bundled label file. An address labeled from an earlier
 * snapshot takes this snapshot as its source; a new address is added after the file's exchange
 * entries, sorted; an address the snapshot no longer lists keeps its earlier snapshot, which still
 * shows it. An address labeled from another source is kept when it names the same entity and
 * refused when it names another.
 */
export function mergeOkxPor(
  file: BundledLabelFile,
  found: readonly OkxPorAddress[],
  source: string,
  verifiedAt: string,
): OkxPorMerge {
  // Later imports recognize their own entries by this URL.
  if (!OKX_POR_SNAPSHOT_URL_RE.test(source)) {
    throw new Error(`not an OKX reserves snapshot URL: ${source}`);
  }
  const entries = [...file.entries];
  const byAddress = new Map(entries.map((entry, index) => [entry.address, { entry, index }]));
  const added: BundledLabelEntry[] = [];
  const kept: string[] = [];
  let updated = 0;
  for (const { chain, address, entity } of found) {
    if (chain !== file.chain) continue;
    const labeled = byAddress.get(address);
    if (labeled === undefined) {
      added.push({ address, name: entity, category: "exchange", entity, source, verifiedAt });
      continue;
    }
    const { entry, index } = labeled;
    if (entry.entity !== entity) {
      throw new Error(
        `${address} is labeled ${entry.entity ?? entry.name}; OKX's reserves list it for ${entity}`,
      );
    }
    if (OKX_POR_SNAPSHOT_URL_RE.test(entry.source)) {
      entries[index] = { ...entry, source, verifiedAt };
      updated++;
    } else {
      kept.push(address);
    }
  }
  added.sort((a, b) => (a.address < b.address ? -1 : 1));
  const afterExchanges = entries.findLastIndex((entry) => entry.category === "exchange") + 1;
  entries.splice(afterExchanges, 0, ...added);
  return { file: { ...file, entries }, added: added.length, updated, kept };
}
