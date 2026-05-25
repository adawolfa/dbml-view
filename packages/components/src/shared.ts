// Helpers shared by <dbml-structure> and <dbml-detail>. The two elements now
// live in separate files but speak the same selection vocabulary and share a
// handful of relation-walking utilities.

import {
  type Column,
  DEFAULT_SCHEMA,
  type Database,
  type Enum,
  type Ref,
  type Table,
  type TableGroup,
  allRefs,
  endpointTableId,
  tableId,
} from '@dbml-view/parser';

export type RefDirection = 'outgoing' | 'incoming';
export type RefEntry = { ref: Ref; direction: RefDirection };

export type Selection =
  | { kind: 'none' }
  | { kind: 'table'; tableId: string; columnName?: string }
  | { kind: 'enum'; enumId: string };

/**
 * Set of items hidden from the diagram. Stored as three flat sets so toggling
 * a schema or tablegroup is O(1); membership of a single table can be
 * overridden independently. See {@link computeHiddenTableIds} for how these
 * three buckets combine into the effective list passed to the diagram.
 */
export type HiddenSet = {
  /** Individual table IDs (`schema.name`). */
  tables: Set<string>;
  /** Schema names — every table under a hidden schema is hidden. */
  schemas: Set<string>;
  /** TableGroup keys (`schema.name`) — every member table is hidden. */
  tableGroups: Set<string>;
};

export function emptyHiddenSet(): HiddenSet {
  return { tables: new Set(), schemas: new Set(), tableGroups: new Set() };
}

export function hiddenSetIsEmpty(set: HiddenSet): boolean {
  return set.tables.size === 0 && set.schemas.size === 0 && set.tableGroups.size === 0;
}

/** Stable key for a TableGroup: `schema.name`. Matches dbml/parse's empty-vs-null
 * quirk by falling back to the default schema for both falsy values. */
export function tableGroupKey(group: Pick<TableGroup, 'name' | 'schemaName'>): string {
  return `${group.schemaName || DEFAULT_SCHEMA}.${group.name ?? ''}`;
}

/**
 * Effective set of hidden table IDs given the three-bucket {@link HiddenSet}.
 * A table is hidden if any of:
 *   - its id is in `tables`
 *   - its schema is in `schemas`
 *   - it belongs to a tablegroup whose key is in `tableGroups`
 */
export function computeHiddenTableIds(db: Database, hidden: HiddenSet): Set<string> {
  const out = new Set<string>();
  // Direct table membership.
  for (const id of hidden.tables) out.add(id);
  // Schema membership.
  if (hidden.schemas.size > 0) {
    for (const t of db.tables) {
      const schema = t.schemaName ?? DEFAULT_SCHEMA;
      if (hidden.schemas.has(schema)) out.add(tableId(t));
    }
  }
  // TableGroup membership.
  if (hidden.tableGroups.size > 0) {
    for (const tg of db.tableGroups) {
      if (!hidden.tableGroups.has(tableGroupKey(tg))) continue;
      for (const member of tg.tables) {
        out.add(`${member.schemaName || DEFAULT_SCHEMA}.${member.name}`);
      }
    }
  }
  return out;
}

/**
 * Cross-panel hover state broadcast via `hover-change` CustomEvents.
 * - `table`  — a whole table is hovered (diagram node or structure row)
 * - `column` — a single column is hovered (diagram row, structure column node, or detail row)
 * - `edge`   — a relationship edge is hovered (diagram SVG edge or structure relation node)
 *              `colA`/`colB` are the two endpoint columnIds in any order.
 */
export type HoverState =
  | { kind: 'none' }
  | { kind: 'table'; tableId: string }
  | { kind: 'column'; tableId: string; columnId: string }
  | { kind: 'edge'; colA: string; colB: string };

export function hoverStateEquals(a: HoverState, b: HoverState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'table' && b.kind === 'table') return a.tableId === b.tableId;
  if (a.kind === 'column' && b.kind === 'column') return a.columnId === b.columnId;
  if (a.kind === 'edge' && b.kind === 'edge') {
    return (a.colA === b.colA && a.colB === b.colB) || (a.colA === b.colB && a.colB === b.colA);
  }
  return true; // both 'none'
}

export type TreeGroup = {
  id: string;
  label: string;
  kind: 'tablegroup' | 'schema';
  tables: Table[];
  enums: Enum[];
};

/**
 * Group tables + enums for the tree.
 *
 * **Schema-mode** (any table lives outside the default "public" schema):
 * `TableGroup` declarations are ignored entirely — they are a diagram-visual
 * concept, and mixing them with real schemas in the structure view would be
 * confusing. Every table and enum is placed under its schema group.
 *
 * **Default-schema-only mode** (all tables are in "public"):
 * `TableGroup` declarations are honoured. Tables go under their named group;
 * unclaimed tables fall into a synthetic schema group. Enums always belong to
 * their schema group regardless.
 *
 * Stable ordering: table groups first (alphabetical), then schema groups
 * (alphabetical).
 */
