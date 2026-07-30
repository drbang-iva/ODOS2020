# ODOS Practice Install

Run ODOS on your own hardware. Your patients, your machines, your data.

This is the v0.5d local-hardware install path from the production-spine build sheet. The canonical deployment unit is the root `docker-compose.yml`; v0.5d adds the setup wizard, backup-destination verifier, and provider-agnostic local preflight linter around that stack.

## Hardware

Use practice-owned hardware: Mac Studio, NUC, Linux box, or server. Minimum practical target:

- 16 GB RAM or more.
- 500 GB storage or more.
- Local or attached-drive backup destination.
- Physical access, device inventory, media handling, and facility safeguards owned by the practice.

Ledger row 46 verifies HIPAA 45 CFR §164.310 physical safeguards. ODOS documents and assists, but the practice is the responsible actor for the machine and backup media.

## Install Docker Compose v2

Install Docker with Compose v2 from Docker's official documentation:

<https://docs.docker.com/compose/install/>

Ledger row 47 verifies that Compose v2 uses `docker compose` and the Compose Specification. If your install exposes the standalone `docker-compose` binary instead, use the equivalent `docker-compose` command; the root npm scripts follow the binary available in this local development environment.

## Start the Local Stack

```bash
git clone https://github.com/drbang-iva/ODOS2020.git
cd ODOS2020
npm install
cd mcp && npm install && cd ..
cd ui && npm install && cd ..
npm run generate-medplum-signing-keys
docker-compose up -d
docker-compose ps
```

The root `docker-compose.yml` starts Postgres, Redis, Medplum server, and the local Medplum admin UI. ODOS setup and preflight commands run from the repo against that local stack.
Run `npm install` in `mcp/` after pulling changes as well as during first install.
Its dependencies are separate from the root package; stale `mcp/node_modules` can
otherwise surface only at backend start as an `ERR_MODULE_NOT_FOUND` crash loop
(for example, when `csv-parse` is first imported by a newly pulled job).

The signing-key generator writes independent main and DR-drill RSA keys to ignored,
mode-0600 files under `.odos/`. Medplum 5.1.8 loads the tracked JSON first and then
overlays `MEDPLUM_SIGNING_KEY`, `MEDPLUM_SIGNING_KEY_ID`, and
`MEDPLUM_SIGNING_KEY_PASSPHRASE` from those files. The tracked values are inert.
For an intentional rotation, run `npm run generate-medplum-signing-keys -- --force`
and restart the applicable Medplum server. Rotation expires outstanding one-hour
storage URLs; it does not change stored Binary data.
If you remap the storage port or serve storage from another host, set
`MEDPLUM_STORAGE_BASE_URL` to that public storage origin; otherwise attachment
fetches fail with HTTP 401 `Invalid signature` and no server-log breadcrumb.

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
| `ODOS_PRACTICE_NAME` | yes | Practice/project name for first-run provisioning. |
| `ODOS_ADMIN_EMAIL` | yes | Human-owned admin email; it must be distinct from the `MEDPLUM_ADMIN_EMAIL` service identity. |
| `ODOS_ADMIN_NAME` | yes | First admin/practitioner display name. |
| `ODOS_ADMIN_PASSWORD` | yes | Human-owned Medplum password. `MEDPLUM_ADMIN_PASSWORD` is also accepted. |
| `MEDPLUM_BASE_URL` | no | Defaults to `http://localhost:8103`. |
| `MEDPLUM_STORAGE_BASE_URL` | no | Defaults to `http://localhost:8103/storage/`; set it to the public storage origin when the port or host is remapped. |
| `ODOS_POSTGRES_URL` | no | Defaults to local compose Postgres. Used for audit rows. |
| `ODOS_SETUP_STATE_PATH` | no | Defaults to `./.odos-setup-state.json`. No PHI is written there. |
| `ODOS_SETUP_INTERACTIVE_ACK` | no | Set to `human-supervised` only when a human is intentionally running without a TTY. |
| `ODOS_MCP_TRANSPORT` | yes for the browser UI | Set to `sse` so the UI can call the local HTTP routes. The default `stdio` mode is for launch-on-demand MCP clients. |
| `ODOS_SMART_SIGNING_KEY_PATH` | yes for the local HTTP backend | Absolute path to the local mode-0600 SMART RS256 private key. |
| `ODOS_BACKUP_DIR` | no | Destination used by backup scripts and backup-destination verification. |
| `ODOS_COMMS_PROVIDERS` | no | Comma-separated native communications adapters. Empty keeps communications inert; Slice 1 supports `google-workspace`. |
| `ODOS_TIMEZONE` | yes for reminders | IANA practice timezone used when no patient timezone is present. |
| `ODOS_REMINDER_ENGINE_ENABLED` | no | Must be explicitly `true` after Google Workspace and BAA setup is confirmed. |
| `ODOS_COMMS_PUBLIC_BASE_URL` | yes for tracked links | HTTPS practice-domain origin for campaign redirect links. |

