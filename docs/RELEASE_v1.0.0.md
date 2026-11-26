# DB EX v1.0.0

DB EX is a local-first desktop database workspace for MySQL, MariaDB, MongoDB, Redis, SQLite and ClickHouse.

## What changed since v0.7.1

- Verified compatibility across ten additional engine/version targets, using real database servers with authenticated SOCKS, SSH and TLS/mTLS. Correct MongoDB TLS context initialization and case-insensitive URI flags.
- MySQL 8.0 and 8.4 native client support with isolated login configuration, explicit TLS identity checks and private credential files. MariaDB native CLI and MongoDB native archive/EJSON backup and restore verified.
- ClickHouse real two-server Keeper replication, distributed queries, replica outage and restart catch-up tested.
- Atomic no-clobber backup and export publication for SQLite, ClickHouse and native database tools; improved process cleanup and clear filesystem errors.
- Preserve workspace recovery when a connection is temporarily unavailable. Synchronize language and theme across open windows.
- Large SQLite and ClickHouse workload, precise values, transaction rollback and actual platform upgrades with retained local data verified.

See [M11 compatibility evidence](M11_COMPATIBILITY.md) for the full acceptance matrix and limitations. The merged M11 candidate passed all 15 specialist jobs, 171 integrated tests, 48 browser UI tests and native desktop smoke on all three platforms. The release is published only after both the integrated/native CI and the full M11 matrix pass on the exact release commit.

## Installers

- macOS ARM64: DMG or ZIP (ad-hoc signed, not notarized).
- Windows x64: NSIS EXE (not commercially code signed).
- Linux x64: AppImage or DEB.
- Three platform SHA-256 checksum files.

Before upgrading, close other DB EX windows, back up important connection settings and data, and verify the installer checksum. Keep the app's existing user data directory. Native upgrade checks include saved connections, encrypted credentials metadata, saved query, recovery draft, preferences and SQLite data.

## Scope and limits

- This is the first stable application release for the documented support scope, not a guarantee for every database server version, topology or filesystem.
- MySQL-family external native tools do not support combined tunnel + database TLS. Unsupported modes fail closed; ordinary driver-based routed TLS remains available.
- Native CLI allows one supported SQL statement and explicit transaction controls; it is not an unrestricted operating-system shell.
- ClickHouse transfer limit is 256 MiB / 120 seconds, conditional mutations require appropriate server settings, and asynchronous task submission is not completion. Imports can partially write before an error.
- Backup/export never overwrites an existing file; filesystems without safe no-clobber publication are rejected.
- Linux upgrade testing uses an isolated extracted DEB prefix, not package-manager registration/maintainer scripts. macOS Gatekeeper or Windows SmartScreen may display warnings for non-notarized/unsigned packages.
- Cancellation cannot undo committed writes. Backups and recovery drafts are local; users should protect their device and copies of database data.

The application does not require an account or cloud service. Existing preview releases remain available for rollback.
