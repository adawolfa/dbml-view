# dbml-view — ROADMAP

A tool for quickly **viewing** `.dbml` files. No editor, no SQL export, no DB connection. The goal is to be able to:

1. Paste/load DBML and see it as a **diagram** (ER).
2. See it as a **clickable structure** (tables → columns → FK → target table).
3. Use it as a web SPA.
4. Double-click a `.dbml` file on Windows and open it in a native window.

---

## 1. Scope & non-goals

**In scope**
- Read-only DBML viewer
- Single-file `.dbml` as input (text input for components, file input for the app shell)
- Diagram view + structured view, side by side / switchable
- Pan & zoom in the diagram, search + filter in the structure
- Works offline, no server, no account

**Non-goals (at least for v1)**
- DBML editor
- Import from a live DB / export to SQL
- Sharing / cloud
- Multi-file DBML projects (`importer` / `@dbml/core` multifile API) — maybe v2
- macOS/Linux desktop build (the web app will run there, but the shell targets Windows only)

---

## 2. Key library decisions

### Parser: `@dbml/parse`
The official DBML v2 parser from Holistics (v5.5.1, May 2026). Full syntax coverage including `TableGroup`, `Enum`, `Ref`, indexes, notes, settings, projects.

- The package has no README — we will verify the API directly from `node_modules/@dbml/parse/dist/*.d.ts` when implementation starts.
- If `@dbml/parse` doesn't expose a convenient `Database` model (only an AST), we fall back to **`@dbml/core`** (`Parser.parse(src, 'dbml')` → `Database`). `@dbml/core` internally calls `@dbml/parse`, so syntax coverage is identical, just the bundle is bigger (it contains SQL importers/exporters that we don't need anyway). We therefore primarily target `@dbml/parse`, with `@dbml/core` as a fallback.

### Diagram renderer: **custom**, HTML tables + SVG overlay for edges
Existing DBML renderers (`@softwaretechnik/dbml-renderer`, mermaid, …) are either inflexible or not pretty enough. We target a modern WebView2 (Chromium), so there's no point fighting with SVG text — tables will be rendered purely in **HTML/CSS**, edges in an **SVG overlay** above them. A standard approach (this is exactly how React Flow does it), which solves a large part of the work for free:

- text rendering, font metrics, line-height, ellipsis;
- accessibility (selectable text, screen reader, browser search via Ctrl+F);
- hover/focus states, transitions, theming via CSS variables;
- no `createElementNS` boilerplate, no manual text measurement for sizing.

**Viewport composition:**

```
┌─ <div class="dv-viewport">                       (clip, overflow:hidden)
│  └─ <div class="dv-canvas" style="transform: translate(tx,ty) scale(s)">
│     ├─ <svg class="dv-edges">  ← absolute, covers the whole canvas, only <path>
│     └─ <div class="dv-nodes">  ← absolute, contains table divs
│        ├─ <div class="dv-table" style="transform:translate(x,y)"> … </div>
│        ├─ <div class="dv-table" …> … </div>
│        └─ …
```

**Pipeline:**

