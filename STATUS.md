# OSOD Build Status

**As of:** 2026-04-25
**Foundation:** Medplum 5.1.8 (Apache-2.0, self-hosted via docker-compose)
**This repo:** code (Medplum stack, MCP server, Director UI)
**Strategy / decisions / mandates:** [drbang-iva/performance-od](https://github.com/drbang-iva/performance-od)

---

## Where we are

**v0.2.6 HL7 Eye Care IG alignment shipped 2026-04-25.** 35/35 integration tests green. SNOMED CT dual-coding live for IOP / Refraction / Sphere / Cylinder / Axis. New `BodyStructure` resources for OD / OS / OU. New FHIR `VisionPrescription` emitter (unblocks optical lab and dispensary interop). `OPHTHALMOLOGY_CODE_BINDING_VERSION` 0.2.2 → 0.3.0. **Foundation is now IG-conformant.** All SNOMED codes triple-source verified per Mandate 14 (PHIN VADS + BioPortal + IG ValueSets). Next milestone: **v0.3** — first real clinical encounter UI on the IG-conformant data layer.

---

## Stages shipped

| Stage | SHA | What ships | Verified |
|---|---|---|---|
| reset | [`e13f25b`](https://github.com/drbang-iva/osod/commit/e13f25b) | Archive custom pre-Medplum build to `archive/2026-04-22-custom-pre-medplum` | git log |
| **v0.0.1** | [`76d902a`](https://github.com/drbang-iva/osod/commit/76d902a) | Medplum stack live; Patient → Encounter → ChargeItem POC flow | POC |
| fix | [`0311a78`](https://github.com/drbang-iva/osod/commit/0311a78) | Remove CPT from `Encounter.type` (CPT belongs in `ChargeItem`, not Encounter) | commit |
| POC ext | [`6b8c270`](https://github.com/drbang-iva/osod/commit/6b8c270) | 3 ChargeItems for realistic optometry visit | commit |
| **v0.1 MCP** | [`01252d9`](https://github.com/drbang-iva/osod/commit/01252d9) | osod-mcp v0.1: 6 read tools (`list_patients`, `get_patient`, `get_encounters`, `get_observations`, `get_charge_items`, `fhir_search`), stdio transport, Zod-validated | tsc + dist |
| **v0.2 scaffold** | [`c2e1f0b`](https://github.com/drbang-iva/osod/commit/c2e1f0b) | Director UI (Variant A — Patient ocular universe). Vite + React + Three.js. Plain FHIR REST. Zero `@medplum/react` coupling | tsc + vite build ≈ 1MB |
| **v0.2.1 dual-transport** | [`b2b4c6e`](https://github.com/drbang-iva/osod/commit/b2b4c6e) | osod-mcp HTTP+SSE alongside stdio. `OSOD_MCP_TRANSPORT=stdio\|sse`. Fail-closed TLS gate on non-loopback bindings | tsc |
| **v0.2.2 eye data foundation** | [`e83da85`](https://github.com/drbang-iva/osod/commit/e83da85) | FHIR-native VA / IOP / refraction Observations. `DocumentReference` + `DiagnosticReport` + `Provenance` patterns. OSOD extensions (`source-sha256`, `quality-score`, `confidence-score`, `eye-laterality`). `code-bindings/ophthalmology-concepts.yaml`. `create_observation` + `create_raw_asset_reference` write tools | 15/15 |
| **v0.2.3 create_encounter** | [`d306589`](https://github.com/drbang-iva/osod/commit/d306589) | MCP write tool for FHIR Encounter (Patient + optional Practitioner refs, v3-ActEncounterCode class, type, status, period, reason). Per-tool `X-OSOD-Source: mcp/create_encounter`. Optional Provenance | 20/20 |
| **v0.2.4 update_patient** | [`aae433f`](https://github.com/drbang-iva/osod/commit/aae433f) | MCP write tool with PATCH semantics via RFC 6902 JSON Patch. `fhir-client.patch()` added (`Content-Type: application/json-patch+json`). Field-level Zod validation. Per-tool `X-OSOD-Source: mcp/update_patient` | 26/26 |
| **v0.2.5 audit-header consistency** | [`aa149f1`](https://github.com/drbang-iva/osod/commit/aa149f1) | Per-tool `X-OSOD-Source` constant on every write handler (no more shared header reuse). Empirical Medplum `AuditEvent` verification: **header is NOT surfaced in `5.1.8`** → Provenance is the durable per-resource attribution path | 27/27 + build-log |
| **v0.2.6 HL7 Eye Care IG alignment** | [`285f063`](https://github.com/drbang-iva/osod/commit/285f063) | SNOMED CT dual-coding for IOP (`41633001`) / Refraction (`251794006`) / Sphere (`251795007`) / Cylinder (`251797004`) / Axis (`251799001`). NEW `bodyStructure.ts` emitting `BodyStructure` for OD (`18944008`) / OS (`8966001`) / OU (`81745001` + bilateral qualifier `51440002`). NEW `visionPrescription.ts` building FHIR `VisionPrescription` from FINAL_RX-tagged Refractions. Structured PRISM (`valueQuantity` + `valueCodeableConcept`). FHIR-standard Provenance codes. New `create_vision_prescription` MCP tool. Version bump 0.2.2 → 0.3.0. **All SNOMED codes triple-source verified per Mandate 14.** | 35/35 tests + tsc clean + stdio smoke |

---

## What works end-to-end today

- `docker compose up -d` → Medplum + Postgres + Redis healthy in ~30s
- Director UI at `localhost:5173`, plain FHIR REST against Medplum
- **9 MCP tools live:** 6 read + 5 write (`create_observation`, `create_raw_asset_reference`, `create_encounter`, `update_patient`, `create_vision_prescription`)
- MCP addressable from any client: Claude Desktop, Claude Code, Iris OpenClaw, Codex, future osod-lens
- Patient → Encounter → Observation → ChargeItem round-trip with billing scaffolding
- **HL7 Eye Care IG-conformant ophthalmic Observations** with SNOMED CT dual-coding for IOP / Refraction / Sphere / Cylinder / Axis
- **FHIR `BodyStructure` references** for OD / OS / OU laterality — IG-conformant + queryable from any FHIR client
- **FHIR `VisionPrescription` emitter** for FINAL_RX dispensary handoff to optical labs (Essilor, VSP, etc.)
- Optional FHIR `Provenance` creation alongside Observations and Encounters (Mandate 7a)
- DocumentReference-based raw asset preservation: SHA-1 (FHIR-native) + SHA-256 (OSOD extension `source-sha256`)
- HTTP+SSE remote transport with fail-closed TLS gate (Tailnet-bound by default)
- 35 integration tests against the live docker-compose stack

---

## What's NOT yet built

- Optometry-specific FHIR profiles (`Observation-Refraction`, `Observation-IOP`, `Observation-VA`, `Observation-AxialLength`, `Encounter-ComprehensiveExam`) → **v0.3**
- Standard modules (dry eye advanced, ortho-K, myopia management — Mandate 4 says these ship with base) → **v0.4**
- Image handling (Orthanc bridge, `ImagingStudy` linking) → v0.5+
- Compliance rules engine skeleton (Mandate 8) → v0.5
- Intake scaffold skeleton (Mandate 6) → v0.5
- Exam skins (Spine default / Classic Grid / Traditional Form / Three-Column — Mandate 3) → v0.5
- Role-based timeline dropdown → v0.5
- iOS `osod-lens` companion → deferred (Mandate 12 kill criteria; not on critical path)

---

## How to verify locally

```bash
# 1. Stand up the Medplum stack
cd osod && npm run up && sleep 30
docker compose ps   # all three containers should be "running (healthy)"

# 2. Run MCP integration tests against the running stack
cd mcp && npm test
# Expected: 27/27 passing

# 3. Type-check
npx tsc --noEmit   # expected: clean

# 4. stdio MCP smoke
# Register `osod-mcp` in Claude Desktop or Claude Code; confirm 8 tools listed
```

---

## Reference docs (canonical)

- **Master build sheet** (sequence + mandates anchors + integration map): [`performance-od/decisions/2026-04-22-osod-master-build-sheet-v0.2.md`](https://github.com/drbang-iva/performance-od/blob/main/decisions/2026-04-22-osod-master-build-sheet-v0.2.md)
- **Architectural rulebook** (binding constraints): [`performance-od/reference/domain/open-source-od/mandates.md`](https://github.com/drbang-iva/performance-od/blob/main/reference/domain/open-source-od/mandates.md)
- **Agent workflow** (Conductor two-tab discipline): [`performance-od/reference/domain/open-source-od/agent-workflow.md`](https://github.com/drbang-iva/performance-od/blob/main/reference/domain/open-source-od/agent-workflow.md)
- **Build log** (per-slice narrative + verification reports): [`osod/docs/build-log/`](https://github.com/drbang-iva/osod/tree/main/docs/build-log)

---

## Known gaps (with follow-up)

- **Medplum AuditEvent does not surface `X-OSOD-Source` in `5.1.8`.** Verified empirically in v0.2.5 — 0 entries returned across 5 different AuditEvent searches against just-created resources. Container logs show OAuth login events, not FHIR `AuditEvent` resources. **Resolution:** FHIR `Provenance` is the durable per-resource attribution mechanism. See [`x-osod-source-vs-provenance-attribution`](https://github.com/drbang-iva/performance-od/blob/main/decisions/2026-04-25-x-osod-source-vs-provenance-attribution.md). `create_observation` + `create_encounter` will default Provenance ON when they graduate from manual harness to agent-facing workflows.
- **OSOD FHIR profile pre-flight is a no-op** until v0.3 ships StructureDefinitions. Native FHIR conformance is the only validation today.

---

## License

AGPL-3.0 application code. Apache-2.0 dependencies underneath. Derivative works must share source — practitioner-owned, practitioner-shared.
