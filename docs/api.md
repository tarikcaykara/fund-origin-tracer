# REST and SSE API

The server (`bun run start`, default `http://localhost:3000`) exposes a JSON API under `/api`. All result payloads use the types in `packages/core/src/schema.ts` (`AnalysisResult`, `TraceEdge`, `RunEvent`, …); this page does not repeat them. Field names are camelCase.

There is no authentication: run the server on a trusted network or behind your own proxy.

## Conventions

- Request and response bodies are JSON (`Content-Type: application/json`), except SSE and CSV.
- Run ids are UUID v4 strings.
- Errors always use one envelope:

  ```json
  {"error":{"code":"invalid_request","message":"seeds.0.value: not a valid ethereum transaction hash"}}
  ```

| Status | `error.code` | Raised by |
|---|---|---|
| 400 | `invalid_request` | Validation failed (the message lists each `path: problem`), bad query, unknown chain/kind |
| 403 | `demo_only` | `POST /api/runs` with live parameters while `DEMO_ONLY=true` |
| 404 | `not_found` | Unknown run, unknown route |
| 404 | `demo_not_found` | `POST /api/runs` with an unknown `demo` id |
| 404 | `edge_not_found` | `POST /api/runs/:id/expand` with an edge that is not in the run |
| 409 | `chain_not_ready` | No API key for the chain (`ETHERSCAN_API_KEY` / `TRONSCAN_API_KEYS`) |
| 409 | `run_active` | Delete or expand while the run is in progress |
| 409 | `not_finished` | Export or expand a run that has no result yet |
| 409 | `edge_not_expandable` | The edge is not stopped, or its stop reason cannot be continued |
| 409 | `demo_only` | `POST /api/runs/:id/expand` while `DEMO_ONLY=true` |
| 409 | `demo_run_not_expandable` | `POST /api/runs/:id/expand` on a recorded demo run |
| 429 | `too_many_runs` | More than 3 live runs at once |
| 500 | `internal_error` | Unexpected server error (details are logged, not returned) |

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Version, per-chain readiness, demo mode, data freshness |
| GET | `/api/demo` | List recorded demo scenarios |
| POST | `/api/runs` | Start a live run or a demo run |
| GET | `/api/runs` | List runs (history) |
| GET | `/api/runs/:id` | One run, with its result once finished |
| GET | `/api/runs/:id/events` | SSE stream of the run |
| POST | `/api/runs/:id/pause` | Pause |
| POST | `/api/runs/:id/resume` | Resume |
| POST | `/api/runs/:id/cancel` | Cancel (the partial result is kept) |
| POST | `/api/runs/:id/expand` | Continue a stopped edge |
| PATCH | `/api/runs/:id` | Edit title and notes |
| DELETE | `/api/runs/:id` | Delete a finished run |
| GET | `/api/runs/:id/export.json` | Full `AnalysisResult` as a download |
| GET | `/api/runs/:id/export.csv` | One CSV table as a download |
| GET | `/api/screen/:chain/:address` | Label and sanctions lookup, no explorer calls |

Any other `GET` outside `/api/` serves the built web app (`apps/web/dist`) with SPA fallback; it returns 404 when the app has not been built.

### `GET /api/health`

```bash
curl -s localhost:3000/api/health
```

```json
{"version":"1.1.0","chains":{"ethereum":"missing_key","polygon":"missing_key","arbitrum":"missing_key","tron":"missing_key"},"demoOnly":false,"explorerMaxPages":2,"ofacFetchedAt":null,"labelsVersion":"2026-10-20"}
```

- `chains.<id>` is `ready` when the key for that chain is configured (`ETHERSCAN_API_KEY` covers ethereum, polygon and arbitrum; at least one `TRONSCAN_API_KEYS` entry for tron), else `missing_key`. The keys themselves are not validated here.
- `explorerMaxPages` is `EXPLORER_MAX_PAGES`: pages fetched per explorer list. The web UI uses it to state the cost of one expansion.
- `ofacFetchedAt` is the time of the current OFAC snapshot, or `null` when the list could not be loaded (sanctions screening is then off).
- `labelsVersion` is the newest `verifiedAt` across the bundled label files.

### `GET /api/demo`

Returns `[{id, title, description, chain, direction, addresses, transfers}]` for every valid scenario in `fixtures/demo/`:

