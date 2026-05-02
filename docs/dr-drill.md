# OSOD v0.5b DR Drill Runbook

This drill is operator-driven. No OSOD MCP tool, autonomous agent, launchd job,
or unsupervised subagent may trigger backup, restore, or the destructive reset.
Per the CLAUDE.md scope clarification (performance-od, 2026-04-29) carried into
v0.55c Lesson #5 (amended 2026-05-02), Claude Code running interactively on the
operator's laptop with the operator at the keyboard MAY drive this drill — every
tool call is supervised and explicit `Bash(...)` permission rules in
`.claude/settings.local.json` paper-trail the authorization. The boundary
protects against unsupervised destructive operations, not against supervised
ones.

**Isolation warning:** This drill runs in an isolated compose context. The
primary `osod` compose project is NOT touched. Operators are responsible for
ensuring the drill compose context is the active context before running
destructive commands.

## Preconditions

- Docker Compose stack reachable in the isolated `osod-dr-drill` project.
- `pg_dump`, `pg_restore`, `psql`, `rsync`, `shasum`, Docker Compose v2, and `npx` available.
- `redis-cli` available on the host, or `docker compose exec` access to the `redis` service for the fallback path.
- Backup volume mounted and encrypted at rest by the operator.
- Human-provisioned env vars available where needed:
  - `OSOD_POSTGRES_URL`
  - `OSOD_REDIS_PASSWORD`
  - `OSOD_BACKUP_DIR`

## Commands

```bash
export OSOD_DR_COMPOSE="docker compose -p osod-dr-drill -f docker-compose.dr-drill.yml"
export MEDPLUM_BASE_URL="http://localhost:18103"
export OSOD_POSTGRES_URL="postgresql://medplum:medplum@127.0.0.1:15432/medplum"
export OSOD_REDIS_PORT="16379"
export OSOD_COMPOSE_PROJECT="osod-dr-drill"
export OSOD_COMPOSE_FILE="docker-compose.dr-drill.yml"
export MEDPLUM_ADMIN_EMAIL="${MEDPLUM_ADMIN_EMAIL:-drill-admin@osod.local}"
export MEDPLUM_ADMIN_PASSWORD="${MEDPLUM_ADMIN_PASSWORD:-Osod-dr-drill-Password-1!}"

$OSOD_DR_COMPOSE up -d
npx tsx scripts/seed-dr-drill.ts
MEDPLUM_BASE_URL="$MEDPLUM_BASE_URL" MEDPLUM_ADMIN_EMAIL="$MEDPLUM_ADMIN_EMAIL" MEDPLUM_ADMIN_PASSWORD="$MEDPLUM_ADMIN_PASSWORD" OSOD_BACKUP_DIR="$PWD/backup-dr-drill" scripts/backup.sh
$OSOD_DR_COMPOSE down -v
$OSOD_DR_COMPOSE up -d
MEDPLUM_BASE_URL="$MEDPLUM_BASE_URL" MEDPLUM_ADMIN_EMAIL="$MEDPLUM_ADMIN_EMAIL" MEDPLUM_ADMIN_PASSWORD="$MEDPLUM_ADMIN_PASSWORD" scripts/restore.sh "$PWD/backup-dr-drill/manifest-<timestamp>.json"
cd mcp && MEDPLUM_BASE_URL="http://localhost:18103" OSOD_POSTGRES_URL="postgresql://medplum:medplum@127.0.0.1:15432/medplum" node --import tsx --test --test-concurrency=1 tests/v05b-audit-ib-backup.test.ts ../tests/boundaries/mandate-8-auth-flow.test.ts
```

## Expected Output

- `backup-started <timestamp>`
- `backup-completed <backup-dir>/manifest-<timestamp>.json`
- `restore-started <backup-dir>/manifest-<timestamp>.json`
- Five integrity checks print `PASS`.
- `restore-completed <backup-dir>/manifest-<timestamp>.json`
- v0.5a Mandate 8 boundary tests pass.
- v0.5a enforcement boundary fixture passes when the human-provisioned
  Medplum credentials are present.
- v0.5b fixtures pass:
  - OCR-style query
  - denied-access `ib_exception=privacy`
  - audit UI CSV / JSON export model

## Integrity Suite

The restore script runs `scripts/verify-restore-integrity.ts`, which gates on:

1. `osod_audit_events` row count and latest event time.
2. `Provenance.signature` sample validity.
3. `Binary.securityContext` presence.
4. `AuditEvent` projection count against audit-row count.
5. AccessPolicy / ProjectMembership round-trip status.
