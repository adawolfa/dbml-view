// <dbml-structure source="…"> — left-rail tree (group → table → columns/relations),
// right-pane detail. Vanilla DOM (no shadow root, so consumer CSS can theme it
// via the :where(dbml-structure) variable block in style.css).

import {
  type Column,
  DEFAULT_SCHEMA,
  type Database,
  type Ref,
  type Table,
  allRefs,
  columnId,
  endpointTableId,
  hasMultipleSchemas,
  parseDbml,
  tableId,
} from '@dbml-view/parser';

type RefDirection = 'outgoing' | 'incoming';
type RefEntry = { ref: Ref; direction: RefDirection };
type TreeGroup = { id: string; label: string; kind: 'tablegroup' | 'schema'; tables: Table[] };

export class DbmlStructureElement extends HTMLElement {
  static readonly tagName = 'dbml-structure';

  static get observedAttributes(): string[] {
    return ['source'];
  }

  private database: Database | null = null;
  private selectedTableId: string | null = null;
  private selectedColumnName: string | null = null;
  private searchQuery = '';
  private refsByTableId = new Map<string, RefEntry[]>();
  private expandedGroups = new Set<string>();
  private expandedTables = new Set<string>();
  private rendered = false;
  private hashListener = (): void => this.syncFromHash();

  connectedCallback(): void {
    if (!this.rendered) {
      this.classList.add('dv-structure');
      this.innerHTML = TEMPLATE;
      this.wireEvents();
      this.rendered = true;
    }
    window.addEventListener('hashchange', this.hashListener);
    const source = this.getAttribute('source');
    if (source !== null && this.database === null) {
      this.source = source;
    } else {
      this.renderAll();
    }
  }

