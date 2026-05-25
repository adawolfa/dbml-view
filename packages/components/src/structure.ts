// <dbml-structure source="…"> — left-rail tree (group → table → columns/relations).
// The detail pane was split out into <dbml-detail>; this element now only owns
// the tree + search and emits selection-change events that the app shell wires
// to <dbml-detail> (and the URL hash).

import {
  type Column,
  DEFAULT_SCHEMA,
  type Database,
  type Enum,
  type Table,
  endpointTableId,
  enumId,
  hasMultipleSchemas,
  parseDbml,
  tableId,
} from '@dbml-view/parser';

import { t } from '@dbml-view/i18n';

import {
  type HiddenSet,
  type HoverState,
  type RefEntry,
  type Selection,
  type TreeGroup,
  buildTree,
  computeHiddenTableIds,
  emptyHiddenSet,
  escapeAttr,
  escapeHtml,
  formatColumnType,
  highlightHtml,
  hoverStateEquals,
  indexRefsByTable,
  otherEndpointOf,
  relationArrow,
  searchMatch,
  selfEndpoint,
  tableGroupKey,
} from './shared';

/**
 * One entry in the ordered list of search matches the structure can step
 * through with arrow keys. The shape mirrors {@link Selection} but is its own
 * type so consumers can't confuse "currently selected" with "search cursor".
 */
export type SearchMatch =
  | { kind: 'table'; tableId: string; columnName?: string }
  | { kind: 'enum'; enumId: string };

/** Detail of the `search-active-change` event — `null` means search is empty
 * or has no matches and the diagram/detail should drop any preview highlight. */
export type SearchActiveDetail = { match: SearchMatch; hover: HoverState } | null;

export class DbmlStructureElement extends HTMLElement {
  static readonly tagName = 'dbml-structure';

  static get observedAttributes(): string[] {
    return ['source'];
  }

  private database: Database | null = null;
  private selection: Selection = { kind: 'none' };
  private searchQuery = '';
  private refsByTableId = new Map<string, RefEntry[]>();
  private expandedGroups = new Set<string>();
  private expandedTables = new Set<string>();
  private hiddenSet: HiddenSet = emptyHiddenSet();
  private effectiveHidden: Set<string> = new Set();
  private rendered = false;
  /** Hover state applied from another panel. Cleared when this panel emits its own hover. */
  private externalHover: HoverState = { kind: 'none' };
  /** Tracks which hover state is currently being emitted so we can deduplicate. */
  private internalHover: HoverState = { kind: 'none' };
  /** Ordered list of search matches in tree traversal order. Rebuilt on every
   * search-driven render so arrow nav follows visual order. */
  private searchMatches: SearchMatch[] = [];
  /** Index into {@link searchMatches} for the currently highlighted match. */
  private activeMatchIndex = 0;
  /** Per-target highlight indices, keyed by `t:<tableId>` / `c:<tableId>.<col>`
   * / `e:<enumId>`. Lookup during render to wrap matched chars in &lt;mark&gt;. */
  private matchIndices = new Map<string, number[]>();

