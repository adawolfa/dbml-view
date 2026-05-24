// <dbml-structure source="…"> — left-rail table list, right-pane detail.
// Vanilla DOM (no shadow root, so consumer CSS can theme it via the
// :where(dbml-structure) variable block in style.css).

import {
  type Column,
  DEFAULT_SCHEMA,
  type Database,
  type Ref,
  type Table,
  allRefs,
  columnId,
  endpointTableId,
  parseDbml,
  tableId,
} from '@dbml-view/parser';

type RefDirection = 'outgoing' | 'incoming';
type RefEntry = { ref: Ref; direction: RefDirection };

export class DbmlStructureElement extends HTMLElement {
  static readonly tagName = 'dbml-structure';

  static get observedAttributes(): string[] {
    return ['source'];
  }

  private database: Database | null = null;
  private selectedTableId: string | null = null;
  private searchQuery = '';
  private refsByTableId = new Map<string, RefEntry[]>();
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
    if (!this.rendered) return;
    this.renderAll();
    this.syncFromHash();
  }

  private wireEvents(): void {
    const search = this.querySelector<HTMLInputElement>('[data-search]');
    search?.addEventListener('input', () => {
      this.searchQuery = search.value.trim().toLowerCase();
      this.renderTableList();
    });

    const list = this.querySelector<HTMLElement>('[data-table-list]');
    list?.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-table-id]');
      if (target) {
        event.preventDefault();
        this.selectTable(target.dataset.tableId ?? null);
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
    this.renderTableList();
    this.renderDetail();
  }

  private renderError(errors: { line: number; column: number; message: string }[]): void {
    const detail = this.querySelector('[data-detail]');
    const list = this.querySelector('[data-table-list]');
    if (list) list.innerHTML = '';
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

  private renderTableList(): void {
    const container = this.querySelector('[data-table-list]');
    if (!container) return;
    if (!this.database) {
      container.innerHTML = '<p class="dv-empty">No DBML loaded.</p>';
      return;
    }
    const q = this.searchQuery;
    const filtered = this.database.tables.filter((t) => {
      if (q === '') return true;
      if (t.name.toLowerCase().includes(q)) return true;
      if ((t.schemaName ?? DEFAULT_SCHEMA).toLowerCase().includes(q)) return true;
      return t.fields.some((c) => c.name.toLowerCase().includes(q));
    });
    if (filtered.length === 0) {
      container.innerHTML = '<p class="dv-empty">No matches.</p>';
      return;
    }
    const bySchema = groupBy(filtered, (t) => t.schemaName ?? DEFAULT_SCHEMA);
    const schemas = [...bySchema.keys()].sort();
    container.innerHTML = schemas
      .map((schema) => {
        const tables = (bySchema.get(schema) ?? [])
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name));
        return `
          <section class="dv-schema">
            <h3 class="dv-schema-name">${escapeHtml(schema)}</h3>
            <ul class="dv-table-list">
              ${tables
                .map((t) => {
                  const id = tableId(t);
                  const active = id === this.selectedTableId ? ' is-active' : '';
                  return `
                    <li>
                      <a href="#table:${encodeURIComponent(id)}" data-table-id="${escapeAttr(id)}" class="dv-table-link${active}">
                        ${escapeHtml(t.name)}
                        <span class="dv-table-meta">${t.fields.length}</span>
                      </a>
                    </li>
                  `;
                })
                .join('')}
            </ul>
          </section>
        `;
      })
      .join('');
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
    container.innerHTML = renderTableDetail(table, this.refsByTableId.get(tableId(table)) ?? []);
  }

  private selectTable(id: string | null): void {
    if (id === this.selectedTableId) return;
    this.selectedTableId = id;
    if (id) {
      const targetHash = `#table:${encodeURIComponent(id)}`;
      if (window.location.hash !== targetHash) {
        history.replaceState(null, '', targetHash);
      }
    }
    this.renderTableList();
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
    <nav data-table-list></nav>
  </aside>
  <section class="dv-pane" data-detail></section>
`;

function renderTableDetail(table: Table, refs: RefEntry[]): string {
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
      <div class="dv-detail-schema">${escapeHtml(schema)}</div>
      <h2 class="dv-detail-name">${escapeHtml(table.name)}</h2>
      <code class="dv-detail-id">${escapeHtml(id)}</code>
      ${note ? `<p class="dv-note">${escapeHtml(note)}</p>` : ''}
    </header>

    <h3 class="dv-section-title">Columns</h3>
    <table class="dv-columns">
      <thead>
        <tr><th>Name</th><th>Type</th><th>Flags</th><th>Default</th><th>Note</th></tr>
      </thead>
      <tbody>
        ${table.fields.map((c) => renderColumnRow(table, c, pkColumns, fkColumns)).join('')}
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

function renderColumnRow(table: Table, column: Column, pks: Set<string>, fks: Set<string>): string {
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
    <tr id="${escapeAttr(id)}">
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
  const [a, b] = entry.ref.endpoints;
  const aIsSelf = endpointTableId(a) === selfId;
  const bIsSelf = endpointTableId(b) === selfId;
  let selfEnd: typeof a;
  let otherEnd: typeof a;
  if (aIsSelf && bIsSelf) {
    const wantRelation = entry.direction === 'outgoing' ? '*' : '1';
    if (a.relation === wantRelation) {
      selfEnd = a;
      otherEnd = b;
    } else {
      selfEnd = b;
      otherEnd = a;
    }
  } else if (aIsSelf) {
    selfEnd = a;
    otherEnd = b;
  } else {
    selfEnd = b;
    otherEnd = a;
  }
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

function groupBy<T, K>(items: T[], keyOf: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    push(out, key, item);
  }
  return out;
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
