# OSOD Build Status

**As of:** 2026-04-28
**Foundation:** Medplum 5.1.8 (Apache-2.0, self-hosted via docker-compose)
**This repo:** code (Medplum stack, MCP server, Director UI, FHIR profiles, tests)
**Strategy / decisions / mandates:** [drbang-iva/performance-od](https://github.com/drbang-iva/performance-od)

---

## Where we are

**Milestone v0.35 shipped 2026-04-26.** Code SHA: [`c06d89d`](https://github.com/drbang-iva/osod/commit/c06d89d) (tag `v0.35`). The Director UI now renders the full v0.35 backbone: Programs / Allergies / Tobacco Use / Care Team / Problem List sidebar cards, Episode-aware "Start comprehensive exam" flow (stand-alone / existing program / new program with retroactive promote-to-Episode), Principal/Secondary diagnosis tier tagger inline on Spine Assessment, edit-in-place affordances for laterality / ICD-10 / tier / clinical status / entered-in-error (no delete-and-recreate anywhere), deterministic MDM threshold counter at sign-off (Low/Moderate/High per CPT 2023, read-only — no E/M code suggestion), and a role dropdown switching presentation between doctor / tech / front-desk views (presentation-only, NOT authorization). Closes the milestone v0.35 architecture lock from `decisions/2026-04-25-v0.35-architecture-pressure-test-synthesis.md`. **Manual browser golden path validated** including Program promotion + role switching.

**v0.35a inbound write logic shipped 2026-04-25.** Code SHA: [`8917662`](https://github.com/drbang-iva/osod/commit/8917662) (tag `v0.35a`). First slice of milestone v0.35. USCDI v3 capture matrix (94 elements / 19 data classes), Mandate 14 verification ledger (every code constant primary-source verified before use), EpisodeOfCare CodeSystem + ValueSet for clinical-program types, six FHIR builders mirrored MCP↔UI (EpisodeOfCare / Condition with encounter-diagnosis vs problem-list-item split / AllergyIntolerance code-first / SmokingStatus LOINC 72166-2 / CareTeam PractitionerRole-first / Procedure with `procedure-targetBodyStructure` extension), and fourteen MCP write tools with version-aware PATCH semantics + per-tool `X-OSOD-Source` headers + default-on Provenance sidecars. **Second production run of the pressure-test protocol** caught seven BLOCKING items pre-Codex including a numerical USCDI error and two wrong FHIR mappings.

**v0.3 first clinical encounter UI shipped 2026-04-25.** Code SHA: [`8e2a5ef`](https://github.com/drbang-iva/osod/commit/8e2a5ef). The Director UI now supports the thin clinical path: pick patient, start comprehensive exam, enter VA / IOP / refraction, save each section as an atomic FHIR transaction Bundle with Provenance sidecars, then sign and finish. The data layer is guarded by installable v0.3 FHIR StructureDefinitions with snapshots for VA, IOP, Refraction, Axial Length, and Comprehensive Exam Encounter.

This slice is intentionally narrow: no AI, no voice, no additional charting skins, no billing workflow beyond the archived POC foundation.

**Next: v0.4 — FHIR-native ocular measurement graph + first standard modules.** Pressure-test in progress per [`performance-od/research/2026-04-28-v0.4-pre-triangulation-draft.md`](https://github.com/drbang-iva/performance-od/blob/main/research/2026-04-28-v0.4-pre-triangulation-draft.md). Locked-default sub-slice split: **v0.4a** ocular measurement graph hardening + Mandate 4 infrastructure audit + gap-fillers + verification ledger; **v0.4b** Dry Eye Advanced module (meibography, OSDI/SPEED/DEQ-5 questionnaires, IPL/LLLT/RF treatment series, product/supplement timeline); **v0.4c** Contact Lens + Myopia Management module (unified lens-fitting infra for ortho-K adult+pediatric, MiSight, dual-focus, stock soft — with shape that supports specialty CL extension at v0.6 — plus myopia-management overlay for axial length progression, treatment comparison, atropine MedicationStatement, age-banded protocols). No Codex execution against v0.4 scope until full triangulation (Wave-1 + ChatGPT GPT-5.5 + Gemini hybrid) reconciles into a binding decision file.

---

## Stages shipped

| Stage | SHA | What ships | Verified |
|---|---|---|---|
| reset | [`e13f25b`](https://github.com/drbang-iva/osod/commit/e13f25b) | Archive custom pre-Medplum build to `archive/2026-04-22-custom-pre-medplum` | git log |
| **v0.0.1** | [`76d902a`](https://github.com/drbang-iva/osod/commit/76d902a) | Medplum stack live; Patient -> Encounter -> ChargeItem POC flow | POC |
| **v0.1 MCP** | [`01252d9`](https://github.com/drbang-iva/osod/commit/01252d9) | osod-mcp read tools over stdio transport, Zod-validated | tsc + dist |
| **v0.2 scaffold** | [`c2e1f0b`](https://github.com/drbang-iva/osod/commit/c2e1f0b) | Director UI scaffold. Vite + React + Three.js. Plain FHIR REST. Zero `@medplum/react` coupling | tsc + vite build |
| **v0.2.1 dual-transport** | [`b2b4c6e`](https://github.com/drbang-iva/osod/commit/b2b4c6e) | osod-mcp HTTP+SSE alongside stdio. `OSOD_MCP_TRANSPORT=stdio\|sse`. Fail-closed TLS gate on non-loopback bindings | tsc |
| **v0.2.2 eye data foundation** | [`e83da85`](https://github.com/drbang-iva/osod/commit/e83da85) | FHIR-native VA / IOP / refraction Observations, DocumentReference, DiagnosticReport, Provenance patterns, OSOD extensions, `create_observation`, `create_raw_asset_reference` | 15/15 |
| **v0.2.3 create_encounter** | [`d306589`](https://github.com/drbang-iva/osod/commit/d306589) | MCP write tool for FHIR Encounter with per-tool `X-OSOD-Source` and optional Provenance | 20/20 |
| **v0.2.4 update_patient** | [`aae433f`](https://github.com/drbang-iva/osod/commit/aae433f) | MCP write tool with JSON Patch semantics for Patient demographics | 26/26 |
| **v0.2.5 audit-header consistency** | [`aa149f1`](https://github.com/drbang-iva/osod/commit/aa149f1) | Per-tool `X-OSOD-Source` constants. Empirical Medplum 5.1.8 finding: header is not surfaced in FHIR `AuditEvent`; Provenance is durable attribution | 27/27 + build-log |
| **v0.2.6 HL7 Eye Care IG alignment** | [`285f063`](https://github.com/drbang-iva/osod/commit/285f063) | SNOMED dual-coding, OD / OS / OU `BodyStructure`, FHIR `VisionPrescription`, structured PRISM, `create_vision_prescription` | 35/35 + tsc |
| **v0.3 clinical encounter UI** | [`8e2a5ef`](https://github.com/drbang-iva/osod/commit/8e2a5ef) | Patient picker, comprehensive exam start, Encounter charting scene, VA / IOP / Refraction section saves, sign & finish, mirrored ophthalmology builders, `save_section_observations`, clinical Provenance default ON, five v0.3 StructureDefinitions, idempotent profile installer | 54/54 + MCP tsc + UI tsc + UI build 1.039 MB |
| **v0.35a inbound write logic** | [`8917662`](https://github.com/drbang-iva/osod/commit/8917662) (tag `v0.35a`) | USCDI v3 capture matrix (94 elements / 19 classes), Mandate 14 verification ledger (all `verified`), EpisodeOfCare CodeSystem + ValueSet (myopia-management / glaucoma / dry-eye / diabetic-eye-care), six FHIR builders mirrored MCP↔UI (EpisodeOfCare, Condition with encounter-diagnosis vs problem-list-item split + health-concern category, AllergyIntolerance with `.code`-first + SNOMED 716186003, SmokingStatus US Core Observation with LOINC 72166-2, CareTeam PractitionerRole-first, Procedure with `procedure-targetBodyStructure` extension), fourteen MCP write tools all version-aware PATCH + per-tool `X-OSOD-Source` + Provenance default-on. Second production run of the pressure-test protocol caught seven BLOCKING + nine DECISION-AFFECTING items pre-Codex. | 30 files +4237/-26; 112/112 mcp tests; MCP + UI tsc clean; tag `v0.35a` pushed |
| **v0.35 milestone close** | [`c06d89d`](https://github.com/drbang-iva/osod/commit/c06d89d) (tag `v0.35`) | v0.35b outbound view/UI logic: Director chart sidebar grew Programs / Allergies / Tobacco Use / Care Team / Problem List cards. Episode-aware "Start comprehensive exam" prompt (stand-alone / existing program / new program) + retroactive promote-to-Episode via PATCH. Spine Assessment grew Principal/Secondary tier tagger inline + edit-in-place affordance for laterality / ICD-10 / tier / clinical status / entered-in-error (NO delete-and-recreate path). Deterministic MDM threshold counter at sign-off (Low/Moderate/High per CPT 2023, read-only — no E/M suggestion). Role context plumbing: `RoleContext` + `useRole()` + `roles.ts` (doctor / tech / front-desk) + dropdown + role-aware card density (presentation-only, NOT authorization). UI ↔ MCP parity guard extended for v0.35a builders. | 21 files +2200/-54; **120/120 mcp integration tests**; MCP + UI tsc clean; UI vite build clean; **manual browser golden path validated** including Program promotion + role switching; tag `v0.35` pushed |

---

## What works end-to-end today

- `npm run up` runs Medplum + Postgres + Redis locally via `docker-compose`.
- `npm run install-profiles` installs or updates the v0.3 + v0.35 FHIR profiles, CodeSystems, and ValueSets and is idempotent on repeat runs.
- Director UI at `localhost:5173` talks plain FHIR REST to Medplum through `ui/src/lib/fhir.ts`.
- Patient picker searches `Patient` by name with a 300 ms debounce and routes into Director state without auto-selecting the first patient.
- "Start comprehensive exam" prompt offers three options — stand-alone visit, part of an existing program, or start a new program. Episode-aware flow creates a profiled Encounter (linked to selected EpisodeOfCare when applicable) and Provenance attribution, then advances the Encounter to `in-progress`. Promote-to-Episode action retroactively links prior stand-alone Encounters to a new Episode via PATCH (no recreate).
- Encounter charting scene supports VA, IOP, and Refraction sections. Each section save composes `BodyStructure` ensure + `Observation` creates + `Provenance` sidecars in a transaction Bundle.
- Spine Assessment section supports Principal/Secondary diagnosis tier tagger inline (`Encounter.diagnosis.use=billing` + `rank`) and edit-in-place affordances on every diagnosis card: laterality (`update_condition_body_site` via `procedure-targetBodyStructure` extension), ICD-10 recoding (`update_condition_code`), tier change (`update_condition_tier` — rejects category-flip), clinical status, and entered-in-error (`mark_condition_entered_in_error` — preserves the Condition with `verificationStatus=entered-in-error`). No delete-and-recreate path anywhere.
- Director chart sidebar renders five v0.35 cards against live data: **Programs** (active EpisodeOfCare list with status + linked Encounter count), **Allergies** (`AllergyIntolerance` list with Add allergy + Mark no known allergies → SNOMED 716186003 negation), **Tobacco Use** (Smoking Status Observation with LOINC 72166-2 + coded answer picker), **Care Team** (PractitionerRole-first member list), **Problem List** (chronic Conditions with `category=problem-list-item`).
- Sign-off renders a deterministic MDM threshold counter (Low / Moderate / High per CPT 2023 problem-count tiers; reads `Encounter.diagnosis` + active problem-list Conditions; read-only label, no E/M code suggestion — Mandate 13 + FDA SaMD §Criterion 3 boundary preserved).
- Role context plumbing: `RoleContext` provider, `useRole()` hook, `roles.ts` (doctor / tech / front-desk + default-view config), role dropdown in Director top bar, role-aware card-renderer registry. Presentation-only by binding acceptance criterion — NOT authorization, NOT MCP gating, NOT write-permission logic.
- Section save Bundles are composed by the same mirrored contract used by UI and MCP; parity test guard extended for v0.35a builders covers all v0.35b write paths.
- BodyStructure idempotency uses `BodyStructure.location` by patient + SNOMED laterality, not morphology.
- "Sign & finish" patches Encounter status to `finished`, writes `period.end`, and emits Provenance.
- MCP exposes ~26 tools: 6 read tools plus 20 write tools. v0.3 writes (`create_observation`, `create_raw_asset_reference`, `create_encounter`, `update_patient`, `create_vision_prescription`, `save_section_observations`) plus v0.35a writes (`create_episode_of_care`, `update_episode_of_care`, `create_condition_with_tier`, `create_problem_list_condition`, `update_condition_status`, `update_condition_tier`, `update_condition_body_site`, `update_condition_code`, `mark_condition_entered_in_error`, `create_allergy_intolerance`, `create_smoking_status_observation`, `create_care_team`, `create_procedure`, `update_procedure_body_site`).
- All v0.35a write tools are version-aware PATCH (use `If-Match`) + per-tool `X-OSOD-Source` header + Provenance default-on. Clinical writes default Provenance ON across the full v0.3 + v0.35a clinical-write surface.
- Client transaction execution detects per-entry failures and compensates created resources so section saves do not leave partial clinical state when Medplum returns a mixed transaction-response.

---

## What's NOT yet built

- Standard clinical modules (dry eye advanced, contact-lens fitting, myopia management) -> v0.4 (in pre-triangulation)
- Ocular measurement graph longitudinal-query infrastructure (search params, helper MCP tools, cross-resource linkage discipline) -> v0.4a
- Mandate 4 infrastructure systems not yet stood up (equipment registry, module registration system, fitting/trial/remake tracking, unified medication/product timeline view) -> v0.4a audit + gap-fillers
- Billing workflow (Claim / EOB / clearinghouse integration) -> v0.6
- Image handling (Orthanc bridge, DICOM Supp 247 ingestion, `ImagingStudy` linking) -> v0.5+/v0.6
- Compliance rules engine skeleton (Mandate 8) -> v0.5
- Intake scaffold skeleton (Mandate 6) -> v0.5
- Alternate exam skins (Spine remains the only charting UI) -> v0.5
- Native voice-to-FHIR scribe + clinician attestation pipeline -> v0.5
- Multi-tenant RBAC + Medplum AccessPolicy + Information Blocking compliance audit -> v0.5 (production spine)
- SMART on FHIR v2 + CDS Hooks 2.0.1 + AgentOps governance -> v0.55 (depends on v0.5)
- 3D Three.js timeline rendering -> parallel visual track per Mandate 3 (reads from already-built data model; not gating)
- Role-based timeline dropdown rendering -> parallel visual track (role *context* plumbing already shipped at v0.35; what's deferred is the actual timeline visualization)
- Specialty CL UI surfaces + ordering integrations (scleral / RGP / hybrid / custom) -> v0.6 (data model lands in v0.4c, UI is the deferred piece)
- iOS `osod-lens` companion -> deferred per Mandate 12

---

## How to verify locally

```bash
# 1. Stand up the Medplum stack
npm run up && sleep 30
docker-compose ps

# 2. Install profiles; repeat once to confirm idempotency
npm run install-profiles
npm run install-profiles

# 3. Run MCP checks
cd mcp
npx tsc --noEmit
npm test
# Expected: 120/120 passing (was 54/54 at v0.3 close; +58 v0.35a write-logic tests + +8 v0.35b view-logic tests)

# 4. Run UI checks
cd ../ui
npx tsc --noEmit
npm run build
# Expected: build clean; existing large-chunk warning only

# 5. Human golden path smoke
npm run dev
# Open http://localhost:5173 and verify:
# pick patient -> start comprehensive exam -> save VA -> save IOP -> save Refraction -> sign & finish
```

---

## Reference docs (canonical)

- **Mandates:** [`performance-od/reference/domain/open-source-od/mandates.md`](https://github.com/drbang-iva/performance-od/blob/main/reference/domain/open-source-od/mandates.md)
- **Master build sheet:** [`performance-od/decisions/2026-04-22-osod-master-build-sheet-v0.2.md`](https://github.com/drbang-iva/performance-od/blob/main/decisions/2026-04-22-osod-master-build-sheet-v0.2.md)
- **Pre-v0.3 pressure-test synthesis:** [`performance-od/decisions/2026-04-25-pre-v0.3-architecture-pressure-test-synthesis.md`](https://github.com/drbang-iva/performance-od/blob/main/decisions/2026-04-25-pre-v0.3-architecture-pressure-test-synthesis.md)
- **v0.35 pressure-test synthesis:** [`performance-od/decisions/2026-04-25-v0.35-architecture-pressure-test-synthesis.md`](https://github.com/drbang-iva/performance-od/blob/main/decisions/2026-04-25-v0.35-architecture-pressure-test-synthesis.md)
- **v0.4 pre-triangulation draft (in pressure-test):** [`performance-od/research/2026-04-28-v0.4-pre-triangulation-draft.md`](https://github.com/drbang-iva/performance-od/blob/main/research/2026-04-28-v0.4-pre-triangulation-draft.md)
- **Pressure-test protocol:** [`performance-od/reference/domain/open-source-od/pressure-test-protocol.md`](https://github.com/drbang-iva/performance-od/blob/main/reference/domain/open-source-od/pressure-test-protocol.md)
- **Build log:** [`osod/docs/build-log/`](https://github.com/drbang-iva/osod/tree/main/docs/build-log)

---

## Known gaps

- **Medplum AuditEvent does not surface `X-OSOD-Source` in 5.1.8.** Verified empirically in v0.2.5. OSOD still sends the header for ingress attribution, but FHIR `Provenance` is the durable per-resource attribution path.
- **Medplum 5.1.8 can return a mixed transaction-response instead of rolling back every successful entry after a later entry failure.** OSOD client transaction helpers compensate by deleting resources created in the failed response. Section-save tests assert no created clinical resource persists after the covered failure mode.
- **Profile snapshots are intentionally checked in.** Medplum profile validation requires snapshots in this stack; the source files in `data/profiles/` are therefore larger than hand-written differentials.

---

## License

AGPL-3.0 application code. Apache-2.0 dependencies underneath. Derivative works must share source -- practitioner-owned, practitioner-shared.
