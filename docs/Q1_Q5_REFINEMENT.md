# Q1–Q5 workspace refinements — candidate implementation

Based on the Navicat comparison, this batch improves existing features; it does not claim complete Navicat parity.

## Implemented

- Q1: shared grid cell focus, arrow/Tab navigation, Shift rectangular selection, TSV clipboard copy/paste, current-page find/replace, explicit field editor, persisted column visibility/order/pins/widths, and atomic staging followed by explicit save-all. Original primary-key/whole-document optimistic concurrency checks still apply.
- Q2: long-value text/JSON/EJSON editors, JSON formatting, BSON binary hex and image preview (PNG/JPEG/GIF), existing record form and document tree entry points. Full unprojected BSON documents can stage a canonical EJSON field change. Original identity is retained. Read-only previews are not used to reconstruct unavailable full fields.
- Q3: encrypted per-connection/object named browse profiles, create/update/delete/apply, filters/sorting/layout/view/page size; custom 1–500 row page size; visited-page offsets. For ordinary bounded MySQL SELECT, aggregate byte truncation permits continuation at the actual offset without discarding the connection. Per-record oversize, cancellation and time limits still protect the driver.
- Q4: dialect-specific function vocabulary and signatures; multi-table/alias and explicit qualified table metadata; on-demand MongoDB field sampling and nested field paths; current SQL statement execution; typed positional/named parameter form; independent read query cancellation. Write operations, explicit transactions and recognized session-sensitive SQL retain the original session. They may require explicit disconnect to cancel.
- Q5: CSV and JSONL/EJSON wizard for MySQL, MariaDB, SQLite and MongoDB: 20-row preview, explicit field mappings/conversion, append/upsert, relational replace, conversion-error reporting, filtered/field-selective streaming export, row/byte progress, cancellation, atomic non-overwriting export. Files are streamed in the main process; relational writes are transactional, MongoDB writes are acknowledged in batches and partial/uncertain outcomes remain visible. The file itself is not transferred into the renderer.

## Boundaries

This is a substantial Q1–Q5 implementation batch, not a claim all planned features are done. Ordinary query previews remain bounded (500 rows, byte/row limits); full export/import are separate streaming jobs with no total row limit. CSV is text and explicit mapping/conversion is needed for exact types; typed JSONL carries DB EX relational value wrappers and MongoDB canonical EJSON. UTF-8 only. Existing ClickHouse native file transfer and Redis-specific operations remain separate. The wizard reports up to 200 conversion errors and total count; it does not skip database constraint errors automatically. No automatic retry for uncertain writes. Complex target schemas and unsupported MongoDB topology/options remain guarded.

Remaining work: multi-statement execution and multiple result sets; switch query connection/database in-place; direct editable SQL query results; complete CTE/version-sensitive metadata and execution history; continuous append browsing and primary-key/ObjectId locator; full direct nested-node CRUD and SQL binary/date-specialized widgets; Excel/SQL/Parquet import in the general wizard, additional encodings, named import/export presets, full error report and explicit selected-row export. Full engine and packaged desktop compatibility are subject to CI. Do not publish v1.1.0 from this batch until those required release gates pass.

## Local evidence

- 27 focused tests passed: grid identity/types, column layouts, browse profile scope, SQL lexical boundaries and metadata, typed file parsing, page byte limits and previous query features.
- Ten focused Playwright tests passed, including both previously failing color regressions, selection/paste/save-all, extended BSON editor, persistent columns, named browse profile, custom page size, typed parameters, current statement execution, independent cancellation and file wizard.
- Isolated real SQLite database: export and import of 50,001 records, 6,616,788 bytes, approximately 2.6 seconds combined in the development fixture; exact Int64, BLOB, REAL storage type and NULL. Duplicate rollback, mapped CSV replacement including multiline/doubled quotes, upsert with conversion-error reporting, non-clobber output. Real recursive read query cancelled and original session verified reusable.
- No live customer databases or credentials were used. MySQL/MariaDB/MongoDB file endpoints need dedicated real engine CI coverage.

## Follow-up — 2026-11-27

