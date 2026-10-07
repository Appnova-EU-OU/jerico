# Contributing to Jerico

Thanks for helping. This repository holds Jerico's open client packages; the
hosted service they talk to is developed separately and is not open source.
That shapes what can be reproduced here: daemon, MCP server, codegraph and
desktop behaviour can, server-side orchestration behaviour cannot.

## Before you start

- Search existing issues first. For anything larger than a small fix, open an
  issue to agree on the approach before writing code.
- Security problems: do **not** open a public issue — follow [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node.js 22 or newer, and pnpm 10 (`npx -y pnpm@10 …` works
without a global install).

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck
```

Per-package tests:

| Package | Command |
|---|---|
| `packages/daemon` | `pnpm --filter @jerico/inspect-runtime build && cd packages/daemon && node scripts/build.mjs && bun test` (Bun 1.3) — see the warning below |
| `packages/mcp-server` | `pnpm --filter @bridge/mcp-server build && pnpm --filter @bridge/mcp-server test` |
| `packages/codegraph` | `pnpm --filter @bridge/codegraph build && node --test packages/codegraph/src/__tests__/*.test.mjs` |
| `packages/shared` | `cd packages/shared && bun test` |
| `apps/desktop` | `cd apps/desktop && node --test` |

**Run the daemon suite with a throw-away home directory.** A few daemon tests
exercise install/uninstall code paths. They mock the system calls, but run
them the way CI does so that nothing can reach your real configuration:

```bash
HOME="$(mktemp -d)" BRIDGE_PROFILE= bun test
```

## Pull requests

- Keep each pull request to one change, with tests for behaviour changes.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
  messages (`fix:`, `feat:`, `docs:`, `test:`, `refactor:`, `chore:`).
- CI must pass: typecheck, tests and the secret scan (`scripts/secret-scan.sh`).

## Developer Certificate of Origin

Every commit must be signed off. By adding a `Signed-off-by` line you certify
the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
that you wrote the change or otherwise have the right to submit it under the
licence of the package it modifies.

```bash
git commit -s -m "fix(daemon): describe the change"
```

This adds `Signed-off-by: Your Name <you@example.com>`, which must match the
commit author. To sign off commits you already made:

```bash
git rebase --signoff main
```

Contributions are licensed under the licence of the package they change (MIT
for `packages/daemon`, Apache-2.0 elsewhere — see [LICENSE.md](LICENSE.md)).
No contributor licence agreement is required.

## Code of Conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md).
