# Contributing

Thanks for helping. This project traces crypto funds for compliance, fraud and incident-response work, so accuracy and traceability of every change matter more than speed.

## Setup

Requirements: [Bun](https://bun.sh) 1.4.3.

```bash
bun install
cp .env.example .env     # add a free Etherscan key and/or Tronscan key(s); optional
bun run dev              # API on :3000, web UI on :5173
```

You do not need any key to work on most of the code: the tests run offline and the three demo scenarios replay without keys (`DEMO_ONLY=true bun run start`).

Layout and conventions are in [`CLAUDE.md`](CLAUDE.md). The short version:

- TypeScript strict, `.ts`/`.tsx` import extensions, `import type` for types, no `any`.
- `packages/core` is runtime-agnostic: no `bun`, `bun:*` or `node:*` imports. Env, files and the clock are injected.
- `packages/core/src/schema.ts` is the only result/event contract. Do not redefine its types elsewhere.
- Code, comments, docs, commits and UI are in English.

## Checks

Run all three before every commit and before opening a pull request:

```bash
bun run check       # Biome lint + format check (bun run format fixes formatting)
bun run typecheck   # tsc for core, server, cli and web
bun test            # unit and integration tests, fully offline
```

Behavior changes need a test. Changes to behavior, configuration or the API also update `README.md`, `CLAUDE.md`, `.env.example` and the matching page in `docs/` in the same commit.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org) in English: `feat(core): …`, `fix(server): …`, `docs: …`. Types: `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `perf`.
- No `Co-Authored-By` trailers.
- Reference the issue in the commit footer: `Refs #N`, or `Closes #N` on the commit that finishes it.
- Work on a branch named `<type>/<issue-number>-<slug>` (for example `feat/42-polygon-bridges`; `<type>/<slug>` when there is no issue) and open a pull request whose description says `Closes #N`. The maintainer squash-merges; keep the PR to one logical change.
- Contributors do not push to `master`.

## Contributing labels

Labels (exchange hot wallets, DEX routers, bridges, mixers, tokens) are the most useful contribution and the easiest to get wrong. A wrong label can wrongly stop a trace or wrongly accuse an address.

- Every entry **must** have a `source`: a public URL that you **opened**, that shows that exact address with that name, and that falls in one of the accepted source kinds. The kinds and rules are in [`docs/labels.md`](docs/labels.md#source-policy).
- Set `verifiedAt` to the day you checked. Use the name the source shows.
- Third-party label dumps are not a source. Pull requests without a source per entry are closed.
- Edit `packages/core/labels/<chain>.json` (EVM addresses lowercase, TRON addresses in base58 case), then run:

  ```bash
  bun apps/cli/src/main.ts labels validate packages/core/labels/<chain>.json
  bun run check && bun test
  ```

Private labels (your own cases and customers) belong in a local file loaded through `FOT_LABELS_PATH`; never commit those.

## Recording a demo scenario

Demo scenarios replay a recorded trace so the product runs without keys. Recording needs working keys for the chain.

```bash
bun run fixtures:record \
  --scenario d4-my-case \
  --title "My case" \
  --description "One sentence on what this demo shows." \
  --chain ethereum --direction backward \
  --tx 0x… --max-depth 6 --max-branches 3 --max-edges 120
```

This runs a live trace through a recording transport and writes `fixtures/demo/<id>/scenario.json`, `http.json.gz` (API key stripped, headers never recorded) and `ofac.json` (the parsed OFAC snapshot, not the 29 MB XML). Notes:

- Scenario ids are lowercase letters, digits and dashes.
- Recording and replay both use engine concurrency 1 and a fresh in-memory cache; do not change that, or replay will miss requests.
- Keep `http.json.gz` under 3 MB; the command warns otherwise. Re-record with a smaller `--max-edges`.
- Only record public on-chain activity that you are comfortable publishing. Prefer activity of public entities or your own test wallets.
- **Fixtures must pass gitleaks before you commit them:**

  ```bash
  gitleaks dir fixtures          # gitleaks >= 8.19
  gitleaks detect --no-git --source fixtures   # older versions
  ```

## Secrets runbook

- `.env` and `.env.*` (except `.env.example`) are git-ignored. **Never commit `.env`**, API keys, recorded requests with keys, or local label/policy files with private data. Do not paste keys into issues, pull requests, logs or screenshots.
- Before committing, check `git status` and `git diff --cached` for stray files.
- **If a key leaks, rotate it first**, before anything else: create a new key at Etherscan or Tronscan, update your `.env`, and delete the old key. Only then clean up the history (an old key stays valid in clones, forks and caches until it is revoked, so removing the commit alone is not a fix).
- If you find a leaked key in this repository, follow [`SECURITY.md`](SECURITY.md); do not open a public issue containing it.
