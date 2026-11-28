# DB EX v1.1.0 — Database migration and workspace improvements

DB EX is a local-first desktop database workspace for MySQL, MariaDB, MongoDB,
Redis, SQLite and ClickHouse. No account or cloud service is required.

## New in v1.1.0

- Database structure synchronization and explicit data-transfer plans across
  all six native adapters. Review SQL differences, export deployment scripts,
  and apply supported additive changes. Ordinary same-engine SQL foreign-key
  dependencies can be ordered explicitly.
- Existing-object and field mapping between supported SQL-family, SQLite,
  MongoDB and ClickHouse endpoints; native Redis key rename and expiry
  preservation. Explicit conversions protect numeric precision, BSON and
  binary values. Destination conflict policies depend on the engine.
- Independent migration tasks, encrypted named configurations, task history,
  cancellation and explicit continuation of known-safe unfinished objects.
- Streaming import/export: CSV, JSONL/EJSON, XLSX, SQL INSERT data, and Parquet
  for supported engines; native Redis archives and ClickHouse Native streams.
  Select columns, apply filters and review progress and errors.
- Improved table and document editing: keyboard/clipboard selection, staged
  batch edits, typed BSON tree, field editors, persistent column layout,
  browse profiles, record locator and SQL condition filtering.
- Resizable query editor/results, multiple result tabs, saved queries and
  history, contextual completion, explicit execution target, read batches
  and confirmed mixed SQL scripts.
- Refined object inspector, context menus, column resizing, and additional
  black, grey and soft-white themes.

## Compatibility and installation

The published v1.0.0 installers are the upgrade baseline. Publication
requires all integrated/native CI jobs, the fifteen-job compatibility
matrix (including upgrades on Linux, macOS and Windows), and the seven-job
M12 real database matrix to succeed on the exact release SHA. The prior
release and its assets are preserved.

- macOS ARM64: DMG and ZIP (ad-hoc signed; not notarized).
- Windows x64: NSIS EXE (not commercially signed).
- Linux x64: DEB and AppImage.
- Three platform SHA-256 checksum files.

Back up your local configuration and important database data before upgrading.
Keep the existing DB EX user-data directory. Verify the installer checksum.
Gatekeeper or SmartScreen may warn about non-notarized/unsigned packages.
Linux upgrade tests use a private extracted DEB prefix, not OS-level package
registration.

## Scope and limits

M12 uses existing destination objects for cross-engine mappings; complex or
destructive DDL stays manual-review only. Redis archives and native migration
are supported for standalone instances. XLSX does not execute formulas; legacy
XLS and unrestricted nested Parquet are not supported. SQL file import parses
single-table INSERT data rather than executing arbitrary SQL dumps.
Nontransactional targets may be partially written; cancellation cannot undo
committed changes. Resume operates on known-safe objects, not arbitrary row
offsets; uncertain writes are never automatically replayed. Row-level
difference synchronization is planned for M13, not included here.

See [M12 migration](M12_MIGRATION.md), [workspace refinement](Q1_Q5_REFINEMENT.md),
and [M11 compatibility](M11_COMPATIBILITY.md) for implementation, evidence,
and detailed boundaries.
