# DB EX v0.5.1 — Multi-platform Preview

DB EX is a local-first desktop database manager for **MySQL, MongoDB and Redis**, supporting SSH jump hosts, network proxies, and TLS.

## Changes from v0.5.0
- **MongoDB connection fixes:** a single host/port without a replica-set name defaults to directConnection in Auto mode. Explicit replica discovery, multi-seed and replica-set topologies retain discovery.
- Better error diagnosis for MongoDB authentication/authSource, DNS, TLS, topology, timeouts, and older server versions. Connection testing includes an authenticated, read-only ping.
- URI/SRV-triggered TLS loads configured CA and client certificates. The connection form makes URI and seed precedence visible.
- **Approved application icon:** native PNG/ICNS/ICO are generated from a single SHA-256-pinned image, replacing the previously distorted geometric redraw.
- Native builds for macOS Apple Silicon, Windows x64, and Linux x64, each with packaged-app smoke tests.

## Downloads
- macOS Apple Silicon: `DB-EX-0.5.1-mac-arm64.dmg` or `.zip`
- Windows x64: `DB-EX-0.5.1-win-x64.exe`
- Linux x64: `DB-EX-0.5.1-linux-x86_64.AppImage` or `DB-EX-0.5.1-linux-amd64.deb`
- Separate `SHA256SUMS-<platform>.txt` for each platform.

**Preview release:** macOS is Ad-hoc signed but not Apple Developer ID notarized; browser-downloaded apps may require Gatekeeper user approval. Windows builds are not Authenticode signed. Do not treat these builds as independently security audited or approved for production database administration.

Previous v0.5.0, macOS RC1, MongoDB RC2 and approved-icon RC3 remain available as rollback options. Only packages verified on their native platform are published in this Release.
