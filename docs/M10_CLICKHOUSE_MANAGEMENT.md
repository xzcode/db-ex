# M10.1 — ClickHouse object management reports

Baseline: v0.7.0. Adds a Management tab to ordinary ClickHouse table workspaces, with four read-only views:

- Partitions: active parts grouped by partition ID, exact row/byte counts and uncompressed-to-compressed ratio.
- Mutations: retained tasks, completion flag, pending parts and bounded failure details. A zero pending count is not independently treated as completion; use the server's is_done flag.
- Replicas: local replica identity, queue counts, read-only/session state, absolute delay and active/total replicas. An empty result is valid for non-replicated tables.
- Query statistics: aggregated recorded query finishes and exceptions for the selected object over the last 24 hours, average/P95/max latency and read volume. Local query log only; may be delayed, disabled or restricted. No raw SQL, usernames, forced log flush or cluster-wide query.

Each operation selects fixed system-table SQL in the main process, binds database and table as String parameters, uses existing server readonly=1 and resource budgets, and rejects unknown report names. Results retain exact integer strings and pagination limits. The UI keeps the management tab in workspace recovery and provides translations for all 14 supported languages.

Local regression covers the report policy, binding and paging, readonly enforcement, workspace restoration and localization. The isolated ClickHouse CI fixture additionally creates two partitions, tests object-scoped mutation history, non-replicated status and aggregated query log. Real-server acceptance and native CI remain required before merging/releasing; local tests do not prove compatibility across versions or deployments.

M10.2+ still requires guarded explicit mutation submission/cancellation, partition write management, streaming CSV/JSON/Parquet, server-side backup/restore, richer topology and common workspace/tool improvements. No write operations are introduced in this batch. Never enable cluster-wide or unbounded changes as a substitute for explicit scope and verification.
