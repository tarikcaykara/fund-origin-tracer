import { CANONICAL_TOKENS, normalizeAddress } from "../chains.ts";
import type { Asset } from "../schema.ts";

const HOMOGLYPHS: Record<string, string> = {
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  У: "Y",
  І: "I",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
  // Tether's own "USD₮" branding: fold to T so look-alikes of USDT are caught.
  "₮": "T",
};

const LEET: Record<string, string> = { "0": "O", "1": "I", "3": "E", "5": "S", "8": "B" };

export function foldSymbol(symbol: string): string {
  let out = "";
  for (const ch of symbol.normalize("NFKC").toUpperCase()) {
    out += HOMOGLYPHS[ch] ?? LEET[ch] ?? ch;
  }
  return out.replace(/[^A-Z.]/g, "");
}

export function isSpoofed(asset: Asset): boolean {
  if (asset.kind !== "token") return false;
  const folded = foldSymbol(asset.symbol);
  if (folded === "") return false;
  const contract = normalizeAddress(asset.chain, asset.contract);
  const canonical = CANONICAL_TOKENS[asset.chain];
  // A canonical contract is never a spoof, whatever symbol it reports.
  if (canonical.some((t) => normalizeAddress(asset.chain, t.contract) === contract)) return false;
  return canonical.some((t) => [t.symbol, ...t.aliases].some((s) => foldSymbol(s) === folded));
}