- Q1: relational column type/comment display in column manager; selected records export to canonical MongoDB EJSON or exact available SQL JSON. Existing 8 MiB UI export limit remains for a selection; use full streaming export for large files. No write from a lossy preview.
- Q2: editable document tree within the existing MongoDB edit dialog: add/remove/rename document fields, append/remove array elements, replace values including typed BSON constructors and canonical EJSON. Immutable _id and explicit save with original-document conflict check retained. Tree operations are local drafts.
- Q3: exact typed primary-key tuple/ObjectId lookup (temporarily replaces applied filter, with explicit restore), sort priority up/down, and manually append further pages in a read-only continuous view. Regular pagination restores editable single-page mode. This is not a server-side snapshot or unbounded keyset cursor; existing offset and per-page protections remain.
- Q4: read-only SQL batches, preflight all statements and parameters before executing, positional placeholders distributed across statements, ClickHouse named parameter map, independent bounded reads and individual result tabs. Stop on failure or cancellation, preserve preceding results. Existing 32 MiB aggregate preview limit; use smaller batches or stream export for large outputs. Explicit transactions and mixed write scripts are not supported by this batch mode.
- Q5: encrypted named import/export presets scoped to connection/object/direction, no file path, token, or filter literals in persisted preset. Apply preset then choose and preview file again. Import decoding for UTF-8, UTF-16LE/BE, GB18030 and Windows-1252; export remains UTF-8. Full conversion-error report streamed to private temporary CSV, owner-scoped explicit non-overwriting export; UI still previews first 200. No row payload in report. Reports are removed on next job or window close. Database constraint errors still stop rather than automatically skip. Existing target guards and commit/uncertain handling remain.
- Added all missing Traditional Chinese strings from the previous batch and new English/Traditional Chinese strings for this batch. Other languages use the existing English fallback for untranslated new controls.

### Evidence

35 focused unit/policy/locale cases passed. Full local suite: 179 passed, 10 environment-dependent skips, zero failures (189 top-level cases). Five focused browser tests passed, plus two earlier browsing/editing cases in an interrupted larger UI run. Typecheck and M11/M12 script typecheck passed.

Real isolated SQLite: 50,001 record round-trip (6,616,788 bytes, 3.766 s combined in the development fixture); UTF-16 CSV import with 251 conversion errors, complete report with 251 records, owner scope protection; exact large integers/binary/REAL/NULL; rollback/upsert/replace and independent read cancellation. Real read batch parameter binding, whole-batch write preflight rejection, and partial result retention passed.

Added dedicated MySQL 8.0/8.4, MariaDB 11.8, MongoDB 8.0 mTLS/SOCKS file round-trip fixtures to the existing isolated M12 workflow. They have not run locally. Full combined candidate CI and desktop packaging are still required before merging/releasing.

Outstanding deeper parity: editable SQL query results, query retargeting, mixed read/write script semantics, full CTE and version-aware metadata, history metrics, SQL date/BLOB editor, raw SQL filter text, Excel/SQL/Parquet general import, and consistent Redis/ClickHouse file wizard integration. No claim that Q1–Q5 are fully complete.

## Query history and field refinement — next candidate

The previous exact candidate `d565d8f` passed complete integration/UI CI,
all three desktop packages, macOS ad-hoc verification, and the seven M12
real-fixture jobs. MySQL 8.0/8.4 and MariaDB 11.8 each copied 1,001
records through verified TLS/SOCKS JSONL export/import; UInt64, DECIMAL,
binary and NULL matched, rollback and transactional replacement passed.
MongoDB 8.0 copied 1,001 EJSON documents with byte-exact BSON and explicit
upsert. These are results for the previous commit, not the new candidate.

- Saved query execution history now stores optional execution time, elapsed
  time, returned preview rows, affected rows, status, stable error code
  and batch completion counts alongside the existing encrypted snippets.
  Explicit runs only; paging does not duplicate history. Search, status
  filter, favorite, delete, copy and explicit load into editor. No automatic
  execution. Old snippets remain readable; the existing storage retention
  policy remains. Raw driver diagnostic text is not persisted in the new
  execution metadata.
- SQL DATE/DATETIME/TIMESTAMP/TIME field editor uses native date selection
  and exact time text. Validate Gregorian date and precision without JS
  timezone conversion or fractional-second rounding. Existing optimistic
  concurrency and staged write flow are unchanged.
- MySQL/MariaDB and SQLite complete bounded BLOB previews are returned as
  separate base64 metadata, aligned with the result rows. Hex/image viewing
  and copying use this exact preview rather than truncated table text.
  Binary row originals remain read-only; no SQL binary mutation is claimed.
- Typecheck and production build passed. 36 focused tests passed (including
  real SQLite binary read). Both new UI cases passed: history
  success/failure/filter/load-without-execution and microsecond date editing
  plus read-only exact hex preview. The latter initially failed because the
  fixture omitted the name expected by the existing openUsers test helper;
  corrected fixture and rerun passed.
- Conservative single-table SQL result edit groundwork was preserved as
  local WIP commit `3c13098` on `work/q-query-result-edit`. The combined
  execution-target wiring tool call was blocked; no bypass was attempted.
  Neither SQL result editing nor query retargeting is included in this
  candidate. Remaining mixed write scripts, raw SQL browse filter and
  general Excel/SQL/Parquet file formats are still outstanding. Full exact
  candidate CI is required before merging or publishing.

