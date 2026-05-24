// Stub — Phase 1.
// Thin wrapper around `@dbml/parse` (v3.14.1).
//
// API (verified in node_modules/@dbml/parse/dist/src/index.d.ts):
//   import { Compiler, type Database, CompileError } from '@dbml/parse';
//   const c = new Compiler();
//   c.setSource(src);
//   const db: Database | undefined = c.parse.rawDb();
//   const errors: readonly CompileError[] = c.parse.errors();
//
// We re-export `Database` (and other model types) as `ParsedDatabase`,
// `parseDbml(src)` returns a discriminated ok/error union.

export type ParseError = {
  message: string;
  line?: number;
  column?: number;
};

export type ParseResult<T> =
  | { ok: true; db: T }
  | { ok: false; errors: ParseError[] };

export function parseDbml(_src: string): ParseResult<unknown> {
  throw new Error('parseDbml: not implemented (Phase 1)');
}
