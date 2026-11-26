#!/usr/bin/env bash
set -euo pipefail
fixture="$(mktemp -d /tmp/dbex-m11-cluster.XXXXXXXX)"
name="$(basename "$fixture" | tr '[:upper:].' '[:lower:]-')"
a="$name-a"; b="$name-b"; network="$name-net"
cleanup(){
 local status=$?
 if [[ "$status" != 0 ]]; then
   for node in "$a" "$b"; do
     docker inspect --format 'node={{.Name}} state={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' "$node" 2>/dev/null || true
     docker port "$node" 8123/tcp 2>/dev/null || true
     # Redact the fixture-only password if an engine diagnostic echoes it.
     docker logs --tail 45 "$node" 2>&1 | sed "s/$password/[redacted]/g" || true
     docker exec "$node" sh -c 'tail -n 30 /var/log/clickhouse-server/clickhouse-server.err.log' 2>/dev/null | sed "s/$password/[redacted]/g" || true
   done
 fi
 docker rm -f "$a" "$b" >/dev/null 2>&1 || true
 docker network rm "$network" >/dev/null 2>&1 || true
 rm -rf -- "$fixture"
}
image='clickhouse/clickhouse-server:25.8'
password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
trap cleanup EXIT
# Distinct host ports allocated once, then explicitly published by Docker.
# Random Docker port mappings may change when a stopped container restarts.
read -r port_a port_b < <(python3 - <<'PORTS'
import socket
sockets=[socket.socket() for _ in range(2)]
try:
    for s in sockets: s.bind(('127.0.0.1',0))
    print(*(s.getsockname()[1] for s in sockets))
finally:
    for s in sockets: s.close()
PORTS
)
docker network create "$network" >/dev/null
for node in "$a" "$b"; do
 cat > "$fixture/$node.xml" <<XML
<clickhouse>
 <interserver_http_host>$node</interserver_http_host>
 <zookeeper><node><host>$a</host><port>9181</port></node></zookeeper>
 <background_schedule_pool_size>16</background_schedule_pool_size>
 <background_buffer_flush_schedule_pool_size>4</background_buffer_flush_schedule_pool_size>
 <background_message_broker_schedule_pool_size>4</background_message_broker_schedule_pool_size>
 <background_distributed_schedule_pool_size>4</background_distributed_schedule_pool_size>
 <remote_servers><dbex_m11_shards>
  <shard><replica><host>$a</host><port>9000</port><user>dbex</user><password>$password</password></replica></shard>
  <shard><replica><host>$b</host><port>9000</port><user>dbex</user><password>$password</password></replica></shard>
 </dbex_m11_shards></remote_servers>
</clickhouse>
XML
 if [[ "$node" == "$a" ]]; then
  python3 - "$fixture/$node.xml" "$a" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]);host=sys.argv[2]
s=p.read_text().replace('</clickhouse>',f'''<keeper_server>
<tcp_port>9181</tcp_port><server_id>1</server_id>
<log_storage_path>/var/lib/clickhouse/keeper/log/</log_storage_path>
<snapshot_storage_path>/var/lib/clickhouse/keeper/snapshots/</snapshot_storage_path>
<raft_configuration><server><id>1</id><hostname>{host}</hostname><port>9234</port></server></raft_configuration>
</keeper_server></clickhouse>''')
p.write_text(s)
PY
 fi
 chmod 644 "$fixture/$node.xml"
 if [[ "$node" == "$a" ]]; then port="$port_a"; else port="$port_b"; fi
 docker run -d --name "$node" --hostname "$node" --network "$network" --ulimit nofile=262144:262144 -p "127.0.0.1:$port:8123" \
  --mount "type=bind,src=$fixture/$node.xml,dst=/etc/clickhouse-server/config.d/m11.xml,readonly" \
  -e CLICKHOUSE_USER=dbex -e "CLICKHOUSE_PASSWORD=$password" -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 "$image" >/dev/null
done
[[ "$(docker port "$a" 8123/tcp)" == "127.0.0.1:$port_a" ]]
[[ "$(docker port "$b" 8123/tcp)" == "127.0.0.1:$port_b" ]]
for port in "$port_a" "$port_b"; do
 ready=0
 for i in $(seq 1 90); do
  if curl -fsS --max-time 2 -u "dbex:$password" "http://127.0.0.1:$port/" --data-binary 'SELECT 1' >/dev/null; then ready=1; break; fi
  sleep 1
 done
 [[ "$ready" == 1 ]]
done
DBEX_M11_CH_PORT_A="$port_a" DBEX_M11_CH_PORT_B="$port_b" DBEX_M11_CH_PASSWORD="$password" DBEX_M11_CH_CONTAINER_B="$b" node --import tsx scripts/test-m11-clickhouse-cluster.ts
