import type { AddressNode, Flag, TraceEdge } from "@fot/core/schema";
import { assetSymbol } from "./format.ts";
import { SEVERITY_ORDER } from "./meta.ts";
import type { Selection } from "./selection.ts";

/** Normalized characters needed before anything is searched. */
export const PALETTE_MIN_QUERY = 2;
/** Items shown per Addresses/Transfers/Flags group. */
export const PALETTE_GROUP_LIMIT = 6;
/** `limit` for `GET /api/runs`. */
export const PALETTE_RUN_LIMIT = 5;
export const PALETTE_RUN_DEBOUNCE_MS = 200;

export interface PaletteRunData {
  addresses: readonly AddressNode[];
  edges: readonly TraceEdge[];
  flags: readonly Flag[];
}

export interface PaletteGroup<T> {
  total: number;
  items: T[];
}

export interface PaletteMatches {
  addresses: PaletteGroup<AddressNode>;
  transfers: PaletteGroup<TraceEdge>;
  flags: PaletteGroup<Flag>;
}

interface PaletteEntry<T> {
  item: T;
  /** Lowercased text a query must be a substring of. */
  text: string;
  /** Lowercased values an exact or prefix match ranks first on. */
  keys: readonly string[];
}

export interface PaletteIndex {
  addresses: readonly PaletteEntry<AddressNode>[];
  transfers: readonly PaletteEntry<TraceEdge>[];
  /** In severity order; flags have no rank keys. */
  flags: readonly PaletteEntry<Flag>[];
}

export function normalizeQuery(raw: string): string {
  return raw.trim().toLocaleLowerCase();
}

/** ⌘K or Ctrl+K, accepted on every platform. */
export function isPaletteShortcut(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}

/** Lowercased text of a transfer: addresses, tx hash, asset, token contract and label names. */
export function transferSearchText(
  edge: TraceEdge,
  labels: ReadonlyMap<string, AddressNode>,
): string {
  const labelText = [edge.from, edge.to]
    .flatMap((address) => labels.get(address)?.labels.map((label) => label.name) ?? [])
    .join(" ");
  return [
    edge.from,
    edge.to,
    edge.transfer.txHash,
    assetSymbol(edge.transfer.asset),
    edge.transfer.asset.kind === "token" ? edge.transfer.asset.contract : "",
    labelText,
  ]
    .join(" ")
    .toLocaleLowerCase();
}

export function createPaletteIndex(data: PaletteRunData): PaletteIndex {
  const labels = new Map(data.addresses.map((node) => [node.address, node]));
  const addresses = data.addresses.map((node) => {
    const names = node.labels.map((label) => label.name);
    const entities = node.labels.flatMap((label) => (label.entity ? [label.entity] : []));
    return {
      item: node,
      text: [node.address, ...names, ...entities].join(" ").toLocaleLowerCase(),
      keys: [node.address, ...names, ...entities].map((key) => key.toLocaleLowerCase()),
    };
  });
  const transfers = data.edges.map((edge) => ({
    item: edge,
    text: transferSearchText(edge, labels),
    keys: [edge.transfer.txHash.toLocaleLowerCase()],
  }));
  const flags = [...data.flags]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .map((flag) => ({
      item: flag,
      text: [flag.title, flag.id, ...flag.evidence.addresses].join(" ").toLocaleLowerCase(),
      keys: [],
    }));
  return { addresses, transfers, flags };
}

function rank(keys: readonly string[], query: string): number {
  if (keys.some((key) => key === query)) return 0;
  if (keys.some((key) => key.startsWith(query))) return 1;
  return 2;
}

function searchGroup<T>(entries: readonly PaletteEntry<T>[], query: string): PaletteGroup<T> {
  const matches = entries
    .filter((entry) => entry.text.includes(query))
    .map((entry) => ({ item: entry.item, rank: rank(entry.keys, query) }))
    .sort((a, b) => a.rank - b.rank);
  return {
    total: matches.length,
    items: matches.slice(0, PALETTE_GROUP_LIMIT).map((match) => match.item),
  };
}

/** Matches `query` (already normalized) against the index: exact, then prefix, then substring. */
export function searchPalette(index: PaletteIndex, query: string): PaletteMatches {
  if (query.length < PALETTE_MIN_QUERY) {
    return {
      addresses: { total: 0, items: [] },
      transfers: { total: 0, items: [] },
      flags: { total: 0, items: [] },
    };
  }
  return {
    addresses: searchGroup(index.addresses, query),
    transfers: searchGroup(index.transfers, query),
    flags: searchGroup(index.flags, query),
  };
}

export function groupHeading(label: string, shown: number, total: number): string {
  return total <= shown ? label : `${label} · ${shown} of ${total}`;
}

/** The graph selection of a flag's evidence, as Flags → "Select … in graph" makes it. */
export function flagSelection(flag: Flag): Extract<Selection, { kind: "set" }> {
  return {
    kind: "set",
    addresses: [...new Set(flag.evidence.addresses)],
    edgeIds: flag.evidence.edgeIds,
    title: flag.title,
  };
}
