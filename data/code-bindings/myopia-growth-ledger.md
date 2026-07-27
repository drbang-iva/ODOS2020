---
title: Myopia growth clinical-measurement verification ledger
scope: AXIAL_LENGTH and CORNEAL_RADIUS finding definitions; ophthalmology canonical compatibility
status: active
created: 2026-07-25
mandate: Mandate 14
---

# Myopia Growth Verification Ledger

| # | Assertion | Source 1 | Source 2 | Access date | Status | Consuming code path |
|---|---|---|---|---|---|---|
| 1 | UCUM is identified by `http://unitsofmeasure.org`, and the case-sensitive code `mm` represents millimeter at `0.001 m`. | [UCUM official unit table](https://ucum.org/ucum-essence.xml) | [HL7 Terminology UCUM CodeSystem](https://terminology.hl7.org/6.5.0/CodeSystem-v3-ucum.html) | 2026-07-25 | verified | `mcp/src/clinical-graph/myopia-finding-definition.ts`; `mcp/src/clinical-graph/eye-growth-endpoint.ts` |
| 2 | FHIR R4 Quantity carries a decimal value with unit, system, and code; UCUM is the preferred system for computable units. | [FHIR R4 Quantity](https://hl7.org/fhir/R4/datatypes.html#Quantity) | [FHIR R4 Quantity StructureDefinition](https://hl7.org/fhir/R4/quantity.profile.json.html) | 2026-07-25 | verified | AXIAL_LENGTH and CORNEAL_RADIUS Observation values |
| 3 | IMI reports that individual criteria for normal versus accelerated axial elongation are not established; about `0.10 mm/year` is associated with normal eye growth, `0.20-0.30 mm/year` with increasing myopia, and younger children generally grow faster. | [IMI Clinical Management Guidelines clinical summary](https://myopiainstitute.org/wp-content/uploads/2020/09/2023.02.12_IMI-Clinical-Myopia-Management-Guidelines_English.pdf) | [IMI Clinical Management Guidelines full report](https://iovs.arvojournals.org/article.aspx?articleid=2727312) | 2026-07-26 | verified-source-summary | `data/myopia-reference-datasets/truckenbrod-2021-german-axial-length.json`; `mcp/src/clinical-graph/eye-growth-endpoint.ts` |
| 4 | European longitudinal cohorts support age-dependent interpretation: ages 6-9 averaged `0.19 mm/year` in emmetropes, `0.15 mm/year` in hyperopes, and `0.34 mm/year` in myopes; a separate cohort reported `0.30 mm/year` for myopes aged 6-16 and `0.15 mm/year` for myopes aged 12-22. | [Tideman et al., *Acta Ophthalmologica* 2018](https://pmc.ncbi.nlm.nih.gov/articles/PMC6002955/) | [McCullough et al., *Scientific Reports* 2020](https://www.nature.com/articles/s41598-020-72240-y) | 2026-07-26 | verified | `data/myopia-reference-datasets/truckenbrod-2021-german-axial-length.json`; `mcp/src/clinical-graph/eye-growth-endpoint.ts` |
| 5 | ODOS migrated its local ophthalmology CodeSystem canonical from `https://osod.dev/fhir/CodeSystem/ophthalmology` to `https://odos2020.com/fhir/CodeSystem/ophthalmology`; the former remains read-compatible for records created before the migration. | [Pre-migration binding at `7f8b63b`](https://github.com/drbang-iva/ODOS2020/blob/7f8b63b63bc8299279324cfb803b578b21d6c5cf/mcp/src/fhir/ophthalmology/codeBindings.ts) | [Canonical namespace migration `eae0b52`](https://github.com/drbang-iva/ODOS2020/commit/eae0b522f9292b1936bfcb2c86e11405db0bdc77) | 2026-07-26 | verified | `mcp/src/clinical-graph/eye-growth-endpoint.ts`; `mcp/src/clinical-graph/refractive-status.ts` |

`AXIAL_LENGTH`, `CORNEAL_RADIUS`, `biometryMethod`, `instrument`, `OPTICAL_BIOMETRY`, and `ULTRASOUND_A_SCAN` are ODOS-local identifiers, not external terminology claims. The published percentile values are source data rather than medical terminology codes; their citation and provenance live in the versioned dataset registry row.

The configured age-banded axial growth-rate bands are a PRACTICE-SET DEFAULT consistent with published cohorts, not a consensus standard.
