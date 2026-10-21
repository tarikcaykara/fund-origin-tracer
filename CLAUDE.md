# fund-origin-tracer

Open-source crypto fund-flow tracer (Ethereum, Polygon, Arbitrum, TRON) for compliance/AML, fraud/risk and security/IR teams. Bun workspace, strict TypeScript end to end.

## Module map

| Path | Role |
|---|---|
| `packages/core/src/schema.ts` | The only result/event contract (Zod schemas + inferred types: `RunParams`, `TraceEdge`, `AnalysisResult`, `RunEvent`, …) |
| `packages/core/src/chains.ts` | `CHAINS` (ids, chainids, native coin, explorer URLs), address/tx regexes + normalization, `CANONICAL_TOKENS` (stable = priced 1:1 by contract) |
| `packages/core/src/errors.ts` | `FotError` (`code`, `retryable`, `fatal`) |
| `packages/core/src/infra/` | `transport.ts` (`fetchTransport`, `RecordingTransport`, `FixtureTransport`), `limiter.ts` (`MinIntervalLimiter`), `retry.ts` (`withRetry`), `store.ts` (`CacheStore`, `MemoryCacheStore`, `cacheKey`), `http.ts` (`cachedRequest`: cache → limiter → retry → transport, TTLs), `controller.ts` (`RunController` pause/resume/cancel) |
| `packages/core/src/providers/` | `types.ts` (`ExplorerProvider`, `PriceSource`), `etherscan.ts` (Etherscan V2: Ethereum, Polygon, Arbitrum), `tronscan.ts` + `tronscan-key-pool.ts` (TRON, key rotation) |
| `packages/core/src/prices/defillama.ts` | `PriceService`: DefiLlama hourly-bucket prices; canonical stables 1:1 by contract |
| `packages/core/src/labels/` | `registry.ts` (`LabelRegistry`: bundled + local + OFAC), `files.ts` (label file schemas), `bundled.ts` (loads `packages/core/labels/*.json`), `ofac.ts` (SDN parser + `OfacSource` refresh), `spoof.ts` (`foldSymbol`, `isSpoofed`) |
| `packages/core/src/engine/` | `trace.ts` (`runTrace`: seeds, scheduler, per-edge checks, expansion, swap-through), `score.ts` (scoring constants, drop reasons), `types.ts` (engine deps/output) |
| `packages/core/src/analysis/` | `analyze.ts` (`analyze`), `reachability.ts`, `convergence.ts` (linked wallets + follow-up), `exposure.ts`, `touchpoints.ts`, `flags.ts` (policy flags, `riskLevelOf`), `shared.ts` |
| `packages/core/src/policy/` | `default-policy.json` + `policy.ts` (`loadPolicy`, strict override schema) |
| `packages/core/src/export/csv.ts` | `toCsv` (edges, convergences, exposure, touchpoints); also imported by the web app |
| `packages/core/labels/` | Bundled label files per chain (every entry has a verified `source`) |
| `packages/core/test/` | Offline unit tests; JSON captures in `test/fixtures/`, fakes in `test/helpers/` |
| `apps/server` (`@fot/server`) | `config.ts` env→`AppConfig`; `db.ts` bun:sqlite (investigations, `SqliteCacheStore`, `SqliteKv`); `runtime.ts` shared limiter/key pool/labels/OFAC/policy + per-run providers; `execute.ts` `executeRun` (trace→analyze); `runs.ts` `RunManager` (live state, SSE fan-out, expand); `demo.ts` scenario files; `app.ts` Hono routes; `serve.ts` `startServer` |
| `apps/cli` (`@fot/cli`) | `fot` CLI (`main.ts` is the only `process.exit`; `cli.ts` `runCli` returns the exit code): `commands/{trace,screen,labels,serve,fixtures}.ts`, `summary.ts` text report |
| `apps/web` (`@fot/web`) | React + Vite + Tailwind + shadcn/ui UI; imports only types and small helpers from `@fot/core` (`@fot/core/schema`, `/chains`, `/csv`) |
| `fixtures/demo/<id>/` | Recorded demo scenarios: `scenario.json`, `http.json.gz`, `ofac.json` (written by `fot fixtures record`) |
| `docs/` | `methodology.md` (scoring, drops, stops, flags), `api.md` (REST + SSE), `labels.md` (source policy, formats, coverage) |
| `scripts/dev.ts` | Runs API (3000) and Vite (5173) together |
| `Dockerfile`, `docker-compose.yml`, `.dockerignore` | Two-stage image on `oven/bun:1.4.3-debian` (build the web app, then ship sources + prod deps + `apps/web/dist`, `packages/core/labels`, `fixtures/demo`); compose pins `PORT`/`DATA_DIR` inside the container and maps `${PORT:-3000}` |
| `.github/workflows/ci.yml` | CI: install, check, typecheck, test, build, gitleaks |
| `CONTRIBUTING.md`, `SECURITY.md` | Contributor workflow and secrets runbook; private vulnerability reporting |

