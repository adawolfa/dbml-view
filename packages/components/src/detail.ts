// <dbml-detail source="…"> — pane that renders the detail of a selected
// table or enum. Decoupled from <dbml-structure>; the app shell forwards the
// current selection via setSelection().

import {
  type Column,
  DEFAULT_SCHEMA,
  type Database,
  type Enum,
  type Table,
  columnId,
  columnUsesEnum,
  endpointTableId,
  enumId,
  hasMultipleSchemas,
  parseDbml,
  tableId,
} from '@dbml-view/parser';

import {
  type RefEntry,
  type Selection,
  escapeAttr,
  escapeHtml,
  formatColumnType,
  indexRefsByTable,
  otherEndpointOf,
  relationArrow,
  selfEndpoint,
} from './shared';

type EnumUsage = { table: Table; column: Column };

export class DbmlDetailElement extends HTMLElement {
  static readonly tagName = 'dbml-detail';

  static get observedAttributes(): string[] {
    return ['source'];
  }

  private database: Database | null = null;
  private refsByTableId = new Map<string, RefEntry[]>();
  private selection: Selection = { kind: 'none' };
  private rendered = false;

  connectedCallback(): void {
    if (!this.rendered) {
      this.classList.add('dv-detail');
      this.innerHTML = '<section class="dv-pane" data-detail></section>';
      this.wireEvents();
      this.rendered = true;
    }
    const source = this.getAttribute('source');
    if (source !== null && this.database === null) {
      this.source = source;
    } else {
      this.renderDetail();
    }
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
    this.renderDetail();
  }

  /**
   * Replace the current selection. Re-renders. If the selection points to a
   * column, the matching row is scrolled into view.
   */
  setSelection(selection: Selection): void {
    this.selection = selection;
    if (!this.rendered) return;
    this.renderDetail();
    if (selection.kind === 'table' && selection.columnName !== undefined) {
      this.scrollColumnIntoView(selection.tableId, selection.columnName);
    }
  }

