# Security policy

DB EX manages database credentials and can access sensitive production data. Do not commit credentials, private keys, TLS client keys, full connection URIs containing passwords, customer data or production dumps.

- Electron Renderer is sandboxed and has no database driver access.
- Stored connection settings must be encrypted with OS-backed Electron `safeStorage`. Refuse plaintext fallback.
- Verify SSH host keys and TLS certificates by default; do not add an insecure one-click bypass.
- Keep tunnel sockets bound to loopback only and close all channels when sessions end.
- Restrict database browsing to bounded result sets, and require explicit confirmation for mutation operations as they are implemented.

For suspected vulnerabilities, report privately to the repository owner instead of opening a public issue containing secrets.