## SQL single-table result editing — follow-up

Recovered local groundwork from `3c13098` and integrated it with the applied
query/result identity. Supports MySQL, MariaDB and SQLite ordinary
transactional tables with a complete primary key, exact full-row originals
and a conservative single-table SELECT * shape. No projection, join, view,
aggregate, batch, pinned snapshot, active transaction, system table, or
lossy binary preview is editable. A native write confirmation and existing
atomic optimistic-concurrency update batch are required. MySQL-family
query-result writes additionally reject temporary-table shadowing. On save,
refresh only the originally applied read, never the changed editor buffer.
No insert/delete or direct SQL grid-wide writes are added in this batch.

Local evidence: 13 focused unit/real SQLite tests passed, one focused browser
interaction test passed (write unlock, immutable pinned result, buffer change,
exact write target and refresh, projection rejection). Typecheck and
production build passed. MySQL/MariaDB real acceptance is still required.

## Explicit execution target switching

- The query header exposes an explicit connection/database selector. Choose
  an already-connected session of the same engine and one of its visible
  databases; no automatic connect, query execution or change to the saved
  query's home connection/database, name or recovery key.
- Editor buffer and parameters stay intact. Current results, paging, applied
  operations, edit eligibility and completion metadata are invalidated on
  switching. Pinned read-only snapshots retain their original source label.
- Execution, metadata, history, confirmation, cancellation, transaction
  controls and record updates use the selected live session. A disconnected
  target never silently redirects a query to the home connection. Selection
  is transient and cannot change while a transaction is active or a task is
  running. Cross-engine retargeting is deliberately not enabled.
- The original and target workspace busy states track the active task.
  Detailed controls are translated into English and both Chinese variants;
  the existing English fallback applies elsewhere.

Focused browser coverage passed for query target switching, preservation of
saved-query home scope and pinned results, target-specific history and
record edits, disconnection without fallback, explicit return to the home
connection, plus existing history and single-table edit cases. Added a
real isolated SQL-family fixture to the existing M12 workflow for exact
UInt64/DECIMAL query editing, stale row rejection and temporary-table
shadow protection; results are pending CI.

## Mixed SQL scripts, bulk query-result edits and completion refinement

- Added a separate explicitly confirmed read/write script action for
  MySQL, MariaDB and SQLite. Preflight every statement's lexical boundaries,
  supported policy and positional parameters before starting. A fresh
  authenticated connection runs statements sequentially, preserving their
  individual read results, affected rows and partial completion. No implicit
  outer transaction; earlier writes may already be committed. Existing
  explicit transactions, session-variable scripts and unsupported statements
  are rejected. Stop requests take effect at statement boundaries; uncertain
  write failures are reported, not retried. The existing 32 MiB preview
  budget remains; an executed statement's outcome is not misrepresented as
  an unexecuted statement when its preview must be omitted.
- Added explicit bulk editing for eligible complete single-table SQL results:
  inline cell editing, range paste/replace, draft indicators, save-all and
  discard. Each paste is validated as a whole. Save reuses the native
  confirmation and atomic full-original-row concurrency guard. No key
  mutations, lossy rows, pinned results, joins or batch results are editable.
  While editing, target switching and query execution are blocked; a failed
  write requires discard and refresh before another attempt.
- CTE output-list and simple projected-field/AS-alias completion, including
  recursive CTE names and qualified aliases. Physical metadata is not fetched
  for a recognized unqualified CTE. Wildcards, ambiguous expressions and
  complex nested/multi-statement scopes are not fully inferred. The completion
  provider uses the current editor buffer so same-keystroke suggestions work.
  Reported server versions filter selected MySQL/MariaDB/SQLite function
  vocabulary; suggestions remain reference guidance, not a policy bypass.
- Fixed the previous exact candidate's MariaDB temporary-table acceptance:
  it correctly rejected writes as read-only but the fixture expected the
  query-edit-specific error. Query-result safety checks now precede generic
  record capability errors; both MySQL and MariaDB retain the shadow guard.

Local evidence: 16 focused policy/metadata/real SQLite cases passed; the
SQLite isolated worker fixture validated ordered mixed scripts, confirmation
and preflight, partial commit, stop at a statement boundary, and original
connection reuse. Targeted browser regressions passed for SQL bulk edits,
mixed scripts, CTE completion, read batches, saved query scope, single row
edits and execution history. Added a real mixed-script fixture to the
existing MySQL/MariaDB TLS/SOCKS matrix. Remote acceptance must run on this
exact candidate before merge/release.

### Advanced predicates and file formats

