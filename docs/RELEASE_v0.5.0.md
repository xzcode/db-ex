# DB EX v0.5.0 — Core Preview

DB EX is a local-first desktop database client for **MySQL, MongoDB and Redis**.

### Highlights
- MySQL: SQL editor, parameterized queries, bounded paging, table and index inspection, guarded CRUD, transactions, and small-batch CSV/JSON import.
- MongoDB: Canonical Extended JSON, BSON-preserving document edits, filters, sort/projection, read-only aggregation, index management.
- Redis: SCAN-based Key explorer, String/Hash/List/Set/ZSet/Stream editing, TTL, String compare-and-set, guarded deletion and limited command console.
- Advanced connections: SSH password/key/Agent and up to three preceding jump hosts, verified SSH SHA-256 fingerprints, SOCKS5/HTTP CONNECT, TLS/mTLS, MongoDB replica sets and Redis Sentinel/Cluster.
- Desktop UI: multi-session workbench, Monaco editor, virtualized result grid, encrypted connection/query history, and explicit write confirmations.

### Downloads
Choose your system's installer from Release assets: **macOS ARM64 DMG/ZIP**, **Windows x64 EXE**, **Linux x64 AppImage/DEB**. Each platform has a `SHA256SUMS-*.txt` file.

**Unsigned development preview:** packages are not code-signed or notarized. Review your platform's security prompts. This release is not yet validated for production database administration. The Release is published only after all files are uploaded and the packaged app starts successfully on each platform.

### Notes and limitations
- New sessions default to read-only; edits require explicit confirmation. SQL is limited to one approved statement at a time.
- Maximum 500 records per import batch; exports use the currently loaded page, not the whole database.
- MongoDB multi-document insertion and Redis cross-key removal are not fully atomic. Investigate uncertain write results before retrying.
- MongoDB SRV DNS resolution happens on the local machine. MySQL TLS requires a DNS certificate identity; IP-only SAN certificates are not supported in this preview.
- Full install/uninstall and upgrade verification, long-running production topology tests, code signing and notarization remain future release gates.
- Current production dependency audit reports no known advisories; development build tools have pending moderate-severity advisories.

See [ROADMAP](docs/ROADMAP.md), [Connection guide](docs/CONNECTIONS.md) and [Security](SECURITY.md) for the detailed scope.
