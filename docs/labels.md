# Labels

Labels turn raw addresses into names and categories (exchange, DEX, bridge, mixer, ...). The engine uses them to decide where to stop a trace, and the analysis uses them for exposure, touchpoints and flags. Bundled labels live in `packages/core/labels/<chain>.json`; you can add private ones without touching the repo (see [Local overrides](#local-overrides)).

## Source policy

Every bundled entry cites a public `source` URL that was opened and checked on the `verifiedAt` date. Only these source kinds are accepted:

1. **The entity's own disclosure**: exchange proof-of-reserves wallet lists, official documentation.
2. **Official protocol docs or GitHub deployment files**: DEX routers, bridges, Tornado Cash pools.
3. **The explorer's public name-tag page for that single address**: the URL is the address page itself (Etherscan, PolygonScan, Tronscan), and the page shows the tag you cite.
4. **Issuer docs for token contracts**: Tether, Circle, Sky, USDD, and the official Arbitrum token list.

Rules:

- **Verification rule.** An entry is added only after its source was actually opened and showed that address with that name. If the source cannot be confirmed, the entry is left out.
- **`verifiedAt`** is the date (`YYYY-MM-DD`) the source was checked. `labelsVersion` in results is the newest `verifiedAt` across the bundled files.
- **No unverified imports.** Third-party label dumps and older lists may be used as a list of candidates, never as a source. A candidate becomes an entry only after the check above.
- The label `name` is the name the source shows (for explorer tags, the tag as displayed), not a guess.
- Labels are heuristics from public data. Exchanges rotate wallets; absence of a label means "unknown", not "clean".

## Bundled file format

`packages/core/labels/<chain>.json`:

```json
{
  "chain": "ethereum",
  "entries": [
    {
      "address": "0x28c6c06298d514db089934071355e5743bf21d60",
      "name": "Binance 14",
      "category": "exchange",
      "entity": "Binance",
      "source": "https://etherscan.io/address/0x28c6c06298d514db089934071355e5743bf21d60",
      "verifiedAt": "2026-10-20"
    }
  ]
}
```

- `chain`: `ethereum`, `polygon`, `arbitrum` or `tron`.
- `address`: EVM addresses are lowercase; TRON addresses keep their base58 case. No duplicates per file.
- `category`: `exchange`, `dex`, `bridge`, `mixer`, `sanctioned`, `scam`, `defi`, `token` or `other`.
- `entity` (optional): the company or protocol behind the address (`Binance`, `Uniswap`, `Tornado Cash`).
- `source`: the exact URL that shows the address with that name; an `http:` or `https:` URL (`fot labels validate` rejects `javascript:`, `data:` and every other scheme).
- `verifiedAt`: see above.

Validate a file with `fot labels validate <file>`.

## Local overrides

Private labels (your own customers, cases, internal wallets) go in a local file loaded from `FOT_LABELS_PATH`:

```json
{
  "entries": [
    {
      "chain": "ethereum",
      "address": "0x0000000000000000000000000000000000000001",
      "name": "Case 42 suspect wallet",
      "category": "scam",
      "entity": "Case 42",
      "note": "Reported by customer support"
    }
  ]
}
```

- Fields: `chain`, `address`, `name`, `category`, `entity?`, `note?`.
- A local entry replaces the bundled entry for the same chain and address.
- Local labels carry `origin: "local"` and `source: "local"`, and results record `dataSources.localLabels: true`.
- The file is yours: never commit it to this repository.

## OFAC SDN

The sanctions list is not bundled. The server downloads OFAC's SDN XML (`OFAC_SDN_URL`) at boot and again whenever the stored snapshot is `OFAC_REFRESH_HOURS` old (fractions are honoured, minimum `0.1`, six minutes), and stores the parsed snapshot in SQLite. One-shot CLI commands (`fot trace`, `fot screen`) load the list once.

- Only `Digital Currency Address` ids that are EVM (`0x` + 40 hex) or TRON (`T` + 33 base58) addresses are kept. The currency tag (`ETH`, `USDT`, `TRX`, …) does not identify the chain, so addresses are classified by format.
- A sanctioned address gets one label per SDN entry that lists it (an address can sit on more than one entry):
  - `name` and `entity`: the entry name exactly as OFAC publishes it, `lastName` for entities and `lastName, firstName` for individuals (`LAZARUS GROUP`, `MESRI, Behzad`). Exposure by entity, flags and the CSV `entities` column therefore group by the sanctioned party.
  - `programs`: the entry's sanctions programs (`["DPRK3"]`). A program is the legal authority, not the party (one program covers many unrelated entries), so it is never used as `entity`.
  - `source`: the entry's page on OFAC's sanctions search, `https://sanctionssearch.ofac.treas.gov/Details.aspx?id=<uid>`, which lists its addresses.
  - `category: "sanctioned"`, `origin: "ofac"`.
- **Order.** SDN labels come first, before the bundled or local label of the same address, so anything that shows only the first label (graph node, Path view, touchpoint names, the first name in the CSV `labels` column) shows the sanctions match; the other label stays in the list. Stops, exposure and flags do not depend on the order: `sanctioned` always ranks first.
- **Snapshots.** Version 2 (`ofac:sdn` in the SQLite KV, `ofac.json` in demo scenarios) is `{version, fetchedAt, entries: [{uid, name, programs}], evm: {address: [uid]}, tron: {…}}`. Version 1 snapshots (`{fetchedAt, evm[], tron[]}`, addresses only) still load, and their addresses carry the constant label `OFAC SDN` without entity. A version 1 snapshot in the KV is downloaded again at the next load even when it is younger than `OFAC_REFRESH_HOURS`, and is kept if that download fails.
- **Failed downloads.** A response counts as a download only if it is a complete SDN document (with both `<sdnList` and `</sdnList>`) and holds at least one EVM or TRON address. An HTTP error, a maintenance page, a format change or a cut-off body keeps the previous snapshot in use and in SQLite, and the server logs `OFAC SDN list unavailable (<reason>); using stale snapshot` (at boot as warning `ofac_unavailable`, then at each failed retry). Without a previous snapshot the list is empty and sanctions screening is off (`… sanctions screening disabled`, `ofacFetchedAt: null` in `GET /api/health`; `GET /api/screen` answers `ofac.available: false` and `fot screen` exits 4; a trace raises `incomplete_trace`, its addresses show "not screened" in the workspace and `fot trace` exits 4). A run's labels and its `dataSources.ofacFetchedAt` come from the same snapshot: the one loaded when the run (or its expansion) started.
- **Retries.** While no snapshot younger than `OFAC_REFRESH_HOURS` is loaded (a failed boot load, or only a stale snapshot), `fot serve` retries after 1, 2 and 5 minutes, then every 15 minutes, and returns to the regular refresh after the first good download.

## OKX proof of reserves

OKX and Okcoin addresses on Arbitrum and Polygon come from OKX's monthly reserves snapshot, a "Reserves" file on [okx.com/proof-of-reserves/download](https://www.okx.com/proof-of-reserves/download) (source kind 1).

- **Import.** `bun scripts/okx-por.ts <snapshot zip URL>` (needs `unzip`) reads the snapshot's `ARBITRUM` and `POLYGON` rows and rewrites `arbitrum.json` and `polygon.json`; commit the result. Each address becomes one `exchange` entry named after its entity: `OKX`, or `Okcoin` for rows that say "I am an Okcoin address". The snapshot URL is its `source` and the import date its `verifiedAt`.
- **Signatures.** Every row is verified before it becomes a label, as OKX's own [VerifyAddress tool](https://github.com/okx/proof-of-reserves) does: the signer of `keccak256("\x19Ethereum Signed Message:\n32" ‖ keccak256(message))` must be the address or, for a contract wallet, each owner listed in `EOA1` and `EOA2`. A row that does not verify, an unknown message or an address listed for both entities stops the import before any file is written.
- **Later snapshots** update the `source` and `verifiedAt` of the addresses they list and add new addresses after the file's exchange entries. An address a later snapshot no longer lists keeps its earlier snapshot as its source: OKX controlled it then, which is what a trace through older transfers needs. An address already labeled from another source stays as it is when it names the same entity, and stops the import when it names another.
- **Ethereum and TRON are not imported.** Their lists hold 23,944 and 474,530 addresses (2026-11-01 snapshot), deposit addresses included: too many to bundle.

## Contributing a label

Open a pull request that edits the relevant `packages/core/labels/<chain>.json` file:

- Add one entry per address in the format above, with a `source` URL per entry that you opened and that shows the address with that name.
- Use the name the source shows; set `verifiedAt` to the day you checked.
- Run `fot labels validate packages/core/labels/<chain>.json` and `bun run check`.
- Do not paste entries from private or unverifiable lists; PRs without a source per entry are closed.

## Coverage

Counts as of 2026-11-20 (entries per category):

| Chain | exchange | dex | bridge | mixer | token | Total |
|---|---:|---:|---:|---:|---:|---:|
| Ethereum | 61 | 15 | 15 | 26 | 5 | 122 |
| Polygon | 102 | 10 | 8 | 4 | 6 | 130 |
| Arbitrum | 119 | 8 | 6 | 4 | 5 | 142 |
| TRON | 53 | 8 | 14 | 0 | 4 | 79 |

Known gaps (these are gaps in verified coverage, not statements that the entities are absent):

- **Arbitrum exchanges: OKX and Okcoin only**, from OKX's signed reserves list (see [OKX proof of reserves](#okx-proof-of-reserves)). Arbiscan blocks automated access, so address tags there could not be opened, and no other exchange discloses Arbitrum addresses in a source we could check.
- **TRON mixers: none.** TRON exchange coverage is Binance, OKX (1), Bybit, Kraken, KuCoin, Gate (1), HTX, Bitget and MEXC (1, tagged `MXC`, the exchange's name before its 2021 rebrand to MEXC). Crypto.com has no tagged TRON addresses that could be verified.
- **Coinbase and Crypto.com**: Ethereum only (Coinbase has no verified Polygon/TRON entries).
- **Gate on Ethereum** is listed through the explorer's `Gate Deposit` tags only (deposit-side addresses), not hot wallets.
- **Mixers**: Tornado Cash pools only on Ethereum, Polygon and Arbitrum; Tornado Cash is the only mixer covered.
- **Bridges** cover Stargate, Across, Hop, Celer cBridge, deBridge, the Polygon PoS bridge (Ethereum side), the THORChain router (Ethereum) and the Arbitrum gateways/inbox where a source was found. On TRON they cover the BitTorrent Chain (BTTC) bridge proxies, deBridge DLN, Allbridge Core (the bridge and pools used until July 2026 and the current OFT interface) and the USDT0 Legacy Mesh, all from the protocols' own documentation. The BTTC bridge and the Allbridge Core pools are discontinued; their labels stay for older transfers. THORChain's TRON inbound address is a rotating vault without a router contract, so it is not labeled. Other bridges are not covered.
- **DEX coverage** is routers only (Uniswap, 1inch, 0x, Velora/ParaSwap, SushiSwap, Curve, QuickSwap, PancakeSwap, CoW, OKX DEX, SunSwap); pools and aggregators not listed are unlabeled.
- **Tokens**: canonical stablecoins and wrapped natives only. On Polygon and Arbitrum the Tether token is now the USDT0 deployment (symbol `USDT0` / `USD₮0`), and the TRON USDC contract is the deprecated "USD Coin Old".
- The OFAC SDN list is a separate source (`origin: "ofac"`), loaded at runtime rather than bundled; see [OFAC SDN](#ofac-sdn).