  connectedCallback(): void {
    if (!this.rendered) {
      this.classList.add('dv-structure');
      this.innerHTML = makeTemplate();
      this.wireEvents();
      this.rendered = true;
    }
    const source = this.getAttribute('source');
    if (source !== null && this.database === null) {
      this.source = source;
    } else {
      this.renderTree();
    }
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === 'source' && value !== null) {
      this.source = value;
    }
  }

  /** Parse the DBML string and re-render. Invalid input clears the tree. */
  set source(value: string) {
    const result = parseDbml(value);
    if (!result.ok) {
      this.database = null;
      this.refsByTableId.clear();
      this.renderTree();
      return;
    }
    this.setDatabase(result.db);
  }

  /** Set a pre-parsed Database directly (skips parsing). */
  setDatabase(db: Database): void {
    this.database = db;
    this.refsByTableId = indexRefsByTable(db);
    // Expand all groups by default; tables stay collapsed until selected.
    this.expandedGroups = new Set(buildTree(db).map((g) => g.id));
    this.effectiveHidden = computeHiddenTableIds(db, this.hiddenSet);
    if (!this.rendered) return;
    this.renderTree();
  }

  /**
   * Apply an externally-managed {@link HiddenSet} (e.g. restored from
   * localStorage). Replaces the current state and re-renders the tree;
   * does NOT emit `visibility-change` — pushes flow one way only.
   */
  setHiddenSet(next: HiddenSet): void {
    this.hiddenSet = {
      tables: new Set(next.tables),
      schemas: new Set(next.schemas),
      tableGroups: new Set(next.tableGroups),
    };
    if (this.database) {
      this.effectiveHidden = computeHiddenTableIds(this.database, this.hiddenSet);
    }
    if (!this.rendered) return;
    this.renderTree();
  }

  /** Current {@link HiddenSet}. The returned object is a fresh shallow copy. */
  getHiddenSet(): HiddenSet {
    return {
      tables: new Set(this.hiddenSet.tables),
      schemas: new Set(this.hiddenSet.schemas),
      tableGroups: new Set(this.hiddenSet.tableGroups),
    };
  }

  /** Focus the search input and select any current value (e.g. for Ctrl+F). */
  focusSearch(): void {
    const search = this.querySelector<HTMLInputElement>('[data-search]');
    if (!search) return;
    search.focus();
    search.select();
  }

  /**
   * Sync the tree's highlight + auto-expansion to an externally-driven
   * selection (hash navigation, diagram clicks, …). Does NOT emit
   * selection-change — only `notify()` should do that.
   */
  setSelection(selection: Selection): void {
    if (selectionEquals(this.selection, selection)) return;
    this.selection = selection;
    // Only expand the table itself when a column is specified — we need to open
    // it to make the column visible. For plain table selections (e.g. diagram
    // clicks) only expand the containing group so the table row scrolls into
    // view without expanding its column list.
    if (selection.kind === 'table' && selection.columnName !== undefined) {
      this.autoExpandForSelection();
    } else {
      this.autoExpandGroupForSelection();
    }
    if (!this.rendered) return;
    this.renderTree();
    this.scrollSelectionIntoView();
  }

  private wireEvents(): void {
    const search = this.querySelector<HTMLInputElement>('[data-search]');
    search?.addEventListener('input', () => {
      this.searchQuery = search.value.trim();
      this.activeMatchIndex = 0;
      this.renderTree();
      this.updateClearButton();
      this.emitSearchActive();
    });
    search?.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        if (this.searchMatches.length > 0) {
          event.preventDefault();
          this.activeMatchIndex = (this.activeMatchIndex + 1) % this.searchMatches.length;
          this.applyActiveMatchHighlight();
          this.emitSearchActive();
        }
      } else if (event.key === 'ArrowUp') {
        if (this.searchMatches.length > 0) {
          event.preventDefault();
          this.activeMatchIndex =
            (this.activeMatchIndex - 1 + this.searchMatches.length) % this.searchMatches.length;
          this.applyActiveMatchHighlight();
          this.emitSearchActive();
        }
      } else if (event.key === 'Enter') {
        if (this.searchMatches.length > 0) {
          event.preventDefault();
          this.activateCurrentMatch();
          this.clearSearch();
          search.blur();
        }
      } else if (event.key === 'Escape') {
        if (search.value !== '') {
          event.preventDefault();
          this.clearSearch();
        }
      }
    });

    const clearBtn = this.querySelector<HTMLButtonElement>('[data-search-clear]');
    clearBtn?.addEventListener('click', () => {
      this.clearSearch();
      search?.focus();
    });

    const tree = this.querySelector<HTMLElement>('[data-tree]');
    tree?.addEventListener('mouseover', (event) => {
      const node = (event.target as HTMLElement).closest<HTMLElement>('[data-node]');
      const state = node ? this.hoverStateFromNode(node) : { kind: 'none' as const };
      if (hoverStateEquals(state, this.internalHover)) return;
      this.internalHover = state;
      this.dispatchEvent(
        new CustomEvent<HoverState>('hover-change', { detail: state, bubbles: true }),
      );
    });
    tree?.addEventListener('mouseleave', () => {
      if (this.internalHover.kind === 'none') return;
      this.internalHover = { kind: 'none' };
      this.dispatchEvent(
        new CustomEvent<HoverState>('hover-change', {
          detail: { kind: 'none' },
          bubbles: true,
        }),
      );
    });
    tree?.addEventListener('click', (event) => {
      // Eye toggle takes precedence over the surrounding node click so the
      // user can show/hide without selecting/expanding the row underneath.
      const hideBtn = (event.target as HTMLElement).closest<HTMLElement>('[data-hide-toggle]');
      if (hideBtn) {
        event.preventDefault();
        event.stopPropagation();
        this.toggleHidden(hideBtn);
        return;
      }
      const node = (event.target as HTMLElement).closest<HTMLElement>('[data-node]');
      if (!node) return;
      event.preventDefault();
      const kind = node.dataset.node;
      if (kind === 'group') {
        const id = node.dataset.groupId ?? '';
        this.toggleGroup(id);
      } else if (kind === 'table') {
        const id = node.dataset.tableId ?? '';
        this.selectTableNoExpand(id);
      } else if (kind === 'column') {
        const id = node.dataset.tableId ?? '';
        const col = node.dataset.column ?? '';
        this.activateColumn(id, col);
      } else if (kind === 'relation') {
        const target = node.dataset.targetTable ?? '';
        this.selectTable(target);
      } else if (kind === 'enum') {
        const id = node.dataset.enumId ?? '';
        this.selectEnum(id);
      }
    });

    tree?.addEventListener('dblclick', (event) => {
      const node = (event.target as HTMLElement).closest<HTMLElement>('[data-node="table"]');
      if (!node) return;
      event.preventDefault();
      const id = node.dataset.tableId ?? '';
      this.toggleTableExpansion(id);
    });
  }

  private renderTree(): void {
    const container = this.querySelector('[data-tree]');
    if (!container) return;
    if (!this.database) {
      container.innerHTML = `<p class="dv-empty">${escapeHtml(t('structure.empty.no_dbml'))}</p>`;
      this.applyExternalHoverToDom();
      this.searchMatches = [];
      this.matchIndices.clear();
      return;
    }
    const groups = buildTree(this.database);
    const q = this.searchQuery;
    const matchingTables = new Set<string>();
    const matchingColumns = new Map<string, Set<string>>();
    const matchingEnums = new Set<string>();
    this.matchIndices.clear();
    this.searchMatches = [];
    if (q !== '') {
      // Tables first across all groups (visually rendered top-down), enums last
      // (rendered after every schema/tablegroup section). Matches the order the
      // arrow keys step through.
      for (const group of groups) {
        for (const table of group.tables) {
          const tId = tableId(table);
          const tableNameMatch = searchMatch(table.name, q);
          const colHits: Array<{ name: string; indices: number[] }> = [];
          for (const col of table.fields) {
            const hit = searchMatch(col.name, q);
            if (hit) colHits.push({ name: col.name, indices: hit });
          }
          if (tableNameMatch || colHits.length > 0) {
            matchingTables.add(tId);
            if (tableNameMatch) {
              this.matchIndices.set(`t:${tId}`, tableNameMatch);
              this.searchMatches.push({ kind: 'table', tableId: tId });
            }
            if (colHits.length > 0) {
              matchingColumns.set(tId, new Set(colHits.map((c) => c.name)));
              for (const c of colHits) {
                this.matchIndices.set(`c:${tId}.${c.name}`, c.indices);
                this.searchMatches.push({ kind: 'table', tableId: tId, columnName: c.name });
              }
            }
          }
        }
      }
      for (const group of groups) {
        for (const en of group.enums) {
          const eId = enumId(en);
          const enumNameMatch = searchMatch(en.name, q);
          if (enumNameMatch) {
            matchingEnums.add(eId);
            this.matchIndices.set(`e:${eId}`, enumNameMatch);
            this.searchMatches.push({ kind: 'enum', enumId: eId });
          }
        }
      }
      if (this.activeMatchIndex >= this.searchMatches.length) this.activeMatchIndex = 0;
      if (matchingTables.size === 0 && matchingEnums.size === 0) {
        container.innerHTML = `<p class="dv-empty">${escapeHtml(t('structure.empty.no_matches'))}</p>`;
        this.applyExternalHoverToDom();
        return;
      }
    }

    const showSchemaHeaders = hasMultipleSchemas(this.database);

    // Collect all visible enums from all groups — enums always live in schema
    // groups (never tablegroups), so flatMap is safe and preserves schema-then-
    // name alphabetical order established by buildTree.
    const allVisibleEnums = groups.flatMap((group) =>
      q === '' ? group.enums : group.enums.filter((e) => matchingEnums.has(enumId(e))),
    );

    const html = groups
      .map((group) => {
        const visibleTables =
          q === '' ? group.tables : group.tables.filter((t) => matchingTables.has(tableId(t)));
        // Enums are rendered separately at the bottom — skip them here.
        if (visibleTables.length === 0) return '';
        const tablesHtml = visibleTables
          .map((t) => this.renderTreeTable(t, q, matchingColumns, matchingTables))
          .join('');
        // Single-schema DB: drop the redundant schema-group wrapper and show
        // tables directly. TableGroups still get their wrapper either way.
        if (group.kind === 'schema' && !showSchemaHeaders) {
          return tablesHtml;
        }
        const groupOpen = q !== '' || this.expandedGroups.has(group.id);
        const chevron = groupOpen ? '▾' : '▸';
        const childrenHtml = groupOpen ? `<ul class="dv-tree-children">${tablesHtml}</ul>` : '';
        const hideToggle = this.renderHideToggle(group);
        const hiddenClass = this.isGroupHidden(group) ? ' is-hidden' : '';
        return `
          <li class="dv-tree-group${hiddenClass}" data-group-id="${escapeAttr(group.id)}">
            <div class="dv-tree-row">
              <button
                type="button"
                class="dv-tree-node dv-tree-node-group"
                data-node="group"
                data-group-id="${escapeAttr(group.id)}"
                aria-expanded="${groupOpen}"
              >
                <span class="dv-tree-chevron">${chevron}</span>
                ${group.kind === 'tablegroup' ? iconTableGroup(group.color) : iconSchema()}
                <span class="dv-tree-group-name">${escapeHtml(group.label)}</span>
              </button>
              ${hideToggle}
              <span class="dv-tree-count">${visibleTables.length}</span>
            </div>
            ${childrenHtml}
          </li>
        `;
      })
      .join('');

    // Render all enums after all schema/tablegroup sections, always flat (no folder).
    const enumsSectionHtml =
      allVisibleEnums.length > 0 ? allVisibleEnums.map((e) => this.renderTreeEnum(e)).join('') : '';

    container.innerHTML = `<ul class="dv-tree">${html}${enumsSectionHtml}</ul>`;
    this.applyExternalHoverToDom();
    this.applyActiveMatchHighlight();
  }

  /** Mark the DOM node corresponding to the active search match with
   * `is-search-active` and scroll it into view. Cleared before re-applying so
   * stale highlights don't accumulate across re-renders. */
  private applyActiveMatchHighlight(): void {
    for (const el of this.querySelectorAll<HTMLElement>('.is-search-active')) {
      el.classList.remove('is-search-active');
    }
    if (this.searchQuery === '' || this.searchMatches.length === 0) return;
    const match = this.searchMatches[this.activeMatchIndex];
    if (!match) return;
    const target = this.matchTargetEl(match);
    if (!target) return;
    target.classList.add('is-search-active');
    target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  private matchTargetEl(match: SearchMatch): HTMLElement | null {
    if (match.kind === 'enum') {
      return this.querySelector<HTMLElement>(
        `[data-node="enum"][data-enum-id="${cssEscape(match.enumId)}"]`,
      );
    }
    if (match.columnName !== undefined) {
      return this.querySelector<HTMLElement>(
        `[data-node="column"][data-table-id="${cssEscape(match.tableId)}"][data-column="${cssEscape(match.columnName)}"]`,
      );
    }
    return this.querySelector<HTMLElement>(
      `[data-node="table"][data-table-id="${cssEscape(match.tableId)}"]`,
    );
  }

  /** Translate the active match into a {@link HoverState} so listeners can mirror
   * the highlight in the diagram and detail panes. Returns `null` when there is
   * no active match (empty query or no hits). */
  private activeMatchHover(): HoverState | null {
    if (this.searchQuery === '' || this.searchMatches.length === 0) return null;
    const match = this.searchMatches[this.activeMatchIndex];
    if (!match || match.kind === 'enum') return null;
    if (match.columnName !== undefined) {
      return {
        kind: 'column',
        tableId: match.tableId,
        columnId: `${match.tableId}.${match.columnName}`,
      };
    }
    return { kind: 'table', tableId: match.tableId };
  }

  private emitSearchActive(): void {
    if (this.searchQuery === '' || this.searchMatches.length === 0) {
      this.dispatchEvent(
        new CustomEvent<SearchActiveDetail>('search-active-change', {
          detail: null,
          bubbles: true,
        }),
      );
      return;
    }
    const match = this.searchMatches[this.activeMatchIndex];
    if (!match) return;
    const hover = this.activeMatchHover() ?? { kind: 'none' };
    this.dispatchEvent(
      new CustomEvent<SearchActiveDetail>('search-active-change', {
        detail: { match, hover },
        bubbles: true,
      }),
    );
  }

  private activateCurrentMatch(): void {
    const match = this.searchMatches[this.activeMatchIndex];
    if (!match) return;
    if (match.kind === 'enum') {
      this.selectEnum(match.enumId);
      return;
    }
    if (match.columnName !== undefined) {
      this.activateColumn(match.tableId, match.columnName);
      return;
    }
    this.selectTable(match.tableId);
  }

  private clearSearch(): void {
    const search = this.querySelector<HTMLInputElement>('[data-search]');
    if (search) search.value = '';
    this.searchQuery = '';
    this.activeMatchIndex = 0;
    this.renderTree();
    this.updateClearButton();
    this.emitSearchActive();
  }

  private updateClearButton(): void {
    const btn = this.querySelector<HTMLButtonElement>('[data-search-clear]');
    if (!btn) return;
    btn.hidden = this.searchQuery === '';
  }

  private renderTreeTable(
    table: Table,
    q: string,
    matchingColumns: Map<string, Set<string>>,
    matchingTables: Set<string>,
  ): string {
    const id = tableId(table);
    const isSearching = q !== '';
    const expanded = isSearching || this.expandedTables.has(id);
    const active = this.selection.kind === 'table' && this.selection.tableId === id;
    const chevron = expanded ? '▾' : '▸';

    // Which columns to show under this table: when searching, only matches
    // (or all when the table name itself matches). Otherwise all.
    const colsToShow: Column[] = (() => {
      if (!isSearching) return table.fields;
      const set = matchingColumns.get(id);
      if (!set) return table.fields; // table name matched → show all
      return table.fields.filter((c) => set.has(c.name));
    })();

    const refs = this.refsByTableId.get(id) ?? [];
    const refsToShow: RefEntry[] = isSearching
      ? refs.filter((r) => {
          const selfEnd = selfEndpoint(r.ref, id, r.direction);
          const other = otherEndpointOf(r.ref, selfEnd);
          return matchingTables.has(endpointTableId(other));
        })
      : refs;

    const childrenHtml = expanded
      ? `
        <ul class="dv-tree-children">
          <li class="dv-tree-section">
            <span class="dv-tree-section-label">${escapeHtml(t('structure.section.columns'))}</span>
            <span class="dv-tree-count">${colsToShow.length}</span>
          </li>
          ${colsToShow.map((c) => this.renderTreeColumn(table, c)).join('')}
          ${
            refsToShow.length === 0
              ? ''
              : `
                <li class="dv-tree-section">
                  <span class="dv-tree-section-label">${escapeHtml(t('structure.section.relations'))}</span>
                  <span class="dv-tree-count">${refsToShow.length}</span>
                </li>
                ${refsToShow.map((r) => this.renderTreeRelation(table, r)).join('')}
              `
          }
        </ul>
      `
      : '';

    const hideToggle = this.renderTableHideToggle(id);
    const hiddenClass = this.effectiveHidden.has(id) ? ' is-hidden' : '';
    const tableNameHtml = highlightHtml(table.name, this.matchIndices.get(`t:${id}`) ?? null);
    return `
      <li class="dv-tree-table${active ? ' is-active' : ''}${hiddenClass}" data-table-id="${escapeAttr(id)}">
        <div class="dv-tree-row">
          <button
            type="button"
            class="dv-tree-node dv-tree-node-table${active ? ' is-active' : ''}"
            data-node="table"
            data-table-id="${escapeAttr(id)}"
            aria-expanded="${expanded}"
          >
            <span class="dv-tree-chevron">${chevron}</span>
            ${iconTable(table.headerColor ?? null)}
            <span class="dv-tree-table-name">${tableNameHtml}</span>
          </button>
          ${hideToggle}
          <span class="dv-tree-count">${table.fields.length}</span>
        </div>
        ${childrenHtml}
      </li>
    `;
  }

  private renderTreeColumn(table: Table, column: Column): string {
    const id = tableId(table);
    const active =
      this.selection.kind === 'table' &&
      this.selection.tableId === id &&
      this.selection.columnName === column.name;
    const pk = column.pk
      ? `<span class="dv-tree-flag dv-tree-flag-pk" title="${escapeAttr(t('structure.pk.title'))}">${escapeHtml(t('detail.flag.pk'))}</span>`
      : '';
    const nameHtml = highlightHtml(
      column.name,
      this.matchIndices.get(`c:${id}.${column.name}`) ?? null,
    );
    return `
      <li>
        <button
          type="button"
          class="dv-tree-node dv-tree-node-column${active ? ' is-active' : ''}"
          data-node="column"
          data-table-id="${escapeAttr(id)}"
          data-column="${escapeAttr(column.name)}"
        >
          <span class="dv-tree-column-name">${nameHtml}</span>
          ${pk}
          <span class="dv-tree-column-type">${escapeHtml(formatColumnType(column))}</span>
        </button>
      </li>
    `;
  }

  private renderTreeEnum(en: Enum): string {
    const id = enumId(en);
    const active = this.selection.kind === 'enum' && this.selection.enumId === id;
    const nameHtml = highlightHtml(en.name, this.matchIndices.get(`e:${id}`) ?? null);
    return `
      <li class="dv-tree-enum${active ? ' is-active' : ''}">
        <button
          type="button"
          class="dv-tree-node dv-tree-node-enum${active ? ' is-active' : ''}"
          data-node="enum"
          data-enum-id="${escapeAttr(id)}"
        >
          ${iconEnum()}
          <span class="dv-tree-enum-name">${nameHtml}</span>
          <span class="dv-tree-count">${en.values.length}</span>
        </button>
      </li>
    `;
  }

  private renderTreeRelation(self: Table, entry: RefEntry): string {
    const selfId = tableId(self);
    const selfEnd = selfEndpoint(entry.ref, selfId, entry.direction);
    const other = otherEndpointOf(entry.ref, selfEnd);
    const targetId = endpointTableId(other);
    const arrow = relationArrow(selfEnd.relation, other.relation);
    const fieldsLabel = `${selfEnd.fieldNames.join(', ')} ${arrow} ${other.tableName}.${other.fieldNames.join(', ')}`;
    // First field column IDs for cross-panel edge hover matching.
    const fromColId = selfEnd.fieldNames[0] ? `${selfId}.${selfEnd.fieldNames[0]}` : '';
    const toColId = other.fieldNames[0] ? `${targetId}.${other.fieldNames[0]}` : '';
    // Highlight matches in the target table name and the (comma-separated) self
    // field names so relationship rows reflect the active query just like the
    // primary nodes do.
    const q = this.searchQuery;
    const targetIndices = q !== '' ? searchMatch(other.tableName, q) : null;
    const targetHtml = highlightHtml(other.tableName, targetIndices);
    const fieldsStr = `(${selfEnd.fieldNames.join(', ')})`;
    const fieldsIndices = q !== '' ? searchMatch(fieldsStr, q) : null;
    const fieldsHtml = highlightHtml(fieldsStr, fieldsIndices);
    const arrowStyle = entry.ref.color ? ` style="color: ${escapeAttr(entry.ref.color)}"` : '';
    return `
      <li>
        <button
          type="button"
          class="dv-tree-node dv-tree-node-relation"
          data-node="relation"
          data-target-table="${escapeAttr(targetId)}"
          data-from-column-id="${escapeAttr(fromColId)}"
          data-to-column-id="${escapeAttr(toColId)}"
          title="${escapeAttr(fieldsLabel)}"
        >
          <span class="dv-tree-rel-arrow"${arrowStyle}>${arrow}</span>
          <span class="dv-tree-rel-target">${targetHtml}</span>
          <span class="dv-tree-rel-fields">${fieldsHtml}</span>
        </button>
      </li>
    `;
  }

  private toggleGroup(id: string): void {
    if (this.expandedGroups.has(id)) this.expandedGroups.delete(id);
    else this.expandedGroups.add(id);
    this.renderTree();
  }

  // ---- Hide-from-diagram toggle ----

  /** Render the eye-toggle button for a schema or tablegroup row. */
  private renderHideToggle(group: TreeGroup): string {
    if (group.kind === 'tablegroup') {
      // The tree's group.id encodes `tg:<schema>.<name>`; for the hide set we
      // need the bare `<schema>.<name>` so the diagram-side computation matches.
      const key = group.id.startsWith('tg:') ? group.id.slice(3) : group.id;
      const hidden = this.hiddenSet.tableGroups.has(key);
      return makeHideToggle('tablegroup', key, hidden, group.label);
    }
    // Schema group — the id is `sc:<schema>`, the key is just the schema name.
    const schema = group.id.startsWith('sc:') ? group.id.slice(3) : group.label;
    const hidden = this.hiddenSet.schemas.has(schema);
    return makeHideToggle('schema', schema, hidden, group.label);
  }

  private renderTableHideToggle(id: string): string {
    const directlyHidden = this.hiddenSet.tables.has(id);
    // A table can also be hidden via its schema or tablegroup (transitively).
    // Rather than disabling the toggle, we allow clicking it — the handler will
    // smart-unhide the parent group and hide all sibling tables so only this
    // one becomes visible.
    const transitivelyHidden = !directlyHidden && this.effectiveHidden.has(id);
    return makeHideToggle('table', id, directlyHidden || transitivelyHidden, id);
  }

  /**
   * A table that is hidden via its parent group (schema or tablegroup) was
   * toggled to visible. We operate at the database level — not the tree level —
   * because a table's tree-group and its actual hiding source can differ (e.g.
   * a table whose schema is hidden may appear under a tablegroup in the tree).
   *
   * For each hiding bucket that covers this table:
   *   1. Remove the bucket entry (schema name / tablegroup key) so the group
   *      itself becomes visible again.
   *   2. Individually hide every other table that was covered by the same
   *      bucket entry so they stay off the diagram.
   * Finally, ensure the target table is not also in `hiddenSet.tables`.
   *
   * Net result: all masking groups un-hidden, only the clicked table visible.
   */
  private smartUnhideTable(id: string): void {
    if (!this.database) return;

    // Schema bucket: if the table's schema is hidden, un-hide it and
    // individually hide every other table in that schema.
    const table = this.database.tables.find((t) => tableId(t) === id);
    if (table) {
      const schema = table.schemaName ?? DEFAULT_SCHEMA;
      if (this.hiddenSet.schemas.has(schema)) {
        this.hiddenSet.schemas.delete(schema);
        for (const t of this.database.tables) {
          const tId = tableId(t);
          if (tId !== id && (t.schemaName ?? DEFAULT_SCHEMA) === schema) {
            this.hiddenSet.tables.add(tId);
          }
        }
      }
    }

    // TableGroup bucket: if any tablegroup containing this table is hidden,
    // un-hide it and individually hide every other member.
    for (const tg of this.database.tableGroups) {
      const key = tableGroupKey(tg);
      if (!this.hiddenSet.tableGroups.has(key)) continue;
      const memberIds = tg.tables.map((m) => `${m.schemaName || DEFAULT_SCHEMA}.${m.name}`);
      if (!memberIds.includes(id)) continue;
      this.hiddenSet.tableGroups.delete(key);
      for (const tId of memberIds) {
        if (tId !== id) this.hiddenSet.tables.add(tId);
      }
    }

    // Ensure the target table is not directly hidden either.
    this.hiddenSet.tables.delete(id);
  }

  private isGroupHidden(group: TreeGroup): boolean {
    if (group.kind === 'tablegroup') {
      const key = group.id.startsWith('tg:') ? group.id.slice(3) : group.id;
      return this.hiddenSet.tableGroups.has(key);
    }
    const schema = group.id.startsWith('sc:') ? group.id.slice(3) : group.label;
    return this.hiddenSet.schemas.has(schema);
  }

  /** Toggle hidden state from a clicked eye button. */
  private toggleHidden(btn: HTMLElement): void {
    const kind = btn.dataset.hideKind;
    const id = btn.dataset.hideId ?? '';
    if (!kind || !id) return;
    if (kind === 'table') {
      if (this.hiddenSet.tables.has(id)) {
        // Directly hidden → un-hide.
        this.hiddenSet.tables.delete(id);
      } else if (this.database && this.effectiveHidden.has(id)) {
        // Transitively hidden via a parent group → smart-unhide: reveal only
        // this table and hide every sibling individually.
        this.smartUnhideTable(id);
      } else {
        // Visible → hide.
        this.hiddenSet.tables.add(id);
      }
    } else if (kind === 'schema') {
      if (this.hiddenSet.schemas.has(id)) {
        this.hiddenSet.schemas.delete(id);
      } else {
        this.hiddenSet.schemas.add(id);
      }
      // Clear any individual table overrides in this schema so the group toggle
      // always has "all or nothing" semantics — in both directions, every member
      // ends up in a consistent state (all hidden via schema, or all visible).
      if (this.database) {
        for (const t of this.database.tables) {
          if ((t.schemaName ?? DEFAULT_SCHEMA) === id) {
            this.hiddenSet.tables.delete(tableId(t));
          }
        }
      }
    } else if (kind === 'tablegroup') {
      if (this.hiddenSet.tableGroups.has(id)) {
        this.hiddenSet.tableGroups.delete(id);
      } else {
        this.hiddenSet.tableGroups.add(id);
      }
      // Clear individual table overrides within this group (same "all or nothing"
      // contract as schemas above).
      if (this.database) {
        const tg = this.database.tableGroups.find((g) => tableGroupKey(g) === id);
        if (tg) {
          for (const m of tg.tables) {
            this.hiddenSet.tables.delete(`${m.schemaName || DEFAULT_SCHEMA}.${m.name}`);
          }
        }
      }
    }
    if (this.database) {
      this.effectiveHidden = computeHiddenTableIds(this.database, this.hiddenSet);
    }
    this.renderTree();
    this.dispatchEvent(
      new CustomEvent<HiddenSet>('visibility-change', {
        detail: this.getHiddenSet(),
        bubbles: true,
      }),
    );
  }

  /** Single click on a table node: select it (notifies detail) without expanding.
   *  If the table is already selected, toggle its expansion instead. */
  private selectTableNoExpand(id: string): void {
    if (
      this.selection.kind === 'table' &&
      this.selection.tableId === id &&
      this.selection.columnName === undefined
    ) {
      this.toggleTableExpansion(id);
      return;
    }
    this.selection = { kind: 'table', tableId: id };
    this.autoExpandGroupForSelection();
    this.renderTree();
    this.notify();
  }

  /** Double click on a table node: toggle its expansion in the tree. */
  private toggleTableExpansion(id: string): void {
    if (this.expandedTables.has(id)) this.expandedTables.delete(id);
    else this.expandedTables.add(id);
    this.renderTree();
  }

  private activateColumn(tId: string, columnName: string): void {
    this.expandedTables.add(tId);
    this.selection = { kind: 'table', tableId: tId, columnName };
    this.autoExpandForSelection();
    this.renderTree();
    this.notify();
  }

  private selectTable(id: string): void {
    this.expandedTables.add(id);
    this.selection = { kind: 'table', tableId: id };
    this.autoExpandForSelection();
    this.renderTree();
    this.notify();
  }

  private selectEnum(id: string): void {
    if (this.selection.kind === 'enum' && this.selection.enumId === id) return;
    this.selection = { kind: 'enum', enumId: id };
    this.autoExpandGroupForSelection();
    this.renderTree();
    this.notify();
  }

  /**
   * Expands the containing group AND the item itself. Used for external
   * navigation (diagram click, URL hash) so the tree reveals the selection.
   */
  private autoExpandForSelection(): void {
    if (!this.database) return;
    const sel = this.selection;
    if (sel.kind === 'table') {
      this.expandedTables.add(sel.tableId);
      for (const group of buildTree(this.database)) {
        if (group.tables.some((t) => tableId(t) === sel.tableId)) {
          this.expandedGroups.add(group.id);
          break;
        }
      }
    }
    // Enums are rendered flat — no group to expand.
  }

  /**
   * Expands only the containing group (not the item itself). Used for
   * user-initiated tree clicks where expansion is intentionally separate.
   */
  private autoExpandGroupForSelection(): void {
    if (!this.database) return;
    const sel = this.selection;
    if (sel.kind === 'table') {
      for (const group of buildTree(this.database)) {
        if (group.tables.some((t) => tableId(t) === sel.tableId)) {
          this.expandedGroups.add(group.id);
          break;
        }
      }
    }
    // Enums are rendered flat — no group to expand.
  }

  private scrollSelectionIntoView(): void {
    const sel = this.selection;
    let target: HTMLElement | null = null;
    if (sel.kind === 'table') {
      target = this.querySelector<HTMLElement>(
        `[data-node="table"][data-table-id="${cssEscape(sel.tableId)}"]`,
      );
    } else if (sel.kind === 'enum') {
      target = this.querySelector<HTMLElement>(
        `[data-node="enum"][data-enum-id="${cssEscape(sel.enumId)}"]`,
      );
    }
    target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ---- Cross-panel hover (public API) ----

  /**
   * Apply a hover highlight driven by another panel. Directly toggles CSS
   * classes on the existing DOM — no re-render. Does NOT emit `hover-change`.
   */
  setExternalHover(state: HoverState): void {
    this.externalHover = state;
    this.applyExternalHoverToDom();
  }

  private hoverStateFromNode(node: HTMLElement): HoverState {
    const kind = node.dataset.node;
    switch (kind) {
      case 'table':
        return { kind: 'table', tableId: node.dataset.tableId ?? '' };
      case 'column': {
        const tId = node.dataset.tableId ?? '';
        const colName = node.dataset.column ?? '';
        return { kind: 'column', tableId: tId, columnId: `${tId}.${colName}` };
      }
      case 'relation': {
        const fromColumnId = node.dataset.fromColumnId ?? '';
        const toColumnId = node.dataset.toColumnId ?? '';
        if (fromColumnId && toColumnId) {
          return { kind: 'edge', colA: fromColumnId, colB: toColumnId };
        }
        // Fall back to table hover for the target if column IDs aren't set.
        const target = node.dataset.targetTable ?? '';
        return target ? { kind: 'table', tableId: target } : { kind: 'none' };
      }
      default:
        return { kind: 'none' };
    }
  }

  private applyExternalHoverToDom(): void {
    // Clear all previously applied external hover classes.
    for (const el of this.querySelectorAll<HTMLElement>('.is-hovered')) {
      el.classList.remove('is-hovered');
    }
    const state = this.externalHover;
    if (state.kind === 'none') return;

    if (state.kind === 'table') {
      this.querySelector(
        `[data-node="table"][data-table-id="${cssEscape(state.tableId)}"]`,
      )?.classList.add('is-hovered');
    } else if (state.kind === 'column') {
      // Highlight the column node.
      const colName = state.columnId.slice(state.tableId.length + 1);
      this.querySelector(
        `[data-node="column"][data-table-id="${cssEscape(state.tableId)}"][data-column="${cssEscape(colName)}"]`,
      )?.classList.add('is-hovered');
      // Also subtly highlight the parent table row.
      this.querySelector(
        `[data-node="table"][data-table-id="${cssEscape(state.tableId)}"]`,
      )?.classList.add('is-hovered');
    } else if (state.kind === 'edge') {
      // Highlight every relation node whose column pair matches, in either table.
      for (const node of this.querySelectorAll<HTMLElement>('[data-node="relation"]')) {
        const f = node.dataset.fromColumnId ?? '';
        const t = node.dataset.toColumnId ?? '';
        if ((f === state.colA && t === state.colB) || (f === state.colB && t === state.colA)) {
          node.classList.add('is-hovered');
        }
      }
      // Also highlight the table nodes for both endpoints so there is visible
      // feedback even when the tables are collapsed (no relation nodes rendered).
      for (const colId of [state.colA, state.colB]) {
        const lastDot = colId.lastIndexOf('.');
        if (lastDot === -1) continue;
        const tId = colId.slice(0, lastDot);
        this.querySelector(`[data-node="table"][data-table-id="${cssEscape(tId)}"]`)?.classList.add(
          'is-hovered',
        );
      }
    }
  }

  // ---- Internal event dispatch ----

  private notify(): void {
    this.dispatchEvent(
      new CustomEvent<Selection>('selection-change', {
        detail: this.selection,
        bubbles: true,
      }),
    );
  }
}

// ---- Tree node icons (inline SVG, 12×12, stroke-based) ----

/** Optional `color` paints the icon stroke via inline `color:` — icons use
 *  `currentColor`, so the rest of the row text is unaffected. */
function iconTable(color: string | null = null): string {
  const style = color ? ` style="color: ${escapeAttr(color)}"` : '';
  return `<svg class="dv-tree-node-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${style}><rect x="1" y="1.5" width="10" height="9" rx="1"/><line x1="1" y1="4.5" x2="11" y2="4.5"/><line x1="4.5" y1="4.5" x2="4.5" y2="10.5"/></svg>`;
}

function iconSchema(): string {
  return `<svg class="dv-tree-node-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true"><ellipse cx="6" cy="3" rx="4" ry="1.5"/><path d="M2 3L2 9C2 9.83 3.79 10.5 6 10.5C8.21 10.5 10 9.83 10 9L10 3"/><path d="M2 6C2 6.83 3.79 7.5 6 7.5C8.21 7.5 10 6.83 10 6"/></svg>`;
}

function iconTableGroup(color: string | null = null): string {
  const style = color ? ` style="color: ${escapeAttr(color)}"` : '';
  return `<svg class="dv-tree-node-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${style}><path d="M1 3.5C1 2.95 1.45 2.5 2 2.5H4.5L5.5 3.5H10C10.55 3.5 11 3.95 11 4.5V9C11 9.55 10.55 10 10 10H2C1.45 10 1 9.55 1 9V3.5Z"/></svg>`;
}

/**
 * Eye / eye-slash toggle for hiding an item from the diagram. The button is
 * hidden by CSS until the row is hovered or the item is already hidden (then
 * it stays visible so the user can find their way back).
 *
 * `transitive` = true means this table is hidden indirectly through a parent
 * schema or tablegroup; the icon shows the hidden state but clicks do nothing
 * because the parent must be un-hidden first.
 */
function makeHideToggle(
  kind: 'table' | 'schema' | 'tablegroup',
  id: string,
  hidden: boolean,
  label: string,
  transitive = false,
): string {
  const icon = hidden ? iconEyeSlash() : iconEye();
  const action = hidden ? t('structure.hide.show') : t('structure.hide.hide');
  const title = `${action}: ${label}`;
  const classes = [
    'dv-tree-hide-toggle',
    hidden ? 'is-hidden-target' : '',
    transitive ? 'is-disabled' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `
    <button
      type="button"
      class="${classes}"
      data-hide-toggle
      data-hide-kind="${kind}"
      data-hide-id="${escapeAttr(id)}"
      ${transitive ? 'data-disabled="true"' : ''}
      title="${escapeAttr(title)}"
      aria-label="${escapeAttr(title)}"
      aria-pressed="${hidden}"
    >${icon}</button>
  `;
}

function iconEye(): string {
  return `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 7C2.6 4.3 4.7 3 7 3C9.3 3 11.4 4.3 13 7C11.4 9.7 9.3 11 7 11C4.7 11 2.6 9.7 1 7Z"/><circle cx="7" cy="7" r="1.7"/></svg>`;
}

function iconEyeSlash(): string {
  return `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5C1.85 5.2 1.35 6.05 1 7C2.6 9.7 4.7 11 7 11C7.95 11 8.85 10.78 9.65 10.35"/><path d="M5.4 3.3C5.9 3.1 6.45 3 7 3C9.3 3 11.4 4.3 13 7C12.45 7.93 11.85 8.7 11.2 9.3"/><path d="M5.4 5.4C5.07 5.81 4.87 6.34 4.87 6.92C4.87 8.18 5.86 9.2 7.08 9.2C7.65 9.2 8.17 8.99 8.58 8.65"/><line x1="2" y1="2" x2="12" y2="12"/></svg>`;
}

function iconEnum(): string {
  return `<svg class="dv-tree-node-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true"><path d="M4 1.5C3.5 1.5 3 2 3 2.5V5C3 5.5 2.5 6 2 6C2.5 6 3 6.5 3 7V9.5C3 10 3.5 10.5 4 10.5"/><path d="M8 1.5C8.5 1.5 9 2 9 2.5V5C9 5.5 9.5 6 10 6C9.5 6 9 6.5 9 7V9.5C9 10 8.5 10.5 8 10.5"/><circle cx="6" cy="6" r="0.75" fill="currentColor" stroke="none"/></svg>`;
}

function iconSearch(): string {
  return `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="4"/><line x1="9" y1="9" x2="12.5" y2="12.5"/></svg>`;
}

function iconClear(): string {
  return `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3.5" y1="3.5" x2="10.5" y2="10.5"/><line x1="10.5" y1="3.5" x2="3.5" y2="10.5"/></svg>`;
}

function makeTemplate(): string {
  const clearLabel = t('structure.search.clear');
  return `
    <div class="dv-search" role="search">
      <input type="search" placeholder="${escapeAttr(t('structure.search.placeholder'))}" data-search />
      <span class="dv-search-icon" aria-hidden="true">${iconSearch()}</span>
      <button
        type="button"
        class="dv-search-clear"
        data-search-clear
        title="${escapeAttr(clearLabel)}"
        aria-label="${escapeAttr(clearLabel)}"
        hidden
      >${iconClear()}</button>
    </div>
    <nav class="dv-tree-wrap" data-tree></nav>
  `;
}

function selectionEquals(a: Selection, b: Selection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'table' && b.kind === 'table') {
    return a.tableId === b.tableId && (a.columnName ?? null) === (b.columnName ?? null);
  }
  if (a.kind === 'enum' && b.kind === 'enum') {
    return a.enumId === b.enumId;
  }
  return true;
}

function cssEscape(value: string): string {
  return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/"/g, '\\"');
}

// Re-export for consumers that want to type their wiring.
export type { HoverState, Selection, TreeGroup } from './shared';

export function registerStructureElement(): void {
  if (!customElements.get(DbmlStructureElement.tagName)) {
    customElements.define(DbmlStructureElement.tagName, DbmlStructureElement);
  }
}
