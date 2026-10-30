# Methodology

How fund-origin-tracer decides what to follow, what to stop at, and what to report. Every constant below is taken from the code (file noted in each section); if this page and the code disagree, the code wins and the page is a bug.

The tool is a heuristic. On account-based chains (Ethereum, Polygon, Arbitrum, TRON) there is no input-to-output link between transfers, so "these funds came from there" is always a **hypothesis ranked by amount and time proximity**, never proof. Read results as leads for an investigation, not as findings.

## Terms

| Term | Meaning |
|---|---|
| Direction | `backward` = where did the funds come from (source of funds). `forward` = where did they go (destination of funds). |
| Seed | A starting point: a transaction hash (`tx`) or an address (`address`). 1–20 seeds per run (`s1`…`s20`). |
| Edge | One transfer in the graph. `from`/`to` are the transfer's endpoints. |
| `far` | The counterparty being followed: `from` when backward, `to` when forward. |
| `near` | The other endpoint: `to` when backward, `from` when forward. |
| Depth | Seed edges have depth 0; each selected child has parent depth + 1. |
| Hops | `depth + 1`. Exposure uses hops: a labeled `far` on a seed edge is 1 hop (direct). |
| Subject | The address whose history is listed to expand an edge: `far`, or `near` for a swap-through edge. |

## How a trace runs

Source: `packages/core/src/engine/trace.ts`, `engine/score.ts`.

1. **Load seeds** (up to `concurrency` seeds in parallel).
2. **Schedule** edges in a priority queue and expand up to `concurrency` of them at a time.
3. For every popped edge, run the **per-edge checks**; if none stops it, **expand**: list the subject's transfers, drop, score, select, create children.
4. Stop when the queue is empty, or on cancel, timeout or a fatal error. Then run the analysis (below).

### Seeds

| Seed | What becomes seed edges (depth 0) |
|---|---|
| `tx` | All transfers of the transaction with `amount > 0` and neither endpoint a zero address (native, token, and on EVM internal transfers). Sorted by USD value descending (unpriced last, then input order). At most **10** legs are kept (`MAX_SEED_LEGS`). |
| `address` | The address's transfers in the trace direction, with no time bound, newest first: incoming (`to === address`) for backward, outgoing (`from === address`) for forward. Zero-value, self-transfers and spoofed-token transfers are skipped, duplicates removed. Ranked by USD descending (unpriced counts as 0), ties newest first. The top `maxBranches` become seed edges. |

Seed failures:

- A seed that cannot be loaded (`not_found`, `tx_failed`) is skipped with warning `seed_failed:<id>`.
- A seed with no usable transfers produces warning `seed_empty:<id>`; a seed whose transfer already exists from an earlier seed produces `seed_duplicate:<id>`.
- If **every** seed fails, the run ends `failed` with error `seeds_failed`.
- A fatal provider error (invalid key, chain needs a paid plan, all Tronscan keys exhausted) ends the run `failed`.

### Scheduler

- Queue order: depth ascending, then seed order, then selection rank, then creation order. Shallow, high-ranked edges are expanded first.
- `concurrency` expansions in flight (default 4, `ENGINE_CONCURRENCY` 1–32; demo replays use 1).
- `maxEdges` counts **expansions started**, reserved before the first network call, so the limit is exact under concurrency.
- Pause stops new work at the next gate; resume continues. Cancel and timeout (`timeoutSec`, measured from the start of the trace phase) stop in-flight and queued edges with `cancelled` / `timeout`.
- A progress event is emitted every 1000 ms.

### Per-edge checks

Applied in this order when an edge is popped. The first match stops the edge (`status: "stopped"`, with its `stopReason`).

| # | Check | Stop reason |
|---|---|---|
| 1 | `far` is the chain's zero address | `mint` |
| 2 | `far` is on the OFAC SDN list or carries a `sanctioned` label | `sanctioned` |
| 3 | `far` carries a label whose category is in the stop set (skipped for swap-through edges) | `entity` (detail = label name) |
| 4 | `far` is already in the edge's path (skipped for swap-through edges) | `cycle` |
| 5 | `edge.depth >= maxDepth` | `max_depth` |
| 6 | expansions started `>= maxEdges` | `max_edges` |

