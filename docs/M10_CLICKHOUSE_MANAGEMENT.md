# M10.1 — ClickHouse object management reports

Baseline: v0.7.0. Adds a Management tab to ordinary ClickHouse table workspaces, with four read-only views:

- Partitions: active parts grouped by partition ID, exact row/byte counts and uncompressed-to-compressed ratio.
- Mutations: retained tasks, completion flag, pending parts and bounded failure details. A zero pending count is not independently treated as completion; use the server's is_done flag.
- Replicas: local replica identity, queue counts, read-only/session state, absolute delay and active/total replicas. An empty result is valid for non-replicated tables.
- Query statistics: aggregated recorded query finishes and exceptions for the selected object over the last 24 hours, average/P95/max latency and read volume. Local query log only; may be delayed, disabled or restricted. No raw SQL, usernames, forced log flush or cluster-wide query.

Each operation selects fixed system-table SQL in the main process, binds database and table as String parameters, uses existing server readonly=1 and resource budgets, and rejects unknown report names. Results retain exact integer strings and pagination limits. The UI keeps the management tab in workspace recovery and provides translations for all 14 supported languages.

Local regression covers the report policy, binding and paging, readonly enforcement, workspace restoration and localization. The isolated ClickHouse CI fixture additionally creates two partitions, tests object-scoped mutation history, non-replicated status and aggregated query log. Real-server acceptance and native CI remain required before merging/releasing; local tests do not prove compatibility across versions or deployments.

M10.2+ still requires guarded explicit mutation submission/cancellation, partition write management, streaming CSV/JSON/Parquet, server-side backup/restore, richer topology and common workspace/tool improvements. No write operations are introduced in this batch. Never enable cluster-wide or unbounded changes as a substitute for explicit scope and verification.

## M10 advanced management implementation — 2026-11-25

The following changes are development candidates on the M10 branch, not part of the published v0.7.0 Preview:

- Explicit table-scoped mutation preview/update/delete and cancellation by existing mutation ID. Equality predicates and replacement values are typed server parameters; key/generated columns are excluded. Submission is asynchronous, and the existing task report is the source of completion/failure status.
- Partition drop/detach/attach by validated ID, with explicit confirmation and server metadata checks.
- Streaming full-table CSV, JSONL and Parquet import/export with a 256 MiB transfer limit, a 120-second deadline, server-side resource budgets, cancellation, temporary-file cleanup and no overwrite. JSONL passes raw bytes rather than decoding integers through JS numbers. CSV contains raw database data and is not spreadsheet-sanitized.
- Asynchronous table BACKUP to an authorized named server disk, and RESTORE to a new table with a unique job ID and status lookup. Server permissions/configuration determine availability. No arbitrary file paths or cluster-wide backup operations.
- Native tools: direct TLS with identity verification and an explicit local forward for supported single-node SSH/proxy routes. Combined forwarded TLS, MongoDB separate certificate/key mTLS and unsupported topology/URI modes fail closed. Routed native MySQL/MongoDB regression is included in CI; only local policy tests have run in this batch.
- SQL table inference and bounded connection-scoped metadata cache (five-minute TTL), refresh, engine-specific functions and quoting. Workspace restores up to 12 validated object tabs and unsaved encrypted query drafts without executing queries or granting write access.

Verification: local full unit suite 145 passed, 8 environment-dependent skipped; ClickHouse unit suite after the JSONL correction 7 passed; 6 focused Playwright tests passed. Real ClickHouse 25.8.33.6 over authenticated SOCKS passed typed mutation preview, update/delete, detach/attach, mutation cancellation, CSV/JSONL/Parquet round-trips with exact UInt64/Decimal/NULL, export overwrite protection, readonly import protection and asynchronous backup/restore. Production build and type checking passed. Transfer verification used small isolated datasets, not a throughput benchmark. HTTP client warns about intermediary idle timeouts on long-running operations.

Outstanding: lightweight mutations, actual replicated/sharded cluster topology, MariaDB-specific object expansion, interactive native CLI, more native tool TLS/SSH/proxy compatibility testing and multi-window restoration. Full exact-commit integrated CI and three-platform packaging must be verified before release.
