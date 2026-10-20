# fund-origin-tracer

Open-source crypto fund-flow tracer (Ethereum, Polygon, Arbitrum, TRON) for compliance/AML, fraud/risk and security/IR teams. Bun workspace, strict TypeScript end to end.

## Module map

| Path | Role |
|---|---|
| `packages/core` (`@fot/core`) | Runtime-agnostic engine: chains, result schema, providers, prices, labels, trace engine, analysis, exports |
| `apps/server` (`@fot/server`) | Hono REST/SSE API, SQLite persistence, run manager |
| `apps/cli` (`@fot/cli`) | `fot` CLI: trace, screen, labels, serve, fixtures |
| `apps/web` (`@fot/web`) | React + Vite + Tailwind + shadcn/ui UI |
| `scripts/dev.ts` | Runs API (3000) and Vite (5173) together |

## Hard rules

1. Code, comments, docs, commits and UI are in English.
2. `packages/core/src` imports nothing from `bun`, `bun:*` or `node:*`; only web-standard globals. Env, files and the clock are injected.
3. One result schema: `packages/core/src/schema.ts`. Server, CLI and web import it; never duplicate result or event types.
4. Every bundled label carries a public `source` URL that was opened and verified.
5. Never commit API keys, `.env` or recorded keys. Fixtures strip `apikey`; headers are never recorded.
6. Never push. The owner pushes. After v1, work goes through `feat/<slug>` branches and PRs, squash-merged by the owner.

## Conventions

- Conventional Commits in English (`feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `perf`). No `Co-Authored-By` lines.
- Gate before every commit: `bun run check && bun run typecheck && bun test`.
- Explicit `.ts` import extensions and `import type`.
- Update `README.md`, `CLAUDE.md` and `.env.example` in the same commit as any behaviour or config change.

## Workflow

- Work is tracked in GitHub milestones (`Phase N — Name`, each with a "Done when:" description) and issues, one issue per plan step until v1.
- Issue titles use the commit style (`feat(core): …`); bodies carry Scope, an Acceptance checklist and the planned commit message.
- Commits reference their issue with a `Refs #N` footer, or `Closes #N` on the commit that finishes it. The owner pushes and closes issues; never close one yourself.
- After v1, branches are `<type>/<issue-number>-<slug>` and the PR body says `Closes #N`.
