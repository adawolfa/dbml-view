# samples

Fixtures for development and manual testing. Kept at a reasonable size so they can be opened by hand.

- `small.dbml` — 2 tables, 1 FK. Smoke test.
- `medium.dbml` — 2 schemas, enum, indexes, notes, TableGroup, Project header. A more realistic sample.
- `edge-cases.dbml` — self-ref, 1:1, M:N, composite FK, quoted identifiers, "fat" table.
- `large.dbml` — 31 tables across 5 schemas (auth/shop/cms/logistics/analytics), 6 enums, 40 refs, 5 TableGroups. Exercises every feature @dbml/parse supports: Project with multi-line Note, enums with per-value notes, quoted enum values, table aliases, all column settings (pk/unique/not null/null/increment/default string|number|expression/note/inline ref), all index forms (composite PK, named, unique, hash type, expression index, index note), all four ref cardinalities (> < - <>), inline/short/long-form refs, composite FK, cross-schema refs, delete+update actions.
