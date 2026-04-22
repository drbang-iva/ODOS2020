---
memory_class: canon
authority: human-approved
auto_inject_priority: 10
---

# OSOD — Open Source Optometry

Practitioner-owned open-source EHR/PM for independent optometry practices. Built by a practicing O.D. on the Medplum FHIR foundation. Self-hosted on practice hardware. AGPL v3.

**Status:** v0.0.1 — Medplum foundation, first Patient → Encounter → ChargeItem flow.

---

## Repo boundary (hard rule)

**This repo is code.** Application code, infrastructure config, tests, dev scripts.

Strategy, research, decisions, vertical knowledge, clinical reference, marketing — all live in [performance-od](https://github.com/drbang-iva/performance-od). If you find yourself writing a decision rationale or a research investigation here, stop and move it to `performance-od/decisions/` or `performance-od/research/`.

---

## Architecture (2026-04-22)

### Foundation

**Medplum** — Apache-2.0, FHIR-native, self-hosted. Runs as a Docker container alongside Postgres 16 + Redis 7. Never on anyone's cloud.

Chosen over HAPI FHIR for:
1. TypeScript end-to-end (no polyglot tax for solo-dev + LLM team)
2. In-process automation via Bots (optional use; HAPI requires separate Node service)
3. 3-6 months less rebuild work on admin/auth/subscriptions
4. Open-core dynamics favor OSS (Medplum Inc. monetizes hosted SaaS, feature-identical to OSS)

Full rationale: [`performance-od/decisions/2026-04-22-osod-foundation-medplum-over-hapi.md`](https://github.com/drbang-iva/performance-od/blob/main/decisions/2026-04-22-osod-foundation-medplum-over-hapi.md)

### SDK discipline (Option 3 architecture)

OSOD application code imports **only** `@medplum/fhirtypes` — pure Apache-2.0 TypeScript types, zero runtime coupling. All server communication is plain FHIR REST/GraphQL.

**Never import in OSOD app code:**
- `@medplum/core` → use plain `fetch()` in `src/fhir-client.ts`
- `@medplum/react` → OSOD builds its own UI
- `@medplum/bot-layer` → workflow logic lives in OSOD's own service layer

**Never call these Medplum-proprietary endpoints:**
- `$execute-bot` (proprietary operation)
- Medplum-specific GraphQL extensions
- Proprietary WebSocket subscription format (use standard FHIR REST-hook or Messaging)

**OK to import as standalone libraries** (no server lock-in):
- `@medplum/ccda` (C-CDA converter library)
- `@medplum/hl7` (HL7 v2 parser library)

Why: this keeps the FHIR server swappable. If a future reason appears to leave Medplum (HAPI, Blaze, IBM FHIR), OSOD's application layer is portable.

### Data locality (non-negotiable)

Patient data lives ONLY on the practice's own hardware. No cloud, no vendor telemetry, no phone-home, no centralized backups unless the practice explicitly opts in. IVA is the proving ground; each subscribing practice installs their own self-hosted OSOD on their own Mac Mini / Mac Studio.

**Docker-compose.yml is the deployment unit.** Same file works on laptop (dev), Iris (test/temp production), and M5 Studio (production after M5 ships).

---

## Build order

### v0.0.1 — Foundation (shipped 2026-04-22)
- Docker-compose (Medplum + Postgres + Redis)
- Plain-fetch FHIR client (`src/fhir-client.ts`)
- First POC flow: Patient → Encounter → ChargeItem(CPT 92015)

### v0.1 — Optometry-specific FHIR
- Observation profiles: Refraction, Keratometry, IOP, Visual Acuity, Pupils, Visual Field
- Encounter extensions for eye-exam structure
- CPT loader (post-Chacon call, once AMA token is live)

### v0.2 — Scheduling + patient demographics
- Custom scheduling UI on FHIR Appointment/Slot
- Patient management UI on FHIR Patient/RelatedPerson/Coverage

### v0.3 — Billing
- Claim workflow (FHIR Claim + ChargeItem + ExplanationOfBenefit)
- Clearinghouse integration (Office Ally or Claim.MD)

### v0.4+ — Clinical encounters
- Eye exam documentation UI
- Prescriptions (WENO e-Rx, not SureScripts — see performance-od decisions)
- Reports (AR aging, revenue-by-provider)

**Every scope bullet re-implements work first proven in the archived v0 (see `archive/2026-04-22-custom-pre-medplum` branch).** The 341 tests of the archived build describe the requirements; the new implementation is FHIR-native.

---

## Licensing

- OSOD application code: **AGPL v3** (copyleft — community protection, prevents closed-source forks)
- Runtime deps: Apache-2.0 (Medplum, `@medplum/fhirtypes`), PostgreSQL License, BSD-3 (Redis)
- CPT codes: © American Medical Association, licensed per-practice via OpenEMR BYOL pattern. OSOD ships **zero** CPT data in the open-source repo; practices load their own licensed CPT files.

---

## Working directory conventions

| Path | Purpose |
|---|---|
| `docker-compose.yml` | Medplum + Postgres + Redis stack |
| `medplum.config.json` | Dev config (replace signing keys before production) |
| `src/` | Application code — plain TypeScript, FHIR-native |
| `src/fhir-client.ts` | Thin plain-fetch FHIR client (no Medplum SDK) |
| `src/index.ts` | POC entrypoint — extends into full app |
| `tests/` | Test suite (reincarnating the archived v0 requirements as FHIR tests) |
| `.env` | Local secrets — never committed |
| `.env.example` | Template for `.env` |

Runtime:
- Dev (laptop): `npm run up` → localhost:8103 (FHIR API), localhost:8100 (Admin UI)
- Test/temp production: Iris Mac Studio, same compose file, accessed via Tailscale
- Production (future): M5 Mac Studio dedicated to OSOD, once M5 ships (~2-3 months)

---

## Boundary reminders

- **Strategy/decisions/research** → write to `performance-od/`, not here.
- **Vertical knowledge** (clinical, billing, GHL, Foxfire) → already in `performance-od/reference/domain/`. Don't duplicate.
- **IVA practice-specific data** → `iva_eyecare` + `iva-aesthetics` repos.
- **Marketing/business** → `performance-od/reference/core/`.

---

## Security (carried forward from performance-od)

**No agent interacts with authentication flows, credential management, or account settings.** Browser automation is read-only by default. If a task requires authentication, stop and let the human do it. Full policy: `performance-od/reference/core/soul.md`.

---

## History

Prior custom TypeScript implementation (341 passing tests, non-FHIR) archived at:
- Branch: `archive/2026-04-22-custom-pre-medplum` (pushed to origin)
- Tag: `custom-v0-final`

Reason for reset: Medplum foundation gives 2+ years of FHIR plumbing for free, aligns with AMA CPT distribution criterion (a) structurally (CPT only appears inside FHIR Encounter/ChargeItem/Claim — inseparable from clinical context), and removes the polyglot + rebuild tax HAPI would impose.

Full decision rationale: `performance-od/decisions/2026-04-22-osod-foundation-medplum-over-hapi.md`
