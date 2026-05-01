# OSOD — Open Source Optometry

Practitioner-owned open-source EHR/PM for independent optometry practices. Self-hosted on practice hardware. Built on the Medplum FHIR foundation.

**Status:** v0.5d production-spine closeout in progress. Local Medplum foundation, identity/RBAC, audit/DR, scribe-attestation-amendment substrate, and local-hardware setup/preflight ergonomics.

## Architecture

- **FHIR backend:** Medplum (Apache-2.0, self-hosted). Swappable with any FHIR R4 server — OSOD imports zero Medplum SDK beyond `@medplum/fhirtypes` (pure TypeScript types).
- **Application:** Custom TypeScript/Node, talks plain FHIR REST.
- **Data locality:** Patient data lives only on practice hardware. No cloud, no phone-home, no telemetry.

## Practice Install

Run OSOD on your own hardware. Your patients, your machines, your data.

OSOD is designed for a practice-owned Mac Studio, NUC, Linux box, or server with at least 16 GB RAM and 500 GB storage. The practice remains responsible for physical safeguards around that hardware and its backup media; see v0.5 verification ledger row 46 for HIPAA 45 CFR §164.310. Docker Compose v2 is the local deployment surface; see ledger row 47 and the official Docker Compose install docs: <https://docs.docker.com/compose/install/>.

```bash
# 1. Install Docker + Docker Compose v2, then clone OSOD
git clone https://github.com/drbang-iva/osod.git
cd osod

# 2. Install Node dependencies for the setup scripts
npm install
cd mcp && npm install && cd ..

# 3. Start the canonical local stack
docker compose up -d
docker compose ps

# 4. Provide human-owned setup credentials
cp .env.example .env
# Edit .env or export OSOD_PRACTICE_NAME, OSOD_ADMIN_EMAIL,
# OSOD_ADMIN_NAME, and OSOD_ADMIN_PASSWORD.

# 5. Run the interactive setup wizard
npm run setup-practice

# 6. Run the local preflight linter before live patient data
npm run preflight
```

The setup wizard creates the first admin project/user, first Practitioner, first clinician AccessPolicy, and an audit trail for those writes. It is an interactive, human-supervised installer, not an autonomous agent. Re-running it after setup is a clean no-op.

The local SMART authorization server runs in the MCP Node adapter for SMART App Launch v2 authorization, token, introspection, revocation, JWKS, and sandbox-registration flows. It uses the practice-local signing key at `OSOD_SMART_SIGNING_KEY_PATH` and intersects requested SMART scopes with OSOD AccessPolicy before issuing tokens; see [`docs/smart.md`](docs/smart.md).

OSOD is designed for your own hardware. If you have a strong reason to want cloud, that is a separate conversation; the engine ships local-only.

For the expanded walkthrough, troubleshooting, env-var table, port checks, backup destination verification, and preflight reports, see [`docs/install.md`](docs/install.md) and [`docs/backup.md`](docs/backup.md).

## Developer Quick Start

```bash
# 1. Start Medplum + Postgres + Redis
npm run up

# 2. Wait ~30s for services to come up, then check
docker compose ps
# All three should be "running (healthy)"

# 3. Copy credentials into .env
cp .env.example .env
# Edit .env with your email + password

# 4. Install deps + run POC
npm install
npm run poc
```

Expected output:

```
✓ Logged in as admin@osod.local
✓ Created Patient: <uuid>
✓ Created Encounter: <uuid>
✓ Created ChargeItem (CPT 92015): <uuid>

— Demo ready —
Admin UI: http://localhost:8100
```

## What's in v0.0.1

- `docker-compose.yml` — Postgres 16 + Redis 7 + Medplum server
- `medplum.config.json` — server config (dev defaults)
- `src/fhir-client.ts` — thin plain-fetch FHIR client (no SDK dep)
- `src/index.ts` — POC: Patient → Encounter → ChargeItem(CPT 92015)

## What's NOT in v0.0.1 (deferred)

- CPT loader (post-Chacon AMA call, once token is live)
- Optometry FHIR profiles (Observation-Refraction, etc.)
- Scheduling, encounter UI, billing workflow
- Reports
- User roles / permissions beyond admin

## Licensing

Application code: **AGPL v3** (copyleft — prevents closed-source forks).
Runtime dependencies (Medplum, Postgres, Redis): Apache-2.0 / PostgreSQL License / BSD-3.
CPT codes (when loaded): copyright American Medical Association, licensed per-practice per the OpenEMR BYOL pattern.

## Repository relationships

- Business brain + knowledge vault: [performance-od](https://github.com/drbang-iva/performance-od) — reference files, decisions, research
- Code: this repository

See [`performance-od/decisions/2026-04-22-osod-foundation-medplum-over-hapi.md`](https://github.com/drbang-iva/performance-od/blob/main/decisions/2026-04-22-osod-foundation-medplum-over-hapi.md) for full architecture rationale.

## History

Prior custom implementation (341 passing tests, no FHIR) archived at:
- Branch: `archive/2026-04-22-custom-pre-medplum`
- Tag: `custom-v0-final`

That work captured the business requirements (AR aging, fee schedule, bulk import, clinical encounters shell) as the spec we now re-implement FHIR-native on Medplum.
