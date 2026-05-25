# dbml-view

Read-only viewer for `.dbml` files — diagram (ER) + clickable structure. See [ROADMAP.md](ROADMAP.md) for the full scope and design decisions.

## Layout

pnpm workspace, ESM, TypeScript strict.

- `packages/parser` — wraps `@dbml/parse` into the normalized model the rest of the app consumes
- `packages/layout` — graph layout for the diagram (`@dagrejs/dagre`)
- `packages/components` — framework-free DOM components (diagram canvas, structure tree), ships its own `style.css`
- `apps/web` — Vite SPA shell that wires the packages together
- `samples/` — `.dbml` files used during development
- A future `apps/desktop` (Tauri, Windows-only) will wrap the web app — not present yet

Internal packages export TypeScript sources directly (`main`/`exports` point at `src/index.ts`); there is no pre-build step required for `pnpm dev`.

## Commands

Run from the repo root.

- `pnpm dev` — start the web app (Vite, `@dbml-view/web`)
- `pnpm build` — recursive build of all workspace packages
- `pnpm typecheck` — recursive `tsc -b`
- `pnpm lint` — Biome check
- `pnpm format` — Biome format (writes)
- `pnpm test:e2e` — Playwright E2E (`apps/web/e2e/`); auto-starts `pnpm dev` on port 4173. First run needs `pnpm --filter @dbml-view/web exec playwright install chromium`.

When working outside the main worktree (e.g. in `.claude/worktrees/*`), `pnpm dev` already uses a random OS-assigned port by default — no extra flags needed.

## Preview server config (`.claude/launch.json`)

The Claude Preview MCP reads `.claude/launch.json` to start the dev server. This file is **deliberately pinned to `port: 0` with no `--port` arg**, so each session/worktree gets an OS-assigned free port and concurrent agents never collide.

**Do not edit `.claude/launch.json` to set a fixed port.** If `preview_start` fails, the cause is not the port — read the actual error. The MCP discovers the real port from Vite's stdout. The file is now tracked in git so any rewrite shows up in `git status`; revert it.

## Conventions

- **Toolchain:** Biome for lint + format, Vite for the app, pnpm workspaces. No ESLint/Prettier/webpack — keep it single-tool. (See user memory: prefer lean toolchains.)
- **TS config:** strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Code must hold up under these.
- **Formatting (Biome):** 2-space indent, 100-col, single quotes, trailing commas, semicolons.
- **Module style:** ESM only (`"type": "module"`), bundler-style resolution.
- **Node:** `>=20`, package manager pinned to `pnpm@9.15.0`.
- **Scope discipline:** read-only viewer. No editor, no SQL export, no DB connection, no multi-file DBML — those are explicit non-goals for v1.
