# DB EX v0.5.2 (Preview)

- Built-in AES-256-GCM encryption for local connections, query history and favorites. No user-supplied master password, key, or OS keychain required for new records.
- Export one or all saved connections into an encrypted, portable JSON backup, including database, SSH, proxy and Sentinel passwords and MongoDB URI. Import creates new entries without replacing existing connections.
- Legacy v1 redacted templates are still accepted. Existing local safeStorage records are migrated when the original system can decrypt them; unreadable records are preserved and do not block new connections.
- The bundled key is public; protect the files. Imported SSH host fingerprints are not trusted automatically; private-key and TLS certificate files are not embedded.
- macOS Apple Silicon preview remains ad-hoc signed, not notarized; see [MAC_INSTALL.md](MAC_INSTALL.md).
- Windows x64 and Linux x64 previews retain their native installer formats.
