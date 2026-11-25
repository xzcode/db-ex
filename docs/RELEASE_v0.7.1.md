# DB EX v0.7.1 (Preview)

## What's new

- The workspace header now uses the exact user-approved DB EX app artwork instead of a generic symbol.
- ClickHouse management: partition statistics, compression, mutation status and cancellation, confirmed conditional updates/deletes, optional lightweight mutations when the server already supports them, configured cluster topology, replica and replication queue status, and bounded query statistics.
- ClickHouse table CSV/JSONL/Parquet streaming transfer preserves server-native data types, including exact integer and decimal values. Server-configured backup disks support asynchronous table backup and restore to a new table with job status.
- MariaDB sequence inspection and explicit restart, system-versioned table history, and partition metadata. Special object types remain protected from generic row editing.
- Native SQL CLI for MySQL, MariaDB and SQLite, using explicitly configured executables and per-operation write confirmation. Existing MongoDB, Redis and ClickHouse editors remain available.
- Multiple desktop workspaces with independent connection sessions and recovery drafts. Restore open workspaces without restoring write permissions or automatically executing saved queries.
- MongoDB native-tool transport supports verified remote TLS over an existing SSH/proxy route. SQL metadata completion caches field names by connection and database.

## Validation and installers

Development evidence and compatibility boundaries are recorded in [M11 compatibility matrix](M11_COMPATIBILITY.md). The release gate requires successful integrated CI for the exact master commit, native desktop startup and workspace restart tests on all three platforms, and verified SHA-256 hashes for the five installers.

macOS ARM64 (DMG/ZIP, ad-hoc signed), Windows x64 (EXE), Linux x64 (AppImage/DEB), plus three platform checksum files.

## Limits

- Preview release, not a claim of universal server or topology compatibility. ClickHouse tested lightweight updates require compatible table metadata and server settings. Cluster reports are configured topology metadata, not live remote connectivity checks; multi-host distributed deployments are not yet fully verified.
- ClickHouse streaming transfer is capped at 256 MiB and 120 seconds. CSV exports the complete table, not current-page filters, and preserves raw values; existing files are never overwritten. Imports may partially write before an error; do not retry blindly.
- Native CLI accepts one SQL statement at a time plus transaction controls, not operating-system shell commands. It is limited to MySQL, MariaDB and SQLite. MySQL-family external tools cannot combine a tunnel and database TLS. MongoDB native-tool tunnel TLS requires further full real-engine compatibility verification.
- Asynchronous task submission is not completion. Cancellation does not roll back already committed changes.
- macOS ad-hoc signing is not Apple notarization. Actual installation and desktop icon behavior can vary by OS and version.
