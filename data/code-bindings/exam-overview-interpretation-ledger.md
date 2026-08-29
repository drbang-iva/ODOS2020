---
title: Exam Overview Interpretation Verification Ledger
date: 2026-08-22
status: verified
purpose: Mandate 14 evidence for Exam Overview Observation interpretation codings.
---

# Exam Overview Interpretation Verification Ledger

| Assertion | Chosen value | Source 1 | Source 2 | Access date | Status | Consuming code path |
|---|---|---|---|---|---|---|
| FHIR R4 `Observation.interpretation` uses the Observation Interpretation value set, whose codes come from the case-sensitive HL7 v3 ObservationInterpretation CodeSystem. | `http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation` | [HL7 THO ObservationInterpretation CodeSystem](https://terminology.hl7.org/6.5.0/CodeSystem-v3-ObservationInterpretation.html) | [HL7 FHIR R4 Observation Interpretation ValueSet](https://hl7.org/fhir/R4/valueset-observation-interpretation.html) | 2026-08-22 | verified | `mcp/src/clinical-graph/custom-section-endpoint.ts`; `mcp/src/clinical-graph/glaucoma-suspect.ts` |
| The active code for an observation outside the expected norm is `A`, display `Abnormal`. | `A` — Abnormal | [HL7 THO ObservationInterpretation CodeSystem](https://terminology.hl7.org/6.5.0/CodeSystem-v3-ObservationInterpretation.html) | [HL7 FHIR R4 Observation Interpretation ValueSet](https://hl7.org/fhir/R4/valueset-observation-interpretation.html) | 2026-08-22 | verified | `mcp/src/clinical-graph/custom-section-endpoint.ts`; `mcp/src/clinical-graph/glaucoma-suspect.ts` |
| The active code for an observation within the expected norm is `N`, display `Normal`. | `N` — Normal | [HL7 THO ObservationInterpretation CodeSystem](https://terminology.hl7.org/6.5.0/CodeSystem-v3-ObservationInterpretation.html) | [HL7 FHIR R4 Observation Interpretation ValueSet](https://hl7.org/fhir/R4/valueset-observation-interpretation.html) | 2026-08-22 | verified | `mcp/src/clinical-graph/custom-section-endpoint.ts`; `mcp/src/clinical-graph/glaucoma-suspect.ts` |
| FHIR R4 binds `Observation.interpretation` extensibly: a code from the bound value set is required when one applies, while an alternate local code is permitted when human review finds no applicable value-set concept. | `extensible` | [HL7 FHIR R4 Observation definitions](https://hl7.org/fhir/R4/observation-definitions.html) | [HL7 FHIR R4 binding-strength rules](https://hl7.org/fhir/R4/terminologies.html#extensible) | 2026-08-28 | verified | `mcp/src/clinical-graph/glaucoma-suspect.ts` |
| The active standard code for a successfully performed procedure whose result is borderline and cannot be classified under the established criteria is `E`, display `Equivocal`. This applies to the low-risk cup/disc tier, so the extensible binding does not permit an ODOS-local substitute. | `E` — Equivocal | [HL7 THO ObservationInterpretation CodeSystem](https://terminology.hl7.org/6.5.0/CodeSystem-v3-ObservationInterpretation.html) | [HL7 FHIR R4 Observation Interpretation ValueSet](https://hl7.org/fhir/R4/valueset-observation-interpretation.html) | 2026-08-28 | verified | `mcp/src/clinical-graph/glaucoma-suspect.ts`; `mcp/src/clinical-graph/exam-overview-projection.ts` |
