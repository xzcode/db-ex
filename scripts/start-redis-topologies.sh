#!/usr/bin/env bash
# Isolated CI fixtures only: pass the existing redis:7 service container ID.
set -euo pipefail
if [[ $# != 1 || ! "$1" =~ ^[a-fA-F0-9]{12,64}$ ]]; then
  echo 'Usage: scripts/start-redis-topologies.sh <redis-service-container-id>' >&2
  exit 2
fi
if [[ "${GITHUB_ACTIONS:-}" != true && "${DB_EX_TOPOLOGY:-}" != 1 ]]; then
  echo 'This fixture requires GitHub Actions or explicit DB_EX_TOPOLOGY=1.' >&2
  exit 2
fi
container_id="$1"
container_image="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
case "$container_image" in
  redis:7|redis:7.*|redis:7@*) ;;
  *) echo 'Refusing to start fixtures outside the designated redis:7 service container.' >&2; exit 2 ;;
esac

timeout 90s docker exec -i "$container_id" sh -eu <<'CONTAINER_SCRIPT'
fixture_root=/tmp/dbex-redis-topologies
if [ -e "$fixture_root" ]; then
  echo 'Topology fixture directory already exists; use a fresh CI service container.' >&2
  exit 1
fi
for fixture_port in 7000 7001 7002 6380 6381 26379; do
  if timeout 2s redis-cli -h 127.0.0.1 -p "$fixture_port" ping >/dev/null 2>&1; then
    echo "Refusing to replace an existing Redis service on port $fixture_port." >&2
    exit 1
  fi
done
mkdir -p "$fixture_root"

print_fixture_logs() {
  for ready_log in "$@"; do
    if [ -f "$ready_log" ]; then
      printf 'Redis fixture log: %s\n' "$ready_log" >&2
      tail -n 60 "$ready_log" >&2
    fi
  done
}
wait_fixture_ready() {
  ready_port="$1"
  ready_log_path="$2"
  ready_deadline=$(( $(date +%s) + 10 ))
  while :; do
    if [ "$(timeout 2s redis-cli --raw -h 127.0.0.1 -p "$ready_port" ping 2>/dev/null || true)" = PONG ]; then
      return 0
    fi
    if [ "$(date +%s)" -ge "$ready_deadline" ]; then
      printf 'Redis fixture on port %s did not answer PING within 10 seconds.\n' "$ready_port" >&2
      print_fixture_logs "$ready_log_path"
      return 1
    fi
    sleep 0.25
  done
}

for fixture_port in 7000 7001 7002; do
  fixture_dir="$fixture_root/$fixture_port"
  mkdir -p "$fixture_dir"
  cat > "$fixture_dir/redis.conf" <<CONFIG
bind 0.0.0.0
protected-mode no
port $fixture_port
daemonize yes
pidfile $fixture_dir/redis.pid
logfile $fixture_dir/redis.log
dir $fixture_dir
save ""
appendonly no
cluster-enabled yes
cluster-config-file nodes.conf
cluster-node-timeout 3000
cluster-announce-ip 127.0.0.1
cluster-announce-port $fixture_port
cluster-announce-bus-port $((fixture_port + 10000))
CONFIG
  redis-server "$fixture_dir/redis.conf"
  wait_fixture_ready "$fixture_port" "$fixture_dir/redis.log"
done
if ! timeout 20s redis-cli --cluster create 127.0.0.1:7000 127.0.0.1:7001 127.0.0.1:7002 --cluster-replicas 0 --cluster-yes; then
  print_fixture_logs "$fixture_root/7000/redis.log" "$fixture_root/7001/redis.log" "$fixture_root/7002/redis.log"
  exit 1
fi

for fixture_port in 6380 6381; do
  fixture_dir="$fixture_root/$fixture_port"
  mkdir -p "$fixture_dir"
  cat > "$fixture_dir/redis.conf" <<CONFIG
bind 0.0.0.0
protected-mode no
port $fixture_port
daemonize yes
pidfile $fixture_dir/redis.pid
logfile $fixture_dir/redis.log
dir $fixture_dir
save ""
appendonly no
replica-announce-ip 127.0.0.1
replica-announce-port $fixture_port
CONFIG
  if [ "$fixture_port" = 6381 ]; then
    printf '%s\n' 'replicaof 127.0.0.1 6380' >> "$fixture_dir/redis.conf"
  fi
  redis-server "$fixture_dir/redis.conf"
  wait_fixture_ready "$fixture_port" "$fixture_dir/redis.log"
done

cat > "$fixture_root/sentinel.conf" <<CONFIG
bind 0.0.0.0
protected-mode no
port 26379
daemonize yes
pidfile $fixture_root/sentinel.pid
logfile $fixture_root/sentinel.log
dir $fixture_root
sentinel announce-ip 127.0.0.1
sentinel announce-port 26379
sentinel monitor dbex-primary 127.0.0.1 6380 1
sentinel down-after-milliseconds dbex-primary 1500
sentinel failover-timeout dbex-primary 15000
sentinel parallel-syncs dbex-primary 1
CONFIG
redis-server "$fixture_root/sentinel.conf" --sentinel
wait_fixture_ready 26379 "$fixture_root/sentinel.log"

# A bounded wait; replication must be ready before the failover test starts.
fixture_deadline=$(( $(date +%s) + 45 ))
while :; do
  if timeout 2s redis-cli -p 7000 cluster info | tr -d '\r' | grep -q '^cluster_state:ok$' &&
     timeout 2s redis-cli -p 6381 info replication | tr -d '\r' | grep -q '^master_link_status:up$' &&
     timeout 2s redis-cli -p 26379 sentinel replicas dbex-primary | grep -q '6381'; then
    break
  fi
  if [ "$(date +%s)" -ge "$fixture_deadline" ]; then
    echo 'Redis topology fixtures did not become ready within 45 seconds.' >&2
    print_fixture_logs "$fixture_root/7000/redis.log" "$fixture_root/7001/redis.log" "$fixture_root/7002/redis.log" "$fixture_root/6380/redis.log" "$fixture_root/6381/redis.log" "$fixture_root/sentinel.log"
    exit 1
  fi
  sleep 1
done
printf '%s\n' 'Redis topology fixtures ready: Cluster 7000/7001/7002; primary/replica 6380/6381; Sentinel 26379.'
CONTAINER_SCRIPT
