---
title: Myopia growth clinical-measurement verification ledger
scope: AXIAL_LENGTH and CORNEAL_RADIUS finding definitions
status: active
created: 2026-07-25
mandate: Mandate 14
---

# Myopia Growth Verification Ledger

| # | Assertion | Source 1 | Source 2 | Access date | Status | Consuming code path |
|---|---|---|---|---|---|---|
| 1 | UCUM is identified by `http://unitsofmeasure.org`, and the case-sensitive code `mm` represents millimeter at `0.001 m`. | [UCUM official unit table](https://ucum.org/ucum-essence.xml) | [HL7 Terminology UCUM CodeSystem](https://terminology.hl7.org/6.5.0/CodeSystem-v3-ucum.html) | 2026-07-25 | verified | `mcp/src/clinical-graph/myopia-finding-definition.ts`; `mcp/src/clinical-graph/myopia-progression-endpoint.ts` |
| 2 | FHIR R4 Quantity carries a decimal value with unit, system, and code; UCUM is the preferred system for computable units. | [FHIR R4 Quantity](https://hl7.org/fhir/R4/datatypes.html#Quantity) | [FHIR R4 Quantity StructureDefinition](https://hl7.org/fhir/R4/quantity.profile.json.html) | 2026-07-25 | verified | AXIAL_LENGTH and CORNEAL_RADIUS Observation values |

`AXIAL_LENGTH`, `CORNEAL_RADIUS`, `biometryMethod`, `instrument`, `OPTICAL_BIOMETRY`, and `ULTRASOUND_A_SCAN` are ODOS-local identifiers, not external terminology claims. The published percentile values are source data rather than medical terminology codes; their citation and provenance live in the versioned dataset registry row.