```json
[{"id":"d1-source-of-funds-ethereum","title":"Source of funds on Ethereum","description":"Backward trace of a 50k USDT transfer. …","chain":"ethereum","direction":"backward","addresses":64,"transfers":84}, …]
```

- `addresses` and `transfers` are the size of the recorded run (`graph.addresses.length` and `graph.edges.length`), written by `fot fixtures record`; both are omitted for scenarios recorded without them.

### `POST /api/runs`

Starts a run in the background and returns immediately with `201`:

```json
{"runId":"d5a99a54-d2a0-4ff7-961e-8d437044258b"}
```

The body is one of two shapes.

**Demo run** (strict; no other keys allowed):

| Field | Type | Notes |
|---|---|---|
| `demo` | string | A scenario id from `GET /api/demo` |

**Live run:**

| Field | Type | Default | Constraint |
|---|---|---|---|
| `chain` | string | required | `ethereum`, `polygon`, `arbitrum`, `tron` |
| `direction` | string | required | `backward` (source of funds), `forward` (destination of funds) |
| `seeds` | array | required | 1–20 items |
| `seeds[].kind` | string | required | `tx` or `address` |
| `seeds[].value` | string | required | Trimmed; must match the chain's tx/address format (below); normalized (EVM lowercase) |
| `seeds[].id` | string | `s1`, `s2`, … by position | `s1`…`s20`; must be unique within the run |
| `maxDepth` | integer | 10 | 1–50 |
| `maxBranches` | integer | 3 | 1–10 |
| `maxEdges` | integer | 200 | 10–5000 |
| `minUsd` | number | 0 | ≥ 0 |
| `traceThroughEntities` | boolean | false | |
| `followUnpriced` | boolean | false | |
| `timeoutSec` | integer | 600 | 10–3600 |

Seed formats: EVM tx `0x` + 64 hex; EVM address `0x` + 40 hex; TRON tx 64 hex (no `0x`); TRON address `T` + 33 base58 characters.

Failure cases: `400 invalid_request` (validation), `403 demo_only`, `409 chain_not_ready`, `429 too_many_runs` (live runs only; demo runs do not count), `404 demo_not_found`.

```bash
curl -s -i -XPOST localhost:3000/api/runs -H 'content-type: application/json' \
  -d '{"chain":"ethereum","direction":"backward","seeds":[{"kind":"tx","value":"0x123"}]}'
# HTTP/1.1 400 Bad Request
# {"error":{"code":"invalid_request","message":"seeds.0.value: not a valid ethereum transaction hash"}}

curl -s -XPOST localhost:3000/api/runs -H 'content-type: application/json' \
  -d '{"chain":"ethereum","direction":"backward","seeds":[{"kind":"tx","value":"0x8e463bd42d8cc09e3d05449676c631132dcb170147fc410d406e9049822fe998"}]}'
# without ETHERSCAN_API_KEY (HTTP 409):
# {"error":{"code":"chain_not_ready","message":"ETHERSCAN_API_KEY is not set."}}
```

A multi-seed live run (linked-wallet detection) is the same call with several seeds:

```bash
curl -s -XPOST localhost:3000/api/runs -H 'content-type: application/json' -d '{
  "chain": "ethereum",
  "direction": "backward",
  "maxDepth": 4,
  "seeds": [
    {"kind": "tx", "value": "0x8e463bd42d8cc09e3d05449676c631132dcb170147fc410d406e9049822fe998"},
    {"kind": "tx", "value": "0x1b59b93dcee5cc162d96a9140809d45e72f8946d265116489389b1e70fef8de5"}
  ]
}'
```

### `GET /api/runs`

History, newest first. Query:

| Param | Default | Constraint |
|---|---|---|
| `limit` | 50 | integer 1–100 |
| `offset` | 0 | integer ≥ 0 |
| `q` | – | non-empty text filter |
| `chain` | – | one of the four chains |
| `status` | – | `running`, `completed`, `cancelled`, `timed_out`, `failed`, `interrupted` |

Response `{items, total, totalAll}`: `total` counts the rows matching `q`/`chain`/`status`, `totalAll` counts every stored investigation ignoring those filters. Each item is a run row **without** the result:

