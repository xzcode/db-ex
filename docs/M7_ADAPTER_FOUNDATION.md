# M7 — Database adapter foundation (first batch)

This branch is based on the M6 release candidate `fde9450`. It is separate from the v0.5.7 release branch and does not change its version, publication workflow or dependencies.

## Implemented boundary

- `src/main/connections/adapters/types.ts`: connection context, live adapter session, engine operation allowlist, roots/children/preview, close, transaction and read-budget hooks.
- `src/main/connections/adapters/index.ts`: exhaustive registry of MySQL, MongoDB, Redis and SQLite, with exact action matching instead of prefix-only dispatch.
- Each engine owns its driver creation and cleanup, resource tree and existing operation implementation. SessionManager retains the common transport, credential validation, timeouts, cancellation, byte budget enforcement, write authorization and error redaction. Native tools remain separate.
- Shared baseline capability metadata drives editor type, transaction controls, database administration, backup menu, index controls and workspace tab recovery. Capability metadata does not grant write permission or imply all server versions/objects support a feature.
- Existing IPC operation names, serialized connection settings, driver libraries and UI behavior are preserved. SQLite deliberately rejects server-level create/drop database actions even though it uses the historical mysql.* operation names.

## Remaining M7 work

Dynamic capability negotiation for server versions, table storage engines and actual permissions; replace remaining relational-engine-specific UI branches and separate SQL dialect/parameter strategies before ClickHouse. Existing MySQL/MongoDB/Redis/SQLite regressions and native packaging must pass before merge. MariaDB and ClickHouse are not implemented in this batch.

## Local verification
Typecheck, production build, 8 targeted tests and the isolated SQLite process cancellation/rollback passed on the Seoul host. Four-engine full CI and packaged checks are still required for this new branch.