export function buildTree(db: Database): TreeGroup[] {
  // If any table uses a non-default schema, groups are ignored in this view.
  const hasNonDefaultSchema = db.tables.some(
    (t) => (t.schemaName ?? DEFAULT_SCHEMA) !== DEFAULT_SCHEMA,
  );

  const claimed = new Set<string>();
  const groups: TreeGroup[] = [];

  if (!hasNonDefaultSchema) {
    for (const tg of db.tableGroups) {
      const tables: Table[] = [];
      for (const ref of tg.tables) {
        // @dbml/parse returns schemaName: "" (empty string) on TableGroupField
        // when no schema is specified, but schemaName: null on Table. Use ||
        // so both null and "" fall back to DEFAULT_SCHEMA and the lookup matches.
        const id = `${ref.schemaName || DEFAULT_SCHEMA}.${ref.name}`;
        const table = db.tables.find((t) => tableId(t) === id);
        if (table && !claimed.has(id)) {
          tables.push(table);
          claimed.add(id);
        }
      }
      if (tables.length === 0) continue;
      const label = tg.name ?? '(unnamed group)';
      groups.push({
        id: `tg:${tg.schemaName || DEFAULT_SCHEMA}.${label}`,
        label,
        kind: 'tablegroup',
        tables: tables.slice().sort((a, b) => a.name.localeCompare(b.name)),
        enums: [],
      });
    }
    groups.sort((a, b) => a.label.localeCompare(b.label));
  }

  const schemas = new Set<string>();
  const tablesBySchema = new Map<string, Table[]>();
  for (const t of db.tables) {
    const schema = t.schemaName ?? DEFAULT_SCHEMA;
    schemas.add(schema);
    if (claimed.has(tableId(t))) continue;
    push(tablesBySchema, schema, t);
  }
  const enumsBySchema = new Map<string, Enum[]>();
  for (const e of db.enums) {
    const schema = e.schemaName ?? DEFAULT_SCHEMA;
    schemas.add(schema);
    push(enumsBySchema, schema, e);
  }

  const schemaGroups: TreeGroup[] = [...schemas]
    .map((schema) => ({
      id: `sc:${schema}`,
      label: schema,
      kind: 'schema' as const,
      tables: (tablesBySchema.get(schema) ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
      enums: (enumsBySchema.get(schema) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((g) => g.tables.length > 0 || g.enums.length > 0)
    .sort((a, b) => a.label.localeCompare(b.label));

  return [...groups, ...schemaGroups];
}

export function indexRefsByTable(db: Database): Map<string, RefEntry[]> {
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

/** Pick the endpoint that isn't `selfEnd`. Works for self-refs since we
 * compare by identity, not table id. */
export function otherEndpointOf(
  ref: Ref,
  selfEnd: Ref['endpoints'][number],
): Ref['endpoints'][number] {
  const [a, b] = ref.endpoints;
  return a === selfEnd ? b : a;
}

export function selfEndpoint(
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

export function relationArrow(self: '1' | '*', other: '1' | '*'): string {
  if (self === '*' && other === '1') return '&rarr;';
  if (self === '1' && other === '*') return '&larr;';
  if (self === '1' && other === '1') return '&minus;';
  return '&harr;';
}

export function formatColumnType(column: Column): string {
  // @dbml/parse already bakes args into type_name (e.g. "varchar(255)"),
  // so we only need the schema prefix — appending `args` again would duplicate the parens.
  const { schemaName, type_name } = column.type;
  return schemaName ? `${schemaName}.${type_name}` : type_name;
}

export function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Two-tier name search used by the structure tree.
 *   1. Case-insensitive contiguous substring (the original behaviour).
 *   2. Word-aware subsequence — each query char must either start a new word in
 *      the target (after `_`, `-`, `.`, ` `, a camel-case bump, or a letter→
 *      digit transition) or directly continue the previously matched char.
 *      Lets `poRe` match `post_revisions` without being so loose that `us`
 *      starts matching any name with a stray `u` and `s` in it.
 *
 * Returns the indices in `target` where each query char matched, or `null` if
 * no match. Empty query → empty array (caller's "no filter" sentinel).
 */
export function searchMatch(target: string, query: string): number[] | null {
  if (query.length === 0) return [];
  const t = target.toLowerCase();
  const q = query.toLowerCase();

  const direct = t.indexOf(q);
  if (direct >= 0) {
    const out: number[] = [];
    for (let k = 0; k < q.length; k++) out.push(direct + k);
    return out;
  }

  const indices: number[] = [];
  let prev = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const qc = q[qi]!;
    let pick = -1;
    for (let j = prev + 1; j < t.length; j++) {
      if (t[j] !== qc) continue;
      const continuation = prev !== -1 && j === prev + 1;
      if (continuation || isWordBoundary(target, j)) {
        pick = j;
        break;
      }
    }
    if (pick === -1) return null;
    indices.push(pick);
    prev = pick;
  }
  return indices;
}

function isWordBoundary(s: string, i: number): boolean {
  if (i === 0) return true;
  const prev = s[i - 1]!;
  if (/[^A-Za-z0-9]/.test(prev)) return true;
  const curr = s[i]!;
  if (/[a-z]/.test(prev) && /[A-Z]/.test(curr)) return true;
  if (/[A-Za-z]/.test(prev) && /[0-9]/.test(curr)) return true;
  return false;
}

/**
 * Render `text` with the characters at `indices` wrapped in `<mark>` spans.
 * Contiguous indices collapse into a single span so adjacent matches read as
 * one highlighted run rather than a strobe of individual characters.
 *
 * `null` / empty `indices` → plain escaped text (no markup).
 */
export function highlightHtml(text: string, indices: number[] | null): string {
  if (!indices || indices.length === 0) return escapeHtml(text);
  const ranges: Array<[number, number]> = [];
  for (const i of indices) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] + 1 === i) last[1] = i;
    else ranges.push([i, i]);
  }
  const parts: string[] = [];
  let pos = 0;
  for (const [start, end] of ranges) {
    if (start > pos) parts.push(escapeHtml(text.slice(pos, start)));
    parts.push(`<mark class="dv-tree-match">${escapeHtml(text.slice(start, end + 1))}</mark>`);
    pos = end + 1;
  }
  if (pos < text.length) parts.push(escapeHtml(text.slice(pos)));
  return parts.join('');
}

export function escapeAttr(value: string): string {
  return escapeHtml(value);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
