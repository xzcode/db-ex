# M8 — MariaDB initial implementation

Development branch: feature/m7-database-adapters, based on the released v0.5.7 master. The stable v0.5.7 release contains four engines; MariaDB is the fifth engine on this development branch. This work targets v0.6.0, but no new version tag or release is created until integration and packaging pass.

## Implementation
- Independent MariaDB connection choice, profile type, default TCP 3306, authentication fields, encrypted connection import/export, icon and server version check. Driver: existing mysql2 over the existing transport, with explicit MariaDB server identity validation.
- Register MariaDB as a distinct adapter; share the SQL operation module and conservative MySQL-family SQL policy. The common native write-confirmation path now uses the registered adapter's own action allowlist and write classification, including SQLite, MongoDB and Redis.
- Resource catalog queries actual information_schema.TABLES metadata. MariaDB SHOW FULL TABLES alone reports system-versioned tables as ordinary tables; the explorer now identifies SEQUENCE and SYSTEM VERSIONED objects, marks both read-only for the generic editor, and retrieves actual CREATE SEQUENCE DDL where available.
- Metadata-based relational object capabilities: regular table insertion, primary-key updates/deletes, transaction-aware operations, atomic batch import only for InnoDB. MariaDB refuses generic record edits of views, sequences and system-versioned tables and refuses structured mutations of non-InnoDB tables during an explicit transaction. Main-process operations recheck metadata, independent of UI restrictions. Arbitrary explicitly confirmed SQL is not guaranteed rollback-safe on nontransactional tables.
- MariaDB JSON is the server's LONGTEXT alias, not MySQL binary JSON. Use the actual wire field type and declared column metadata; preserve BIGINT and DECIMAL as strings. Recognize persistent generated columns and refuse editing them.
- Independent MariaDB page size, type colors, encrypted SQL draft mode, history and favorites, existing 14-language UI. MariaDB CLI paths mariadb-dump and mariadb are configurable. Direct native backup/restore uses dedicated MariaDB flags, private temporary credential files, non-overwriting export and native confirmation. It does not use the MySQL-only --ssl-mode or --no-login-paths flags.
- Native tools remain limited to direct non-TLS profiles until secure tunnel/TLS integration is implemented. The SQL restore script is user-selected and can target other databases if its content says so; nontransactional SQL restore may partially apply.

## Local real-engine checks
- MariaDB 10.11.19 and 11.4.13: authenticated SOCKS connection and version detection; real object catalog, sequence and system-versioned metadata; exact BIGINT/DECIMAL, JSON alias, parameterized browse/query, generated-column protection, CRUD conflict detection, transaction rollback and nontransactional protection; native dump/restore, backup file preservation and credential cleanup all passed.
- Isolated disposable Docker databases only. No user's business database was used. Both fixture containers were removed.
- The two versions are now part of the integrated CI test step. MariaDB 10.6 and 11.8, specific TLS/SSH deployment configurations and alternative authentication plugins are still unverified. No blanket claim of MariaDB compatibility.

## Remaining
Finish M7/M8 cross-engine and desktop CI, review engine-specific SQL dialect coverage and object operations. Publish v0.6.0 only after the validated branch is merged and exact installers are produced. Then start M9 ClickHouse with its own client, SQL policy, typed values and non-transactional mutation semantics.