Otherwise the edge is expanded.

**Stop set** for check 3: `exchange`, `dex`, `bridge`, `mixer`, `scam`, `token` by default. With `traceThroughEntities` only `mixer` stops the trace. `defi` and `other` labels never stop a trace.

**Path** (check 4) is the chain of subject addresses from the seed to this edge, so cycles are detected **per path**: the same address reached through two different branches is not a cycle. Transfers that already exist in the graph are linked, not re-expanded (the graph is a DAG).

### Expansion

For the subject address the engine asks the explorer for its transfers in the trace direction:

- backward: incoming transfers with a time bound at the edge's timestamp `t`;
- forward: outgoing transfers starting at `t`.

Rows are deduplicated, then each is priced (one batched price lookup per expansion) and put through the drop checks.

#### Drop reasons

Checked in this order; the first that applies is the reason. `TIME_TOLERANCE_SEC = 5` (`engine/score.ts`).

| # | Reason | Condition |
|---|---|---|
| 1 | `same_tx` | Same transaction hash as the edge being expanded |
| 2 | `self_transfer` | `from` equals `to` |
| 3 | `zero_value` | Raw amount is `0` |
| 4 | `spoofed_token` | Look-alike of a canonical token (see [Spoofed tokens](#spoofed-tokens)) |
| 5 | `outside_time_window` | Backward: `timestamp > t + 5`. Forward: `timestamp < t − 5` |
| 6 | `unpriced` | No USD price, and `minUsd > 0` or `followUnpriced` is false (the default). Not applied while the expansion's price lookup failed (`prices_unavailable`) unless `minUsd > 0` |
| 7 | `below_min_usd` | `minUsd > 0` and USD value `< minUsd` |
| 8 | `exceeds_max_branches` | Scored but ranked below the top `maxBranches` |

The "5 s" tolerance exists because the explorer's time bound is resolved to a block, so a candidate in the same block as the edge can carry a timestamp a few seconds either side.

#### Scoring

Candidates that survive the drops get a score; the highest `maxBranches` (default 3, max 10) are selected and become child edges. The score is the sum of four components and is stored on each child (`selection.breakdown`).

| Component | Points |
|---|---|
| Same asset (`assetId` equal) | +50 |
| Amount proximity, `rel = \|ref − c\| / ref` | `rel < 1e-4` → 25; `< 0.01` → 18; `< 0.05` → 12; `< 0.10` → 6; `< 0.50` → 2; else 0 |
| Time proximity, `\|Δt\|` seconds | `< 60` → 30; `< 300` → 22; `< 3600` → 15; `< 86400` → 7; `< 604800` → 2; else 0 |
| Dust | −10 if USD value `< 1` (when priced), or amount `< 0.001` units (when unpriced) |

- Amount proximity uses the same-asset amounts when the assets match. When they differ it compares USD values if both are known (and the reference is positive), otherwise it scores 0.
- Ties are broken by smaller `|Δt|`, then by listing order.
- The maximum is 105 (same asset, near-identical amount, within a minute).

#### Dropped-candidate retention

Per edge, `droppedTotal` is the full number of candidates dropped and `droppedByReason` breaks that number down by reason (the counts sum to `droppedTotal`). `dropped` keeps at most **30** of them: first one example of each distinct reason (in the order of the drop table; for `exceeds_max_branches` the best-scored one), then the best-scored remaining candidates, then unscored ones in candidate order. The kept list is shown scored-first, highest score first.

#### Swap-through

When a candidate transfer is part of a swap (in the same transaction, the candidate's recipient also sent a different asset), the engine remembers the swapped-for asset (`edge.swap = {asset, amount}`) and follows the funds through the swap instead of stopping at the DEX/router:

- Backward: another transfer in the candidate's transaction **sent by** the candidate's `to` address, in a different asset, with the largest such amount.
- Forward: another transfer in the transaction **received by** the candidate's `from` address, in a different asset.

For a swap-through edge, the subject becomes `near` (the swapper), only candidates in the swapped-for asset are considered (others are skipped without a drop record), the reference amount is `edge.swap.amount`, and the entity and cycle checks are skipped.

**TRON limitation:** Tronscan listings are filtered by direction, so the opposite leg of a swap is not visible in an address listing. On TRON, swap-through therefore only triggers for **seed transactions**, where the full transaction is fetched. On Ethereum, Polygon and Arbitrum it also triggers during expansion.

### Run status

| Status | When |
|---|---|
| `completed` | The queue drained (edges may still carry stop reasons such as `max_depth`). |
| `cancelled` | Cancelled by the user. |
| `timed_out` | `timeoutSec` elapsed. |
| `failed` | Fatal provider error, or every seed failed. |

After **Expand further**, the status describes the merged graph. A continuation that times out or fails sets `timed_out` or `failed`. Otherwise the previous status stands, and a `timed_out` or `cancelled` run becomes `completed` once no edge still carries `timeout` or `cancelled`. A cancelled expansion keeps the edges it found, with its unfinished edges stopped as `cancelled`; a completed run stays `completed`. The `incomplete_trace` flag follows this status.

### Stop reasons

| Reason | Meaning |
|---|---|
| `entity` | `far` is a labeled exchange, DEX, bridge, mixer, scam or token (or mixer only with `traceThroughEntities`). The label name is in `stopDetail`. |
| `sanctioned` | `far` is OFAC-listed or labeled `sanctioned`. |
| `mint` | `far` is the zero address (mint/burn). |
| `no_candidates` | No transfer survived the drops. `stopDetail` is `listing_truncated` when the listing hit the page cap. |
| `cycle` | `far` is already on this path. |
| `max_depth` | `edge.depth >= maxDepth`. |
| `max_edges` | The `maxEdges` expansion budget was used up. |
| `timeout` | `timeoutSec` elapsed. |
| `cancelled` | The run was cancelled. |
| `fetch_failed` | The explorer failed for this edge (`stopDetail` = error code), or a fatal error aborted the run. |

`max_depth`, `max_edges`, `timeout`, `cancelled` and `entity` edges can be continued with "Expand further" (`POST /api/runs/:id/expand`). The depth budget of the continuation is relative to the edge (API default +3; the web UI expands one hop per click, so each step is an analyst's choice), and an `entity` continuation traces through that entity (mixers still stop). `maxEdges` and `timeoutSec` apply to each expansion on its own. One hop costs one listing of the edge's address: on Etherscan chains `tokentx`, `txlist` and `txlistinternal` (1 to `EXPLORER_MAX_PAGES` pages each), on TRON TRC-20 transfers and transactions (re-queried once for an incomplete forward window), plus a price lookup.

## Analysis

Source: `packages/core/src/analysis/`. Runs after the trace, deterministically (edges ordered by depth, seed, rank, id), apart from the convergence follow-up lookups.

### Seed reachability

A breadth-first walk from each seed's edges over `children` assigns every edge the set of seeds that reach it (`seedIds`). An address's `seedIds` are those of the edges where it is the `far` end, plus its own seed for seed subjects.

### Linked wallets (convergences)

A convergence is an **unlabeled** address (no label of any category, including `other`) that is the `far` end of at least one edge and qualifies as either:

| Kind | Condition |
|---|---|
| `shared_across_seeds` | Edges where the address is `far` are reached by two or more seeds. |
| `shared_within_trace` | Those edges have two or more distinct `near` addresses. |

An address can carry both kinds. `role` is `common_source` for backward traces and `common_destination` for forward traces. Each convergence lists its edges, counterparties, per-asset totals, USD sum (non-null values only) and the minimum depth. Results are sorted by USD descending (unknown last), then depth.

**Follow-up ("who else did this funder pay?").** For the top **10** convergences by USD, one listing is fetched (page 1 only, no time bound): the address's other outgoing transfers when backward, incoming when forward. Transfers whose counterparty is already in the graph, zero-value and spoofed-token transfers are removed; up to **20** are kept in `otherCounterparties`, sorted by USD descending. A failure only adds warning `convergence_followup_failed`.

### Exposure

One exposure entry per edge whose `far` carries at least one label with a category other than `other`. If an address has several labels, the first by this priority wins: `sanctioned` > `mixer` > `scam` > `exchange` > `bridge` > `dex` > `defi` > `token`.

- `hops = depth + 1`. **Direct** exposure is hops = 1; **indirect** is more than 1.
- `byCategory`: per category, direct and indirect count and USD, and the minimum indirect hops.
- `byEntity`: grouped by (category, entity), top 20 by USD. The entity is the label's `entity`, else its `name`.
- **Unresolved:** a stopped edge with an unlabeled `far` whose stop reason is one of `no_candidates`, `max_depth`, `max_edges`, `timeout`, `cancelled`, `fetch_failed` (the origin or destination of that branch is unknown). Counted per stop reason with their USD.
- `terminalUsd` = USD of exposure entries on stopped edges + unresolved USD. It is the value "at the end" of the traced branches.
- `unpricedCount` = number of edges without a USD value. USD totals treat unpriced edges as missing, not zero.

### Exchange touchpoints

Every edge whose `far` is labeled `exchange`:

| Direction | Kind | Meaning |
|---|---|---|
| backward | `origin` | Funds came from this exchange address. The exchange holds the account holder's identity. |
| forward | `arrival` | Funds arrived at this exchange address. |

`counterparty` is the `near` address: for an arrival this is the probable deposit address. Touchpoints are sorted by USD descending (unknown last), then depth. They are the addresses to put in a freeze or information request.

### Provisional analysis

While a run is live, the server streams a **provisional** analysis of the edges found so far (`analyzeProvisional` in `analysis/analyze.ts`; cadence in `apps/server/src/runs.ts`): at most once per second when edges changed, immediately on pause, and at the start of an "Expand further". It applies every rule above to the current edges and differs from the final analysis in three ways:

- **No follow-up lookups.** Convergences have empty `otherCounterparties`; the follow-up listings run only for the final result.
- **No run outcome.** `incomplete_trace` is raised only for `fetch_failed` edges, never for the run's status, because the run has not ended.
- **Pending edges are not stops.** Edges still queued count as transfers (for convergences and touchpoints) but not as unresolved ends, so exposure's unresolved and terminal values grow as the run proceeds.

The provisional risk level can therefore still change in either direction. It is shown as provisional, never stored, and replaced by the final analysis when the run finishes.

## Flags and risk level

Source: `analysis/flags.ts`, defaults in `packages/core/src/policy/default-policy.json`.

The risk level is **not a score**. It is the worst severity among the raised flags:

| Risk level | When |
|---|---|
| `high` | At least one flag with severity `high` |
| `medium` | No `high`, at least one `medium` |
| `low` | Otherwise (`low` and `info` flags never raise the level) |

Flags are listed by severity (high first), then by id. A flag set to `off` is not evaluated. Each flag has a title, a one-sentence detail with the numbers, and evidence (up to 50 addresses and 50 edge ids).

| Flag id | Default severity | Parameters (default) | Raised when |
|---|---|---|---|
| `sanctioned_exposure` | high | – | Any edge endpoint (`from` or `to`) is OFAC-listed or labeled `sanctioned`. |
| `mixer_direct` | high | `directHops` (1) | Exposure entry of category `mixer` with `hops <= directHops`. |
| `mixer_indirect` | medium | `directHops` (1) | Exposure entry of category `mixer` with `hops > directHops`. |
| `scam_direct` | high | `directHops` (1) | Exposure entry of category `scam` with `hops <= directHops`. |
| `scam_indirect` | medium | `directHops` (1) | Exposure entry of category `scam` with `hops > directHops`. |
| `common_source_across_seeds` | medium | – | Any convergence with kind `shared_across_seeds` (source or destination, by direction). |
| `common_source_within_trace` | low | – | Any convergence with kind `shared_within_trace`. |
| `cycle` | medium | – | Any edge stopped with `cycle`. |
| `funnel` | medium | `minSenders` (4), `windowSec` (86400) | An address is the `near` end of edges from at least `minSenders` distinct `far` addresses whose timestamps fit in one window of `windowSec` seconds. |
| `round_trip` | medium | `tolerance` (0.03) | On one root-to-leaf path an address (as `far`) repeats with the same asset and an amount within `tolerance` of its first amount, relative to that first amount (an address's first appearance includes the seed subject). Port of the legacy wash-trade check; the walk has a step budget of 200 000. |
| `structuring` | low | `minAddresses` (5), `maxUsd` (100) | At least `minAddresses` unlabeled `far` addresses each appear on exactly one edge with a known USD value `< maxUsd`. |
| `long_chain` | low | `hops` (5) | `maxDepthReached + 1 >= hops` and no exposure entry within `hops` hops. |
| `unresolved_majority` | low | `share` (0.5) | `terminalUsd > 0` and `unresolved.usd / terminalUsd > share`. |
| `exchange_origin` | info | – | Any touchpoint of kind `origin` (backward traces; forward `arrival`s are reported as touchpoints but do not raise a flag). |
| `spoofed_tokens_ignored` | info | – | Any retained dropped candidate with reason `spoofed_token`. |
| `incomplete_trace` | info | – | Run status is not `completed`, or any edge stopped with `fetch_failed`. |

The `mixer_indirect` and `scam_indirect` flags have their own `directHops`; when changing the boundary, set it on both the direct and indirect flag of a category.

### Overriding the policy

Point `FOT_POLICY_PATH` (or the CLI `--policy`) at a JSON file. It is merged onto the defaults **per flag and per setting**, so you only write what you change. Unknown flag ids, unknown settings and out-of-range values are rejected at boot with the file name and path (for example `flags.funnel.minSenders: Too small`). The result records `policy: {version, overridden}`.

```json
{
  "version": 1,
  "flags": {
    "cycle": { "severity": "off" },
    "structuring": { "severity": "medium", "minAddresses": 8, "maxUsd": 250 },
    "mixer_indirect": { "severity": "high", "directHops": 3 },
    "unresolved_majority": { "share": 0.7 }
  }
}
```

Settings: `severity` is `high`, `medium`, `low`, `info` or `off`. Numeric ranges: `directHops`, `hops`, `minAddresses` ≥ 1; `minSenders` ≥ 2; `windowSec` ≥ 1; `maxUsd` ≥ 0; `tolerance` and `share` between 0 and 1.

## Data, pricing and labels

### Data sources

| Data | Source | Notes |
|---|---|---|
| Ethereum, Polygon, Arbitrum transfers | Etherscan API V2 (`https://api.etherscan.io/v2/api`, `chainid` 1 / 137 / 42161) | Free key; free tier is 3 calls/s (`ETHERSCAN_RPS`). BSC, Base and OP are paid-only and not supported. |
| TRON transfers | Tronscan API (`https://apilist.tronscanapi.com/api`) | Free key(s) required (`TRONSCAN_API_KEYS`). |
| USD prices | DefiLlama `coins.llama.fi` (`batchHistorical`) | No key. |
| Sanctions | OFAC SDN list (`sanctionslistservice.ofac.treas.gov`) | Digital currency addresses with their SDN entry name and programs, refreshed every `OFAC_REFRESH_HOURS`. |
| Labels | Bundled `packages/core/labels/*.json` and your local file | See [labels.md](labels.md). |

Per address the explorer is asked for several lists (Etherscan: ERC-20 `tokentx`, native `txlist`, internal `txlistinternal`; Tronscan: TRC20 transfers and TRX transactions). Failed transactions and reverted TRC20 transfers are ignored. Responses are cached (SQLite on the server, memory for demos) for 30 days when the queried time bound or transaction is older than one hour, otherwise 300 seconds; error responses are never cached.

### Pricing

- USD value is `amount × price` at the transfer time. Prices are looked up per **hour bucket** (`floor(timestamp / 3600) × 3600`), using the nearest DefiLlama price within a 600-second search width.
- **Canonical stablecoins are priced 1:1 by contract address only**: Ethereum USDT, USDC, DAI, USDP; Polygon USDT, USDC, USDC.e, DAI; Arbitrum USDT, USDC, USDC.e, DAI; TRON USDT. Priced by contract, never by symbol, so a token that merely calls itself "USDT" is not valued as a dollar.
- Everything else (native coins, WETH, other tokens, TRON USDC/USDD) is looked up on DefiLlama. A token DefiLlama does not know is **unpriced** (`usd: null`).
- If DefiLlama cannot be reached, prices come back null and the run carries warning `prices_unavailable`; the run is not aborted.
- Unpriced edges never count towards USD totals. Unpriced expansion candidates are not followed by default (dropped as `unpriced`), which keeps spam and airdrop tokens out of the graph; `followUnpriced` follows them. `minUsd > 0` always drops them. Seed legs are never dropped for being unpriced.

### Spoofed tokens

Fake tokens that imitate a stablecoin are a common noise source. A token is **spoofed** when its symbol, folded to a canonical form, equals the folded symbol (or alias) of a canonical token on that chain but its contract is not the canonical contract.

Folding: Unicode NFKC, uppercase, Cyrillic and Greek look-alike letters mapped to Latin (for example `А`→`A`, `Т`→`T`, `₮`→`T`), the digits `0 1 3 5 8` mapped to `O I E S B`, then every character outside `A–Z` and `.` removed. So Cyrillic `USDТ`, `U5DT` and `USD₮` all fold to `USDT`. A canonical contract is never spoofed whatever symbol it reports (Polygon and Arbitrum USDT report `USDT0`, which is accepted as an alias).

Spoofed transfers are dropped during expansion (`spoofed_token`) and skipped silently for address seeds. They are not filtered out of transaction seeds, which you chose explicitly. Dropped spoofs raise the info flag `spoofed_tokens_ignored`.

## Limits and caveats

- **Heuristic selection.** Following "the best candidate by amount and time" can pick the wrong incoming transfer. Branches (`maxBranches`) exist because one transfer cannot be proven to fund another. Use the score breakdown and dropped candidates on each edge to judge a path.
- **Attribution is a hypothesis.** An address with funds from several sources mixes them; account-model chains have no way to say which inbound transfer funded which outbound one. A label says what a public source called an address, not who controls it today.
- **Page caps.** Each listing fetches `EXPLORER_MAX_PAGES` (default 2, 1–4) pages of 50 rows, nearest to the edge's time first. Busy addresses (exchanges, routers) exceed this; the run then carries warning `listing_truncated`, and a branch with nothing selected has `stopDetail: "listing_truncated"`. Raise `EXPLORER_MAX_PAGES` at the cost of more API calls.
- **TRON forward windows.** Tronscan returns newest rows first regardless of sort order, so forward listings use a 30-day window after the edge, and when that window is not fully fetched a 1-day window is used instead (and the listing is marked truncated).
- **Time bounds are block-resolved.** EVM time bounds are mapped to blocks by Etherscan (`getblocknobytime`) with a 5-second margin.
- **Bridges stop the trace.** A labeled bridge address stops the trace (`entity`); the tool does not follow funds to another chain. Tracing through a bridge on the same chain lists unrelated bridge users and is not meaningful.
- **No NFT tracing.** ERC-721/ERC-1155 transfers (four-topic `Transfer` logs) are ignored.
- **Coverage depends on labels.** Absence of a label means "unknown", not "clean". Exchanges rotate wallets; see the [coverage gaps](labels.md#coverage).
- **Sanctions screening is an address match** against OFAC's published digital currency addresses; it is not a full screening program.
- **Not legal advice.** Results are heuristic analysis, not an accusation or a compliance decision.
