import {
  type CompileError,
  Compiler,
  type Database,
  DEFAULT_ENTRY,
  MemoryProjectLayout,
} from '@dbml/parse';

export type ParseError = {
  message: string;
  code: number;
  line: number;
  column: number;
  offset: number;
};

export type ParseResult = { ok: true; db: Database } | { ok: false; errors: ParseError[] };

/**
 * Parse a DBML source string.
 *
 * Returns `{ ok: true, db }` only when the compiler both produced a `Database`
 * AND reported no errors. A partial parse with errors is treated as failure —
 * the structure/diagram views can't trust a half-built model, and the user is
 * better served by seeing the error list.
 */
export function parseDbml(source: string): ParseResult {
  // @dbml/parse v8 is project-based; for the single-file viewer we feed the
  // source into an in-memory layout under the parser's built-in default entry.
  const layout = new MemoryProjectLayout({ [DEFAULT_ENTRY.absolute]: source });
  const compiler = new Compiler(layout);

  const validateErrors = compiler.validateFile(DEFAULT_ENTRY).getErrors();
  if (validateErrors.length > 0) {
    return { ok: false, errors: validateErrors.map((e) => toParseError(e, source)) };
  }

  const dbReport = compiler.interpretFile(DEFAULT_ENTRY);
  const interpretErrors = dbReport.getErrors();
  if (interpretErrors.length > 0) {
    return { ok: false, errors: interpretErrors.map((e) => toParseError(e, source)) };
  }

  const db = dbReport.getValue();
  if (!db) {
    return {
      ok: false,
      errors: [{ message: 'Parser produced no database.', code: 0, line: 1, column: 1, offset: 0 }],
    };
  }

  return { ok: true, db };
}

function toParseError(error: CompileError, source: string): ParseError {
  const { line, column } = offsetToLineColumn(source, error.start);
  return {
    message: error.diagnostic || error.message,
    code: error.code,
    line,
    column,
    offset: error.start,
  };
}

/** 1-indexed line and column for a 0-indexed character offset. */
function offsetToLineColumn(source: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}
