import { expect, test } from "bun:test";
import {
  CANONICAL_TOKENS,
  CHAINS,
  isValidAddress,
  isValidTx,
  normalizeAddress,
  normalizeTx,
} from "../src/chains.ts";

const evmTx = `0x${"ab".repeat(32)}`;
const evmAddr = `0x${"Cd".repeat(20)}`;
const tronAddr = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

test("validation regexes", () => {
  expect(isValidTx("ethereum", evmTx)).toBe(true);
  expect(isValidTx("ethereum", "ab".repeat(32))).toBe(false);
  expect(isValidTx("tron", "AB".repeat(32))).toBe(true);
  expect(isValidTx("tron", evmTx)).toBe(false);
  expect(isValidAddress("polygon", evmAddr)).toBe(true);
  expect(isValidAddress("polygon", tronAddr)).toBe(false);
  expect(isValidAddress("tron", tronAddr)).toBe(true);
  expect(isValidAddress("tron", `${tronAddr}x`)).toBe(false);
  expect(isValidAddress("tron", "T0yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb")).toBe(false);
});

test("normalization", () => {
  expect(normalizeAddress("arbitrum", evmAddr)).toBe(evmAddr.toLowerCase());
  expect(normalizeAddress("tron", tronAddr)).toBe(tronAddr);
  expect(normalizeTx("ethereum", `0x${"AB".repeat(32)}`)).toBe(evmTx);
  expect(normalizeTx("tron", "AB".repeat(32))).toBe("ab".repeat(32));
});

test("explorer urls and zero addresses", () => {
  expect(CHAINS.ethereum.txUrl("0x1")).toBe("https://etherscan.io/tx/0x1");
  expect(CHAINS.tron.addressUrl("Tx")).toBe("https://tronscan.org/#/address/Tx");
  expect(CHAINS.tron.zeroAddresses).toContain("T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb");
  expect(CHAINS.polygon.nativeSymbol).toBe("POL");
});

test("canonical token contracts are normalized per chain", () => {
  for (const chain of ["ethereum", "polygon", "arbitrum"] as const) {
    for (const tok of CANONICAL_TOKENS[chain]) {
      expect(isValidAddress(chain, tok.contract)).toBe(true);
      expect(tok.contract).toBe(tok.contract.toLowerCase());
    }
  }
  for (const tok of CANONICAL_TOKENS.tron) expect(isValidAddress("tron", tok.contract)).toBe(true);
});
