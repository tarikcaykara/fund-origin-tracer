# Security policy

## Supported versions

Only the `master` branch is supported. Fixes land on `master`; there are no maintained release branches.

## Reporting a vulnerability

Report vulnerabilities **privately** by email to **tarik@caykara.com**. Please do not open a public issue or pull request for a security problem.

Include:

- what the problem is and which component it affects (`packages/core`, `apps/server`, `apps/cli`, `apps/web`, a bundled fixture);
- steps or a minimal request to reproduce it;
- the commit you tested against;
- the impact you expect (for example information disclosure, request forgery, denial of service).

Reports are handled privately by the maintainer; a fix lands on `master`.

## Keys and secrets

- **Never include API keys** (Etherscan, Tronscan) or the contents of your `.env` in issues, pull requests, logs, screenshots or report emails. Redact them first.
- If you find a key or other secret committed to this repository, report it privately as above. Treat any key that was ever exposed as compromised and rotate it at the provider.
- Recorded demo fixtures strip `apikey` parameters and never record request headers; a fixture that contains a secret is a vulnerability, please report it.

## Scope notes

- The server has no built-in authentication and is meant to run on a trusted network or behind your own access control. Missing authentication on an exposed instance is a deployment issue, not a vulnerability in itself.
- Findings from the traced data (labels, sanctions matches, risk levels) are heuristic analysis, not security vulnerabilities. Wrong or missing labels are normal issues; see [`docs/labels.md`](docs/labels.md).