```json
{"total":1,"totalAll":1,"items":[{"id":"d5a99a54-…","chain":"ethereum","direction":"backward",
  "seeds":[{"id":"s1","kind":"tx","value":"0xe7f7c883…"}],
  "params":{"chain":"ethereum","direction":"backward","maxDepth":6,"maxBranches":3,"maxEdges":120,"minUsd":0,"traceThroughEntities":false,"followUnpriced":false,"timeoutSec":600,"seeds":[…]},
  "status":"completed","riskLevel":"medium","title":"Source of funds on Ethereum","notes":null,
  "demo":"d1-source-of-funds-ethereum","createdAt":"2026-10-20T20:59:22.516Z","finishedAt":"2026-10-20T20:59:28.540Z","error":null}]}
```

Row fields: `id`, `chain`, `direction`, `seeds`, `params`, `status`, `riskLevel` (`low`/`medium`/`high`, `null` until finished), `title`, `notes`, `demo` (scenario id or `null`), `createdAt`, `finishedAt`, `error`.

`status` is one of `running`, `paused` (live overlay, not storable, so `?status=paused` is rejected), `completed`, `cancelled`, `timed_out`, `failed`, `interrupted` (the server stopped while the run was in progress).

### `GET /api/runs/:id`

The row above plus `result`: the full `AnalysisResult` once the run is finished, `null` while it is running or paused (use the event stream for live state; its `provisional` events carry the analysis so far). `404 not_found` for an unknown id.

### `GET /api/runs/:id/events` (SSE)

