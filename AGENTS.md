# Repository Guidelines

## Project Structure & Module Organization

- `porthop` is the Bash CLI. It contains the `forward`, `coordinator`,
  `server`, and `client` commands.
- `test/cli.test.mjs` contains Node.js tests for CLI parsing and behavior. Test
  doubles live under `test/fixtures/coordinator/`.
- `worker/src/index.js` implements the Cloudflare Worker and D1-backed HTTP API.
- `worker/test/worker.test.js` tests Worker routing and state changes with an
  in-memory database double.
- `worker/migrations/` contains ordered D1 migrations. Never edit a migration
  already applied to production; add the next numbered migration instead.
- `DESIGN.md` is the authoritative architecture and protocol description.

## Build, Test, and Development Commands

Run CLI checks from the repository root:

```bash
bash -n porthop
node --test test/cli.test.mjs
```

Run Worker tasks from `worker/`:

```bash
npm install                         # install development dependencies
npm test                            # run Worker unit tests
npm run dev                         # start a local Wrangler server
npx wrangler d1 migrations apply DB --local
npm run deploy                      # deploy the production Worker
```

`npm run db:migrate` modifies the remote D1 database. Review every pending
migration before running it.

## Coding Style & Naming Conventions

Use four-space indentation in Bash and two-space indentation in JavaScript.
Keep Bash compatible with the existing `set -euo pipefail` execution model.
Use `snake_case` for shell functions and variables, uppercase names for shell
constants, and `camelCase` for JavaScript functions and variables. Channel names
must match `[A-Za-z0-9_.-]+`. Preserve JSON and D1 field names documented in
`DESIGN.md`. No automatic formatter is configured; run `git diff --check` before
committing.

## Testing Guidelines

Tests use `node:test` and strict assertions. Add regression
tests with each behavior change. Name tests as plain descriptions of observable
behavior. Use fixtures instead of real nftables, WireGuard, Cloudflare, or network
access. Run both CLI and Worker test suites before submitting changes.

## Commit & Pull Request Guidelines

Use Conventional Commits with a lowercase scope, for example:
`feat(client): report stale endpoint ports`. Include a short body explaining the
reason or important behavior. Keep subject and body in English and avoid
attribution trailers.

Pull requests should summarize behavior changes, list verification commands, and
call out API, schema, migration, or deployment effects. Update `DESIGN.md` and
`worker/README.md` whenever their contracts change. Screenshots are unnecessary
unless a future change introduces a visual interface.

## Security & Configuration

Never commit `.dev.vars`, tokens, or production credentials. Use
`PORTHOP_TOKEN_FILE` for the CLI and Wrangler secrets for the Worker. Treat remote
D1 migrations and Worker deployment as explicit production operations.
