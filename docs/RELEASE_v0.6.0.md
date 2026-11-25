# DB EX v0.6.0 (Preview)

## What's new
- MariaDB joins MySQL, MongoDB, Redis and SQLite as a fifth database engine. Independent connection profile, adapter, settings, metadata-aware CRUD, transactions and native dump/restore. Real integration fixtures cover MariaDB 10.11 and 11.4.
- The shared database adapter registry separates engine-specific operations and write classification. Existing connection profiles and legacy IPC remain compatible.
- A sortable object catalog, search and independent object tabs preserve work state while switching. MongoDB collection statistics and SQL table metadata use real server values; unavailable values are not fabricated. Column-header actions apply database-side sorting and draft filters.
- Named query objects for MySQL, MariaDB, SQLite and MongoDB. Local encrypted storage is separate from history/favorites; SQL parameters, MongoDB filter/projection/sort and aggregation pipelines are preserved. New query, save, save as, rename, copy, delete, import/export and Ctrl/Cmd+S are supported. Queries do not run on open.
- The top toolbar exposes only Preferences. Language and theme are configurable under General. The macOS white title bar is replaced by the existing themed toolbar, with native traffic lights and drag regions. Windows and Linux keep native frames.
- Existing 14 UI languages, explicit write authorization and per-operation native confirmation remain in place.

## Installers
macOS ARM64 (DMG and ZIP, ad-hoc signed, not notarized), Windows x64 (NSIS EXE), Linux x64 (AppImage and DEB). Three SHA-256 checksum files accompany the installers. The release workflow publishes only after the exact master commit has passed integrated native CI and all uploaded assets have been checked for size and SHA-256.

## Limitations
- ClickHouse is not yet included. MariaDB 10.6/11.8, special authentication plugins and all TLS/SSH deployment variants are not claimed to be validated. Sequences and system-versioned tables are restricted in the generic row editor.
- MongoDB catalog statistics are bounded to the first 50 collections and a time budget. MySQL-family counts are estimates. SQLite does not invent per-table size metadata.
- Named queries require saved connections. Exported query files are plaintext; raw SQL exports omit bound parameters, while portable JSON retains them. The encrypted local file remains bounded to 16 MiB; the old 100-favorite limit does not apply. Existing favorites can be adopted explicitly. Full mongosh execution and script formatting remain future work.
- macOS ad-hoc signing is not Apple notarization. OS approval may be required for downloaded apps.