Google Workspace communications setup and the documented manual-send verification path are in
[`docs/google-workspace-comms.md`](google-workspace-comms.md).

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
- Creates one active practice `Organization` named from `ODOS_PRACTICE_NAME` and one active
  `Location` for the existing `main` scheduling office. The Location points to the Organization;
  address and telecom are omitted because setup does not collect those values.
- Creates the canonical ODOS `front-desk`, `practice-admin`, and `clinician` AccessPolicies. (Since 2026-07-05, ODOS AccessPolicies carry a `practice-role` `meta.tag` — the payments endpoint derives a caller's role from it. Installs seeded before that date must run `npm run reseed-role-tags` with a human-provisioned, short-lived `MEDPLUM_ACCESS_TOKEN` set so existing policies gain the tag; the command conditionally patches only missing tags, reports role-tag or concurrent-write conflicts without overwriting them, and exits non-zero when conflicts exist.)
- Reconciles the named human administrator's `ProjectMembership.access[]` to `front-desk`, `practice-admin`, and `clinician`, with `front-desk` first so Desk mutations use the existing actor role.
- Stops before provisioning if `ODOS_ADMIN_EMAIL` matches the `MEDPLUM_ADMIN_EMAIL` service identity.
- Emits `odos_audit_events` rows with `actor_id = setup-wizard`, `actor_role = system`, and `action_reason = "v0.5d setup wizard first-run provisioning"`.
- Records resumable progress in `.odos-setup-state.json`.

Downstream local tooling reads `organizationId` and `locationId` from the setup state at
`ODOS_SETUP_STATE_PATH` (default `.odos-setup-state.json`) and constructs
`Organization/<organizationId>` and `Location/<locationId>` references. TypeScript tooling can
use the exported `readSetupState(path)` helper from `scripts/setup-practice.ts`; no resource id is
hardcoded or stored through a second mechanism.

If setup has already completed, re-running the wizard exits cleanly:

```text
Practice already provisioned. To re-provision, see docs/install.md §Re-provisioning.
```

The no-op path emits an audit row with `event_type = noop` and `action_reason = "v0.5d setup wizard re-run, already provisioned"`.

## Legacy Import Transport Identity

Provision the non-superadmin migration client after the practice roles exist:

```bash
export ODOS_OPERATOR_ACCESS_TOKEN="<temporary token copied from a human-authenticated local Medplum session>"
npm run setup-legacy-importer
unset ODOS_OPERATOR_ACCESS_TOKEN
```

The setup command never accepts an administrator password and never performs a
login. Keep the temporary operator token in the current shell only; do not write
it to `.env` or `.odos/`.

The generated client credentials stay in `.odos/migration-importer.env`. See
[`docs/legacy-import-m0.md`](legacy-import-m0.md) for the raw Binary transport,
Media recovery, operator sweep, and direct-FHIR acceptance gate.

## Repair a Partially Provisioned Local Practice

If the setup state says the practice is complete but one or more canonical ODOS role policies are missing, repair the local project without resetting Postgres:

```bash
npm run repair-practice-roles -- --email "$HUMAN_EMAIL"
```

The repair authenticates with the configured Medplum service credentials but grants only to the explicit `--email` target. It does not create or change credentials. It is restricted to local or private Medplum URLs. It creates any missing canonical policy from the shipped five-role registry, adds a missing role tag to one unambiguous canonical policy, and reconciles the target membership to exactly `front-desk`, `practice-admin`, and `clinician`. `front-desk` remains first by default, so Desk mutations keep their existing actor role. Run `ODOS_DEV_PRIMARY_ROLE=clinician npm run repair-practice-roles -- --email "$HUMAN_EMAIL"` before a charting session to place `clinician` first for `chart.write`; rerun without the override to restore `front-desk` first. The command refuses a target matching `MEDPLUM_ADMIN_EMAIL`.

The repair removes duplicate and unrelated policy bindings, migrates the legacy `accessPolicy` field into ordered `access[]`, clears the legacy field, and is idempotent. It stops without writing the membership when it finds duplicate canonical policy names, a conflicting ODOS role tag, an ambiguous membership, or a stale resource version.

This is the normal recovery path for partial local provisioning. A volume wipe is not required.

## Developer Screen Bring-up

After the Compose stack is running, copy both environment templates and fill in
the root `.env` with the local developer credentials. Keep
`VITE_ODOS_MCP_BASE_URL=http://localhost:3333` in `ui/.env`:

```bash
test -e .env || cp .env.example .env
test -e ui/.env || cp ui/.env.example ui/.env
```

When either template gains new variables, diff its `.env.example` against the existing `.env`
and copy the additions deliberately.

Then repair the local practice roles:

```bash
npm run repair-practice-roles -- --email "$HUMAN_EMAIL"
```

Start the two checked-in launch configurations in `.claude/launch.json`:

| Launch | Address | Purpose |
|---|---|---|
| `odos-mcp` | `http://localhost:3333` | ODOS service routes used by Desk, Statements, and Clinic. |
| `odos-ui` | `http://localhost:5173` | Browser UI; requires `odos-mcp` to be running. |

The `odos-mcp` launch must run with `ODOS_MCP_TRANSPORT=sse`; otherwise it starts only the stdio MCP transport and does not expose the browser-facing HTTP routes. Generate an RSA-2048 local SMART signing key once before starting the backend:

```bash
mkdir -p .odos/keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out .odos/keys/smart-signing.pem
chmod 600 .odos/keys/smart-signing.pem
export ODOS_SMART_SIGNING_KEY_PATH="$PWD/.odos/keys/smart-signing.pem"
```

Keep the private key outside git and preserve its `0600` permissions. Node must
be able to parse it as a private key, and the service enforces the exact mode and
fails closed if the path is missing or the mode is not `0600`. Put the absolute
path emitted by the export command into the root `.env`.

Start the backend from the `mcp/` package in one terminal. There is no root-level
backend start script; load the root environment before changing directories:

```bash
set -a
source .env
set +a
cd mcp && npm run dev
```

Start the UI in a second terminal:

```bash
cd ui && npm run dev
```

Open `http://localhost:5173`, then sign in through the ODOS login screen with the human account named by `--email`. Keep that account distinct from the `MEDPLUM_ADMIN_EMAIL` service identity; no password is stored in this repository. The UI is inert unless the backend is running on `http://localhost:3333`.

### Remote Browser Access

Keep both development services bound to loopback. The MCP server intentionally
fails closed if its SSE transport is bound to `0.0.0.0` or any other
non-loopback host without `ODOS_MCP_TLS`; do not set that variable merely to
bypass the control. From the operator workstation, tunnel both loopback
services instead:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 5173:127.0.0.1:5173 -L 3333:127.0.0.1:3333 <user>@<host>
```

If either local port is already in use, SSH exits instead of leaving a partial tunnel that can
make the browser show a different local application.

Then open `http://localhost:5173` on the operator workstation. The tunnel keeps
the shipped `VITE_ODOS_MCP_BASE_URL=http://localhost:3333` default correct, so
remote access does not require exposing either service or overriding the UI
backend URL.

To open a patient chart directly, use `http://localhost:5173/clinic?patientId=<id>`; add `&encounterId=<id>` to open a specific encounter.

With both dev servers running, seed synthetic screen data:

```bash
npm run seed-demo
```

The idempotent seed creates one clearly synthetic `TEST-` patient, provider, visit type, schedule, current-day appointment, issued Invoice, and $25 unapplied prepaid credit. It also generates the patient's statement through the running MCP service, so the Statements table immediately shows the unapplied-credit line. Re-running the seed keeps the existing marked resources and statement.

Regular bring-up after the one-time repair is: start Compose, start `odos-mcp` and `odos-ui`, open `http://localhost:5173`, and use the regular local login. Run `npm run seed-demo` only when the synthetic demo rows are missing.

## Re-provisioning

For an empty test stack, reset compose volumes and remove the local setup state:

```bash
docker-compose down -v
rm -f .odos-setup-state.json
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

- `.odos/preflight-report.json`
- `.odos/preflight-report.md`

The linter runs four local passes:

| Pass | Result type | Scope |
|---|---|---|
| Log scrubbing | warning | Recent local stack logs for PHI-shaped values. |
| Resource-name linting | warning | Opaque FHIR resource names/descriptions/titles. |
| Env-var PHI check | hard block | Running compose environment values. |
| Vendor-canonical-shape lint | hard block | Source-tree patterns forbidden by the v0.5 verification ledger and lessons. |

There is no data-residency pass in v0.5d because ODOS is local-only.

## Audit Verification

After setup and preflight, run the canonical synthetic Tier-1 visit audit check:

```bash
npm run audit-verify
```

Expected output includes:

```json
{
  "baseline": 8,
  "odosAuditRows": 8,
  "fhirAuditEvents": 8
}
```

This helper charts one synthetic test visit with a Patient, comprehensive Encounter start, five clinical Observations (visual acuity, refraction, IOP, anterior segment, posterior segment), and sign/finish. It verifies both the append-only `odos_audit_events` rows and the projected FHIR `AuditEvent` resources for that visit. The single-visit Tier-1 baseline is **8 ODOS audit rows + 8 FHIR AuditEvent projections**. If a companion bet still says the visit baseline is `32`, correct the bet: `32` belongs to DR drill canonical checks, not to one charted visit.

To re-check the count from the `sessionId` printed by `npm run audit-verify`:

```bash
export ODOS_POSTGRES_URL="${ODOS_POSTGRES_URL:-postgresql://medplum:medplum@127.0.0.1:5432/medplum}"
export SESSION_ID="tier1-visit-<from audit-verify output>"

psql "$ODOS_POSTGRES_URL" -v session_id="$SESSION_ID" <<'SQL'
WITH visit_rows AS (
  SELECT id::text, event_type
  FROM odos_audit_events
  WHERE session_id = :'session_id'
),
projected AS (
  SELECT DISTINCT ae.id
  FROM "AuditEvent" ae
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ae.content::jsonb->'entity', '[]'::jsonb)) AS entity_item(value)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(entity_item.value->'detail', '[]'::jsonb)) AS detail_item(value)
  JOIN visit_rows vr ON detail_item.value->>'type' = 'odos_audit_event_id'
    AND detail_item.value->>'valueString' = vr.id
  WHERE ae.deleted = false
)
SELECT
  (SELECT count(*) FROM visit_rows) AS odos_audit_rows,
  (SELECT count(*) FROM projected) AS fhir_audit_events,
  (SELECT jsonb_object_agg(event_type, count)
   FROM (SELECT event_type, count(*) FROM visit_rows GROUP BY event_type) counts) AS event_types;
SQL
```

## Backup Destination

See [`docs/backup.md`](backup.md). To verify a candidate local or attached-drive destination:

```bash
npm run verify-backup-destination -- /Volumes/ODOS-Backups
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

For the recurring case where another practice system already owns host Postgres port `127.0.0.1:5432`, leave that service running and remap only ODOS's **host** port.

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
ODOS_POSTGRES_URL: postgresql://medplum:medplum@postgres:5432/medplum
```

Then make the host-run tooling URL match the new host port in `.env`:

```bash
ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:5433/medplum
```

Use the same URL for host-side `psql`, setup, preflight, and audit verification:

```bash
export ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:5433/medplum
docker-compose up -d
psql "$ODOS_POSTGRES_URL" -c "select 1;"
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
psql "${ODOS_POSTGRES_URL:-postgresql://medplum:medplum@127.0.0.1:5432/medplum}" -c "select count(*) from odos_audit_events;"
```

If preflight hard-blocks on env-var PHI, remove the PHI-shaped value from the environment, restart the local stack, and rerun `npm run preflight`.

ODOS is designed for your own hardware. If you have a strong reason to want cloud, that is a separate conversation; the engine ships local-only.
