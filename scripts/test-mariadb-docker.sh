#!/usr/bin/env bash
set -euo pipefail
# Only disposable loopback fixtures; never connect to a user's saved server.
fixture="$(mktemp -d /tmp/dbex-maria-fixture.XXXXXXXX)"
container="$(basename "$fixture" | tr '[:upper:].' '[:lower:]-')"
cleanup(){ docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf -- "$fixture"; }
trap cleanup EXIT
image="$(printenv DB_EX_TEST_MARIADB_IMAGE || echo mariadb:11.4)"
password='dbex-maria-isolated-fixture'
docker run -d --rm --name "$container" -p 127.0.0.1::3306 \
 -e "MARIADB_ROOT_PASSWORD=$password" -e 'MARIADB_ROOT_HOST=%' "$image" \
 --innodb-buffer-pool-size=96M --max-connections=20 >/dev/null
port="$(docker port "$container" 3306/tcp | awk -F: 'NR==1{print $NF}')"
[[ "$port" =~ ^[0-9]+$ ]]
ready=0
for i in $(seq 1 75); do
 if docker exec "$container" mariadb -h 127.0.0.1 -uroot "-p$password" -Nse 'SELECT 1' >/dev/null 2>&1; then ready=1; break; fi
 sleep 1
done
[[ "$ready" == 1 ]] || { echo 'MariaDB fixture did not become ready'; exit 1; }
mkdir "$fixture/bin"
export DBEX_MARIA_FIXTURE="$fixture" DBEX_MARIA_IMAGE="$image"
for tool in mariadb mariadb-dump; do
 cat > "$fixture/bin/$tool" <<'WRAPPER'
#!/bin/sh
set -eu
tool="$(basename "$0")"
exec docker run --rm -i --network host --mount "type=bind,src=$DBEX_MARIA_FIXTURE,dst=$DBEX_MARIA_FIXTURE,readonly" --entrypoint "$tool" "$DBEX_MARIA_IMAGE" "$@"
WRAPPER
 chmod 700 "$fixture/bin/$tool"
done
TMPDIR="$fixture" DBEX_MARIA_PORT="$port" DBEX_MARIA_PASSWORD="$password" node --import tsx scripts/test-mariadb-integration.ts
