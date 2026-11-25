#!/usr/bin/env bash
# Each invocation creates exactly one disposable, loopback-only server.
# Never uses saved connection credentials or host database instances.
set -euo pipefail
kind="${1:?engine required}"
image="${2:?image required}"
case "$kind:$image" in
 mysql:mysql:*|mariadb:mariadb:*|mongodb:mongo:*|redis:redis:*|clickhouse:clickhouse/clickhouse-server:*) ;;
 *) echo 'Invalid matrix engine/image'; exit 2 ;;
esac
fixture="$(mktemp -d /tmp/dbex-m11-engine.XXXXXXXX)"
container="$(basename "$fixture" | tr '[:upper:].' '[:lower:]-')"
cleanup(){ docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf -- "$fixture"; }
trap cleanup EXIT
mkdir "$fixture/tls" "$fixture/bin"
bash scripts/m11-generate-tls.sh "$fixture/tls"
password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
certs=(--mount "type=bind,src=$fixture/tls,dst=/dbex-tls,readonly")
case "$kind" in
 mysql|mariadb)
  port=3306
  if [[ "$kind" == mysql ]]; then prefix=MYSQL; tool=mysql; dump=mysqldump; else prefix=MARIADB; tool=mariadb; dump=mariadb-dump; fi
  docker run -d --name "$container" -p "127.0.0.1::$port" "${certs[@]}" \
   -e "${prefix}_ROOT_PASSWORD=$password" -e "${prefix}_ROOT_HOST=%" "$image" \
   --innodb-buffer-pool-size=96M --max-connections=24 --ssl-ca=/dbex-tls/ca.pem --ssl-cert=/dbex-tls/server.pem --ssl-key=/dbex-tls/server.key --require-secure-transport=ON >/dev/null
  ready=0
  for i in $(seq 1 90); do
   if docker exec "$container" "$tool" -uroot "-p$password" -Nse 'SELECT 1' >/dev/null 2>&1; then ready=1; break; fi
   sleep 1
  done
  [[ "$ready" == 1 ]] || { docker logs --tail 15 "$container"; exit 1; }
  docker exec "$container" "$tool" -uroot "-p$password" -Nse 'SELECT VERSION()'
  # Require the client certificate as well as password on TCP sessions.
  docker exec "$container" "$tool" -uroot "-p$password" -e "ALTER USER 'root'@'%' REQUIRE X509"
  tools=("$tool" "$dump")
  ;;
 mongodb)
  port=27017
  # Start with authorization and requireTLS. Create the first admin using
  # MongoDB's localhost exception in this newly created container only.
  docker run -d --name "$container" -p "127.0.0.1::$port" "${certs[@]}" --entrypoint mongod "$image" \
   --bind_ip_all --auth --wiredTigerCacheSizeGB 0.25 --tlsMode requireTLS --tlsCertificateKeyFile /dbex-tls/server-combined.pem --tlsCAFile /dbex-tls/ca.pem >/dev/null
  mongo=(mongosh --quiet --host localhost --tls --tlsCAFile /dbex-tls/ca.pem --tlsCertificateKeyFile /dbex-tls/client-combined.pem)
  ready=0
  for i in $(seq 1 90); do
   if docker exec "$container" "${mongo[@]}" --eval 'db.adminCommand({ping:1})' >/dev/null 2>&1; then ready=1; break; fi
   sleep 1
  done
  [[ "$ready" == 1 ]] || { docker logs --tail 15 "$container"; exit 1; }
  docker exec "$container" "${mongo[@]}" admin --eval "db.createUser({user:'dbex',pwd:'$password',roles:['root']})" >/dev/null
  docker exec "$container" "${mongo[@]}" -u dbex -p "$password" --authenticationDatabase admin --eval 'db.version()'
  tools=(mongodump mongorestore mongoexport mongoimport)
  ;;
 redis)
  port=6379
  docker run -d --name "$container" -p "127.0.0.1::$port" "${certs[@]}" "$image" \
   redis-server --port 0 --tls-port "$port" --tls-cert-file /dbex-tls/server.pem --tls-key-file /dbex-tls/server.key --tls-ca-cert-file /dbex-tls/ca.pem --tls-auth-clients yes --requirepass "$password" --save '' --appendonly no >/dev/null
  redis=(redis-cli --tls --cacert /dbex-tls/ca.pem --cert /dbex-tls/client.pem --key /dbex-tls/client.key)
  ready=0
  for i in $(seq 1 45); do
   if docker exec -e "REDISCLI_AUTH=$password" "$container" "${redis[@]}" ping 2>/dev/null | grep -qx PONG; then ready=1; break; fi
   sleep 1
  done
  [[ "$ready" == 1 ]] || { docker logs --tail 15 "$container"; exit 1; }
  docker exec -e "REDISCLI_AUTH=$password" "$container" "${redis[@]}" INFO server | grep '^redis_version:'
  tools=()
  ;;
 clickhouse)
  port=8443
  cat > "$fixture/https.xml" <<'XML'
