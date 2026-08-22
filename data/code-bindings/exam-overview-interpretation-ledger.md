---
title: Exam Overview Interpretation Verification Ledger
date: 2026-08-22
status: verified
purpose: Mandate 14 evidence for Ocular Health Observation interpretation codings.
---

# Exam Overview Interpretation Verification Ledger

| Assertion | Chosen value | Source 1 | Source 2 | Access date | Status | Consuming code path |
|---|---|---|---|---|---|---|
| FHIR R4 `Observation.interpretation` uses the Observation Interpretation value set, whose codes come from the case-sensitive HL7 v3 ObservationInterpretation CodeSystem. | `http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation` | [HL7 THO ObservationInterpretation CodeSystem](https://terminology.hl7.org/6.5.0/CodeSystem-v3-ObservationInterpretation.html) | [HL7 FHIR R4 Observation Interpretation ValueSet](https://hl7.org/fhir/R4/valueset-observation-interpretation.html) | 2026-08-22 | verified | `mcp/src/clinical-graph/custom-section-endpoint.ts` |
| The active code for an observation outside the expected norm is `A`, display `Abnormal`. | `A` — Abnormal | [HL7 THO ObservationInterpretation CodeSystem](https://terminology.hl7.org/6.5.0/CodeSystem-v3-ObservationInterpretation.html) | [HL7 FHIR R4 Observation Interpretation ValueSet](https://hl7.org/fhir/R4/valueset-observation-interpretation.html) | 2026-08-22 | verified | `mcp/src/clinical-graph/custom-section-endpoint.ts` |
| The active code for an observation within the expected norm is `N`, display `Normal`. | `N` — Normal | [HL7 THO ObservationInterpretation CodeSystem](https://terminology.hl7.org/6.5.0/CodeSystem-v3-ObservationInterpretation.html) | [HL7 FHIR R4 Observation Interpretation ValueSet](https://hl7.org/fhir/R4/valueset-observation-interpretation.html) | 2026-08-22 | verified | `mcp/src/clinical-graph/custom-section-endpoint.ts` |
