# dbml-view

Read-only viewer for `.dbml` files. Three panels — **Structure** (tree), **Detail** (selected table/enum), **Diagram** (ER) — wired together by URL hash, cross-panel hover, and a hide-from-diagram set. Runs as a browser SPA and inside a Tauri desktop shell with `.dbml` file-association on Windows.

## Layout

pnpm workspace, ESM, TypeScript strict.

- `packages/parser` — wraps `@dbml/parse` (`Compiler` API), re-exports the `Database` model and adds id/lookup helpers (`tableId`, `columnId`, `enumId`, `findTable`, …)
- `packages/layout` — pure `Database + measured-DOM-dims → positioned tables + routed edges`. Engine = **ELK** (`elkjs`, `elk.layered`); ELK's edge waypoints are discarded and replaced by our own grid-snapped orthogonal router so arrows anchor at the exact FK/PK row. Self-refs are routed by hand.
- `packages/components` — framework-free Custom Elements: `<dbml-structure>`, `<dbml-detail>`, `<dbml-diagram>`. Ships its own `style.css`. Call `register()` after `setLocale()` so initial render uses the right strings.
- `packages/i18n` — tiny locale store (`en`, `cs`) with `t(key, vars)`. English is the source of truth; `TranslationKey` is derived from it so other locales must cover every key.
- `apps/web` — Vite SPA shell. Three resizable panels with persisted widths, drop-zone + file-picker + sample loader, parse-error modal with code context, theme/font/locale settings, hidden-tables persistence keyed by file label, deep-linking via `#table:…` / `#enum:…` hash.
- `apps/desktop` — Tauri 2 shell (Windows-only target). Registers `.dbml` file association; each launch is its own process (multi-instance) — argv is held in `PendingOpen` and drained by the `take_pending_open` IPC command. Parallel windows share localStorage via WebView2's per-app user-data folder, and the frontend's `storage`-event listener keeps the recent-files dropdown in sync across them. The webview is kept hidden until the frontend has applied theme + initial content (no white flash).
- `samples/` — `.dbml` fixtures (`small`, `medium`, `large`, `edge-cases`, `tablegroup`, `colors`)

Internal packages export TypeScript sources directly (`main`/`exports` point at `src/index.ts`); no pre-build step is needed for `pnpm dev`.

## Commands

Run from the repo root.

- `pnpm dev` — start the web app (Vite, `@dbml-view/web`)
- `pnpm build` — recursive build of all workspace packages
- `pnpm typecheck` — recursive `tsc -b`
- `pnpm lint` — Biome check
- `pnpm format` — Biome format (writes)
- `pnpm test:e2e` — Playwright E2E (`apps/web/e2e/`); auto-starts `pnpm dev` on port 4173 (override with `PLAYWRIGHT_PORT`). First run needs `pnpm --filter @dbml-view/web exec playwright install chromium`.
- `pnpm --filter @dbml-view/desktop dev` — build the web bundle, then launch Tauri pointing at `dist/` via the `custom-protocol` feature (no dev server is involved — restart this between iterations when verifying inside the actual window).
- `pnpm --filter @dbml-view/desktop build` — produce `.msi` + `.exe` under `apps/desktop/src-tauri/target/release/bundle/`.

Both desktop commands go through [apps/desktop/scripts/tauri.mjs](apps/desktop/scripts/tauri.mjs), which on Windows sources `vcvars64.bat` (located via `vswhere`) before invoking the Tauri CLI so cargo finds the MSVC x64 linker. If you see `LNK1104: msvcrt.lib`, the VS "Desktop development with C++" workload is missing or broken — fix the install, don't try to bypass the wrapper.

CI: [.github/workflows/desktop.yml](.github/workflows/desktop.yml) runs the desktop build on `windows-latest` for tags `v*`, `workflow_dispatch`, and PRs that touch `apps/`, `packages/`, the lockfile, or the workflow itself. Artefacts are uploaded as `dbml-view-windows`.

When working outside the main worktree (e.g. in `.claude/worktrees/*`), `pnpm dev` already uses a random OS-assigned port — no extra flags needed.

## Preview server config (`.claude/launch.json`)

The Claude Preview MCP reads `.claude/launch.json` to start the dev server. This file is **deliberately pinned to `port: 0` with no `--port` arg**, so each session/worktree gets an OS-assigned free port and concurrent agents never collide.

**Do not edit `.claude/launch.json` to set a fixed port.** If `preview_start` fails, the cause is not the port — read the actual error. The MCP discovers the real port from Vite's stdout. The file is tracked in git so any rewrite shows up in `git status`; revert it.

## Implementation workflow

- **Cross-panel wiring lives in [apps/web/src/main.ts](apps/web/src/main.ts).** The components don't know about each other — the shell listens to `selection-change`, `hover-change`, `search-active-change`, `visibility-change`, `jump-to`, `table-selected` and routes them. When adding a new cross-panel behaviour, add the event on the source component and the listener in `main.ts`; don't reach across components.
- **Selection is URL-driven.** `#table:<id>` / `#enum:<id>` is the source of truth; `applySelection()` resolves it against the current database and drops stale references when the user switches files.
- **Diagram pipeline is measure → layout → render.** Tables are rendered off-screen, `getBoundingClientRect()` + per-row `offsetTop` is captured, fed into `packages/layout`, and only then placed in the visible canvas with `transform: translate(…)`. Edges live in an SVG overlay that shares the canvas transform.
- **Persistence keys** all live in `apps/web/src/main.ts` as `LS_*` constants — last source, last name, active views, theme, locale, font, per-panel widths, per-file hidden set. Add new keys there and keep them prefixed `dbml-view:`.
- **i18n discipline.** No user-facing string literals in components — everything goes through `t(...)`. Add the English key in [packages/i18n/src/en.ts](packages/i18n/src/en.ts) first; TypeScript will then require it in `cs.ts`.
- **E2E first for UI changes.** The `apps/web/e2e/` suite covers parse errors, settings, diagram snapshots, structure search, hide/show, Ctrl+F, header. If you touch any of those areas, run `pnpm test:e2e` and add/adjust a spec — visual diagram changes will trip the snapshot test.
- **Tauri features flag.** `custom-protocol` is in `[features].default` for release, but `tauri dev` strips defaults; the wrapper re-adds it explicitly so dev and prod serve the bundle the same way. Don't remove that flag from the dev path.

## Conventions

- **Toolchain:** Biome for lint + format, Vite for the app, pnpm workspaces, ELK for layout, Tauri 2 for the shell. No ESLint/Prettier/webpack — keep it single-tool. (See user memory: prefer lean toolchains.)
- **TS config:** strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Code must hold up under these.
- **Formatting (Biome):** 2-space indent, 100-col, single quotes, trailing commas, semicolons.
- **Module style:** ESM only (`"type": "module"`), bundler-style resolution.
- **Components:** vanilla TS Custom Elements; no React/Vue/Svelte; no Shadow DOM (so the shared `style.css` and the app's CSS variables theme everything uniformly).
- **Node:** `>=20`, package manager pinned to `pnpm@9.15.0`. Rust toolchain stable, target `x86_64-pc-windows-msvc`.
- **Scope discipline:** read-only viewer. No editor, no SQL export, no DB connection, no multi-file DBML — those are explicit non-goals for v1.
