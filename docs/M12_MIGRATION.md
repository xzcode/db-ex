# M12 — Structure synchronization and data transfer

Target: v1.1.0. The published v1.0.0 remains unchanged.

## Product scope

- Structure synchronization compares selected source/target databases, table and column declarations, indexes and table options. Present a selectable difference plan and a read-only SQL preview. Export the generated SQL separately.
- Data transfer supports structure plus data, or data-only copies into existing compatible objects. Use independent task connections, not the ordinary 500-row query result IPC. Explicitly selected objects only.
- Task center shows the current object, phase, read/committed/pending rows, bytes, results and cancellation. Persist saved migration configuration separately from credentials. Never replay a write automatically after reconnect or a lost acknowledgment.
- Later M13 is row/document difference synchronization, not part of the M12 full-copy contract.

## First implementation batch

Implemented in the current development branch:

- MySQL/MariaDB catalog and ordinary InnoDB schema snapshots through the existing verified SSH/proxy/TLS connection setup. Both endpoints are selected from saved profiles; protected databases and self-copy are rejected.
- Conservative schema parser, comparison and plans. Create missing ordinary tables, add safe appended fields and ordinary indexes; compare column definitions, primary/secondary indexes, table options. Ignore volatile AUTO_INCREMENT counters. Never generate DROP, TRUNCATE, narrowing type changes, unique-index changes on existing tables or arbitrary opaque SQL. Special definitions/constraints/triggers, views and destructive differences are review-only.
- Main-process-owned, window-scoped, one-use plan with a ten-minute expiry. Recheck connection configuration, server identity and object definitions before execution, including per-object checks. Native confirmation binds to selected plan IDs and source/target. No raw SQL execution endpoint for migration.
- Independent SQL-family transfer sessions, consistent read-only source snapshot, streamed rows with backpressure, parameterized destination writes, per-table commit/rollback. Exact UInt64, DECIMAL, binary, Unicode, NULL and microsecond timestamps are retained in tested fixtures. Existing compatible tables receive append-only writes; duplicates stop and roll back the current table. No automatic coercion, destructive replacement, UPSERT, or automatic retry.
- User-facing Structure synchronization and Data transfer toolbar/context-menu entries, selection, preview, SQL export, save/load one local template (no credentials), task progress and cancellation. Up to twenty in-memory job summaries per window. Closing the dialog minimizes the task; closing its workspace cancels it. No durable or automatic task resume.
- Chinese and English (including Traditional Chinese) new interface resources; primary migration entries localized in all supported languages. Detailed additional-language strings use the existing English fallback.

## Safety and boundaries

- Only MySQL and MariaDB are enabled for this batch. Same-engine structure creation and additive sync are implemented. Cross-family data copy is allowed only for matching safe declarations and table options, with non-ZEROFILL integer display widths normalized; real cross-family acceptance remains pending. No cross-family DDL generation.
- Existing target database required. Up to 500 catalog entries; select at most 100 objects per plan. Metadata has a 4 MiB aggregate cap and 128 KiB per definition. The initial grammar is deliberately limited; foreign keys, CHECK constraints, generated columns, special indexes, triggers, partitioning, special engines and more complex object definitions require review. Complete metadata visibility is required; database privileges can hide definitions/triggers. Use dedicated migration accounts and review existing target-side side effects.
- Transfers explicitly scan only selected tables. Maximum 500 rows and 4 MiB estimated payload per batch, also bounded by destination packet size and parameter count. Oversize or incompatible values stop the task. No fixed overall row-count cap; job deadline is 30 minutes; source may hold a read snapshot and metadata locks for its duration. Progress bytes are estimates, not a wire-byte measurement.
- Atomicity is per destination InnoDB table transaction, not the whole task. DDL commits independently. Earlier committed tables/DDL remain; canceled or failed current copy rolls back if its commit was not attempted. Lost acknowledgment for DDL/commit is reported as uncertain. Concurrent external DDL after a preflight is still possible; source/target metadata is pinned and rechecked during data transfer. Do not claim a global schema lock or distributed transaction.
- No implicit database creation, scheduling, row-difference sync, full database clone, durable checkpoints, or unbounded parallelism in this batch.

## Acceptance evidence

- Local isolated MariaDB 10.11.14, authenticated SOCKS source and direct destination, verified mTLS: ordinary schema comparison and creation, add column/index, rejection of manual/destructive and foreign-key definitions, one-use and ownership checks.
- 12,001 rows streamed in a real copy with exact UInt64/DECIMAL/binary/Unicode/NULL/timestamp preservation. Latest measured ~1.87 MB of estimated payload in 425 ms on the isolated development fixture; not a production throughput guarantee.
- Duplicate-key conflict rolls back current table; changed schema rejects a stale plan; structure+data creates and copies a missing table. Cancellation during blocked INSERT closes task sessions, rolls back the pending transaction and retains existing rows.
- Focused schema and input-policy unit tests: 4 passed; i18n regression: 14 passed; two focused Playwright cases: passed. Main/renderer and integration script type checks passed. New GitHub M12 matrix covers MySQL 8.0, MySQL 8.4 and MariaDB 11.8 with the existing isolated TLS fixture. The M11 fixture readiness probe uses the final TCP listener, avoiding the temporary initialization socket race.
- CI and broader integration results must be confirmed on the exact pushed candidate. No user's saved/live business database was used.

## Remaining milestones

| Stage | Status |
|---|---|
| M12.1 | Implemented first task/plan model, independent sessions and security boundary. Extend persistent task history/checkpoint model. |
| M12.2 | First MySQL/MariaDB structure sync implemented; expand object grammar, dependency ordering and detailed review. |
| M12.3 | SQLite, MongoDB and ClickHouse structure adapters pending. |
| M12.4 | SQL-family streamed append and per-table rollback implemented; cross-server and cross-family real acceptance, more modes and SQLite pending. |
| M12.5 | MongoDB, Redis, ClickHouse data transfer pending. |
| M12.6 | Explicit cross-engine field/type mapping, rename, filters and conflict modes pending. |
| M12.7 | First integrated migration window, local template and task progress implemented; durable task/config management and full localization pending. |
| M12.8 | Six-engine real integration, million-row benchmark, native platform and release gates pending. |

Do not release v1.1.0 or merge an unfinished M12 candidate into stable master.