  disconnectedCallback(): void {
    window.removeEventListener('hashchange', this.hashListener);
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === 'source' && value !== null) {
      this.source = value;
    }
  }

  /** Parse the DBML string and re-render. Invalid input renders the error list. */
  set source(value: string) {
    const result = parseDbml(value);
    if (!result.ok) {
      this.database = null;
      this.refsByTableId.clear();
      this.renderError(result.errors);
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
    if (!this.rendered) return;
    this.renderAll();
    this.syncFromHash();
  }

  private wireEvents(): void {
    const search = this.querySelector<HTMLInputElement>('[data-search]');
    search?.addEventListener('input', () => {
      this.searchQuery = search.value.trim().toLowerCase();
      this.renderTree();
    });

    const tree = this.querySelector<HTMLElement>('[data-tree]');
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
        this.activateTable(id);
      } else if (kind === 'column') {
        const id = node.dataset.tableId ?? '';
        const col = node.dataset.column ?? '';
        this.activateColumn(id, col);
      } else if (kind === 'relation') {
        const target = node.dataset.targetTable ?? '';
        this.selectTable(target);
      }
    });

    const detail = this.querySelector<HTMLElement>('[data-detail]');
    detail?.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-jump-table]');
      if (link) {
        event.preventDefault();
        this.selectTable(link.dataset.jumpTable ?? null);
      }
    });
  }

  private renderAll(): void {
    this.renderTree();
    this.renderDetail();
  }

  private renderError(errors: { line: number; column: number; message: string }[]): void {
    const detail = this.querySelector('[data-detail]');
    const tree = this.querySelector('[data-tree]');
    if (tree) tree.innerHTML = '';
    if (!detail) return;
    detail.innerHTML = `
      <div class="dv-error">
        <h2>Couldn't parse this DBML</h2>
        <ul>
          ${errors
            .map(
              (e) =>
                `<li><span class="dv-error-pos">${e.line}:${e.column}</span> ${escapeHtml(e.message)}</li>`,
            )
            .join('')}
        </ul>
      </div>
    `;
  }

  private renderTree(): void {
    const container = this.querySelector('[data-tree]');
    if (!container) return;
    if (!this.database) {
      container.innerHTML = '<p class="dv-empty">No DBML loaded.</p>';
      return;
    }
    const groups = buildTree(this.database);
    const q = this.searchQuery;
    const matchingTables = new Set<string>();
    const matchingColumns = new Map<string, Set<string>>();
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
      }
      if (matchingTables.size === 0) {
        container.innerHTML = '<p class="dv-empty">No matches.</p>';
        return;
      }
    }

    const showSchemaHeaders = hasMultipleSchemas(this.database);
    const html = groups
      .map((group) => {
        const visibleTables =
          q === ''
            ? group.tables
            : group.tables.filter((t) => matchingTables.has(tableId(t)));
        if (visibleTables.length === 0) return '';
        // Single-schema DB: drop the redundant schema-group wrapper and show
        // tables directly. TableGroups still get their wrapper either way.
        if (group.kind === 'schema' && !showSchemaHeaders) {
          return visibleTables
            .map((t) => this.renderTreeTable(t, q, matchingColumns, matchingTables))
            .join('');
        }
        const groupOpen = q !== '' || this.expandedGroups.has(group.id);
        const chevron = groupOpen ? '▾' : '▸';
        const tablesHtml = groupOpen
          ? `<ul class="dv-tree-children">${visibleTables
              .map((t) => this.renderTreeTable(t, q, matchingColumns, matchingTables))
              .join('')}</ul>`
          : '';
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
              <span class="dv-tree-group-kind">${group.kind === 'tablegroup' ? 'Group' : 'Schema'}</span>
              <span class="dv-tree-group-name">${escapeHtml(group.label)}</span>
              <span class="dv-tree-count">${visibleTables.length}</span>
            </button>
            ${tablesHtml}
          </li>
        `;
      })
      .join('');
    container.innerHTML = `<ul class="dv-tree">${html}</ul>`;
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
    const active = id === this.selectedTableId;
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
            <span class="dv-tree-section-label">Columns</span>
            <span class="dv-tree-count">${colsToShow.length}</span>
          </li>
          ${colsToShow.map((c) => this.renderTreeColumn(table, c)).join('')}
          ${
            refsToShow.length === 0
              ? ''
              : `
                <li class="dv-tree-section">
                  <span class="dv-tree-section-label">Relations</span>
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
          <span class="dv-tree-table-name">${escapeHtml(table.name)}</span>
          <span class="dv-tree-count">${table.fields.length}</span>
        </button>
        ${childrenHtml}
      </li>
    `;
  }

  private renderTreeColumn(table: Table, column: Column): string {
    const id = tableId(table);
    const active = id === this.selectedTableId && this.selectedColumnName === column.name;
    const pk = column.pk ? '<span class="dv-tree-flag dv-tree-flag-pk" title="Primary key">PK</span>' : '';
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

  private renderTreeRelation(self: Table, entry: RefEntry): string {
    const selfId = tableId(self);
    const selfEnd = selfEndpoint(entry.ref, selfId, entry.direction);
    const other = otherEndpointOf(entry.ref, selfEnd);
    const targetId = endpointTableId(other);
    const arrow = relationArrow(selfEnd.relation, other.relation);
    const fieldsLabel = `${selfEnd.fieldNames.join(', ')} ${arrow} ${other.tableName}.${other.fieldNames.join(', ')}`;
    return `
      <li>
        <button
          type="button"
          class="dv-tree-node dv-tree-node-relation"
          data-node="relation"
          data-target-table="${escapeAttr(targetId)}"
          title="${escapeAttr(fieldsLabel)}"
        >
          <span class="dv-tree-rel-arrow">${arrow}</span>
          <span class="dv-tree-rel-target">${escapeHtml(other.tableName)}</span>
          <span class="dv-tree-rel-fields">${escapeHtml(`(${selfEnd.fieldNames.join(', ')})`)}</span>
        </button>
      </li>
    `;
  }

  private renderDetail(): void {
    const container = this.querySelector('[data-detail]');
    if (!container) return;
    if (!this.database) {
      container.innerHTML = '<div class="dv-empty">No DBML loaded.</div>';
      return;
    }
    const table = this.database.tables.find((t) => tableId(t) === this.selectedTableId);
    if (!table) {
      container.innerHTML = `
        <div class="dv-empty">
          <p>Pick a table from the list.</p>
          <p>${this.database.tables.length} table${this.database.tables.length === 1 ? '' : 's'} in this schema.</p>
        </div>
      `;
      return;
    }
    container.innerHTML = renderTableDetail(
      table,
      this.refsByTableId.get(tableId(table)) ?? [],
      this.selectedColumnName,
      hasMultipleSchemas(this.database),
    );
  }

  private toggleGroup(id: string): void {
    if (this.expandedGroups.has(id)) this.expandedGroups.delete(id);
    else this.expandedGroups.add(id);
    this.renderTree();
  }

  private activateTable(id: string): void {
    // Clicking a table selects it (and expands it if not yet expanded). If
    // already selected, the click toggles its expansion — convenient for
    // collapsing a noisy fat_table without losing the selection.
    if (id === this.selectedTableId) {
      if (this.expandedTables.has(id)) this.expandedTables.delete(id);
      else this.expandedTables.add(id);
      this.renderTree();
      return;
    }
    this.expandedTables.add(id);
    this.selectTable(id);
  }

  private activateColumn(tId: string, columnName: string): void {
    this.selectedColumnName = columnName;
    if (tId !== this.selectedTableId) {
      this.expandedTables.add(tId);
      this.selectTable(tId);
    } else {
      this.renderTree();
      this.renderDetail();
    }
    this.scrollColumnIntoView(tId, columnName);
  }

  private scrollColumnIntoView(tId: string, columnName: string): void {
    const id = `${tId}.${columnName}`;
    const escaped = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
    const row = this.querySelector(`#${escaped}`);
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  private selectTable(id: string | null): void {
    if (id === this.selectedTableId) {
      // Same table — only re-render if the column changed.
      this.renderTree();
      this.renderDetail();
      return;
    }
    this.selectedTableId = id;
    if (id === null) this.selectedColumnName = null;
    if (id) {
      // Auto-expand the table and its owning group so the selection is visible
      // (e.g. when jumping in via a relation click or a hash deep-link).
      this.expandedTables.add(id);
      if (this.database) {
        for (const group of buildTree(this.database)) {
          if (group.tables.some((t) => tableId(t) === id)) {
            this.expandedGroups.add(group.id);
            break;
          }
        }
      }
      const targetHash = `#table:${encodeURIComponent(id)}`;
      if (window.location.hash !== targetHash) {
        history.replaceState(null, '', targetHash);
      }
    }
    this.renderTree();
    this.renderDetail();
    this.dispatchEvent(
      new CustomEvent('table-selected', { detail: { tableId: id }, bubbles: true }),
    );
  }

  private syncFromHash(): void {
    const hash = window.location.hash;
    const match = /^#table:(.+)$/.exec(hash);
    if (!match) return;
    const id = decodeURIComponent(match[1] ?? '');
    if (!this.database) return;
    if (this.database.tables.some((t) => tableId(t) === id)) {
      this.selectTable(id);
    }
  }
}

const TEMPLATE = `
  <aside class="dv-rail">
    <label class="dv-search">
      <input type="search" placeholder="Search tables / columns…" data-search />
    </label>
    <nav data-tree></nav>
  </aside>
  <section class="dv-pane" data-detail></section>
`;

/**
 * Group tables for the tree. Tables in a `TableGroup` go under that group;
 * everything else falls back to a synthetic per-schema group. A table never
 * appears twice (TableGroup wins over schema). Stable ordering: real groups
 * first (alphabetical), then schema groups (alphabetical).
 */
function buildTree(db: Database): TreeGroup[] {
  const claimed = new Set<string>();
  const groups: TreeGroup[] = [];

  for (const tg of db.tableGroups) {
    const tables: Table[] = [];
    for (const ref of tg.tables) {
      const id = `${ref.schemaName ?? DEFAULT_SCHEMA}.${ref.name}`;
      const table = db.tables.find((t) => tableId(t) === id);
      if (table && !claimed.has(id)) {
        tables.push(table);
        claimed.add(id);
      }
    }
    if (tables.length === 0) continue;
    const label = tg.name ?? '(unnamed group)';
    groups.push({
      id: `tg:${tg.schemaName ?? DEFAULT_SCHEMA}.${label}`,
      label,
      kind: 'tablegroup',
      tables: tables.slice().sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  groups.sort((a, b) => a.label.localeCompare(b.label));

  const bySchema = new Map<string, Table[]>();
  for (const t of db.tables) {
    if (claimed.has(tableId(t))) continue;
    const schema = t.schemaName ?? DEFAULT_SCHEMA;
    push(bySchema, schema, t);
  }
  const schemaGroups: TreeGroup[] = [...bySchema.entries()]
    .map(([schema, tables]) => ({
      id: `sc:${schema}`,
      label: schema,
      kind: 'schema' as const,
      tables: tables.slice().sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return [...groups, ...schemaGroups];
}

/** Pick the endpoint that isn't `selfEnd`. Works for self-refs since we
 * compare by identity, not table id. */
function otherEndpointOf(ref: Ref, selfEnd: Ref['endpoints'][number]): Ref['endpoints'][number] {
  const [a, b] = ref.endpoints;
  return a === selfEnd ? b : a;
}

function selfEndpoint(
  ref: Ref,
  selfId: string,
  direction: RefDirection,
): Ref['endpoints'][number] {
  const [a, b] = ref.endpoints;
  const aIsSelf = endpointTableId(a) === selfId;
  const bIsSelf = endpointTableId(b) === selfId;
  if (aIsSelf && bIsSelf) {
    const want = direction === 'outgoing' ? '*' : '1';
    return a.relation === want ? a : b;
  }
  return aIsSelf ? a : b;
}

function renderTableDetail(
  table: Table,
  refs: RefEntry[],
  highlightedColumn: string | null,
  showSchema: boolean,
): string {
  const id = tableId(table);
  const schema = table.schemaName ?? DEFAULT_SCHEMA;
  const note = table.note?.value ?? '';
  const pkColumns = new Set(table.fields.filter((c) => c.pk).map((c) => c.name));
  const outgoing = refs.filter((r) => r.direction === 'outgoing');
  const incoming = refs.filter((r) => r.direction === 'incoming');
  const selfId = id;
  const fkColumns = new Set<string>();
  for (const { ref } of outgoing) {
    // The FK-holder side is the endpoint with cardinality `*`. For self-refs
    // both endpoints match the table id, so prefer the `*` side over `find()`'s
    // first match (which is target-first for promoted inline refs).
    const [a, b] = ref.endpoints;
    const candidate =
      (endpointTableId(a) === selfId && a.relation === '*' ? a : null) ??
      (endpointTableId(b) === selfId && b.relation === '*' ? b : null) ??
      (endpointTableId(a) === selfId ? a : b);
    for (const name of candidate.fieldNames) fkColumns.add(name);
  }

  return `
    <header class="dv-detail-header">
      ${showSchema ? `<div class="dv-detail-schema">${escapeHtml(schema)}</div>` : ''}
      <h2 class="dv-detail-name">${escapeHtml(table.name)}</h2>
      <code class="dv-detail-id">${escapeHtml(showSchema ? id : table.name)}</code>
      ${note ? `<p class="dv-note">${escapeHtml(note)}</p>` : ''}
    </header>

    <h3 class="dv-section-title">Columns</h3>
    <table class="dv-columns">
      <thead>
        <tr><th>Name</th><th>Type</th><th>Flags</th><th>Default</th><th>Note</th></tr>
      </thead>
      <tbody>
        ${table.fields
          .map((c) => renderColumnRow(table, c, pkColumns, fkColumns, c.name === highlightedColumn))
          .join('')}
      </tbody>
    </table>

    ${
      table.indexes.length > 0
        ? `
      <h3 class="dv-section-title">Indexes</h3>
      <ul class="dv-indexes">
        ${table.indexes.map(renderIndexItem).join('')}
      </ul>
    `
        : ''
    }

    ${renderRefSection('References out', outgoing, table)}
    ${renderRefSection('References in', incoming, table)}
  `;
}

function renderColumnRow(
  table: Table,
  column: Column,
  pks: Set<string>,
  fks: Set<string>,
  highlighted: boolean,
): string {
  const isPk = pks.has(column.name);
  const isFk = fks.has(column.name);
  const flags: string[] = [];
  if (isPk) flags.push('PK');
  if (isFk) flags.push('FK');
  if (column.unique) flags.push('UNIQUE');
  if (column.increment) flags.push('AUTO');
  if (column.not_null) flags.push('NOT NULL');
  const def = column.dbdefault
    ? column.dbdefault.type === 'expression'
      ? `\`${String(column.dbdefault.value)}\``
      : String(column.dbdefault.value)
    : '';
  const id = columnId(table, column);
  return `
    <tr id="${escapeAttr(id)}"${highlighted ? ' class="is-highlighted"' : ''}>
      <td class="dv-col-name">${escapeHtml(column.name)}</td>
      <td class="dv-col-type">${escapeHtml(formatColumnType(column))}</td>
      <td class="dv-col-flags">${flags.map((f) => `<span class="dv-badge dv-badge-${f.toLowerCase().replace(/[^a-z]/g, '-')}">${f}</span>`).join('')}</td>
      <td class="dv-col-default">${escapeHtml(def)}</td>
      <td class="dv-col-note">${escapeHtml(column.note?.value ?? '')}</td>
    </tr>
  `;
}

function formatColumnType(column: Column): string {
  const { schemaName, type_name, args } = column.type;
  const qualified = schemaName ? `${schemaName}.${type_name}` : type_name;
  return args ? `${qualified}(${args})` : qualified;
}

function renderIndexItem(index: Table['indexes'][number]): string {
  const cols = index.columns.map((c) => c.value).join(', ');
  const tags: string[] = [];
  if (index.pk) tags.push('PK');
  if (index.unique) tags.push('UNIQUE');
  if (index.type) tags.push(index.type.toUpperCase());
  return `
    <li>
      <code>(${escapeHtml(cols)})</code>
      ${tags.map((t) => `<span class="dv-badge">${escapeHtml(t)}</span>`).join('')}
      ${index.name ? ` <span class="dv-muted">${escapeHtml(index.name)}</span>` : ''}
      ${index.note ? ` — ${escapeHtml(index.note.value)}` : ''}
    </li>
  `;
}

function renderRefSection(title: string, refs: RefEntry[], self: Table): string {
  if (refs.length === 0) return '';
  return `
    <h3 class="dv-section-title">${escapeHtml(title)}</h3>
    <ul class="dv-refs">
      ${refs.map((r) => renderRefItem(r, self)).join('')}
    </ul>
  `;
}

function renderRefItem(entry: RefEntry, self: Table): string {
  // Render always as "self <arrow> other", regardless of how the parser
  // ordered the endpoints. For self-refs, split by cardinality so the
  // outgoing entry shows the FK column and the incoming entry shows the PK.
  const selfId = tableId(self);
  const selfEnd = selfEndpoint(entry.ref, selfId, entry.direction);
  const otherEnd = otherEndpointOf(entry.ref, selfEnd);
  const otherId = endpointTableId(otherEnd);
  const selfLabel = `${self.name}.(${selfEnd.fieldNames.join(', ')})`;
  const otherLabel = `${otherId === selfId ? otherEnd.tableName : otherId}.(${otherEnd.fieldNames.join(', ')})`;
  const arrow = relationArrow(selfEnd.relation, otherEnd.relation);
  return `
    <li>
      <code>${escapeHtml(selfLabel)}</code>
      <span class="dv-ref-arrow">${arrow}</span>
      <a href="#table:${encodeURIComponent(otherId)}" data-jump-table="${escapeAttr(otherId)}"><code>${escapeHtml(otherLabel)}</code></a>
    </li>
  `;
}

function relationArrow(self: '1' | '*', other: '1' | '*'): string {
  if (self === '*' && other === '1') return '&rarr;';
  if (self === '1' && other === '*') return '&larr;';
  if (self === '1' && other === '1') return '&minus;';
  return '&harr;';
}

function indexRefsByTable(db: Database): Map<string, RefEntry[]> {
  // Endpoint order in `db.refs` isn't authoritative (inline refs get promoted
  // with target first), so categorize by cardinality: `*` = FK-holder
  // (outgoing), `1` = referenced (incoming). Symmetric refs (`-`/`<>`) land
  // in one bucket on both ends, which is fine for the section heading.
  const out = new Map<string, RefEntry[]>();
  for (const ref of allRefs(db)) {
    for (const endpoint of ref.endpoints) {
      const id = endpointTableId(endpoint);
      const direction: RefDirection = endpoint.relation === '*' ? 'outgoing' : 'incoming';
      push(out, id, { ref, direction });
    }
  }
  return out;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

if (!customElements.get(DbmlStructureElement.tagName)) {
  customElements.define(DbmlStructureElement.tagName, DbmlStructureElement);
}
