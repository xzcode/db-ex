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

## M11 implementation and local evidence (2026-11-25)

Release v0.7.1 was successfully published from master 7993cc4 (publisher run 45664317850, eight verified assets). M11 is an independent branch and must not replace that release.

| Workstream | Implementation and verified local evidence | Remaining gate |
|---|---|---|
| M11.1 Versions | Independent CI matrix for MySQL 8.0/8.4, MariaDB 10.6/11.8, MongoDB 7/8.0, Redis 7.4/8.2, ClickHouse 24.8/25.8; SQLite embedded worker. Local isolated MariaDB 10.11.14, MongoDB 8.0.12, Redis 7.0.15, ClickHouse 25.8.33.6 and SQLite 3.53.4 tested. | Exact new matrix results; MySQL local setup not completed. |
| M11.2 Connections | Authenticated SOCKS -> verified SSH -> database TLS/mTLS with valid and invalid CA, hostname, password and SSH fingerprint checks. Fixed MongoDB v6 rejecting the unsupported minVersion option by using an explicit Node secure context with TLS 1.2 minimum; case-insensitive TLS URI flags. | Exact matrix for additional server versions; MySQL-family external tool tunnel + TLS remains unsupported (fail closed). |
| M11.3 Topology | Two isolated ClickHouse containers, shared Keeper, distinct shard endpoints, replicated data, cross-shard query and replica stop/start catch-up test implemented. Existing MongoDB/Redis topology CI stays mandatory. | Actual Docker two-node execution. Local dual-process attempt did not become ready under the development environment; stopped both fixtures. |
| M11.4 Data volume | Real SQLite 50,000 rows / 29,335,552 bytes: seed 200 ms, page of 500 at offset 49,000 in 29 ms, backup 86 ms. Real ClickHouse 25,000 rows, JSONL 13,901,676 bytes, Parquet 142,010 bytes, import 622 ms/export 212 ms on repeated-value fixture; exact UInt64/Decimal/NULL aggregates after import/export. | These are isolated local measurements, not general throughput guarantees; larger and less compressible workloads remain out of scope. |
| M11.5 Native tools | Real MariaDB native CLI commits/rollbacks and verified direct TLS dump; real MongoDB 8.0.12 + tools 100.13.0 archive backup/restore and canonical EJSON through SSH/SOCKS/mTLS. | Additional matrix server versions and MySQL CLI/TLS. |
| M11.6 Reliability | Shared fsync + no-clobber atomic file publication for native tools, SQLite backups and ClickHouse; explicit unsupported filesystem errors. Real SQLite concurrent WAL session sees committed rows only, cancel rolls back uncommitted insert. Native CLI cleanup and connection removal corrected. | Native OS filesystem coverage. FAT/exFAT or unsupported hard-link filesystems fail closed; choose another filesystem. |
| M11.7 Workspace | Failed initial connection preserves workspace, manual retry restores position; cross-window language/theme updates; localized atomic-output errors. Four focused UI cases passed including failed/retried startup and RTL/light theme. | Full candidate UI and native restart regression. |
| M11.8 Upgrade | Actual old public v0.7.0 DEB checksum verified; extracted old/new DEB into same private prefix, launched both Electron binaries using one isolated user profile, preserved encrypted profile metadata, query, draft, preferences and SQLite data; removed installation, preserved profile/database. macOS DMG copy and Windows NSIS silent install/upgrade/uninstall scripts added. | Real macOS and Windows upgrade jobs; Linux DEB extraction does not claim package-manager registration or maintainer-script execution. |

Local final checks: 151 tests passed, zero failures, 8 environment-dependent skips; application and M11 script TypeScript checks passed, production build passed, 4 focused browser cases passed, Linux DEB upgrade passed. All fixtures are synthetic and isolated; no saved user connection or business database was accessed.

CI workflow: .github/workflows/m11-compatibility.yml. It runs the additional version/TLS matrix, ClickHouse cluster recovery, SQLite file workload and native upgrade matrix for the M11 PR. Existing Verify DB EX and macOS signing/smoke gates remain unchanged. Do not release a stable v1.0.0 until all applicable gates are green and explicitly documented limitations are accepted.

## First full M11 matrix — 2026-11-26

The YAML job conditions were corrected in e3e4218. [M11 run 45746335623](https://github.com/xzcode/db-ex/actions/runs/45746335623) executed all 15 jobs: 13 passed and 2 failed. All three native installation/upgrade jobs passed, as did SQLite and the version/TLS matrix for MySQL 8.4, MariaDB 10.6/11.8, MongoDB 7/8.0, Redis 7.4/8.2, and ClickHouse 24.8/25.8. MySQL 8.0 authenticated SOCKS/SSH/mTLS and negative credential/certificate tests passed, but native CLI startup failed. The ClickHouse two-node test passed actual Keeper replication and cross-shard queries before failing at the post-restart catch-up check.

Follow-up:
- MySQL 8.0.46 local binaries confirmed the newer `--no-login-paths` flag is unsupported. Use the documented `MYSQL_TEST_LOGIN_FILE` setting, pointed at a nonexistent file inside the unique private credential directory, and remove inherited client override environment variables. Keep explicit TLS identity verification, shell-free launch and private credentials unchanged. Real local 8.0.46 mysql and mysqldump accepted the revised options and ignored a separately generated synthetic login-path file. CI wrappers now forward the isolated login-path setting. Reference: https://dev.mysql.com/doc/refman/8.0/en/option-files.html and https://dev.mysql.com/doc/refman/8.4/en/option-files.html.
- ClickHouse restart acceptance now assigns explicit distinct loopback host port mappings before container creation and confirms the binding after restart. It checks authenticated HTTP readiness before querying through the original DB EX session, with bounded labeled polling and container state/log diagnostics on failure. A changed ephemeral port is a possible cause of the initial post-restart ECONNRESET; the previous logs do not establish the exact cause. No recovery assertion has been removed.
- 11 focused local regressions passed, application and M11 script typechecks passed, shell syntax validated. Exact candidate CI must confirm both fixes before declaring M11 complete.
