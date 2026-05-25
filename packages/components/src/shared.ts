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

export type TreeGroup = {
  id: string;
  label: string;
  kind: 'tablegroup' | 'schema';
  tables: Table[];
  enums: Enum[];
};

/**
 * Group tables + enums for the tree. Tables in a `TableGroup` go under that
 * group; everything else falls back to a synthetic per-schema group, with
 * enums always living under their schema (TableGroups don't claim enums).
 * Stable ordering: real groups first (alphabetical), then schema groups
 * (alphabetical).
 */
export function buildTree(db: Database): TreeGroup[] {
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
      enums: [],
    });
  }
  groups.sort((a, b) => a.label.localeCompare(b.label));

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

export function escapeAttr(value: string): string {
  return escapeHtml(value);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
