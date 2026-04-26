# OSOD Build Status

**As of:** 2026-04-25
**Foundation:** Medplum 5.1.8 (Apache-2.0, self-hosted via docker-compose)
**This repo:** code (Medplum stack, MCP server, Director UI, FHIR profiles, tests)
**Strategy / decisions / mandates:** [drbang-iva/performance-od](https://github.com/drbang-iva/performance-od)

---

## Where we are

**Milestone v0.35 shipped 2026-04-26.** Code SHA: [`c06d89d`](https://github.com/drbang-iva/osod/commit/c06d89d) (tag `v0.35`). The Director UI now renders the full v0.35 backbone: Programs / Allergies / Tobacco Use / Care Team / Problem List sidebar cards, Episode-aware "Start comprehensive exam" flow (stand-alone / existing program / new program with retroactive promote-to-Episode), Principal/Secondary diagnosis tier tagger inline on Spine Assessment, edit-in-place affordances for laterality / ICD-10 / tier / clinical status / entered-in-error (no delete-and-recreate anywhere), deterministic MDM threshold counter at sign-off (Low/Moderate/High per CPT 2023, read-only — no E/M code suggestion), and a role dropdown switching presentation between doctor / tech / front-desk views (presentation-only, NOT authorization). Closes the milestone v0.35 architecture lock from `decisions/2026-04-25-v0.35-architecture-pressure-test-synthesis.md`. **Manual browser golden path validated** including Program promotion + role switching.

**v0.35a inbound write logic shipped 2026-04-25.** Code SHA: [`8917662`](https://github.com/drbang-iva/osod/commit/8917662) (tag `v0.35a`). First slice of milestone v0.35. USCDI v3 capture matrix (94 elements / 19 data classes), Mandate 14 verification ledger (every code constant primary-source verified before use), EpisodeOfCare CodeSystem + ValueSet for clinical-program types, six FHIR builders mirrored MCP↔UI (EpisodeOfCare / Condition with encounter-diagnosis vs problem-list-item split / AllergyIntolerance code-first / SmokingStatus LOINC 72166-2 / CareTeam PractitionerRole-first / Procedure with `procedure-targetBodyStructure` extension), and fourteen MCP write tools with version-aware PATCH semantics + per-tool `X-OSOD-Source` headers + default-on Provenance sidecars. **Second production run of the pressure-test protocol** caught seven BLOCKING items pre-Codex including a numerical USCDI error and two wrong FHIR mappings.

**v0.3 first clinical encounter UI shipped 2026-04-25.** Code SHA: [`8e2a5ef`](https://github.com/drbang-iva/osod/commit/8e2a5ef). The Director UI now supports the thin clinical path: pick patient, start comprehensive exam, enter VA / IOP / refraction, save each section as an atomic FHIR transaction Bundle with Provenance sidecars, then sign and finish. The data layer is guarded by installable v0.3 FHIR StructureDefinitions with snapshots for VA, IOP, Refraction, Axial Length, and Comprehensive Exam Encounter.

This slice is intentionally narrow: no AI, no voice, no additional charting skins, no billing workflow beyond the archived POC foundation.

**Next: v0.35b** (outbound view / UI logic) — Director chart sidebar cards (Allergies / Tobacco Use / Care Team / Problem List), Episode-aware "Start comprehensive exam" prompt, diagnosis tier inline tagger on Spine Assessment, edit-in-place affordances (no delete-and-recreate), MDM hint counter (CPT 2023 thresholds), role context dropdown (doctor / tech / front-desk).

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
- `npm run install-profiles` installs or updates five v0.3 FHIR profiles and is idempotent on repeat runs.
- Director UI at `localhost:5173` talks plain FHIR REST to Medplum through `ui/src/lib/fhir.ts`.
- Patient picker searches `Patient` by name with a 300 ms debounce and routes into Director state without auto-selecting the first patient.
- "Start comprehensive exam" creates a profiled Encounter and Provenance attribution, then advances the Encounter to `in-progress`.
- Encounter charting scene supports VA, IOP, and Refraction sections. Each section save composes `BodyStructure` ensure + `Observation` creates + `Provenance` sidecars in a transaction Bundle.
- Section save Bundles are composed by the same mirrored contract used by UI and MCP; parity tests guard drift.
- BodyStructure idempotency uses `BodyStructure.location` by patient + SNOMED laterality, not morphology.
- "Sign & finish" patches Encounter status to `finished`, writes `period.end`, and emits Provenance.
- MCP exposes 12 tools: 6 read tools plus 6 write tools (`create_observation`, `create_raw_asset_reference`, `create_encounter`, `update_patient`, `create_vision_prescription`, `save_section_observations`).
- Clinical writes default Provenance ON for `create_observation`, `create_encounter`, `create_raw_asset_reference`, and `create_vision_prescription`; `update_patient` remains demographics opt-in.
- Client transaction execution detects per-entry failures and compensates created resources so section saves do not leave partial clinical state when Medplum returns a mixed transaction-response.

---

## What's NOT yet built

- Standard clinical modules beyond the v0.3 thin slice (dry eye advanced, ortho-K, myopia management) -> v0.4+
- Billing workflow (Claim / EOB / clearinghouse integration) -> v0.4+
- Image handling (Orthanc bridge, `ImagingStudy` linking) -> v0.5+
- Compliance rules engine skeleton (Mandate 8) -> v0.5
- Intake scaffold skeleton (Mandate 6) -> v0.5
- Alternate exam skins (Spine remains the only v0.3 charting UI) -> v0.5
- Voice, AI charting, and agent attestation flows -> v0.5+
- Role-based timeline dropdown -> v0.5
- iOS `osod-lens` companion -> deferred

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
# Expected: 54/54 passing

# 4. Run UI checks
cd ../ui
npx tsc --noEmit
npm run build
# Expected: build clean; main JS bundle about 1.039 MB, under the 1.2 MB cap

# 5. Human golden path smoke
npm run dev
# Open http://localhost:5173 and verify:
# pick patient -> start comprehensive exam -> save VA -> save IOP -> save Refraction -> sign & finish
```

---

## Reference docs (canonical)

- **v0.3 pressure-test synthesis:** [`performance-od/decisions/2026-04-25-v0.3-architecture-pressure-test-synthesis.md`](https://github.com/drbang-iva/performance-od/blob/main/decisions/2026-04-25-v0.3-architecture-pressure-test-synthesis.md)
- **Master build sheet:** [`performance-od/decisions/2026-04-22-osod-master-build-sheet-v0.2.md`](https://github.com/drbang-iva/performance-od/blob/main/decisions/2026-04-22-osod-master-build-sheet-v0.2.md)
- **Mandates:** [`performance-od/reference/domain/open-source-od/mandates.md`](https://github.com/drbang-iva/performance-od/blob/main/reference/domain/open-source-od/mandates.md)
- **Build log:** [`osod/docs/build-log/`](https://github.com/drbang-iva/osod/tree/main/docs/build-log)

---

## Known gaps

- **Medplum AuditEvent does not surface `X-OSOD-Source` in 5.1.8.** Verified empirically in v0.2.5. OSOD still sends the header for ingress attribution, but FHIR `Provenance` is the durable per-resource attribution path.
- **Medplum 5.1.8 can return a mixed transaction-response instead of rolling back every successful entry after a later entry failure.** OSOD client transaction helpers compensate by deleting resources created in the failed response. Section-save tests assert no created clinical resource persists after the covered failure mode.
- **Profile snapshots are intentionally checked in.** Medplum profile validation requires snapshots in this stack; the source files in `data/profiles/` are therefore larger than hand-written differentials.

---

## License

AGPL-3.0 application code. Apache-2.0 dependencies underneath. Derivative works must share source -- practitioner-owned, practitioner-shared.
