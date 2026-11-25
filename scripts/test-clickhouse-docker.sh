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
