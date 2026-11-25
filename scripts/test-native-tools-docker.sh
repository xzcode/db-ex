#!/usr/bin/env bash
# Real backup/restore against throwaway databases, never against saved profiles.
set -euo pipefail
fixture="$(mktemp -d /tmp/dbex-native-fixture.XXXXXXXX)"
suffix="$(basename "$fixture" | tr '[:upper:].' '[:lower:]-')"
mysql_name="$suffix-mysql"
mongo_name="$suffix-mongo"
cleanup() {
  docker rm -f "$mysql_name" "$mongo_name" >/dev/null 2>&1 || true
  rm -rf -- "$fixture"
}
trap cleanup EXIT
mysql_image="$(printenv DB_EX_TEST_MYSQL_IMAGE || echo mysql:8.4)"
mongo_image="$(printenv DB_EX_TEST_MONGO_IMAGE || echo mongo:8)"
mysql_pw='dbex-native-fixture'
mongo_user='dbex_native'
mongo_pw='dbex:native@fixture'
docker run -d --rm --name "$mysql_name" -p 127.0.0.1::3306 \
  -e "MYSQL_ROOT_PASSWORD=$mysql_pw" -e 'MYSQL_ROOT_HOST=%' "$mysql_image" \
  --innodb-buffer-pool-size=128M --max-connections=20 >/dev/null
docker run -d --rm --name "$mongo_name" -p 127.0.0.1::27017 \
  -e "MONGO_INITDB_ROOT_USERNAME=$mongo_user" -e "MONGO_INITDB_ROOT_PASSWORD=$mongo_pw" \
  "$mongo_image" --wiredTigerCacheSizeGB 0.25 >/dev/null
mysql_port="$(docker port "$mysql_name" 3306/tcp | awk -F: 'NR==1{print $NF}')"
mongo_port="$(docker port "$mongo_name" 27017/tcp | awk -F: 'NR==1{print $NF}')"
[[ "$mysql_port" =~ ^[0-9]+$ && "$mongo_port" =~ ^[0-9]+$ ]]
mysql_ready=0
mongo_ready=0
for i in $(seq 1 90); do
  if docker exec "$mysql_name" mysql -h 127.0.0.1 -uroot "-p$mysql_pw" -Nse 'SELECT 1' >/dev/null 2>&1; then mysql_ready=1; fi
  if docker exec "$mongo_name" mongosh --quiet -u "$mongo_user" -p "$mongo_pw" --authenticationDatabase admin --eval 'db.adminCommand({ping:1})' >/dev/null 2>&1; then mongo_ready=1; fi
  if [[ "$mysql_ready" = 1 && "$mongo_ready" = 1 ]]; then break; fi
  sleep 1
done
[[ "$mysql_ready" = 1 && "$mongo_ready" = 1 ]] || { echo 'Isolated database readiness failed'; exit 1; }
mkdir "$fixture/bin"
export DBEX_NATIVE_FIXTURE="$fixture" DBEX_TEST_MYSQL_IMAGE="$mysql_image" DBEX_TEST_MONGO_IMAGE="$mongo_image"
for tool in mysql mysqldump mongodump mongorestore mongoexport mongoimport; do
  cat > "$fixture/bin/$tool" <<'WRAPPER'
#!/bin/sh
set -eu
tool="$(basename "$0")"
case "$tool" in
  mysql|mysqldump) image="$DBEX_TEST_MYSQL_IMAGE";;
  *) image="$DBEX_TEST_MONGO_IMAGE";;
esac
exec docker run --rm -i --network host --mount "type=bind,src=$DBEX_NATIVE_FIXTURE,dst=$DBEX_NATIVE_FIXTURE,readonly" --entrypoint "$tool" "$image" "$@"
WRAPPER
  chmod 700 "$fixture/bin/$tool"
done
TMPDIR="$fixture" DBEX_NATIVE_MYSQL_PORT="$mysql_port" DBEX_NATIVE_MONGO_PORT="$mongo_port" \
 DBEX_NATIVE_MYSQL_PASSWORD="$mysql_pw" DBEX_NATIVE_MONGO_USER="$mongo_user" DBEX_NATIVE_MONGO_PASSWORD="$mongo_pw" \
 node --import tsx scripts/test-native-tools-integration.ts