<clickhouse>
 <https_port>8443</https_port>
 <openSSL>
  <server>
   <certificateFile>/dbex-tls/server.pem</certificateFile>
   <privateKeyFile>/dbex-tls/server.key</privateKeyFile>
   <caConfig>/dbex-tls/ca.pem</caConfig>
   <verificationMode>strict</verificationMode>
   <loadDefaultCAFile>false</loadDefaultCAFile>
   <disableProtocols>sslv2,sslv3,tlsv1,tlsv1_1</disableProtocols>
  </server>
 </openSSL>
 <background_schedule_pool_size>16</background_schedule_pool_size>
 <background_buffer_flush_schedule_pool_size>4</background_buffer_flush_schedule_pool_size>
 <background_message_broker_schedule_pool_size>4</background_message_broker_schedule_pool_size>
 <background_distributed_schedule_pool_size>4</background_distributed_schedule_pool_size>
</clickhouse>
XML
  chmod 644 "$fixture/https.xml"
  docker run -d --name "$container" --ulimit nofile=262144:262144 -p "127.0.0.1::$port" "${certs[@]}" \
   --mount "type=bind,src=$fixture/https.xml,dst=/etc/clickhouse-server/config.d/dbex-https.xml,readonly" \
   -e CLICKHOUSE_USER=dbex -e "CLICKHOUSE_PASSWORD=$password" -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 "$image" >/dev/null
  tools=()
  ;;
esac
actual="$(docker port "$container" "$port/tcp" | awk -F: 'NR==1{print $NF}')"
[[ "$actual" =~ ^[0-9]+$ ]]
if [[ "$kind" == clickhouse ]]; then
  ready=0
  for i in $(seq 1 90); do
   if curl --fail --silent --max-time 3 --cacert "$fixture/tls/ca.pem" --cert "$fixture/tls/client.pem" --key "$fixture/tls/client.key" -u "dbex:$password" "https://127.0.0.1:$actual/" --data-binary 'SELECT version()'; then ready=1; break; fi
   sleep 1
  done
  [[ "$ready" == 1 ]] || { docker logs --tail 15 "$container"; exit 1; }
  curl --fail --silent --max-time 10 --cacert "$fixture/tls/ca.pem" --cert "$fixture/tls/client.pem" --key "$fixture/tls/client.key" -u "dbex:$password" "https://127.0.0.1:$actual/" --data-binary 'CREATE DATABASE dbex_m11'
fi
# Native clients use the matching server-version image and the same host
# network. Credentials and temporary input files stay in the private fixture.
export DBEX_M11_FIXTURE="$fixture" DBEX_M11_IMAGE="$image"
for tool in "${tools[@]}"; do
 cat > "$fixture/bin/$tool" <<'WRAPPER'
#!/bin/sh
set -eu
tool="$(basename "$0")"
exec docker run --rm -i --network host --mount "type=bind,src=$DBEX_M11_FIXTURE,dst=$DBEX_M11_FIXTURE,readonly" --entrypoint "$tool" "$DBEX_M11_IMAGE" "$@"
WRAPPER
 chmod 700 "$fixture/bin/$tool"
done
TMPDIR="$fixture" DBEX_M11_ENGINE="$kind" DBEX_M11_PORT="$actual" DBEX_M11_PASSWORD="$password" \
 DBEX_M11_TLS_DIR="$fixture/tls" DBEX_M11_NATIVE_BIN="$fixture/bin" node --import tsx scripts/test-m11-engine.ts
