# Repository Guidelines

## Project Structure & Module Organization

Jano is an npm workspace for a personal assistant running as a macOS daemon plus a Cloudflare Worker.

- `daemon-v2/src/`: daemon runtime, agent tools, proactive jobs, and colocated `*.test.ts` files.
- `daemon-v2/scripts/`: operational and standalone workflows, including competitive research.
- `daemon-v2/assets/`: images and other runtime assets.
- `shared-v2/src/`: types and utilities shared by local and edge components.
- `worker-v2/src/`: Cloudflare webhook and queue ingress.
- `launchd/`: macOS job definitions; `docs/`: architecture, decisions, and operational references.
- `widgets/` and `telegram-plugin/`: Scriptable widgets and Telegram integration.

Read `CLAUDE.md` for detailed runtime contracts and `docs/ARCHITECTURE.md` before changing daemon boundaries.

## Build, Test, and Development Commands

Run commands from the repository root:

```bash
npm install                 # install all workspace dependencies
npm test                    # run Vitest across workspaces
npm run typecheck           # TypeScript checks without emitting files
npm run build               # build shared code, then the daemon
npm -w @cos/daemon run dev  # watch the local daemon
npm -w @cos/worker run dev  # run the Worker with Wrangler
```

Use workspace-specific commands for focused validation, for example `npm -w @cos/daemon test -- src/menu.test.ts`.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, semicolons, and double quotes. Prefer small modules and explicit types at external boundaries. Use `camelCase` for values/functions, `PascalCase` for types, and descriptive kebab-case filenames. Keep tests beside their implementation as `name.test.ts`. No formatter or linter script is enforced; always run typecheck and `git diff --check`.

## Testing Guidelines

Vitest is the test framework. Add a regression test before each bug fix and cover success, failure, timeout, and fail-soft behavior when relevant. Run focused tests while iterating, then the full suite, typecheck, and build before handoff.

## Paywall Summaries & Cookie Broker

Authenticated article reads use the Cookie Broker; its cookie source is Safari on the Mac running Jano, not Safari on an iPhone. Registering a domain only copies an existing local session—it does not create a login or membership. `addDomainAndSync()` must provisionally add new domains, wake the FDA-authorized `com.cal.cookie-jar-sync` LaunchAgent, wait for fresh sync output, and roll back failed/no-cookie registrations. Never spawn `node-fda` directly from the daemon.

Cookie presence is not access proof: reject explicit paywall markers even when cookies were supplied, preserve retry state, and offer `Reintentar`. For `fs.blog/knowledge-project-podcast/{slug}/`, a blocked promotional page may have an authenticated transcript at the deterministic same-origin path `/knowledge-project-podcast-transcripts/{slug}/`; try only that path and validate it again before summarizing. Do not follow arbitrary fallback links or summarize a membership teaser.

## Commit & Pull Request Guidelines

History follows Conventional Commits: `feat(scope): ...`, `fix(scope): ...`, `docs(scope): ...`, and `chore: ...`. Keep commits narrowly scoped. Pull requests should explain behavior and risk, list verification commands, link the relevant issue or decision, and include screenshots for widget or card changes.

## Security & Operations

Store secrets only in 1Password and resolve them per process; never commit tokens or populated `.env` files. Preserve unrelated worktree changes. Do not deploy, restart daemons, or modify production data without explicit authorization.