1. **Measurement**: render tables into a hidden off-screen container, measure `getBoundingClientRect()` → get `width`/`height` per table. (No font-metric guessing.)
2. **Layout**: feed tables and FKs into [`dagre`](https://github.com/dagrejs/dagre) (`@dagrejs/dagre`, ~50 kB, pure JS, sync, `rankdir: LR`). Default choice for ER diagrams with dozens of tables. If it produces ugly results on dense schemas, we have a fallback in [`elkjs`](https://github.com/kieler/elkjs) (~1 MB, async, layered/force) — `packages/layout` keeps the engine as a swappable adapter.
3. **Applying positions**: `transform: translate(x, y)` on each table. At the same time, for each row (table column) we remember its `offsetTop` + height — those are the anchor points for FK edges.
4. **Edge routing**: for each `Ref` compute the exit point (right edge of the source FK row) → entry point (left edge of the target PK row) and emit `<path d="M … H … V … H …">` in the SVG overlay. Orthogonal paths with bends. Endmarks (crow's foot / arrow) follow the cardinality in DBML (`>`, `<`, `-`, `<>`).
5. **Pan & zoom**: trivial — wheel changes `scale`, drag changes `translate` on the root `.dv-canvas`. The SVG overlay shares the same transform, so edges and tables overlap exactly. No `svg-pan-zoom`, no external deps — roughly 60 lines of TS.

**Interactions:**
- Hover on a table → CSS adds a class to neighbouring tables and relevant edge `<path>`s (highlight).
- Click on a table → emit a `table-selected` custom event.
- Right-click / context menu not in v1.

**Drag-to-reposition (optional in v1, otherwise v2):** after layout, enable manual table dragging (pointer events on `.dv-table`), persist positions to `localStorage` (key = sha256 prefix of the DBML content). A "Reset layout" button clears the overrides.

**Deliberately not using:**
- **React Flow / xyflow** — tied to React; we are going vanilla. (Inspiration in architecture yes, dependency no.)
- **Cytoscape.js** — beautiful for graphs, but row-anchored ER edges in it produce compromises.
- **JointJS / mxGraph** — overkill.
- **Mermaid** — no control over layout or appearance.

Architecture: `packages/layout` (DBML model + measured dimensions → table positions + edge routes) is a pure function, separated from `packages/components` (custom DOM rendering). The layout engine can be swapped (dagre ↔ elkjs) without touching the renderer.

### Structured view: custom vanilla TS component
No library, it's just a tree/list over the `Database` model from the parser. Routing between tables stays inside the component (hash links), not via a router.

### Desktop shell: **Tauri 2.x**
- Standard choice for "native webview + tiny bundle". On Windows it uses Edge WebView2 (preinstalled on W10/W11), bundle ~5–10 MB, idle RAM 30–50 MB.
- File-association registration via `tauri.conf.json` (`bundle.windows.fileAssociations`).
- We have the Rust toolchain.

### UI framework: none (vanilla TS + Custom Elements)
- Components `<dbml-diagram>` and `<dbml-structure>` as Custom Elements. They mount anywhere, are "framework-agnostic", trivially embeddable into documentation or a spec.
- The SPA shell is also vanilla TS (Vite). No React/Vue/Svelte — we save bundle size, the scope is small, and most of the code is "load file → call component".

### Build & packaging
- **pnpm** workspaces, **TypeScript strict**, **Vite** for the web bundle.
- **Biome** for linter + formatter — single binary, single config, no plugin Babylon à la ESLint.
- Target `ES2022`, no polyfills.

---

## 3. Repo structure

```
dbml-view/
  packages/
    parser/           # @dbml/parse wrapper + stable TS types (Database, Table, Field, Ref...)
    layout/           # Database → { nodes: positioned tables, edges: routed FKs }; engine = dagre (default)
    components/       # <dbml-diagram>, <dbml-structure> as Custom Elements
  apps/
    web/              # SPA — drop zone, load file, show both views
    desktop/          # Tauri shell (or .NET WebView2 host)
  samples/            # .dbml fixtures (small, medium, edge cases)
  ROADMAP.md
  README.md           # will appear as part of v1
  package.json        # pnpm workspace root
  pnpm-workspace.yaml
  tsconfig.base.json
```

---

## 4. Implementation phases

Phase by phase, each phase is independently usable.

### Phase 0 — Bootstrap (½ day)
- pnpm workspace, TS, Vite, prettier.
- Sample `.dbml` files in `samples/` (simple, medium with schemas/enums, edge case with self-refs).
- Hello-world Vite app.

### Phase 1 — `packages/parser` (½ day)
- Thin wrapper around `@dbml/parse`.
- Export a stable `ParsedDatabase` type (re-export or our adapter, depending on what `@dbml/parse` offers).
- Util function: `parseDbml(src: string): { ok: true; db: ParsedDatabase } | { ok: false; error: ParseError }`.
- Test fixtures across all `samples/`.

### Phase 2 — `<dbml-structure>` (1 day)
- Custom Element. Prop `source: string` or `database: ParsedDatabase`.
- Layout: left panel with a list of tables (group → schema → table), right panel with detail.
- In the table detail: note, columns (name, type, nullable, default, note, PK/FK badge), indexes, refs to/from the table (clickable).
- Global fulltext search across table and column names.
- URL hash for deep-linking to a table (`#table:public.users`).
- No external deps besides the parser.

### Phase 3 — `packages/layout` + `<dbml-diagram>` (2 days)
**3a. Layout engine** (`packages/layout`)
- Input: `Database` + `Map<TableId, { width, height, rowOffsets: Map<ColumnId, { top, height }> }>` (dimensions measured by the renderer, see 3b).
- Mapping to a dagre graph: each table = node with measured `width`/`height`, each `Ref` = edge.
- After `dagre.layout()` we get table positions; **we compute edge routing ourselves** with anchor points at the column-row level (FK column → PK column), orthogonal path exit→jog→entry.
- Output: `LayoutResult = { tables: PositionedTable[], edges: RoutedEdge[], bbox: Rect }`. Pure function, no DOM, easily testable.

**3b. HTML/SVG renderer** (`packages/components`)
- `<dbml-diagram>` Custom Element. Prop `source: string` or `database`.
- Pipeline:
  1. Build the table DOM (`<div class="dv-table">` with header + column rows) and insert into an off-screen container.
  2. After `requestAnimationFrame` measure `getBoundingClientRect()` and `offsetTop` of each row.
  3. Pass dimensions to `packages/layout`, get positions + edge routes.
  4. Move the tables into the visible `.dv-canvas` via `transform: translate(x,y)`.
  5. Render the SVG overlay with one `<path>` per FK + endmarks (crow's foot / arrow per cardinality).
- Pan/zoom: custom handler (~60 lines) on wheel + pointer drag, applies `transform` to `.dv-canvas`.
- Toolbar: zoom in/out, fit-to-screen, reset, export SVG (renders the whole canvas into a standalone SVG document).
- Interactions: hover on table → CSS class on neighbours + relevant edges; click on table → emit `table-selected` event.
- Loading + error state (invalid DBML, empty schema).

**3c. Drag-to-reposition** (optional in v1; otherwise v2)
- After auto-layout, enable manual table dragging via pointer events on `.dv-table`, persist positions to `localStorage` (key = sha256 prefix of the DBML content).
- During drag, recompute only the edge routes that touch the table being moved.
- "Reset layout" button → clear overrides and re-render from dagre.

### Phase 4 — `apps/web` SPA (½ day)
- Drop zone + file picker, drag&drop `.dbml`.
- Tab switch: **Structure** ↔ **Diagram** ↔ **Split**.
- Remembers the last file in `localStorage` (for convenience on refresh).
- URL parameter `?url=` for loading DBML from a URL (optional, for embedding into specs via a link).
- No backend, pure static hosting (GitHub Pages / file://).

### Phase 5 — `apps/desktop` Windows shell (1 day)
- **Tauri 2** project, target `windows-msvc`.
- File association: `.dbml` → our app. Tauri handles this via `bundle.windows.fileAssociations` + a handler in the Rust main.
- Window: a plain window hosting the SPA bundle, plus a handler for `argv[1]` → load the file from disk and pass it to the component.
- No menu, no update mechanism in v1.
- CI: GitHub Action on a windows-latest runner, produces `.msi` + `.exe`.
- **Decision point before starting Phase 5**: verify that Tauri is the preferred path vs. WPF+WebView2.

### Phase 6 (optional, if there's appetite)
- Multi-file DBML projects (via `@dbml/core` `parseDbmlProject`).
- ELK as an alternative layout engine for large/dense schemas.
- Drag-to-reposition + persist (if not delivered in Phase 3).
- Dark mode (CSS variables already in place from Phase 2).
- Export structure to markdown for inclusion in a spec.
- Export diagram to PNG (via `<canvas>` from SVG).

---

## 5. Open questions for the implementation phase

1. **`@dbml/parse` API** — if it doesn't return `Database` directly like `@dbml/core` does, how big an adapter do we need? Resolved by reading the `.d.ts` in `node_modules` at the start of Phase 1.
2. **Layout engine** — start with dagre. On dense schemas it may produce too many crossings; therefore keep `packages/layout` such that the engine can be swapped for ELK just by changing the adapter.
3. **Drag-to-reposition v1 vs. v2** — if Phases 3a+3b come together quickly, we ship 3c in v1 too; otherwise it's parked for v2.
