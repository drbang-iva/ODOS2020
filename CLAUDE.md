---
memory_class: canon
authority: human-approved
auto_inject_priority: 10
---

# OSOD — Open Source Optometry

Practitioner-owned open-source EHR / practice management for independent optometry. Built by a practicing O.D. on the Medplum FHIR foundation. Self-hosted on the practice's own hardware. AGPL v3.

**Current state:** v0.6a Frames Data SHIPPED (2026-05-09). v0.55 integration spine shipped (2026-05-05). 1 of 8 v0.6 slices shipped; v0.6b PVerify is next. The substrate is real working code under milestone-locked development. **Nothing is packaged as a customer install yet.** First-pilot scope is named below.

For the full current-state operator view, see [`STATUS.md`](STATUS.md) and [`docs/operator-dashboard.md`](docs/operator-dashboard.md).

---

## Repo boundary (hard rule)

**This repo is code.** Application code, infrastructure config, tests, dev scripts, build logs, evidence files.

Strategy, research, decisions, vertical knowledge, clinical reference, marketing, agent fleet, and business posture — all live in [performance-od](https://github.com/drbang-iva/performance-od) (the companion **private** business repo). If you find yourself writing a decision rationale or a research investigation here, stop and move it to `performance-od/decisions/` or `performance-od/research/`.

**No PHI, secrets, customer data, raw clinic data, or private commercial strategy is committed here. Ever.**

---

## Architecture (2026-04-22 foundation; current as of v0.6a)

### Foundation

**Medplum** — Apache-2.0, FHIR-native, self-hosted. Runs as a Docker container alongside Postgres 16 + Redis 7. Never on anyone's cloud.

Chosen over HAPI FHIR for:
1. TypeScript end-to-end (no polyglot tax for solo-dev + LLM team)
2. In-process automation via Bots (optional use; HAPI requires separate Node service)
3. 3-6 months less rebuild work on admin/auth/subscriptions
4. Open-core dynamics favor OSS (Medplum Inc. monetizes hosted SaaS, feature-identical to OSS)

Full rationale: [`performance-od/decisions/2026-04-22-osod-foundation-medplum-over-hapi.md`](https://github.com/drbang-iva/performance-od/blob/main/decisions/2026-04-22-osod-foundation-medplum-over-hapi.md) (private repo — accessible to maintainers).

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

Patient data lives ONLY on the practice's own hardware. No cloud, no vendor telemetry, no phone-home, no centralized backups unless the practice explicitly opts in. The proving-ground practice is the first install; each subscribing practice installs their own self-hosted OSOD on their own hardware (Mac Mini / Mac Studio / NUC / Linux box / server).

Cloud retracted by decision 2026-04-30 — see `performance-od/decisions/2026-04-30-osod-local-only-cloud-retraction.md`.

**`docker-compose.yml` is the deployment unit.** Same file works for dev, test, and production.

---

## Milestone trajectory

### Shipped

- **v0.5 substrate** (a-e slices, shipped Apr 2026) — identity, RBAC, AccessPolicy, audit substrate, DR drill, scribe attestation, FHIR profile installer, clinical encounter UI baseline.
- **v0.55 integration spine** (a-e slices, SHIPPED 2026-05-05 at osod tag `v0.55` / commit `e8c8d9e`):
  - `v0.55a` — SMART v2 authorization (patient-directed token revocation)
  - `v0.55b` — SMART app registry (third-party SMART apps integrate via local registry)
  - `v0.55c` — CDS Hooks 2.0.1 (locally-enforced service trust)
  - `v0.55d` — AgentOps governance (audited, blockable, undoable agent actions)
  - `v0.55e` — Bulk Data $export + §170.315(g)(10) Patient Access API + SMART Backend Services + truthful CapabilityStatement + Information Blocking Safety Valve
- **v0.6a Frames Data** (SHIPPED 2026-05-09 at osod tag `v0.6a` / merge commit `ce6e94f`):
  - HCPCS V-series terminology sync
  - `osod_frames_catalog` + `osod_practice_frames_inventory` (FHIR + sibling SQL pattern)
  - FHIR `ChargeItemDefinition` builder cross-referencing frame SKUs
  - Bulk-file-ingest pathway (Access-Point-like local-subscriber workflow)
  - Inventory management UI primitive

### In flight (v0.6 remaining)

| Slice | Scope | Status |
|---|---|---|
| `v0.6b` | PVerify eligibility integration | next |
| `v0.6c` | Payment processor adapters (in-clinic POS + online + financing) | queued |
| `v0.6d` | Claim.MD claims pipeline | queued |
| `v0.6e` | DICOM Supplement 247 imaging | queued |
| `v0.6f` | WENO e-prescribing | queued |
| `v0.6g` | Payer FHIR connectors | queued |
| `v0.6h` | Paubox secure email | queued |

Per-slice cadence observed (v0.6a baseline): multi-hour focused-session-per-slice — authoring + four-wave triangulation (CC + GPT pressure-test + Gem independent + Gem triangulation) + Codex Cloud execution + close audit.

### First-pilot milestone (Tier-1 — "Install + Chart + Safety")

A local optometry practice can, on its own hardware:

1. Install OSOD via documented script
2. Pass `npm run preflight` clean
3. Onboard admin Practitioner + AccessPolicies
4. Chart a basic visit (refraction, IOP, anterior/posterior segment, signing)
5. Verify AuditEvent captures all PHI access
6. Run DR drill 32/32 + 5/5 integrity checks recoverably
7. Export the patient via §170.315(g)(10) Patient Access API
8. Understand explicitly what is NOT production-ready yet (each v0.6 gap mapped to its slice)

**Tier-1 has zero in-flight v0.6 dependencies.** The substrate is what we need to validate first. The proving-ground practice will run their current PMS in parallel for revenue cycle during the Tier-1 pilot.

Future tiers (post-Tier-1):

- **Tier-2 "Install + Chart + Cash dispensary"** — requires v0.6c. Cash optical sales through OSOD.
- **Tier-3 "Install + Chart + Insured visit"** — requires v0.6b + v0.6c + v0.6d. Full revenue cycle.

Full Tier-1 acceptance criteria, rationale, and v0.6 ranking against pilot tiers: [`docs/operator-dashboard.md`](docs/operator-dashboard.md).

### Beyond v0.6

- **v0.65** — TEFCA / Direct Trust messaging + C-CDA (scope-reduced per HTI-5 final-rule deltas; TEFCA Subparticipant onboarding deferred to post-v0.8)
- **v0.7** — Claims management surface beyond clearinghouse (medical billing only — ASC X12 837P) + MIPS/MVP reporting; CPT third-party adapter integration
- **v0.8** — ONC certification execution; engine-company posture re-evaluation gate
- **v1.0** — Production-ready for general install

---

## Licensing

- **OSOD application code:** AGPL v3 (copyleft — community protection, prevents closed-source forks)
- **Runtime deps:** Apache-2.0 (Medplum, `@medplum/fhirtypes`), PostgreSQL License, BSD-3 (Redis)
- **Medical coding terminologies:**
  - **ICD-10-CM, ICD-10-PCS, HCPCS Level II, NDC, CVX** — ship native (CMS / FDA / CDC public domain)
  - **LOINC, RxNorm, UCUM** — ship native (Regenstrief / NLM permissive)
  - **SNOMED CT** — ships native via IHTSDO US Affiliate (free for US users; geographic-fenced for non-affiliate countries)
  - **CPT codes** — NOT redistributed in the OSOD codebase (AGPL conflict + AMA copyright). Third-party vendor adapter pattern; first integration in v0.7. Practices integrate per their own AMA CPT license. Decision: `performance-od/decisions/2026-05-05-osod-medical-coding-licensing-strategy.md`.

---

## Working directory conventions

| Path | Purpose |
|---|---|
| `docker-compose.yml` | Medplum + Postgres + Redis stack |
| `docker-compose.dr-drill.yml` | Isolated DR drill stack |
| `medplum.config.json` | Dev config (replace signing keys before production) |
| `src/` | Application code — plain TypeScript, FHIR-native |
| `src/fhir-client.ts` | Thin plain-fetch FHIR client (no Medplum SDK) |
| `mcp/` | Node MCP adapter — local SMART authz server, MCP tools, broad test suite |
| `ui/` | React UI — Vite-built, Three.js for clinical timeline |
| `data/profiles/` | FHIR StructureDefinitions + CodeSystems + ValueSets installed by `npm run install-profiles` |
| `data/code-bindings/` | Verification ledger files (per-milestone Mandate 14 evidence) |
| `docs/` | Architecture docs (SMART, CDS Hooks, AgentOps, install, capability, build-log/) |
| `scripts/` | Setup wizard, preflight, DR drill, sync workers |
| `tests/` | Test suite (FHIR-native re-implementation of archived v0 requirements) |
| `policies/` + `policy/` | AccessPolicies + lint config |
| `backup/` + `backup-dr-drill*/` | DR drill canonical assets (gitignored data subdirs) |
| `.env` | Local secrets — never committed |
| `.env.example` | Template for `.env` |

Runtime targets: `npm run up` for the local stack; same compose file works on laptop, Mac Studio, or any Linux box meeting the install prerequisites in `docs/install.md`.

---

## Boundary reminders

- **Strategy / decisions / research** → write to `performance-od/` (the private business brain), not here.
- **Vertical knowledge** (clinical, billing, GHL, Foxfire) → already in `performance-od/reference/domain/`. Don't duplicate.
- **Practice-specific data** → never. Practices own their own data, on their own hardware.
- **Marketing / business** → `performance-od/reference/core/`.

---

## Security

**No agent interacts with authentication flows, credential management, or account settings.** Browser automation is read-only by default. If a task requires authentication, stop and let the human do it. Full policy lives in the companion private business repo at `performance-od/reference/core/soul.md`.

The 2026-03-21 Figma MCP autonomous-SSO incident is the defining boundary. Inside the OSOD repo, that policy translates to: no automated authentication flow traversal of any kind, ever.

---

## History

Prior custom TypeScript implementation (341 passing tests, non-FHIR) archived at:

- Branch: `archive/2026-04-22-custom-pre-medplum` (pushed to origin)
- Tag: `custom-v0-final`

Reason for reset: Medplum foundation gives 2+ years of FHIR plumbing for free, aligns with AMA CPT distribution criterion (a) structurally (CPT only appears inside FHIR Encounter/ChargeItem/Claim — inseparable from clinical context), and removes the polyglot + rebuild tax HAPI would impose.

Full decision rationale: `performance-od/decisions/2026-04-22-osod-foundation-medplum-over-hapi.md` (private companion repo).
