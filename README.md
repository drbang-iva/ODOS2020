# OSOD — Open Source Optometry

Practitioner-owned open-source EHR / practice management for independent optometry. Self-hosted on the practice's own hardware. Built on the Medplum FHIR foundation.

This repo is in active development. There's no released product, no customer-install path yet — just an O.D. building and refining it at his own practice. Built by someone who has had his own battles with software vendors refusing to release practice data. That's the lock-out pattern this whole thing is being built to fix.

---

## Where it is right now

**v0.55 integration spine shipped** (2026-05-05). Five slices closed:

- `v0.55a` — SMART v2 authorization
- `v0.55b` — SMART app registry
- `v0.55c` — CDS Hooks 2.0.1
- `v0.55d` — AgentOps governance
- `v0.55e` — Bulk Data $export + §170.315(g)(10) Patient Access API + truthful CapabilityStatement

**v0.6 is now in flight** — eight slices planned, moving into catalog / billing / payment infrastructure: v0.6a Frames Data → v0.6b PVerify → v0.6c Payment processor → v0.6d Claim.MD → v0.6e DICOM Supplement 247 → v0.6f WENO e-Rx → v0.6g Payer FHIR connectors → v0.6h Paubox. v0.6a Frames Data pre-triangulation draft authored 2026-05-08.

This is real working code, advancing through milestone-locked slices. It's not packaged for outside install yet.

## How it's built

- **FHIR backend:** Medplum (Apache-2.0, self-hosted). Swappable with any FHIR R4 server — OSOD imports zero Medplum SDK beyond `@medplum/fhirtypes` (pure TypeScript types).
- **Application:** custom TypeScript / Node, talks plain FHIR REST.
- **Data locality:** patient data lives only on practice hardware. No cloud, no phone-home, no telemetry.
- **Local SMART authorization server:** runs in the MCP Node adapter — SMART App Launch v2 (authorize / token / introspection / revocation / JWKS / app-registration). Practice-local signing key. Intersects requested SMART scopes against OSOD AccessPolicy before issuing tokens. See `docs/smart.md` and `docs/smart-app-registry.md`.
- **Decision support runs locally.** External CDS services are off by default — opt in only the ones you trust, only when you trust them. The CDS Hooks client advertises local OSOD specialty services + practice-approved external services through the local `/cds-services` endpoint. See `docs/cds-hooks.md`.
- **AgentOps governance** for any AI agent that touches charts: every action audited, blockable, undoable. See `docs/agentops.md`.
- **Patient Access API** — patients can authorize third-party apps to read their records.
- **Population-level export** — group exports run on the practice's hardware, NDJSON files stay on local disk. Data never leaves the building unless the practice authorizes it. See `docs/bulk-data.md` and `docs/capability-statement.md`.

OSOD is designed for the practice's own hardware. If a practice ever wants cloud, that's a separate conversation — the engine ships local-only.

## What works today (v0.55 spine)

- SMART on FHIR v2 authorization with patient-directed token revocation
- SMART app registry (third-party SMART apps integrate via the local registry)
- CDS Hooks 2.0.1 with locally-enforced service trust
- AgentOps governance — every agent action audited, blockable, undoable
- Bulk Data $export (FHIR Bulk Data 1.0.0 STU1)
- §170.315(g)(10) Patient Access API
- SMART Backend Services
- Truthful CapabilityStatement with severity-aware suppression
- Information Blocking Safety Valve composition
- Audit + DR substrate (broad restore integrity plus v0.6a frames 32/32 canonical checks + 5/5 table integrity)
- Local Medplum foundation (Postgres + Redis + Medplum server via Docker Compose)
- Identity + RBAC + AccessPolicy
- Scribe attestation / amendment substrate
- Local-hardware setup wizard + preflight linter
- Custom Pass 4 lint rules across the spine

## What's coming (v0.6)

- Frames Data catalog + per-practice inventory + ChargeItemDefinition builder
- PVerify eligibility integration
- Payment processor adapter ecosystem (in-clinic POS + online + patient financing)
- Claim.MD claims pipeline
- DICOM Supplement 247 imaging surfaces
- WENO e-prescribing
- Payer FHIR connector layer
- Paubox secure email

Plus the catalog architecture trifecta drafted 2026-05-05: product catalogs hybrid FHIR + sibling SQL; medical-coding licensing strategy; per-catalog sync infrastructure.

## First install/pilot milestone — Tier-1 "Install + Chart + Safety"

A local optometry practice can, on its own hardware, with no cloud dependency:

1. Install OSOD via documented script
2. Pass `npm run preflight` clean
3. Onboard admin Practitioner + AccessPolicies
4. Chart a basic visit (refraction, IOP, anterior/posterior segment, signing)
5. Verify AuditEvent captures all PHI access
6. Run DR drill broad restore integrity plus v0.6a frames 32/32 + 5/5 checks recoverably
7. Export the patient via §170.315(g)(10) Patient Access API
8. Understand explicitly what is NOT production-ready yet

