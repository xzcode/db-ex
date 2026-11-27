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
