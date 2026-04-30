# OSOD v0.5b DR Drill Runbook

This drill is operator-only. No MCP tool may trigger backup, restore, or the
destructive reset.

## Preconditions

- Docker Compose stack reachable.
- `pg_dump`, `pg_restore`, `psql`, `rsync`, `shasum`, `docker-compose`, and `npx` available.
- `redis-cli` available on the host, or `docker-compose exec` access to the `redis` service for the fallback path.
- Backup volume mounted and encrypted at rest by the operator.
- Human-provisioned env vars available where needed:
  - `OSOD_POSTGRES_URL`
  - `OSOD_REDIS_PASSWORD`
  - `OSOD_BACKUP_DIR`

## Commands

```bash
npm run up
OSOD_BACKUP_DIR="$PWD/backup" scripts/backup.sh
docker-compose down -v
npm run up
scripts/restore.sh "$PWD/backup/manifest-<timestamp>.json"
cd mcp && node --import tsx --test --test-concurrency=1 tests/v05b-audit-ib-backup.test.ts ../tests/boundaries/mandate-8-auth-flow.test.ts
```

## Expected Output

- `backup-started <timestamp>`
- `backup-completed <backup-dir>/manifest-<timestamp>.json`
- `restore-started <backup-dir>/manifest-<timestamp>.json`
- Five integrity checks print `PASS`.
- `restore-completed <backup-dir>/manifest-<timestamp>.json`
- v0.5a Mandate 8 boundary tests pass.
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