**Tier-1 has zero in-flight v0.6 dependencies.** v0.55 substrate is what we validate first in a real practice. The proving-ground practice runs their current PMS in parallel for revenue cycle during the Tier-1 pilot — OSOD is the charting + audit + safety substrate during validation.

Tier-2 (cash dispensary) needs v0.6c. Tier-3 (insured visit) needs v0.6b + v0.6c + v0.6d.

Full acceptance criteria, rationale, and v0.6 ranking against pilot tiers: [`docs/operator-dashboard.md`](docs/operator-dashboard.md). Live build status: [`STATUS.md`](STATUS.md).

## Practice install (developer-only — not a customer onboarding path yet)

OSOD targets a practice-owned Mac Studio, NUC, Linux box, or server with at least 16 GB RAM and 500 GB storage. The practice handles the physical safeguards around hardware and backup media; see v0.5 verification ledger row 46 for HIPAA 45 CFR §164.310. Docker Compose v2 is the local deployment surface; ledger row 47 + the official Docker Compose install docs: <https://docs.docker.com/compose/install/>.

Install only the SMART apps you opt into. Your registry, your seed catalog, your call.

```bash
# 1. Install Docker + Docker Compose v2, then clone OSOD
git clone https://github.com/drbang-iva/osod.git
cd osod

# 2. Install Node dependencies for the setup scripts
npm install
cd mcp && npm install && cd ..

# 3. Start the canonical local stack
docker-compose up -d
docker-compose ps

# 4. Provide human-owned setup credentials
cp .env.example .env
# Edit .env or export OSOD_PRACTICE_NAME, OSOD_ADMIN_EMAIL,
# OSOD_ADMIN_NAME, and OSOD_ADMIN_PASSWORD.

# 5. Run the interactive setup wizard
npm run setup-practice

# 6. Run the local preflight linter before live patient data
npm run preflight
```

The wizard creates the first admin project / user, first Practitioner, first clinician AccessPolicy, and an audit trail for those writes. It's an interactive, human-supervised installer, not an autonomous agent. Re-running it after setup is a clean no-op.

For the expanded walkthrough, troubleshooting, env-var table, port checks, backup destination verification, and preflight reports, see `docs/install.md` and `docs/backup.md`.

## Developer quick start

```bash
# 1. Start Medplum + Postgres + Redis
npm run up

# 2. Wait ~30s for services to come up, then check
docker-compose ps
# All three should be "running (healthy)"

# 3. Copy credentials into .env
cp .env.example .env

# 4. Install deps + run a smoke
npm install
npm run poc
```

Expected output:

```
✓ Logged in as admin@osod.local
✓ Created Patient: <uuid>
✓ Created Encounter: <uuid>
✓ Created ChargeItem (comprehensive-established-eye-exam): <uuid>
✓ Created ChargeItem (refraction-determination): <uuid>
✓ Created ChargeItem (fundus-photography): <uuid>

— Demo ready —
Admin UI: http://localhost:8100
```

## Licensing

- **Application code:** AGPL v3 (copyleft — prevents closed-source forks).
- **Runtime dependencies:** Medplum (Apache-2.0), Postgres (PostgreSQL License), Redis (BSD-3).
- **CPT codes (when loaded):** copyright AMA, licensed per-practice per the OpenEMR BYOL pattern.

## Repository relationships

- **Business brain + knowledge vault (private):** [`performance-od`](https://github.com/drbang-iva/performance-od) — strategy, decisions, research, mandates, four-wave triangulation files, the AI agent fleet, and the wider PerformanceOD posture. OSOD is one of three pillars there (alongside open-source marketing & automation, and a community-for-ODs concept). The private repo is maintainer-only; nothing private (PHI, secrets, customer data, raw clinic data, finance) crosses the boundary into this OSOD repo.
- **Code (this repo, public AGPL-3.0):** application code, infrastructure config, tests, dev scripts, build logs, evidence files.

See `performance-od/decisions/2026-04-22-osod-foundation-medplum-over-hapi.md` for the architecture rationale, `performance-od/decisions/2026-03-14-open-source-od-architecture.md` for the founding architecture decision, and `performance-od/decisions/2026-05-10-osod-first-pilot-milestone.md` for the Tier-1 first-pilot-milestone decision.

## History

Earlier custom implementation (341 passing tests, no FHIR) is archived at:

- Branch: `archive/2026-04-22-custom-pre-medplum`
- Tag: `custom-v0-final`

That work captured the business requirements (AR aging, fee schedule, bulk import, clinical encounters shell) as the spec we now re-implement FHIR-native on Medplum.

---

**Owner:** Eric R. Bang, O.D. — DrBang
**Holding company:** Integrated Vision Associates LLC
**Stage:** Developmental / R&D