  private wireEvents(): void {
    this.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const tableLink = target.closest<HTMLAnchorElement>('a[data-jump-table]');
      if (tableLink) {
        event.preventDefault();
        const id = tableLink.dataset.jumpTable ?? '';
        this.dispatchEvent(
          new CustomEvent<Selection>('jump-to', {
            detail: { kind: 'table', tableId: id },
            bubbles: true,
          }),
        );
        return;
      }
      const enumLink = target.closest<HTMLAnchorElement>('a[data-jump-enum]');
      if (enumLink) {
        event.preventDefault();
        const id = enumLink.dataset.jumpEnum ?? '';
        this.dispatchEvent(
          new CustomEvent<Selection>('jump-to', {
            detail: { kind: 'enum', enumId: id },
            bubbles: true,
          }),
        );
      }
    });
  }

  private scrollColumnIntoView(tId: string, columnName: string): void {
    const id = `${tId}.${columnName}`;
    const escaped = window.CSS && CSS.escape ? CSS.escape(id) : id;
    const row = this.querySelector(`#${escaped}`);
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  private renderError(errors: { line: number; column: number; message: string }[]): void {
    const container = this.querySelector('[data-detail]');
    if (!container) return;
    container.innerHTML = `
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

  private renderDetail(): void {
    const container = this.querySelector('[data-detail]');
    if (!container) return;
    if (!this.database) {
      container.innerHTML = '<div class="dv-empty">No DBML loaded.</div>';
      return;
    }
    const sel = this.selection;
    if (sel.kind === 'enum') {
      const en = this.database.enums.find((e) => enumId(e) === sel.enumId);
      if (en) {
        container.innerHTML = renderEnumDetail(
          en,
          findEnumUsages(this.database, en),
          hasMultipleSchemas(this.database),
        );
        return;
      }
    }
    if (sel.kind === 'table') {
      const table = this.database.tables.find((t) => tableId(t) === sel.tableId);
      if (table) {
        const columnName = sel.columnName ?? null;
        container.innerHTML = renderTableDetail(
          table,
          this.refsByTableId.get(tableId(table)) ?? [],
          columnName,
          hasMultipleSchemas(this.database),
          this.database.enums,
        );
        return;
      }
    }
    const tableCount = this.database.tables.length;
    const enumCount = this.database.enums.length;
    const parts = [`${tableCount} table${tableCount === 1 ? '' : 's'}`];
    if (enumCount > 0) parts.push(`${enumCount} enum${enumCount === 1 ? '' : 's'}`);
    container.innerHTML = `
      <div class="dv-empty">
        <p>Pick a table or enum from the list.</p>
        <p>${parts.join(', ')} in this schema.</p>
      </div>
    `;
  }
}

function findEnumUsages(db: Database, en: Enum): EnumUsage[] {
  const out: EnumUsage[] = [];
  for (const table of db.tables) {
    for (const column of table.fields) {
      if (columnUsesEnum(column, en)) {
        out.push({ table, column });
      }
    }
  }
  return out;
}

function renderTableDetail(
  table: Table,
  refs: RefEntry[],
  highlightedColumn: string | null,
  showSchema: boolean,
  enums: Enum[],
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
          .map((c) =>
            renderColumnRow(table, c, pkColumns, fkColumns, c.name === highlightedColumn, enums),
          )
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

function renderEnumDetail(en: Enum, usages: EnumUsage[], showSchema: boolean): string {
  const id = enumId(en);
  const schema = en.schemaName ?? DEFAULT_SCHEMA;
  return `
    <header class="dv-detail-header">
      ${showSchema ? `<div class="dv-detail-schema">${escapeHtml(schema)}</div>` : ''}
      <h2 class="dv-detail-name">
        <span class="dv-detail-kind">enum</span>
        ${escapeHtml(en.name)}
      </h2>
      <code class="dv-detail-id">${escapeHtml(showSchema ? id : en.name)}</code>
    </header>

    <h3 class="dv-section-title">Values</h3>
    <table class="dv-columns">
      <thead>
        <tr><th>Name</th><th>Note</th></tr>
      </thead>
      <tbody>
        ${en.values
          .map(
            (v) => `
              <tr>
                <td class="dv-col-name">${escapeHtml(v.name)}</td>
                <td class="dv-col-note">${escapeHtml(v.note?.value ?? '')}</td>
              </tr>
            `,
          )
          .join('')}
      </tbody>
    </table>

    ${
      usages.length === 0
        ? '<p class="dv-muted dv-empty-inline">Not referenced by any column.</p>'
        : `
          <h3 class="dv-section-title">Used by</h3>
          <ul class="dv-refs">
            ${usages
              .map((u) => {
                const tId = tableId(u.table);
                const label = `${u.table.name}.${u.column.name}`;
                return `
                  <li>
                    <a href="#table:${encodeURIComponent(tId)}" data-jump-table="${escapeAttr(tId)}"><code>${escapeHtml(label)}</code></a>
                  </li>
                `;
              })
              .join('')}
          </ul>
        `
    }
  `;
}

function renderColumnRow(
  table: Table,
  column: Column,
  pks: Set<string>,
  fks: Set<string>,
  highlighted: boolean,
  enums: Enum[],
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
  const enumMatch = enums.find((e) => columnUsesEnum(column, e));
  const typeText = formatColumnType(column);
  const typeCell = enumMatch
    ? `<a href="#enum:${encodeURIComponent(enumId(enumMatch))}" data-jump-enum="${escapeAttr(enumId(enumMatch))}" class="dv-col-type-enum">${escapeHtml(typeText)}</a>`
    : escapeHtml(typeText);
  return `
    <tr id="${escapeAttr(id)}"${highlighted ? ' class="is-highlighted"' : ''}>
      <td class="dv-col-name">${escapeHtml(column.name)}</td>
      <td class="dv-col-type">${typeCell}</td>
      <td class="dv-col-flags">${flags.map((f) => `<span class="dv-badge dv-badge-${f.toLowerCase().replace(/[^a-z]/g, '-')}">${f}</span>`).join('')}</td>
      <td class="dv-col-default">${escapeHtml(def)}</td>
      <td class="dv-col-note">${escapeHtml(column.note?.value ?? '')}</td>
    </tr>
  `;
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

if (!customElements.get(DbmlDetailElement.tagName)) {
  customElements.define(DbmlDetailElement.tagName, DbmlDetailElement);
}
