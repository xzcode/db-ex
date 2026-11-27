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

## Second implementation batch — 2026-11-27

The previous MySQL 8.0/8.4 and MariaDB 11.8 candidate at `17528ba`
passed the complete SQL-family M12 CI matrix, integrated CI, and macOS
packaged smoke. The recovered local work adds four more native endpoints:

| Engine | Schema scope | Transfer scope |
|---|---|---|
| MySQL/MariaDB | Ordinary InnoDB, additive columns/indexes | Append, matching primary-key upsert, transactional full-table replacement, typed single-table condition |
| SQLite | Ordinary tables, indexes and additive columns | Isolated worker streaming, typed storage classes, upsert, transactional replacement, typed single-table condition |
| MongoDB | Ordinary standalone collections and simple indexes | Raw BSON round-trip verification, ordered acknowledged batches, explicit _id-based replacement/upsert and typed condition |
| Redis | No SQL schema | Standalone DBs, selected UTF-8 keys, binary DUMP/RESTORE, TTL, explicit optional matching-key overwrite |
| ClickHouse | Ordinary MergeTree, simple scalar types/keys, nullable appended columns | Server-native binary stream; bytes progress; nontransactional outcome, no invented row count |

All endpoints use existing verified connection routing. Plans stay immutable
and revalidate endpoint identity and schemas. Advanced update/replace modes
default to no selected steps, require explicit selection and native
confirmation. MySQL-family advanced writes require direct global metadata
visibility (SELECT and TRIGGER or ALL PRIVILEGES, no partial revokes), no
alternate unique key for upsert, matching primary keys, and no incoming
foreign-key references. SQLite scans incoming FK definitions before updating
or emptying a table. Full replacement never combines with a source filter.
MongoDB and Redis acknowledge each batch/key separately, and ClickHouse
has no global rollback. Do not auto-retry uncertain writes. Complex objects
remain review-only.

A main-process migration journal persists up to 100 encrypted metadata-only
task records using existing local storage/cipher infrastructure. It saves a
running marker before opening database connections and checkpoints object
boundaries. An interrupted running record becomes uncertain on startup;
completed objects and committed counts are last confirmed checkpoints.
History can be selected and removed, and is visible across windows for
terminal jobs. No credentials, records, executable plans, or filter values
are stored in the journal. If storage initialization fails, ordinary
browsing remains available but new migrations fail before writes. This is
not automatic resume or a guarantee against physical disk failure.

### Actual evidence in the development environment

- SQLite ordinary schema and 12,001-row native storage fidelity,
  duplicate rollback, alias guard and combined copy passed.
- MongoDB 8.0.12 standalone mTLS: collection/index creation, 1,001
  documents byte-exact, duplicate stop and combined copy passed.
- Redis 7.0.15: all six ordinary types, binary values and TTL retained,
  existing target key unchanged in default append mode.
- ClickHouse 25.8.33.6 mTLS/SOCKS: create/add nullable field, 12,001-row
  Native stream and UInt64/decimal/binary/NULL aggregate comparison,
  combined structure+data passed using bounded thread settings.
- MariaDB 10.11.14 and SQLite: filtered copy, upsert and transactional
  replacement passed; incoming FK cascade protection verified.
- SQLite one million rows copied in 8,195 ms in the isolated environment
  (estimated wire payload 79,777,792 bytes). Counts, sum of IDs, labels
  and payload checks agree; encrypted task metadata reopened successfully.
  This is a fixture measurement, not a guaranteed production throughput.
- 23 focused schema/history/i18n tests, three M12 browser tests, script
  and application typechecks, and production build passed.
- Additional MongoDB upsert/typed condition, Redis overwrite, exact MySQL
  8.0/8.4 advanced mode and other-engine CI jobs require the new candidate
  matrix. The local NoSQL advanced fixture launch was not authorized by
  the execution environment; do not claim these new modes passed locally.

### Remaining work

M12.1–M12.5 foundation is now implemented, including safe default copy on
all six engines. M12.7 has the initial migration window, one reusable
template, persistent job metadata and advanced settings. Still outstanding:
broader schema grammar and dependency ordering, arbitrary cross-engine
field/type maps and renames, richer filters, named templates, advanced
parallelism and resumable checkpoints, exact cross-server/version matrix
and release upgrade acceptance. There is no automatic restart/resume.
The stable release remains v1.0.0; the combined M12/UI candidate must pass
its full CI, and remaining scope must be reviewed before v1.1.0 release.
