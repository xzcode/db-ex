# DB EX v0.7.0 (Preview)

## What's new

- ClickHouse is the sixth engine: HTTP/HTTPS connection configuration, shared transport routing, database and table/view metadata, typed parameterized SQL, exact integer and decimal display, sorting, filtering, bounded import/export and guarded MergeTree writes.
- One compact navigation tree combines saved connections and their independently expandable database resources. Local database-specific SVG icons replace generic character placeholders. The empty workspace has no promotional content. Native window and Dock icons use the same approved artwork as the installers.
- MongoDB named queries and aggregation objects use a direct statement editor, with collection and method completion, operators, BSON constructors and result-derived field suggestions. Legacy saved query forms open as equivalent statements. SQL and MongoDB editors provide formatting.
- Double-click editable scalar cells or select a column for current-page assignment. Changes are staged until the bottom checkmark applies the selected row or column; cancel discards the selected draft. MySQL/MariaDB/SQLite/MongoDB preserve original values and reliable identities. InnoDB/SQLite batches use transactions or savepoints; nontransactional writes report partial outcomes.
- MongoDB index creation includes localized syntax help and examples. The obsolete MapReduce entry is removed.

## Validation and installers

Focused real-database acceptance passed for MySQL 8.4.13, MariaDB 11.4.13, MongoDB 8.3.13 (isolated test instance) and SQLite, including conflicts, exact numeric/BSON types and atomic/partial outcomes. ClickHouse 25.8.33.6 core adapter was verified on an isolated instance. The release workflow additionally requires successful full CI for the exact master commit, real native packaged-app startup, and verified installer checksums before publishing.

macOS ARM64 (DMG/ZIP, ad-hoc signed), Windows x64 (EXE), Linux x64 (AppImage/DEB), plus three SHA-256 checksum files.

## Limitations

- MongoDB's statement editor accepts one supported expression, not arbitrary mongosh JavaScript. Native update/delete statements and arbitrary scripting remain unsupported; document/grid write controls use the guarded existing operations.
- Inline editing applies to the currently loaded eligible records, not an entire unseen database table. The first implementation excludes primary keys, _id, generated columns, complex/unsupported values and mixed-type batch columns. Redis and ClickHouse do not use relational single-record editing.
- A nontransactional or interrupted write can have partial or uncertain effects. Verify before retrying; cancel does not undo committed database writes.
- ClickHouse is an initial analytical adapter: no native TCP, arbitrary SETTINGS, clustered DDL, mutation administration, Parquet or complete server backup workflow. Additional versions, HTTPS/mTLS and SSH deployment variants, dictionary metadata and server-side query cancellation require further verification.
- macOS ad-hoc signing is not notarization. Actual Dock/taskbar appearance after installation remains a platform visual acceptance item.
