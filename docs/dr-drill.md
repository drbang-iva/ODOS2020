# ODOS v0.5b DR Drill Runbook

This drill is operator-driven. No ODOS MCP tool, autonomous agent, launchd job,
or unsupervised subagent may trigger backup, restore, or the destructive reset.
Per the CLAUDE.md scope clarification (performance-od, 2026-04-29) carried into
v0.55c Lesson #5 (amended 2026-05-02), Claude Code running interactively on the
operator's laptop with the operator at the keyboard MAY drive this drill — every
tool call is supervised and explicit `Bash(...)` permission rules in
`.claude/settings.local.json` paper-trail the authorization. The boundary
protects against unsupervised destructive operations, not against supervised
ones.

**Isolation warning:** This drill runs in an isolated compose context. The
primary `odos` compose project is NOT touched. Operators are responsible for
ensuring the drill compose context is the active context before running
destructive commands.

## Preconditions

- Docker Compose stack reachable in the isolated `odos-dr-drill` project.
- `pg_dump`, `pg_restore`, `psql`, `rsync`, `shasum`, Docker Compose v2, and `npx` available.
- `redis-cli` available on the host, or `docker-compose exec` access to the `redis` service for the fallback path.
- Backup volume mounted and encrypted at rest by the operator.
- Human-provisioned env vars available where needed:
  - `ODOS_POSTGRES_URL`
  - `ODOS_REDIS_PASSWORD` (required explicitly when invoking backup/restore directly)
  - `ODOS_BACKUP_DIR`

## Commands

One-command operator wrapper:

```bash
npm run dr-drill
```

The wrapper always supplies the isolated Redis credential, ignoring an exported
persistent-stack `ODOS_REDIS_PASSWORD`. It does not change the drill Compose
credential. For manual steps, explicitly set the isolated Redis password as below;
never reuse a persistent credential. Both recovery scripts reject a missing or
empty `ODOS_POSTGRES_URL` or `ODOS_REDIS_PASSWORD` by name before doing work.

The wrapper runs both DR surfaces that v0.6a currently needs:

1. The broad isolated seed → backup → destructive reset → restore → integrity verifier path for `odos_audit_events`, signed `Provenance`, `Binary.securityContext`, FHIR `AuditEvent` projection coverage, and AccessPolicy / ProjectMembership round-trip.
2. The v0.6a frames-table drill in `scripts/v06a-frames-dr-drill.ts`, which prints `canonicalChecks: 32/32` and `tableIntegrity: 5/5`.

Manual equivalent:

```bash
export ODOS_DR_COMPOSE="docker-compose -p odos-dr-drill -f docker-compose.dr-drill.yml"
export MEDPLUM_BASE_URL="http://localhost:18103"
export ODOS_POSTGRES_URL="postgresql://medplum:medplum@127.0.0.1:15432/medplum"
export ODOS_REDIS_PORT="16379"
export ODOS_REDIS_PASSWORD="medplum"
export ODOS_COMPOSE_PROJECT="odos-dr-drill"
export ODOS_COMPOSE_FILE="docker-compose.dr-drill.yml"
export MEDPLUM_ADMIN_EMAIL="${MEDPLUM_ADMIN_EMAIL:-drill-admin@odos.local}"
export MEDPLUM_ADMIN_PASSWORD="${MEDPLUM_ADMIN_PASSWORD:-Odos-dr-drill-Password-1!}"

$ODOS_DR_COMPOSE up -d
npx tsx scripts/seed-dr-drill.ts
MEDPLUM_BASE_URL="$MEDPLUM_BASE_URL" MEDPLUM_ADMIN_EMAIL="$MEDPLUM_ADMIN_EMAIL" MEDPLUM_ADMIN_PASSWORD="$MEDPLUM_ADMIN_PASSWORD" ODOS_BACKUP_DIR="$PWD/backup-dr-drill" scripts/backup.sh
$ODOS_DR_COMPOSE down -v
$ODOS_DR_COMPOSE up -d
MEDPLUM_BASE_URL="$MEDPLUM_BASE_URL" MEDPLUM_ADMIN_EMAIL="$MEDPLUM_ADMIN_EMAIL" MEDPLUM_ADMIN_PASSWORD="$MEDPLUM_ADMIN_PASSWORD" scripts/restore.sh "$PWD/backup-dr-drill/manifest-<timestamp>.json"
cd mcp && MEDPLUM_BASE_URL="http://localhost:18103" ODOS_POSTGRES_URL="postgresql://medplum:medplum@127.0.0.1:15432/medplum" node --import tsx --test --test-concurrency=1 tests/v05b-audit-ib-backup.test.ts ../tests/boundaries/mandate-8-auth-flow.test.ts
cd ..
$ODOS_DR_COMPOSE down -v
$ODOS_DR_COMPOSE up -d postgres
ODOS_POSTGRES_URL="$ODOS_POSTGRES_URL" ODOS_V06A_DR_BACKUP_DIR="$PWD/backup-dr-drill-v06a" npx tsx scripts/v06a-frames-dr-drill.ts
$ODOS_DR_COMPOSE down -v
```

## Expected Output

- `backup-started <timestamp>`
- `backup-completed <backup-dir>/manifest-<timestamp>.json`
- `restore-started <backup-dir>/manifest-<timestamp>.json`
- Five integrity checks print `PASS`.
- `restore-completed <backup-dir>/manifest-<timestamp>.json`
- Broad post-restore fixtures pass.
- v0.6a frames drill prints `canonicalChecks: "32/32"` and `tableIntegrity: "5/5"`.

## Integrity Suite

The restore script runs `scripts/verify-restore-integrity.ts`, which gates on:

1. `odos_audit_events` row count and latest event time.
2. `Provenance.signature` sample validity.
3. `Binary.securityContext` presence.
4. `AuditEvent` projection count against audit-row count.
5. AccessPolicy / ProjectMembership round-trip status.
