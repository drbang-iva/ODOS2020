# OSOD Practice Install

Run OSOD on your own hardware. Your patients, your machines, your data.

This is the v0.5d local-hardware install path from the production-spine build sheet. The canonical deployment unit is the root `docker-compose.yml`; v0.5d adds the setup wizard, backup-destination verifier, and provider-agnostic local preflight linter around that stack.

## Hardware

Use practice-owned hardware: Mac Studio, NUC, Linux box, or server. Minimum practical target:

- 16 GB RAM or more.
- 500 GB storage or more.
- Local or attached-drive backup destination.
- Physical access, device inventory, media handling, and facility safeguards owned by the practice.

Ledger row 46 verifies HIPAA 45 CFR §164.310 physical safeguards. OSOD documents and assists, but the practice is the responsible actor for the machine and backup media.

## Install Docker Compose v2

Install Docker with Compose v2 from Docker's official documentation:

<https://docs.docker.com/compose/install/>

Ledger row 47 verifies that Compose v2 uses `docker compose` and the Compose Specification. If your install exposes the standalone `docker-compose` binary instead, use the equivalent `docker-compose` command; the root npm scripts follow the binary available in this local development environment.

## Start the Local Stack

```bash
git clone https://github.com/drbang-iva/osod.git
cd osod
npm install
cd mcp && npm install && cd ..
docker-compose up -d
docker-compose ps
```

The root `docker-compose.yml` starts Postgres, Redis, Medplum server, and the local Medplum admin UI. OSOD setup and preflight commands run from the repo against that local stack.

The root npm scripts use `docker-compose` in this checkout. If your Docker install exposes only `docker compose`, use the equivalent space-separated command.

Healthcheck commands:

```bash
curl -fsS http://localhost:8103/healthcheck
docker-compose ps
docker-compose logs --tail 100 medplum-server
```

Expected local endpoints:

| Service | URL |
|---|---|
| FHIR API | `http://localhost:8103/fhir/R4` |
| Medplum admin UI | `http://localhost:8100` |
| Postgres | `127.0.0.1:5432` |
| Redis | `127.0.0.1:6379` |

## Environment Variables

Create `.env` from `.env.example` or export these variables in the shell that runs the setup wizard.

| Variable | Required | Purpose |
|---|---:|---|
| `OSOD_PRACTICE_NAME` | yes | Practice/project name for first-run provisioning. |
| `OSOD_ADMIN_EMAIL` | yes | Human-owned admin email. `MEDPLUM_ADMIN_EMAIL` is also accepted. |
| `OSOD_ADMIN_NAME` | yes | First admin/practitioner display name. |
| `OSOD_ADMIN_PASSWORD` | yes | Human-owned Medplum password. `MEDPLUM_ADMIN_PASSWORD` is also accepted. |
| `MEDPLUM_BASE_URL` | no | Defaults to `http://localhost:8103`. |
| `OSOD_POSTGRES_URL` | no | Defaults to local compose Postgres. Used for audit rows. |
| `OSOD_SETUP_STATE_PATH` | no | Defaults to `./.osod-setup-state.json`. No PHI is written there. |
| `OSOD_SETUP_INTERACTIVE_ACK` | no | Set to `human-supervised` only when a human is intentionally running without a TTY. |
| `OSOD_BACKUP_DIR` | no | Destination used by backup scripts and backup-destination verification. |

## Setup Wizard

Run:

```bash
npm run setup-practice
```

Equivalent direct entrypoint:

```bash
npx tsx scripts/setup-practice.ts
```

The wizard:

- Uses `auth/newuser` and `auth/newproject` for first-run admin/project creation.
- Creates the first `Practitioner`.
- Creates the canonical OSOD clinician `AccessPolicy`.
- Binds the policy through the Medplum admin atomic project endpoint.
- Emits `osod_audit_events` rows with `actor_id = setup-wizard`, `actor_role = system`, and `action_reason = "v0.5d setup wizard first-run provisioning"`.
- Records resumable progress in `.osod-setup-state.json`.

If setup has already completed, re-running the wizard exits cleanly:

```text
Practice already provisioned. To re-provision, see docs/install.md §Re-provisioning.
```

The no-op path emits an audit row with `event_type = noop` and `action_reason = "v0.5d setup wizard re-run, already provisioned"`.

## Re-provisioning

For an empty test stack, reset compose volumes and remove the local setup state:

```bash
docker-compose down -v
rm -f .osod-setup-state.json
docker-compose up -d
npm run setup-practice
```

Do not run this against live patient data. For a live practice, export audit/backup evidence first and make a deliberate operator decision.

## Preflight Linter

Run before live patient data:

```bash
npm run preflight
```

Equivalent direct entrypoint:

```bash
npx tsx scripts/preflight-lint.ts
```

Reports are written to:

- `.osod/preflight-report.json`
- `.osod/preflight-report.md`

The linter runs four local passes:

| Pass | Result type | Scope |
|---|---|---|
| Log scrubbing | warning | Recent local stack logs for PHI-shaped values. |
| Resource-name linting | warning | Opaque FHIR resource names/descriptions/titles. |
| Env-var PHI check | hard block | Running compose environment values. |
| Vendor-canonical-shape lint | hard block | Source-tree patterns forbidden by the v0.5 verification ledger and lessons. |

There is no data-residency pass in v0.5d because OSOD is local-only.

## Audit Verification

After setup and preflight, run the canonical synthetic Tier-1 visit audit check:

```bash
npm run audit-verify
```

Expected output includes:

```json
{
  "baseline": 8,
  "osodAuditRows": 8,
  "fhirAuditEvents": 8
}
```

This helper charts one synthetic test visit with a Patient, comprehensive Encounter start, five clinical Observations (visual acuity, refraction, IOP, anterior segment, posterior segment), and sign/finish. It verifies both the append-only `osod_audit_events` rows and the projected FHIR `AuditEvent` resources for that visit. The single-visit Tier-1 baseline is **8 OSOD audit rows + 8 FHIR AuditEvent projections**. If a companion bet still says the visit baseline is `32`, correct the bet: `32` belongs to DR drill canonical checks, not to one charted visit.

To re-check the count from the `sessionId` printed by `npm run audit-verify`:

```bash
export OSOD_POSTGRES_URL="${OSOD_POSTGRES_URL:-postgresql://medplum:medplum@127.0.0.1:5432/medplum}"
export SESSION_ID="tier1-visit-<from audit-verify output>"

psql "$OSOD_POSTGRES_URL" -v session_id="$SESSION_ID" <<'SQL'
WITH visit_rows AS (
  SELECT id::text, event_type
  FROM osod_audit_events
  WHERE session_id = :'session_id'
),
projected AS (
  SELECT DISTINCT ae.id
  FROM "AuditEvent" ae
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ae.content::jsonb->'entity', '[]'::jsonb)) AS entity_item(value)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(entity_item.value->'detail', '[]'::jsonb)) AS detail_item(value)
  JOIN visit_rows vr ON detail_item.value->>'type' = 'osod_audit_event_id'
    AND detail_item.value->>'valueString' = vr.id
  WHERE ae.deleted = false
)
SELECT
  (SELECT count(*) FROM visit_rows) AS osod_audit_rows,
  (SELECT count(*) FROM projected) AS fhir_audit_events,
  (SELECT jsonb_object_agg(event_type, count)
   FROM (SELECT event_type, count(*) FROM visit_rows GROUP BY event_type) counts) AS event_types;
SQL
```

## Backup Destination

See [`docs/backup.md`](backup.md). To verify a candidate local or attached-drive destination:

```bash
npm run verify-backup-destination -- /Volumes/OSOD-Backups
```

The helper checks writability, available space, and at-rest encryption signals. Encryption findings are warnings; the practice owns the physical-safeguards decision.

## Port Collisions

If startup fails, check common ports:

```bash
lsof -nP -iTCP:8103 -sTCP:LISTEN
lsof -nP -iTCP:8100 -sTCP:LISTEN
lsof -nP -iTCP:5432 -sTCP:LISTEN
lsof -nP -iTCP:6379 -sTCP:LISTEN
```

Stop the conflicting local service or edit the root `docker-compose.yml` port mappings before first live use. Keep the compose file as the canonical local stack; do not introduce alternate deploy templates.

For the recurring case where another practice system already owns host Postgres port `127.0.0.1:5432`, leave that service running and remap only OSOD's **host** port.

In root `docker-compose.yml`, change the Postgres published port from:

```yaml
ports:
  - "127.0.0.1:5432:5432"
```

to:

```yaml
ports:
  - "127.0.0.1:5433:5432"
```

Only the left-side host port changes. Keep the container-network URL unchanged:

```yaml
OSOD_POSTGRES_URL: postgresql://medplum:medplum@postgres:5432/medplum
```

Then make the host-run tooling URL match the new host port in `.env`:

```bash
OSOD_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:5433/medplum
```

Use the same URL for host-side `psql`, setup, preflight, and audit verification:

```bash
export OSOD_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:5433/medplum
docker-compose up -d
psql "$OSOD_POSTGRES_URL" -c "select 1;"
npm run setup-practice
npm run preflight
npm run audit-verify
```

## Troubleshooting

If `docker-compose up -d` fails:

```bash
docker-compose logs --tail 200 postgres
docker-compose logs --tail 200 redis
docker-compose logs --tail 200 medplum-server
```

If the setup wizard cannot reach Medplum:

```bash
curl -v http://localhost:8103/healthcheck
docker-compose ps
```

If audit rows fail:

```bash
docker-compose ps postgres
psql "${OSOD_POSTGRES_URL:-postgresql://medplum:medplum@127.0.0.1:5432/medplum}" -c "select count(*) from osod_audit_events;"
```

If preflight hard-blocks on env-var PHI, remove the PHI-shaped value from the environment, restart the local stack, and rerun `npm run preflight`.

OSOD is designed for your own hardware. If you have a strong reason to want cloud, that is a separate conversation; the engine ships local-only.
