# OSOD — Open Source Optometry

Practitioner-owned open-source EHR/PM for independent optometry practices. Self-hosted on practice hardware. Built on the Medplum FHIR foundation.

**Status:** v0.0.1 — Medplum foundation + first Patient → Encounter → ChargeItem flow.

## Architecture

- **FHIR backend:** Medplum (Apache-2.0, self-hosted). Swappable with any FHIR R4 server — OSOD imports zero Medplum SDK beyond `@medplum/fhirtypes` (pure TypeScript types).
- **Application:** Custom TypeScript/Node, talks plain FHIR REST.
- **Data locality:** Patient data lives only on practice hardware. No cloud, no phone-home, no telemetry.

## Prerequisites

- **Docker** — install via Colima (recommended) or Docker Desktop
  ```bash
  brew install colima docker docker-compose
  colima start --cpu 4 --memory 8 --disk 40
  ```
- **Node 22+** and **npm** (for running the POC script)

## Quick start

```bash
# 1. Start Medplum + Postgres + Redis
npm run up

# 2. Wait ~30s for services to come up, then check
docker compose ps
# All three should be "running (healthy)"

# 3. Open admin UI and create first admin account
open http://localhost:8100/register

# 4. Copy credentials into .env
cp .env.example .env
# Edit .env with your email + password

# 5. Install deps + run POC
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
