// Smoke test: parse all sample files, print a one-line summary per file.
// Run from repo root: `node packages/parser/scripts/smoke.mjs`
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDbml } from '../src/parse.ts';
import { allRefs, tableId } from '../src/types.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const samplesDir = join(here, '..', '..', '..', 'samples');

const files = readdirSync(samplesDir).filter((f) => f.endsWith('.dbml'));

for (const file of files) {
  const src = readFileSync(join(samplesDir, file), 'utf8');
  const result = parseDbml(src);
  if (!result.ok) {
    console.log(`✗ ${file}: ${result.errors.length} error(s)`);
    for (const e of result.errors)
      console.log(`    ${e.line}:${e.column} [${e.code}] ${e.message}`);
    continue;
  }
  const db = result.db;
  const refs = allRefs(db);
  console.log(
    `✓ ${file}: ${db.tables.length} tables, ${refs.length} refs (top-level: ${db.refs.length}), ${db.enums.length} enums, ${db.tableGroups.length} groups`,
  );
  for (const t of db.tables) {
    const pkCount = t.fields.filter((f) => f.pk).length;
    console.log(`    - ${tableId(t)}: ${t.fields.length} cols${pkCount ? `, ${pkCount} pk` : ''}`);
  }
}
