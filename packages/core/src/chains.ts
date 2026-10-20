export const CHAIN_IDS = ["ethereum", "polygon", "arbitrum", "tron"] as const;
export type ChainId = (typeof CHAIN_IDS)[number];

export interface ChainInfo {
  id: ChainId;
  kind: "evm" | "tron";
  evmChainId: number | null;
  nativeSymbol: string;
  nativeDecimals: number;
  nativePriceKey: string;
  llamaPrefix: string;
  explorer: string;
  txUrl(hash: string): string;
  addressUrl(address: string): string;
  zeroAddresses: readonly string[];
}

const EVM_ZERO = "0x0000000000000000000000000000000000000000";
const TRON_ZERO = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

function evmChain(
  id: ChainId,
  evmChainId: number,
  nativeSymbol: string,
  nativePriceKey: string,
  explorer: string,
): ChainInfo {
  return {
    id,
    kind: "evm",
    evmChainId,
    nativeSymbol,
    nativeDecimals: 18,
    nativePriceKey,
    llamaPrefix: id,
    explorer,
    txUrl: (hash) => `${explorer}/tx/${hash}`,
    addressUrl: (address) => `${explorer}/address/${address}`,
    zeroAddresses: [EVM_ZERO],
  };
}

export const CHAINS: Record<ChainId, ChainInfo> = {
  ethereum: evmChain("ethereum", 1, "ETH", "coingecko:ethereum", "https://etherscan.io"),
  polygon: evmChain(
    "polygon",
    137,
    "POL",
    "coingecko:polygon-ecosystem-token",
    "https://polygonscan.com",
  ),
  arbitrum: evmChain("arbitrum", 42161, "ETH", "coingecko:ethereum", "https://arbiscan.io"),
  tron: {
    id: "tron",
    kind: "tron",
    evmChainId: null,
    nativeSymbol: "TRX",
    nativeDecimals: 6,
    nativePriceKey: "coingecko:tron",
    llamaPrefix: "tron",
    explorer: "https://tronscan.org/#",
    txUrl: (hash) => `https://tronscan.org/#/transaction/${hash}`,
    addressUrl: (address) => `https://tronscan.org/#/address/${address}`,
    zeroAddresses: [TRON_ZERO],
  },
};

export const EVM_TX_RE = /^0x[0-9a-fA-F]{64}$/;
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const TRON_TX_RE = /^[0-9a-fA-F]{64}$/;
export const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export function normalizeAddress(chain: ChainId, address: string): string {
  return CHAINS[chain].kind === "evm" ? address.toLowerCase() : address;
}

export function normalizeTx(_chain: ChainId, hash: string): string {
  return hash.toLowerCase();
}

export function isValidTx(chain: ChainId, value: string): boolean {
  return (CHAINS[chain].kind === "evm" ? EVM_TX_RE : TRON_TX_RE).test(value);
}

export function isValidAddress(chain: ChainId, value: string): boolean {
  return (CHAINS[chain].kind === "evm" ? EVM_ADDRESS_RE : TRON_ADDRESS_RE).test(value);
}

export function isZeroAddress(chain: ChainId, address: string): boolean {
  return CHAINS[chain].zeroAddresses.includes(normalizeAddress(chain, address));
}

export interface CanonicalToken {
  symbol: string;
  contract: string;
  decimals: number;
  /** Priced 1:1 with USD without a price lookup. */
  stable: boolean;
  /** Other symbols the contract reports on-chain; spoof detection folds these too. */
  aliases: readonly string[];
}

const t = (
  symbol: string,
  contract: string,
  decimals: number,
  stable = false,
  aliases: readonly string[] = [],
): CanonicalToken => ({ symbol, contract, decimals, stable, aliases });

export const CANONICAL_TOKENS: Record<ChainId, readonly CanonicalToken[]> = {
  ethereum: [
    t("USDT", "0xdac17f958d2ee523a2206206994597c13d831ec7", 6, true),
    t("USDC", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6, true),
    t("DAI", "0x6b175474e89094c44da98b954eedeac495271d0f", 18, true),
    t("USDP", "0x8e870d67f660d95d5be530380d0ec0bd388289e1", 18, true),
    t("WETH", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", 18),
  ],
  polygon: [
    // Upgraded to USDT0; the contract now reports symbol "USDT0".
    t("USDT", "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", 6, true, ["USDT0"]),
    t("USDC", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", 6, true),
    t("USDC.e", "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", 6, true),
    t("DAI", "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", 18, true),
    t("WETH", "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", 18),
    t("WPOL", "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", 18),
  ],
  arbitrum: [
    // Upgraded to USDT0; the contract now reports symbol "USD₮0".
    t("USDT", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", 6, true, ["USD₮0", "USDT0"]),
    t("USDC", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", 6, true),
    t("USDC.e", "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", 6, true),
    t("DAI", "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", 18, true),
    t("WETH", "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", 18),
  ],
  tron: [
    t("USDT", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", 6, true),
    // Deprecated Circle USDC ("USD Coin Old"): kept for spoof detection, priced by lookup.
    t("USDC", "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8", 6, false, ["USDCOLD"]),
    // Has traded below peg historically, so it is priced by lookup rather than 1:1.
    t("USDD", "TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz", 18),
    t("WTRX", "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR", 6),
  ],
};

export function findCanonicalToken(chain: ChainId, contract: string): CanonicalToken | undefined {
  const c = normalizeAddress(chain, contract);
  return CANONICAL_TOKENS[chain].find((tok) => normalizeAddress(chain, tok.contract) === c);
}
