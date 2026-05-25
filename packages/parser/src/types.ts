// Re-exports of `@dbml/parse` model types under stable names + small id helpers.
// The shape of `Database` is what the rest of dbml-view consumes; we don't wrap
// it in an adapter — re-exports keep the call-site grep-friendly and avoid drift
// when @dbml/parse adds fields.

export type {
  Database,
  Table,
  Column,
  Enum,
  Ref,
  Project,
  TableGroup,
  TablePartial,
} from '@dbml/parse';

import type { Column, Database, Enum, Ref, Table } from '@dbml/parse';

// Types not re-exported from the @dbml/parse barrel — derive them from the
// public ones via indexed access. Same upstream shape, no internal-path import.
export type ColumnType = Column['type'];
export type Index = Table['indexes'][number];
export type InlineRef = Column['inline_refs'][number];
export type RefEndpoint = Ref['endpoints'][number];
export type RefEndpointPair = Ref['endpoints'];
export type RelationCardinality = RefEndpoint['relation'];
export type EnumField = Database['enums'][number]['values'][number];
export type TableGroupField = Database['tableGroups'][number]['tables'][number];
export type Alias = Database['aliases'][number];
export type TablePartialInjection = Table['partials'][number];
export type Note = Database['notes'][number];
export type TokenPosition = Ref['token'];

/** Default schema used when DBML omits one. Matches the DBML convention. */
export const DEFAULT_SCHEMA = 'public';

/** `schema.table` — stable across runs, safe in URL hashes and DOM ids. */
export function tableId(table: Pick<Table, 'name' | 'schemaName'>): string {
  return `${table.schemaName ?? DEFAULT_SCHEMA}.${table.name}`;
}

/** `schema.table.column` — stable per-column id used for edge anchors. */
export function columnId(
  table: Pick<Table, 'name' | 'schemaName'>,
  column: Pick<Column, 'name'>,
): string {
  return `${tableId(table)}.${column.name}`;
}

/** `schema.enum` — stable across runs, safe in URL hashes and DOM ids. */
export function enumId(en: Pick<Enum, 'name' | 'schemaName'>): string {
  return `${en.schemaName ?? DEFAULT_SCHEMA}.${en.name}`;
}

/** Look up an enum by its stable id. Returns undefined if not present. */
export function findEnum(db: Database, id: string): Enum | undefined {
  return db.enums.find((e) => enumId(e) === id);
}

/**
 * True when an enum is referenced by a column's type. Matches by name + schema,
 * treating a column type with no schema as belonging to the default schema —
 * same convention DBML uses for unqualified enum references.
 */
export function columnUsesEnum(column: Pick<Column, 'type'>, en: Pick<Enum, 'name' | 'schemaName'>): boolean {
  if (column.type.type_name !== en.name) return false;
  const enumSchema = en.schemaName ?? DEFAULT_SCHEMA;
  const colSchema = column.type.schemaName ?? DEFAULT_SCHEMA;
  return colSchema === enumSchema;
}

/** Same shape as `tableId`, but built from a Ref endpoint (which carries name + schema). */
export function endpointTableId(endpoint: Pick<RefEndpoint, 'tableName' | 'schemaName'>): string {
  return `${endpoint.schemaName ?? DEFAULT_SCHEMA}.${endpoint.tableName}`;
}

/** Look up a table by its stable id. Returns undefined if not present. */
export function findTable(db: Database, id: string): Table | undefined {
  return db.tables.find((t) => tableId(t) === id);
}

/**
 * True when tables span more than one schema. When false, schema labels are
 * noise (every table shows the same value — usually "public") and views should
 * hide them.
 */
export function hasMultipleSchemas(db: Database): boolean {
  const first = db.tables[0];
  if (!first) return false;
  const baseline = first.schemaName ?? DEFAULT_SCHEMA;
  for (let i = 1; i < db.tables.length; i++) {
    if ((db.tables[i]?.schemaName ?? DEFAULT_SCHEMA) !== baseline) return true;
  }
  return false;
}

/**
 * All FK refs in the database.
 *
 * `@dbml/parse` already promotes inline refs (`field type [ref: > t.f]`) into
 * `db.refs`, so this is just a thin alias — useful as a stable API in case the
 * upstream behavior ever splits the lists.
 */
export function allRefs(db: Database): Ref[] {
  return db.refs;
}
