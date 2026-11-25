# M11 — six-engine compatibility and native release acceptance

## Evidence

Baseline integrated verification, exact candidate commit `078b1605caa35767d5d9fcacf707883964ee65c3`: [Verify DB EX](https://github.com/xzcode/db-ex/actions/runs/45634231191), integration job [139275255640](https://github.com/xzcode/db-ex/actions/runs/45634231191/job/139275255640).

- 168 tests passed, 0 failed; 46 Playwright UI cases passed.
- All three installer builds completed; native startup smoke failed. Linux/macOS failed because the test tried to find a window using a property that Electron does not guarantee in getLastWebPreferences. Windows timed out with an empty renderer root. These results are not a passing release gate.
- Corrected native smoke uses Playwright's actual BrowserWindow handle. It also records startup console, renderer crash, request failures and DOM/bridge state; preserves a screenshot on failure. Local Linux built and packaged (linux-unpacked) Electron applications passed, including a real two-window quit/restart, independent SQLite connections and encrypted drafts, and no restored write access.

| Engine | Verified baseline / environment | Verified representative behavior | Not yet asserted |
|---|---|---|---|
| MySQL | 8.4 CI service; 8.4.13 earlier isolated test | Parameterized SQL, row edits, transactions, conflict checks, native backup/restore, routed backup | More server releases/auth plugins; native CLI full real engine acceptance; tunnel + database TLS for native tools |
| MariaDB | 10.11.19 and 11.4.13, real isolated CI via authenticated SOCKS | Sequence inspection/restart, temporal history, partitions, precise values, batch edits, rollback, native backup/restore | 10.6/11.8 and broader TLS/authentication compatibility |
| MongoDB | 7 CI service and authenticated native tools; 8.3.13 earlier isolated test | BSON precision, guarded document edits, query/aggregation, replica-set topology, native backup/restore, canonical EJSON, routed backup | Native-tool MongoDB TLS workload across tunnels; wider versions and deployment variants |
| Redis | 7 CI service | Data types, TTL, guarded commands, topology/Sentinel/Cluster integration | Wider Redis releases/modules, additional auth and failover deployments |
| SQLite | Embedded Node SQLite plus sqlite3 3.45.1 local CLI | File operations, isolated process cancellation, atomic editing and rollback, real CLI commit/rollback; actual native multi-window restart locally | Larger datasets and broader OS/filesystem coverage |
| ClickHouse | 25.8.33.6, isolated server | Exact numeric/BSON-independent analytical data, partitions, guarded mutations, cancellation, three streaming formats, backup/restore, lightweight mutations, configured cluster reports, Keeper-backed replication between two identities | Actual multi-host cluster, more releases, HTTPS/mTLS and cancellation behavior on varied servers |

## Release gate

New version candidate is **v0.7.1 Preview**, not a replacement of the published v0.7.0 tag. The above baseline integration evidence is historical; the exact new release commit must pass all CI gates. In addition to type checking, security, integration and UI, the native smoke runs actual quit/restart with two windows, confirms correct recovery identity and checks session isolation.

No compatibility result is inferred from a mock, an installer build alone, or a planned test. macOS ARM64, Windows x64 and Linux x64 must pass native packaged execution and package checksums on the candidate. Publication requires an authorized v0.7.1 release workflow or an authorized manual publisher. The workflow draft is not committed because the ref update carrying it was not accepted. No existing release tag or assets are changed.
