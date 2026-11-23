#!/usr/bin/env bash
# Creates an isolated three-member replica set inside the existing CI mongo:7
# service. The original standalone server on 27017 is never changed or stopped.
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo 'Usage: bash scripts/start-mongo-replica.sh <mongo-service-container-id>' >&2
  exit 2
fi

if [[ "${GITHUB_ACTIONS:-}" != true && "${DB_EX_TOPOLOGY:-}" != 1 ]]; then
  echo 'This fixture requires GitHub Actions or explicit DB_EX_TOPOLOGY=1.' >&2
  exit 2
fi
container_image="$(docker inspect --format '{{.Config.Image}}' "$1")"
case "$container_image" in
  mongo:7|mongo:7.*|mongo:7@*) ;;
  *) echo 'Refusing to start fixtures outside the designated mongo:7 service container.' >&2; exit 2 ;;
esac

timeout 100s docker exec -i "$1" bash -se <<'DBEX_REPLICA_SETUP'
set -euo pipefail
dbex_rs_root=/tmp/db-ex-replica-fixture
if [[ -e "$dbex_rs_root" ]]; then
  echo 'Replica fixture directory already exists; use a fresh test service container.' >&2
  exit 1
fi
mkdir -m 700 "$dbex_rs_root"
trap 'for dbex_port in 27018 27019 27020; do if [[ -f "$dbex_rs_root/$dbex_port/mongod.log" ]]; then tail -n 30 "$dbex_rs_root/$dbex_port/mongod.log"; fi; done' ERR

for dbex_port in 27018 27019 27020; do
  mkdir -m 700 "$dbex_rs_root/$dbex_port"
  mongod --port "$dbex_port" --bind_ip_all --replSet dbex-rs \
    --dbpath "$dbex_rs_root/$dbex_port" \
    --logpath "$dbex_rs_root/$dbex_port/mongod.log" \
    --pidfilepath "$dbex_rs_root/$dbex_port/mongod.pid" \
    --wiredTigerCacheSizeGB 0.25 --oplogSize 64 \
    --setParameter diagnosticDataCollectionEnabled=false \
    --setParameter disableSplitHorizonIPCheck=true --fork
done

mongosh --quiet 'mongodb://127.0.0.1:27018/admin?directConnection=true&serverSelectionTimeoutMS=5000' --file /dev/stdin <<'DBEX_INIT'
const config = {
  _id: 'dbex-rs',
  members: [
    { _id: 0, host: '127.0.0.1:27018' },
    { _id: 1, host: '127.0.0.1:27019' },
    { _id: 2, host: '127.0.0.1:27020' }
  ],
  settings: { electionTimeoutMillis: 2000, heartbeatIntervalMillis: 500 }
};
const initialized = db.adminCommand({ replSetInitiate: config });
if (initialized.ok !== 1) throw new Error('Replica fixture initialization failed');
const deadline = Date.now() + 45000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const status = db.adminCommand({ replSetGetStatus: 1 });
    ready = status.members.length === 3 &&
      status.members.filter(member => member.state === 1).length === 1 &&
      status.members.filter(member => member.state === 2).length === 2;
    if (ready) break;
  } catch (_) { /* Fresh members may still be starting or electing. */ }
  sleep(500);
}
if (!ready) throw new Error('Replica fixture did not reach one primary and two secondaries within 45 seconds');
print('DB EX MongoDB replica fixture ready: dbex-rs, ports 27018/27019/27020');
DBEX_INIT
DBEX_REPLICA_SETUP