- Relational browsing accepts an explicit SQL-condition mode (MySQL,
  MariaDB, SQLite). The shared predicate compiler allows nested boolean
  expressions, comparisons, arithmetic, selected scalar functions, IN,
  BETWEEN, LIKE and NULL tests. Literal strings and explicit placeholders
  are bound, and exact numeric literals are retained. It rejects arbitrary
  statements, subqueries, comments and unapproved functions. Applied
  predicates are shared by paging, counts, saved browse profiles and file
  exports; MongoDB continues using its separate filter syntax.
- SQL data-file import/export supports a single source table with explicit
  columns and INSERT VALUES records. Imports parse data and use the
  existing prepared, transactional write path, never execute the file's
  SQL. Export preserves wide integers, decimal text, binary, NULL and
  escaped text. This is not an arbitrary SQL dump or DDL executor.
- XLSX import/export supports worksheet selection, matching-header
  multi-sheet import, preview and explicit mappings. Streaming reads use
  the opened file identity and spill large shared-string tables to private
  disk storage; streaming exports split at the Excel worksheet row limit.
  Large numbers are text, binary uses Base64/EJSON mappings and NULL has
  an escaped marker. Formulas are not evaluated; formula cells on import
  are rejected and formula-looking exported strings stay literal.
  Excel cannot recover precision already lost in another spreadsheet.
  Legacy XLS and Parquet remain outside this increment. MongoDB XLSX
  conversions are explicit; use JSONL/EJSON for lossless arbitrary BSON.
- Worksheet changes invalidate the old preview token; file presets omit
  per-file selection. The existing mapping, cancellation, rollback,
  diagnostics and no-clobber publication rules remain in effect.

Local evidence: five focused predicate/format tests, two targeted browser
cases, real isolated SQLite filtered SQL round trip and malicious trailing
statement rollback, and a 1001-row mapped XLSX round trip. The new
MySQL/MariaDB/MongoDB TLS/SOCKS acceptance cases are part of the existing
M12 fixture matrix and require remote execution on this exact candidate.
Runtime dependency audit reported no known vulnerabilities after retaining
the DOMPurify override and pinning the transitive UUID dependency.

### Parquet and native Redis / ClickHouse file jobs

- MySQL/MariaDB/SQLite/MongoDB use incremental Parquet row groups,
  native integer/unsigned/decimal/binary/nullable primitives where the
  source has a compatible type. SQLite dynamic values and selected BSON
  fields are encoded as typed JSON/EJSON columns. Mapping is explicit;
  arbitrary nested Parquet schemas and unsupported logical types are not
  promised. Reads have a 64 MiB row-group decoding budget (not a total
  file-size cap); large files should use reasonably sized row groups.
  Missing selected BSON fields are represented as null; JSONL/EJSON is
  still the preferred arbitrary-document fidelity format.
- Redis standalone archives use SCAN MATCH or explicit UTF-8 key selection,
  exact Base64 binary keys and native DUMP payloads, absolute expiration
  and RESTORE. Import validates the record envelope and duplicate key
  identities for the whole file before writing; the Redis server validates
  payload checksums and format during RESTORE. Default conflict policy
  stops without overwriting; overwrite must be confirmed explicitly.
  Expired records are skipped. Scan is not a consistent snapshot.
  Supported native types: string/hash/list/set/zset/stream. Each key has
  a 1 MiB key and 4 MiB dump budget; module types, Cluster/Sentinel and
  arbitrary Redis commands are not supported by this archive format.
  The disk-backed key ledger prevents duplicate output without an
  unbounded in-memory set. Acknowledged writes are not rolled back.
- ClickHouse now has native CSVWithNames, JSONEachRow, Parquet and Native
  file jobs with chosen/reordered columns and the applied equality filter
  for exports. The new job path is streamed, independently cancellable,
  uses actual byte progress (not invented row counts), no-clobber output
  and input identity checks. It does not impose the legacy direct-call
  256 MiB/120-second total limits. Import is append-only on supported
  engines; the user chooses matching field order. No arbitrary cross-engine
  conversion or automatic native schema mapping is claimed. If an import
  is interrupted after the write starts, its outcome is uncertain.

Local real fixtures: SQLite Parquet 50,001 rows with exact int64, dynamic
REAL storage, BLOB and NULL; Redis 7.0.15 disposable loopback instance,
seven keys covering six native data types, binary key/value and absolute
TTL, conflict stop, opt-in overwrite, expired record and duplicate-key
preflight. Remote M12 fixtures now cover filtered native ClickHouse
file jobs and selected Parquet round trips for MySQL/MariaDB/MongoDB;
those fixtures require CI acceptance on this exact candidate.

- Previous candidate full UI CI exposed an outcome-clearing race: delayed
  automatic completion metadata could reset the script failure banner.
  Automatic completion now preserves the query outcome; explicit operations
  retain their existing status lifecycle.
