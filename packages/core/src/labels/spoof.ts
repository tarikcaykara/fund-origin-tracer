import { CANONICAL_TOKENS, normalizeAddress } from "../chains.ts";
import type { Asset } from "../schema.ts";
import { CONFUSABLE_LETTERS } from "./confusables.ts";

/** Look-alike character → the Latin capital letter it imitates. */
const LOOK_ALIKES = new Map<string, string>([
  ...Object.entries(CONFUSABLE_LETTERS).flatMap(([letter, codePoints]) =>
    codePoints.map((cp): [string, string] => [String.fromCodePoint(cp), letter]),
  ),
  // Tether's own "USD₮" branding: fold to T so look-alikes of USDT are caught.
  ["₮", "T"],
]);

const LEET: Record<string, string> = { "0": "O", "1": "I", "3": "E", "5": "S", "8": "B" };

/**
 * NFKD (fullwidth, mathematical and circled letters become plain ones, accented letters split
 * into letter and mark) without combining marks and invisible characters such as zero-width
 * spaces.
 */
export function decomposeSymbol(symbol: string): string {
  return symbol.normalize("NFKD").replace(/[\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}]/gu, "");
}

/**
 * Confusable skeleton of a token symbol, in the style of Unicode TR39. Each character is mapped
 * as a look-alike when it is one (before NFKD, which can change its shape: lunate sigma `Ϲ`
 * becomes `Σ`); otherwise it is decomposed, and each part is mapped as a look-alike, a leet digit
 * or its uppercase form. Only letters and `.` are kept; modifier letters (spacing accents, tone
 * letters) go with the other non-letters. A letter without a Latin look-alike stays, so it can
 * never shorten a symbol into a canonical one or empty it.
 */
export function foldSymbol(symbol: string): string {
  let out = "";
  for (const ch of symbol) {
    const letter = LOOK_ALIKES.get(ch);
    if (letter !== undefined) {
      out += letter;
      continue;
    }
    for (const part of decomposeSymbol(ch)) {
      const upper = part.toUpperCase();
      out += LOOK_ALIKES.get(part) ?? LOOK_ALIKES.get(upper) ?? LEET[upper] ?? upper;
    }
  }
  return out.replace(/[^\p{Lu}\p{Ll}\p{Lt}\p{Lo}.]/gu, "");
}

export function isSpoofed(asset: Asset): boolean {
  if (asset.kind !== "token") return false;
  const folded = foldSymbol(asset.symbol);
  const contract = normalizeAddress(asset.chain, asset.contract);
  const canonical = CANONICAL_TOKENS[asset.chain];
  // A canonical contract is never a spoof, whatever symbol it reports.
  if (canonical.some((t) => normalizeAddress(asset.chain, t.contract) === contract)) return false;
  return canonical.some((t) => [t.symbol, ...t.aliases].some((s) => foldSymbol(s) === folded));
}
