#!/usr/bin/env bash
set -euo pipefail

manifest_path="${1:-}"
if [[ -z "$manifest_path" ]]; then
  echo "Usage: scripts/restore.sh /backup/manifest-{timestamp}.json" >&2
  exit 2
fi

postgres_url="${OSOD_POSTGRES_URL:-postgresql://medplum:medplum@127.0.0.1:5432/medplum}"
redis_host="${OSOD_REDIS_HOST:-127.0.0.1}"
redis_port="${OSOD_REDIS_PORT:-6379}"
redis_password="${OSOD_REDIS_PASSWORD:-medplum}"
binary_target="${OSOD_BINARY_TARGET:-/data/binary}"

record_event() {
  npx tsx scripts/record-audit-event.ts "$1" "${2:-}"
}

redis_cmd() {
  if [[ -n "${OSOD_REDIS_CLI:-}" ]]; then
    "$OSOD_REDIS_CLI" -h "$redis_host" -p "$redis_port" -a "$redis_password" "$@"
  elif command -v redis-cli >/dev/null 2>&1; then
    redis-cli -h "$redis_host" -p "$redis_port" -a "$redis_password" "$@"
  else
    compose exec -T redis redis-cli -a "$redis_password" "$@"
  fi
}

compose() {
  local compose_args=()
  if [[ -n "${OSOD_COMPOSE_PROJECT:-}" ]]; then
    compose_args+=("-p" "$OSOD_COMPOSE_PROJECT")
  fi
  if [[ -n "${OSOD_COMPOSE_FILE:-}" ]]; then
    compose_args+=("-f" "$OSOD_COMPOSE_FILE")
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    docker-compose "${compose_args[@]}" "$@"
  else
    docker compose "${compose_args[@]}" "$@"
  fi
}

hash_path() {
  local path="$1"
  if [[ -d "$path" ]]; then
    find "$path" -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}'
  else
    shasum -a 256 "$path" | awk '{print $1}'
  fi
}

wait_for_medplum() {
  local base_url="${MEDPLUM_BASE_URL:-http://localhost:8103}"
  for _ in $(seq 1 90); do
    if node -e "fetch('${base_url%/}/healthcheck').then(r=>process.exit(r.status < 500 ? 0 : 1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "Timed out waiting for Medplum at $base_url" >&2
  exit 1
}

verify_hash() {
  local path="$1"
  local expected="$2"
  local actual
  actual="$(hash_path "$path")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Hash mismatch for $path: expected $expected got $actual" >&2
    exit 1
  fi
}

postgres_path="$(node -e "const m=require('$manifest_path'); console.log(m.components.postgres.path)")"
redis_path="$(node -e "const m=require('$manifest_path'); console.log(m.components.redis.path)")"
binary_path="$(node -e "const m=require('$manifest_path'); console.log(m.components.binary.path)")"

verify_hash "$postgres_path" "$(node -e "const m=require('$manifest_path'); console.log(m.components.postgres.sha256)")"
verify_hash "$redis_path" "$(node -e "const m=require('$manifest_path'); console.log(m.components.redis.sha256)")"
verify_hash "$binary_path" "$(node -e "const m=require('$manifest_path'); console.log(m.components.binary.sha256)")"

echo "restore-started $manifest_path"
compose stop medplum-app medplum-server || true

pg_restore --jobs 4 --clean --if-exists --dbname="$postgres_url" "$postgres_path"

redis_cmd SHUTDOWN NOSAVE >/dev/null 2>&1 || true
compose start redis
sleep 3
redis_dir="$(redis_cmd --raw CONFIG GET dir | tail -n 1)"
redis_dbfilename="$(redis_cmd --raw CONFIG GET dbfilename | tail -n 1)"
if [[ -d "$redis_dir" ]]; then
  rsync -a "$redis_path" "$redis_dir/$redis_dbfilename"
else
  compose cp "$redis_path" "redis:$redis_dir/$redis_dbfilename"
fi
compose restart redis

if [[ -d "$binary_target" ]]; then
  rsync -a --delete "$binary_path"/ "$binary_target"/
else
  compose cp "$binary_path/." "medplum-server:$binary_target"
fi

compose start medplum-server medplum-app
wait_for_medplum
record_event "restore-started" "restore-started $manifest_path"
npx tsx scripts/verify-restore-integrity.ts "$manifest_path"
record_event "restore-completed" "restore-completed $manifest_path"
echo "restore-completed $manifest_path"