## Gotchas

- **Tronscan returns rows newest-first and ignores `sort`.** Forward listings therefore use a bounded window (`afterTs − 5 s` … `+30 d`, narrowed to `+1 d` when incomplete) and are re-sorted ascending client-side. The base URL is `https://apilist.tronscanapi.com/api` with header `TRON-PRO-API-KEY`; keyless requests get HTTP 429.
- **Tronscan `transaction-info` returns `{}` for unknown hashes** (HTTP 200); the provider maps that to `not_found`.
- **Etherscan errors arrive as HTTP 200 envelopes.** Rate limits and "free API access is not supported" are `status:"0"` bodies, not HTTP errors; classify the body, never cache error envelopes. Only genuine empty results are cached.
- **The free Etherscan tier covers chainid 1, 137 and 42161 only.** BSC (56), Base (8453) and OP are paid-only and return `Free API access is not supported`; they are out of scope (`chain_requires_paid_plan` is fatal).
- **Etherscan `txlistinternal&txhash=` rows have no `hash` field**; the transaction is already known, so do not require it.
- **The OFAC SDN XML is about 29 MB and the URL redirects**: the transport must follow redirects. The currency tag does not identify the chain; classify addresses by format. Never record the XML in fixtures (`ofac.json` holds the parsed snapshot).
- **Recording and replay must both use engine concurrency 1 and a fresh `MemoryCacheStore`.** Otherwise request order and cache hits differ and replay raises `fixture_miss`. Request keys sort query params and drop `apikey`; headers are never part of the key.
- **Price by contract, never by symbol.** A spoofed "USDT" must not be valued at $1; only `CANONICAL_TOKENS` entries with `stable: true` are 1:1 (TRON USDC and USDD are looked up).
- **Cycle detection is per path**, not global: the same address reached by two different branches is not a cycle. Existing transfers are linked, not re-expanded.
- **TRON swap-through only works for seed transactions** (listings are direction-filtered, so the opposite swap leg is not visible).
- **`maxEdges` counts expansions started**, reserved before the first await so the limit is exact under concurrency.
- **`paused` is a live overlay status**, never persisted; `GET /api/runs?status=paused` is rejected.
- **Docker: `env_file: .env` overrides the image `ENV`.** A dev `.env` with `DATA_DIR=./data` or `PORT=3100` would break the volume and port mapping, so `docker-compose.yml` sets `PORT` and `DATA_DIR` under `environment:` (which wins over `env_file`). The server runs from TypeScript sources; there is no server build step, only `apps/web/dist`.

## Hard rules

1. Code, comments, docs, commits and UI are in English.
2. `packages/core/src` imports nothing from `bun`, `bun:*` or `node:*`; only web-standard globals. Env, files and the clock are injected.
3. One result schema: `packages/core/src/schema.ts`. Server, CLI and web import it; never duplicate result or event types.
4. Every bundled label carries a public `source` URL that was opened and verified.
5. Never commit API keys, `.env` or recorded keys. Fixtures strip `apikey`; headers are never recorded.
6. Never push. The owner pushes. After v1, work goes through `<type>/<issue-number>-<slug>` branches and PRs, squash-merged by the owner.

## Conventions

- Conventional Commits in English (`feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `perf`). No `Co-Authored-By` lines.
- Gate before every commit: `bun run check && bun run typecheck && bun test`.
- Explicit `.ts` import extensions and `import type`.
- Update `README.md`, `CLAUDE.md` and `.env.example` in the same commit as any behaviour or config change.

## Workflow

- Work is tracked in GitHub milestones (`Phase N — Name`, each with a "Done when:" description) and issues, one issue per plan step until v1.
- Issue titles use the commit style (`feat(core): …`); bodies carry Scope, an Acceptance checklist and the planned commit message.
- Commits reference their issue with a `Refs #N` footer, or `Closes #N` on the commit that finishes it. The owner pushes and closes issues; never close one yourself.
- After v1, branches are `<type>/<issue-number>-<slug>` (`<type>/<slug>` when there is no issue) and the PR body says `Closes #N`.