See [SSE stream](#sse-stream).

### `POST /api/runs/:id/pause`, `/resume`, `/cancel`

No body. Response `{"status": "<status>"}` with the run's status after the call:

- `pause` on a running run → `paused`; `resume` on a paused run → `running`.
- `cancel` returns the current status (`running` or `paused`); the run then finishes as `cancelled` with its partial result, announced by `result` and `done` on the stream. Cancelling a paused run also stops it.
- On a run that is not active, all three are idempotent and return its stored status (for example `completed`).
- `404 not_found` for an unknown id.

### `POST /api/runs/:id/expand`

Continues a stopped edge of a finished run ("Expand further").

```json
{"edgeId":"ee29d6b3bd1a203a4","maxDepth":3}
```

| Field | Type | Default | Constraint |
|---|---|---|---|
| `edgeId` | string | required | An edge of this run |
| `maxDepth` | integer | 3 | 1–50; extra depth, relative to the edge. The web UI sends 1 (one hop per click) |

Allowed only when the run is not active, the run is not a recorded demo, the edge has `status: "stopped"` and its `stopReason` is `max_depth`, `max_edges`, `timeout`, `cancelled` or `entity` (an `entity` continuation traces through that entity; mixers still stop). Returns `202 {"status":"running"}`. The run reverts to `running` and **keeps its id**: subscribe to `GET /api/runs/:id/events` **after** this call. The first `snapshot` is followed by a `provisional` analysis of the merged graph, then the new edges arrive, then `result` and `done` again; the merged, re-analyzed result replaces the stored one. The continuation makes live explorer calls, so it needs the chain's API key. Demo runs are refused with `409 demo_run_not_expandable`: a continuation would mix live explorer, price and OFAC data into a recorded replay; start a live trace from the address instead.

The stored status describes the merged graph, not the continuation alone. A continuation that times out or fails sets `timed_out` or `failed`. Otherwise the run keeps its previous status, except that a `timed_out` or `cancelled` run becomes `completed` once no edge still stops with `timeout` or `cancelled`. Cancelling an expansion (`POST /api/runs/:id/cancel` while it runs) keeps the edges it already found, its unfinished edges stop with `cancelled`, and a completed run stays `completed`.

Each expansion has its own budget: `maxEdges` and `timeoutSec` apply to the continuation, not to the run so far (a `max_edges` or `timeout` edge could not be continued otherwise). While it runs, the stream starts with `snapshot`, then an `expansion` event naming the edge and the run totals before it (`base`), then the `provisional` analysis; `progress` reports run totals, so the expansion's own counters are `progress` minus `base`.

Errors: `404 not_found`, `404 edge_not_found`, `409 run_active`, `409 not_finished`, `409 edge_not_expandable`, `409 demo_only`, `409 demo_run_not_expandable`, `409 chain_not_ready`, `429 too_many_runs`.

```bash
curl -s -i -XPOST localhost:3000/api/runs/$ID/expand -H 'content-type: application/json' -d '{"edgeId":"nope"}'
# HTTP/1.1 404 Not Found
# {"error":{"code":"edge_not_found","message":"Unknown edge."}}
```

### `PATCH /api/runs/:id`

Edits the investigation's metadata. Both fields optional; `null` clears.

| Field | Constraint |
|---|---|
| `title` | string, trimmed, up to 200 characters, or `null` |
| `notes` | string up to 20 000 characters, or `null` |

Returns the updated row (no result). `400` on a wrong type, `404` for an unknown id.

### `DELETE /api/runs/:id`

Returns `{"deleted":true}`. `409 run_active` while the run is in progress (cancel it first), `404 not_found` for an unknown id.

### `GET /api/runs/:id/export.json`

The `AnalysisResult` as a download (`Content-Disposition: attachment; filename="fot-<id>.json"`). `409 not_finished` while the run is in progress.

### `GET /api/runs/:id/export.csv`

Query `kind` = `edges` (default), `convergences`, `exposure`, `touchpoints` or `addresses`; anything else is `400`. UTF-8 with BOM, CRLF line ends, RFC 4180 quoting. Cells that start with `=`, `+`, `-`, `@`, tab or CR get a leading `'` to defuse spreadsheet formulas. `409 not_finished` while the run is in progress.

Columns:

| `kind` | Columns |
|---|---|
| `edges` | `depth,from,from_label,to,to_label,asset,amount,usd,timestamp_iso,tx_hash,explorer_url,status,stop_reason,score,seed_ids` |
| `convergences` | `role,address,kinds,seed_ids,min_depth,counterparties,edge_count,totals,usd,other_counterparties` |
| `exposure` | `category,entity,address,hops,symbol,amount,usd,tx_hash,explorer_url` |
| `touchpoints` | `kind,entity,exchange_address,counterparty,symbol,amount,usd,timestamp_iso,tx_hash,explorer_url,depth,seed_ids` |
| `addresses` | `address,labels,categories,entities,sanctioned,seed_subject,seed_ids,min_depth,transfers_in,transfers_out,usd_in,usd_out,sdn_programs` |

List-valued cells are joined with `;`.

`addresses` has one row per graph address, in graph order. `labels` are joined with ` \| `; `min_depth` is the smallest depth of any edge touching the address; `usd_in`/`usd_out` sum the priced edges and are blank when none is priced; `sdn_programs` lists the OFAC programs of the address's SDN entries (blank when it is not sanctioned or the snapshot predates SDN entries). Edges in the result also carry `droppedByReason`, a `{reason: count}` map over **every** dropped candidate (sums to `droppedTotal`; absent in results stored before it existed).

```bash
curl -s "localhost:3000/api/runs/$ID/export.csv?kind=touchpoints"
```

```csv
kind,entity,exchange_address,counterparty,symbol,amount,usd,timestamp_iso,tx_hash,explorer_url,depth,seed_ids
origin,Coinbase,0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511,0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43,ETH,2644.661798364201,6442980.81,2026-10-20T20:15:11.000Z,0x3e9e83b9…,https://etherscan.io/tx/0x3e9e83b9…,6,s1
origin,Binance,0x28c6c06298d514db089934071355e5743bf21d60,0xae8cbb7e810f59fd0dd939b2b6623756d91b174a,USDT,169651.349005,169651.35,2026-10-20T20:33:23.000Z,0xd54b5980…,https://etherscan.io/tx/0xd54b5980…,2,s1
```

### `GET /api/screen/:chain/:address`

Looks an address up in the bundled labels, your local labels and the OFAC list. No explorer call, no key needed.

```bash
curl -s localhost:3000/api/screen/ethereum/0x28c6c06298d514db089934071355e5743bf21d60
```

```json
{"labels":[{"name":"Binance 14","category":"exchange","entity":"Binance","source":"https://etherscan.io/address/0x28c6c06298d514db089934071355e5743bf21d60","origin":"bundled"}],"sanctioned":false}
```

A sanctioned address gets one label per SDN entry that lists it, before any bundled or local label:

```bash
curl -s localhost:3000/api/screen/ethereum/0x098b716b8aaf21512996dc57eb0615e2383e2f96
```

```json
{"labels":[{"name":"LAZARUS GROUP","category":"sanctioned","entity":"LAZARUS GROUP","programs":["DPRK3"],"source":"https://sanctionssearch.ofac.treas.gov/Details.aspx?id=27307","origin":"ofac"}],"sanctioned":true}
```

`labels` is the list of `Label` objects (empty when unknown); `sanctioned` is true when the address is on the OFAC list. SDN labels carry the entry name as `name` and `entity`, its `programs`, and the entry's OFAC page as `source` (see [labels.md](labels.md#ofac-sdn)). `400 invalid_request` for an unknown chain or a malformed address.

## SSE stream

`GET /api/runs/:id/events` returns `text/event-stream`. Each message is:

```
event: <type>
data: <json>

```

where `data` is the complete `RunEvent` JSON, including its `type` field. Event types (payloads are the `RunEvent` union in `schema.ts`):

| `event` | Payload | Meaning |
|---|---|---|
| `snapshot` | `{status, edges, stats}` | State so far. Always the first event. `stats` holds `expandedEdges`, `apiCalls`, `cacheHits` (may be `{}` early). |
| `status` | `{status: "running" \| "paused"}` | Pause or resume took effect |
| `edge_added` | `{edge}` | A new edge (a full `TraceEdge`) |
| `edge_linked` | `{edgeId, parentId}` | An existing edge got another parent (no re-expansion) |
| `edge_expanded` | `{edgeId, selected, droppedTotal}` | Edge expanded; `selected` are its child edge ids |
| `edge_stopped` | `{edgeId, reason, detail}` | Edge stopped (`reason` is a stop reason) |
| `progress` | `{expandedEdges, queued, apiCalls, cacheHits, elapsedMs}` | About once per second. Counts are run totals; during an expansion `queued` and `elapsedMs` are the expansion's |
| `expansion` | `{edgeId, maxDepth, base: {expandedEdges, apiCalls, cacheHits}}` | An "Expand further" started on `edgeId`; `base` is the run totals before it. Not stored |
| `provisional` | `{analysis}` | Live analysis of the edges so far: `{chain, direction, seeds, graph: {addresses}, convergences, exposure, exchangeTouchpoints, flags, riskLevel}` (the `DerivedAnalysis` part of an `AnalysisResult`, without edges). Never stored; see below. |
| `warning` | `{code, message}` | Non-fatal issue (`listing_truncated`, `prices_unavailable`, `seed_failed:<id>`, …) |
| `error` | `{code, message}` | Fatal problem; a `result` (status `failed`) and `done` normally follow |
| `result` | `{result}` | The final `AnalysisResult` |
| `done` | `{status}` | Last event: `completed`, `cancelled`, `timed_out` or `failed` |

Behavior:

- **Snapshot on subscribe.** A client that connects mid-run first receives a `snapshot` with every edge so far, then the running `expansion` if there is one, then the latest `provisional` analysis if there is one, then live events. Rebuild state from the snapshot, then apply `edge_added`, `edge_linked`, `edge_expanded` and `edge_stopped`; `result` supersedes it.
- **Provisional analysis.** While a run is live the server recomputes the analysis from the edges so far and sends it as `provisional`: at most once per second and only when edges changed, immediately when the run is paused, and at the start of an expand. It makes no explorer calls: convergences have empty `otherCounterparties` (the follow-up lookups run only for the final result), and `incomplete_trace` reflects only `fetch_failed` edges because the run has no outcome yet. It is never written to the database, never sent after `result`, and the final `result` replaces it. See [methodology](methodology.md#provisional-analysis).
- **Finished runs replay.** Subscribing to a finished run sends `snapshot`, `result` and `done` at once and closes. A run that has no result (interrupted by a restart, or failed before analysis) sends `snapshot`, an `error` (`interrupted` or `no_result`) and `done` with status `failed`.
- **Keepalive.** While no event is pending, the server writes a `: keepalive` comment every 15 seconds so proxies keep the connection open.
- **Closing.** The stream closes after `done`. Closing the client connection does not stop the run; use `/cancel` for that.
- **Unknown run:** `404 not_found` (plain JSON, not a stream).

Real excerpt from the demo `d1-source-of-funds-ethereum` (payloads shortened with `…`):

```
event: snapshot
data: {"type":"snapshot","status":"running","edges":[{"id":"e3a432c49aef572a9","depth":0,…}],"stats":{}}

event: edge_added
data: {"type":"edge_added","edge":{"id":"e721a3031e46eb1ab","depth":2,"from":"0x1231…","to":"0x8f61…",…}}

event: edge_expanded
data: {"type":"edge_expanded","edgeId":"ea71ac1f1a1e2b36e","selected":["e721a3031e46eb1ab","ecf7e48b12c5b46b1"],"droppedTotal":0}

event: edge_stopped
data: {"type":"edge_stopped","edgeId":"ee29d6b3bd1a203a4","reason":"entity","detail":"Binance 17"}

event: edge_linked
data: {"type":"edge_linked","edgeId":"e4e31a6802377f4c5","parentId":"e861e803f30b2b764"}

event: progress
data: {"type":"progress","expandedEdges":7,"queued":8,"apiCalls":41,"cacheHits":8,"elapsedMs":1001}

event: result
data: {"type":"result","result":{"schemaVersion":1,"runId":"d5a99a54-…",…}}

event: done
data: {"type":"done","status":"completed"}
```

In a browser, `new EventSource("/api/runs/" + id + "/events")` and one listener per event name is enough; the web app does exactly this.

## Demo mode

Recorded scenarios in `fixtures/demo/<id>/` (`scenario.json`, `http.json.gz`, `ofac.json`) let the whole product run **without API keys or network access**.

- `POST /api/runs` with `{"demo":"<id>"}` replays the recorded explorer and price responses through the normal engine and analysis. Responses are served with a 40 ms delay each so the stream visibly animates; the engine runs with concurrency 1, and a demo takes a few seconds.
- Demo runs use the **bundled labels and the OFAC snapshot recorded with the scenario** (your local labels and the live OFAC list are not applied), a fresh in-memory cache, and are saved in the history like any other run (the row's `demo` field holds the scenario id).
- They do not count towards the 3-live-run limit and do not need `ETHERSCAN_API_KEY` / `TRONSCAN_API_KEYS`.
- Everything else (SSE, exports, patch, delete) behaves as for live runs, except `expand`, which is refused with `409 demo_run_not_expandable` so a replay never mixes in live data.

**`DEMO_ONLY=true`** is for hosting a public demo: live runs are refused with `403 demo_only` (and expand with `409 demo_only`), while demo runs, screening, history and exports keep working. `GET /api/health` reports `demoOnly: true`.

```bash
# stream a demo run end to end
ID=$(curl -s -XPOST localhost:3000/api/runs -H 'content-type: application/json' \
  -d '{"demo":"d1-source-of-funds-ethereum"}' | sed 's/.*"runId":"\([^"]*\)".*/\1/')
curl -sN localhost:3000/api/runs/$ID/events | grep '^event:' | sort | uniq -c
#   1 event: done
#  84 event: edge_added
#  36 event: edge_expanded
#   7 event: edge_linked
#  48 event: edge_stopped
#   6 event: progress
#   1 event: result
#   1 event: snapshot
#   1 event: warning
```

(Counts vary with when you subscribe: a connection made after the run started begins with a larger `snapshot` and fewer `edge_added` events.)

```bash
# DEMO_ONLY=true: live runs are refused, demo runs are not
curl -s -i -XPOST localhost:3000/api/runs -H 'content-type: application/json' \
  -d '{"chain":"ethereum","direction":"backward","seeds":[{"kind":"address","value":"0x28c6c06298d514db089934071355e5743bf21d60"}]}'
# HTTP/1.1 403 Forbidden
# {"error":{"code":"demo_only","message":"This instance only serves recorded demo scenarios."}}
```

## Typical flow

```bash
B=localhost:3000
ID=$(curl -s -XPOST $B/api/runs -H 'content-type: application/json' \
  -d '{"demo":"d3-linked-wallets"}' | sed 's/.*"runId":"\([^"]*\)".*/\1/')

curl -sN $B/api/runs/$ID/events > /dev/null          # returns after `done`
curl -s  $B/api/runs/$ID | jq '{status, riskLevel, flags: [.result.flags[] | {id, severity}]}'
curl -s  $B/api/runs/$ID | jq '.result.convergences[] | select(.kinds | index("shared_across_seeds")) | .address'
curl -s  "$B/api/runs/$ID/export.csv?kind=edges" -o edges.csv
curl -s  -XPATCH $B/api/runs/$ID -H 'content-type: application/json' -d '{"title":"Case 42","notes":"ticket #1234"}'
```

The second `jq` prints every address shared by both seeds, largest first; in the recorded demo the first is `0x2cff890f0378a11913b6129b2e97417a2c302680`.
