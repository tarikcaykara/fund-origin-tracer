import { describe, expect, test } from "bun:test";
import { keccak256, toBytes } from "viem";
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import type { BundledLabelEntry, BundledLabelFile } from "../src/labels/files.ts";
import { mergeOkxPor, type OkxPorAddress, readOkxPor } from "../src/labels/okx-por.ts";

// Real rows of OKX's 2026-11-01 reserves snapshot: the summary section, the header, a BTC and an
// ETH row (other networks), and Arbitrum and Polygon rows signed directly, by one owner (EOA1) and
// by two owners (EOA1 + EOA2); the Okcoin address appears in two rows.
const fixture = await Bun.file(
  new URL("./fixtures/okx-por/por-fragment.csv", import.meta.url),
).text();
const lines = (text: string) => text.split("\n");

const HEADER =
  "coin,Type,Network,Snapshot Height,address,amount,message,signature1,signature2,redeem script/ public key,EOA1,EOA2";

/** A Polygon row signed the way OKX signs EVM rows, by a key made for the test. */
async function signedRow(account: PrivateKeyAccount, message: string): Promise<string> {
  const signature = await account.signMessage({ message: { raw: keccak256(toBytes(message)) } });
  return `USDT-POLY,Non Staking,POLYGON,1,${account.address.toLowerCase()},1,${message},${signature},,,,`;
}

const SNAPSHOT_1 = "https://static.okx.com/cdn/okx/por/chain/por_csv_2026100300_V4.zip";
const SNAPSHOT_2 = "https://static.okx.com/cdn/okx/por/chain/por_csv_2026110100_V1.zip";

describe("readOkxPor", () => {
  test("returns one verified entry per Arbitrum and Polygon address", async () => {
    expect(await readOkxPor(lines(fixture))).toEqual([
      { chain: "arbitrum", address: "0x03426aacbcf9030a380b3ba4a1f16b968649ef3d", entity: "OKX" },
      {
        chain: "arbitrum",
        address: "0x126d0c3f792b99ec831990c5ef23badda9c95f5e",
        entity: "Okcoin",
      },
      { chain: "arbitrum", address: "0x1d22bd71ac3ef6f35e34715a1414f71e3252d319", entity: "OKX" },
      { chain: "polygon", address: "0x000000000000d5775ff7721cefb8097af62e52dd", entity: "OKX" },
      { chain: "polygon", address: "0x1580369ded0e83e0ea8a51c416a9ac28590b9526", entity: "OKX" },
    ]);
  });

  test("a row whose signature does not verify throws, also when its owners sign", async () => {
    // A direct signature and the owner signature of a contract wallet, each with one digit changed.
    for (const address of [
      "0x03426aacbcf9030a380b3ba4a1f16b968649ef3d",
      "0x1d22bd71ac3ef6f35e34715a1414f71e3252d319",
    ]) {
      const tampered = lines(fixture).map((line) => {
        if (!line.includes(address)) return line;
        const fields = line.split(",");
        const signature = fields[7] ?? "";
        fields[7] = `${signature.slice(0, 10)}${signature[10] === "0" ? "1" : "0"}${signature.slice(11)}`;
        return fields.join(",");
      });
      await expect(readOkxPor(tampered)).rejects.toThrow(address);
    }
  });

  test("a signed row with an unknown message, or one address for two entities, throws", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const address = account.address.toLowerCase();
    const okx = await signedRow(account, "I am an OKX address");
    // The test key signs the way OKX does, so a failure below is not a signature failure.
    expect(await readOkxPor([HEADER, okx])).toEqual([{ chain: "polygon", address, entity: "OKX" }]);

    const binance = await signedRow(account, "I am a Binance address");
    await expect(readOkxPor([HEADER, binance])).rejects.toThrow("I am a Binance address");

    const okcoin = await signedRow(account, "I am an Okcoin address");
    await expect(readOkxPor([HEADER, okx, okcoin])).rejects.toThrow(address);
  });

  test("a file without the address header throws instead of returning nothing", async () => {
    await expect(readOkxPor(lines(fixture).filter((line) => line !== HEADER))).rejects.toThrow(
      "header",
    );
  });
});

