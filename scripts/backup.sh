#!/usr/bin/env bash
set -euo pipefail

timestamp="${OSOD_BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
backup_dir="${OSOD_BACKUP_DIR:-/backup}"
postgres_url="${OSOD_POSTGRES_URL:-postgresql://medplum:medplum@127.0.0.1:5432/medplum}"
redis_host="${OSOD_REDIS_HOST:-127.0.0.1}"
redis_port="${OSOD_REDIS_PORT:-6379}"
redis_password="${OSOD_REDIS_PASSWORD:-medplum}"
binary_source="${OSOD_BINARY_SOURCE:-/data/binary}"

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
  if command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    docker compose "$@"
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

mkdir -p "$backup_dir"

postgres_path="$backup_dir/postgres-$timestamp"
redis_path="$backup_dir/redis-$timestamp.rdb"
binary_path="$backup_dir/binary-$timestamp"
manifest_path="$backup_dir/manifest-$timestamp.json"

echo "backup-started $timestamp"

pg_dump --jobs 4 --format=directory --file="$postgres_path" "$postgres_url"

lastsave_before="$(redis_cmd --raw LASTSAVE 2>/dev/null || echo 0)"
redis_cmd BGSAVE >/dev/null
for _ in $(seq 1 60); do
  lastsave_after="$(redis_cmd --raw LASTSAVE 2>/dev/null || echo 0)"
  if [[ "$lastsave_after" != "$lastsave_before" ]]; then
    break
  fi
  sleep 1
done

redis_dir="$(redis_cmd --raw CONFIG GET dir | tail -n 1)"
redis_dbfilename="$(redis_cmd --raw CONFIG GET dbfilename | tail -n 1)"
if [[ -f "$redis_dir/$redis_dbfilename" ]]; then
  rsync -a "$redis_dir/$redis_dbfilename" "$redis_path"
elif command -v docker-compose >/dev/null 2>&1 || command -v docker >/dev/null 2>&1; then
  compose cp "redis:$redis_dir/$redis_dbfilename" "$redis_path"
else
  echo "Unable to locate Redis dump.rdb at $redis_dir/$redis_dbfilename" >&2
  exit 1
fi

if [[ -d "$binary_source" ]]; then
  rsync -a "$binary_source"/ "$binary_path"/
elif (command -v docker-compose >/dev/null 2>&1 || command -v docker >/dev/null 2>&1) &&
  compose exec -T medplum-server test -d "$binary_source" >/dev/null 2>&1; then
  mkdir -p "$binary_path"
  compose cp "medplum-server:$binary_source/." "$binary_path"
else
  mkdir -p "$binary_path"
  echo "binary-source-missing $binary_source; wrote empty binary backup directory" >&2
fi

audit_snapshot="$(psql "$postgres_url" -Atc "SELECT json_build_object('count', count(*), 'latestEventTime', max(event_time), 'projectionQueueDrained', bool_and(audit_event_id IS NOT NULL))::text FROM osod_audit_events" 2>/dev/null || echo '{"count":0,"projectionQueueDrained":false}')"

postgres_hash="$(hash_path "$postgres_path")"
redis_hash="$(hash_path "$redis_path")"
binary_hash="$(hash_path "$binary_path")"

cat >"$manifest_path" <<JSON
{
  "timestamp": "$timestamp",
  "components": {
    "postgres": { "path": "$postgres_path", "sha256": "$postgres_hash" },
    "redis": { "path": "$redis_path", "sha256": "$redis_hash" },
    "binary": { "path": "$binary_path", "sha256": "$binary_hash" }
  },
  "auditSnapshot": $audit_snapshot
}
JSON

echo "backup-completed $manifest_path"
