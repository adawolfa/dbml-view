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
  type HoverState,
  type RefEntry,
  type Selection,
  type TreeGroup,
  buildTree,
  escapeAttr,
  escapeHtml,
  formatColumnType,
  hoverStateEquals,
  indexRefsByTable,
  otherEndpointOf,
  relationArrow,
  selfEndpoint,
} from './shared';

/** Stable ID for the synthetic "Enums" group rendered at the bottom of the tree. */
const ENUMS_GROUP_ID = '__enums__';

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
  private rendered = false;
  /** Hover state applied from another panel. Cleared when this panel emits its own hover. */
  private externalHover: HoverState = { kind: 'none' };
  /** Tracks which hover state is currently being emitted so we can deduplicate. */
  private internalHover: HoverState = { kind: 'none' };

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
    // Expand all groups by default; tables and enums stay collapsed until selected.
    // Also pre-expand the synthetic Enums group so enums are visible on first load.
    this.expandedGroups = new Set([...buildTree(db).map((g) => g.id), ENUMS_GROUP_ID]);
    if (!this.rendered) return;
    this.renderTree();
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
      this.searchQuery = search.value.trim().toLowerCase();
      this.renderTree();
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
      return;
    }
    const groups = buildTree(this.database);
    const q = this.searchQuery;
    const matchingTables = new Set<string>();
    const matchingColumns = new Map<string, Set<string>>();
    const matchingEnums = new Set<string>();
    if (q !== '') {
      for (const group of groups) {
        for (const table of group.tables) {
          const tId = tableId(table);
          const tableMatches =
            table.name.toLowerCase().includes(q) ||
            (table.schemaName ?? DEFAULT_SCHEMA).toLowerCase().includes(q);
          const colMatches = table.fields.filter((c) => c.name.toLowerCase().includes(q));
          if (tableMatches || colMatches.length > 0) {
            matchingTables.add(tId);
            if (!tableMatches) {
              matchingColumns.set(tId, new Set(colMatches.map((c) => c.name)));
            }
          }
        }
        for (const en of group.enums) {
          const eId = enumId(en);
          const enumMatches =
            en.name.toLowerCase().includes(q) ||
            (en.schemaName ?? DEFAULT_SCHEMA).toLowerCase().includes(q);
          const valueMatches = en.values.filter((v) => v.name.toLowerCase().includes(q));
          if (enumMatches || valueMatches.length > 0) {
            matchingEnums.add(eId);
          }
        }
      }
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
        return `
          <li class="dv-tree-group">
            <button
              type="button"
              class="dv-tree-node dv-tree-node-group"
              data-node="group"
              data-group-id="${escapeAttr(group.id)}"
              aria-expanded="${groupOpen}"
            >
              <span class="dv-tree-chevron">${chevron}</span>
              ${group.kind === 'tablegroup' ? iconTableGroup() : iconSchema()}
              <span class="dv-tree-group-name">${escapeHtml(group.label)}</span>
              <span class="dv-tree-count">${visibleTables.length}</span>
            </button>
            ${childrenHtml}
          </li>
        `;
      })
      .join('');

    // Render all enums after all schema/tablegroup sections.
    let enumsSectionHtml = '';
    if (allVisibleEnums.length > 0) {
      const enumsHtml = allVisibleEnums.map((e) => this.renderTreeEnum(e)).join('');
      if (showSchemaHeaders) {
        // Multi-schema: wrap in a collapsible synthetic "Enums" group so the
        // section is visually consistent with the schema groups above it.
        const groupOpen = q !== '' || this.expandedGroups.has(ENUMS_GROUP_ID);
        const chevron = groupOpen ? '▾' : '▸';
        const childrenHtml = groupOpen ? `<ul class="dv-tree-children">${enumsHtml}</ul>` : '';
        enumsSectionHtml = `
          <li class="dv-tree-group">
            <button
              type="button"
              class="dv-tree-node dv-tree-node-group"
              data-node="group"
              data-group-id="${escapeAttr(ENUMS_GROUP_ID)}"
              aria-expanded="${groupOpen}"
            >
              <span class="dv-tree-chevron">${chevron}</span>
              ${iconEnum()}
              <span class="dv-tree-group-name">${escapeHtml(t('structure.group.kind.enums'))}</span>
              <span class="dv-tree-count">${allVisibleEnums.length}</span>
            </button>
            ${childrenHtml}
          </li>
        `;
      } else {
        // Single-schema: enums are flat, matching the rest of the unwrapped layout.
        enumsSectionHtml = enumsHtml;
      }
    }

    container.innerHTML = `<ul class="dv-tree">${html}${enumsSectionHtml}</ul>`;
    this.applyExternalHoverToDom();
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

    return `
      <li class="dv-tree-table${active ? ' is-active' : ''}">
        <button
          type="button"
          class="dv-tree-node dv-tree-node-table${active ? ' is-active' : ''}"
          data-node="table"
          data-table-id="${escapeAttr(id)}"
          aria-expanded="${expanded}"
        >
          <span class="dv-tree-chevron">${chevron}</span>
          ${iconTable()}
          <span class="dv-tree-table-name">${escapeHtml(table.name)}</span>
          <span class="dv-tree-count">${table.fields.length}</span>
        </button>
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
    return `
      <li>
        <button
          type="button"
          class="dv-tree-node dv-tree-node-column${active ? ' is-active' : ''}"
          data-node="column"
          data-table-id="${escapeAttr(id)}"
          data-column="${escapeAttr(column.name)}"
        >
          <span class="dv-tree-column-name">${escapeHtml(column.name)}</span>
          ${pk}
          <span class="dv-tree-column-type">${escapeHtml(formatColumnType(column))}</span>
        </button>
      </li>
    `;
  }

  private renderTreeEnum(en: Enum): string {
    const id = enumId(en);
    const active = this.selection.kind === 'enum' && this.selection.enumId === id;
    return `
      <li class="dv-tree-enum${active ? ' is-active' : ''}">
        <button
          type="button"
          class="dv-tree-node dv-tree-node-enum${active ? ' is-active' : ''}"
          data-node="enum"
          data-enum-id="${escapeAttr(id)}"
        >
          ${iconEnum()}
          <span class="dv-tree-enum-name">${escapeHtml(en.name)}</span>
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
          <span class="dv-tree-rel-arrow">${arrow}</span>
          <span class="dv-tree-rel-target">${escapeHtml(other.tableName)}</span>
          <span class="dv-tree-rel-fields">${escapeHtml(`(${selfEnd.fieldNames.join(', ')})`)}</span>
        </button>
      </li>
    `;
  }

  private toggleGroup(id: string): void {
    if (this.expandedGroups.has(id)) this.expandedGroups.delete(id);
    else this.expandedGroups.add(id);
    this.renderTree();
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
    } else if (sel.kind === 'enum') {
      // All enums are rendered in the synthetic ENUMS_GROUP_ID section.
      this.expandedGroups.add(ENUMS_GROUP_ID);
    }
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
    } else if (sel.kind === 'enum') {
      // All enums are rendered in the synthetic ENUMS_GROUP_ID section.
      this.expandedGroups.add(ENUMS_GROUP_ID);
    }
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

function iconTable(): string {
  return `<svg class="dv-tree-node-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1" y="1.5" width="10" height="9" rx="1"/><line x1="1" y1="4.5" x2="11" y2="4.5"/><line x1="4.5" y1="4.5" x2="4.5" y2="10.5"/></svg>`;
}

function iconSchema(): string {
  return `<svg class="dv-tree-node-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true"><ellipse cx="6" cy="3" rx="4" ry="1.5"/><path d="M2 3L2 9C2 9.83 3.79 10.5 6 10.5C8.21 10.5 10 9.83 10 9L10 3"/><path d="M2 6C2 6.83 3.79 7.5 6 7.5C8.21 7.5 10 6.83 10 6"/></svg>`;
}

function iconTableGroup(): string {
  return `<svg class="dv-tree-node-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 3.5C1 2.95 1.45 2.5 2 2.5H4.5L5.5 3.5H10C10.55 3.5 11 3.95 11 4.5V9C11 9.55 10.55 10 10 10H2C1.45 10 1 9.55 1 9V3.5Z"/></svg>`;
}

function iconEnum(): string {
  return `<svg class="dv-tree-node-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true"><path d="M4 1.5C3.5 1.5 3 2 3 2.5V5C3 5.5 2.5 6 2 6C2.5 6 3 6.5 3 7V9.5C3 10 3.5 10.5 4 10.5"/><path d="M8 1.5C8.5 1.5 9 2 9 2.5V5C9 5.5 9.5 6 10 6C9.5 6 9 6.5 9 7V9.5C9 10 8.5 10.5 8 10.5"/><circle cx="6" cy="6" r="0.75" fill="currentColor" stroke="none"/></svg>`;
}

function makeTemplate(): string {
  return `
    <label class="dv-search">
      <input type="search" placeholder="${escapeAttr(t('structure.search.placeholder'))}" data-search />
    </label>
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