const entry = (overrides: Partial<BundledLabelEntry>): BundledLabelEntry => ({
  address: "0x0000000000000000000000000000000000000001",
  name: "OKX",
  category: "exchange",
  entity: "OKX",
  source: SNAPSHOT_1,
  verifiedAt: "2026-10-03",
  ...overrides,
});

const found = (address: string, entity: OkxPorAddress["entity"] = "OKX"): OkxPorAddress => ({
  chain: "polygon",
  address,
  entity,
});

describe("mergeOkxPor", () => {
  const binance = entry({
    address: "0x082489a616ab4d46d1947ee3f912e080815b08da",
    name: "Binance 53",
    entity: "Binance",
    source: "https://polygonscan.com/address/0x082489a616ab4d46d1947ee3f912e080815b08da",
    verifiedAt: "2026-10-20",
  });
  const token = entry({
    address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    name: "USDT0",
    category: "token",
    entity: "Tether",
    source: "https://polygonscan.com/token/0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    verifiedAt: "2026-10-20",
  });

  test("adds new addresses after the exchange entries, sorted, for the file's chain only", () => {
    const file: BundledLabelFile = { chain: "polygon", entries: [binance, token] };
    const merged = mergeOkxPor(
      file,
      [
        found("0x00000000000000000000000000000000000000bb", "Okcoin"),
        found("0x00000000000000000000000000000000000000aa"),
        { chain: "arbitrum", address: "0x00000000000000000000000000000000000000cc", entity: "OKX" },
      ],
      SNAPSHOT_2,
      "2026-11-19",
    );
    const added = { source: SNAPSHOT_2, verifiedAt: "2026-11-19" };
    expect(merged.file.entries).toEqual([
      binance,
      entry({ ...added, address: "0x00000000000000000000000000000000000000aa" }),
      entry({
        ...added,
        address: "0x00000000000000000000000000000000000000bb",
        name: "Okcoin",
        entity: "Okcoin",
      }),
      token,
    ]);
    expect([merged.added, merged.updated, merged.kept]).toEqual([2, 0, []]);
  });

  test("a newer snapshot updates the entries it lists and keeps the ones it no longer lists", () => {
    const listed = entry({ address: "0x00000000000000000000000000000000000000aa" });
    const dropped = entry({ address: "0x00000000000000000000000000000000000000bb" });
    const file: BundledLabelFile = { chain: "polygon", entries: [binance, listed, dropped, token] };
    const merged = mergeOkxPor(file, [found(listed.address)], SNAPSHOT_2, "2026-11-19");
    expect(merged.file.entries).toEqual([
      binance,
      { ...listed, source: SNAPSHOT_2, verifiedAt: "2026-11-19" },
      dropped,
      token,
    ]);
    expect([merged.added, merged.updated]).toEqual([0, 1]);
  });

  test("an address labeled from another source is kept for OKX and refused for another entity", () => {
    const tagged = entry({
      address: "0x00000000000000000000000000000000000000aa",
      name: "OKX 3",
      source: "https://polygonscan.com/address/0x00000000000000000000000000000000000000aa",
      verifiedAt: "2026-10-20",
    });
    const file: BundledLabelFile = { chain: "polygon", entries: [binance, tagged, token] };
    const kept = mergeOkxPor(file, [found(tagged.address)], SNAPSHOT_2, "2026-11-19");
    expect(kept.file.entries).toEqual(file.entries);
    expect(kept.kept).toEqual([tagged.address]);

    expect(() => mergeOkxPor(file, [found(binance.address)], SNAPSHOT_2, "2026-11-19")).toThrow(
      "Binance",
    );
  });

  test("a source that is not an OKX snapshot URL throws", () => {
    const file: BundledLabelFile = { chain: "polygon", entries: [] };
    expect(() =>
      mergeOkxPor(file, [], "https://www.okx.com/proof-of-reserves/download", "2026-11-19"),
    ).toThrow("snapshot");
  });
});
