#!/usr/bin/env bash
set -euo pipefail
fixture="$(mktemp -d /tmp/dbex-ch-fixture.XXXXXXXX)"
container="$(basename "$fixture" | tr '[:upper:].' '[:lower:]-')"
cleanup(){ docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf -- "$fixture"; }
trap cleanup EXIT
image="$(printenv DB_EX_TEST_CLICKHOUSE_IMAGE || echo clickhouse/clickhouse-server:25.8)"
password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("hex"))')"
cat > "$fixture/backups.xml" <<'XML'
<clickhouse>
 <storage_configuration><disks><dbex_backups><type>local</type><path>/var/lib/clickhouse/dbex_backups/</path></dbex_backups></disks></storage_configuration>
 <backups><allowed_disk>dbex_backups</allowed_disk></backups>
 <interserver_http_host>127.0.0.1</interserver_http_host>
 <keeper_server>
  <tcp_port>9181</tcp_port><server_id>1</server_id>
  <log_storage_path>/var/lib/clickhouse/keeper/log/</log_storage_path>
  <snapshot_storage_path>/var/lib/clickhouse/keeper/snapshots/</snapshot_storage_path>
  <raft_configuration><server><id>1</id><hostname>127.0.0.1</hostname><port>9234</port></server></raft_configuration>
 </keeper_server>
 <zookeeper><node><host>127.0.0.1</host><port>9181</port></node></zookeeper>
 <remote_servers><dbex_m10_cluster>
  <shard><replica><host>127.0.0.1</host><port>9000</port></replica></shard>
  <shard><replica><host>127.0.0.1</host><port>9000</port></replica></shard>
 </dbex_m10_cluster></remote_servers>
</clickhouse>
XML
chmod 644 "$fixture/backups.xml"
docker run -d --rm --name "$container" --ulimit nofile=262144:262144 -p 127.0.0.1::8123 \
 --mount "type=bind,src=$fixture/backups.xml,dst=/etc/clickhouse-server/config.d/dbex-backups.xml,readonly" \
 -e CLICKHOUSE_USER=dbex -e "CLICKHOUSE_PASSWORD=$password" -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
 "$image" >/dev/null
port="$(docker port "$container" 8123/tcp | awk -F: 'NR==1{print $NF}')"
[[ "$port" =~ ^[0-9]+$ ]]
ready=0
for i in $(seq 1 60); do
 if curl --fail --silent --max-time 2 -u "dbex:$password" "http://127.0.0.1:$port/" --data-binary 'SELECT 1' >/dev/null; then ready=1; break; fi
 sleep 1
done
[[ "$ready" == 1 ]] || { docker logs --tail 25 "$container"; exit 1; }
DBEX_CH_PORT="$port" DBEX_CH_PASSWORD="$password" node --import tsx scripts/test-clickhouse-integration.ts

DBEX_CH_PORT="$port" DBEX_CH_PASSWORD="$password" DBEX_CH_REPLICATION=1 node --import tsx scripts/test-clickhouse-m10-advanced.ts
