---
title: Ocular health grade-field verification ledger
scope: OH optional grade fields
status: active
created: 2026-07-12
mandate: Mandate 14
---

# Ocular Health Grade-Field Verification Ledger

| # | Assertion | Source 1 | Source 2 | Access date | Status | Consuming code path |
|---|---|---|---|---|---|---|
| 1 | UCUM case-sensitive code `s` represents second. | [UCUM Specification, base units](https://ucum.org/ucum#para-28) | [HL7 FHIR UnitsOfTime ValueSet](https://hl7.org/fhir/R5/valueset-units-of-time.html) | 2026-07-12 | verified | `mcp/src/fhir/contactLens.ts`; TBUT numeric grade seed |
| 2 | The SUN anterior-chamber cell grades, measured in a 1 × 1 mm slit-beam field, are 0: <1 cell; 0.5+: 1-5; 1+: 6-15; 2+: 16-25; 3+: 26-50; and 4+: >50. The independently charted flare grades are 0: none; 1+: faint; 2+: moderate with iris and lens details clear; 3+: marked with iris and lens details hazy; and 4+: intense with fibrin or plastic aqueous. | [SUN Working Group originating consensus paper, Tables 3-4](https://pmc.ncbi.nlm.nih.gov/articles/PMC8935739/) | [Roche protocol BP41321 v5, Appendix 6, corroborating adoption of the SUN scale](https://cdn.clinicaltrials.gov/large-docs/61/NCT04265261/Prot_SAP_000.pdf#page=122) | 2026-09-07 | verified | `mcp/src/clinical-graph/ocular-health-definition.ts`; Anterior Chamber `cells` and `flare` graded qualifiers |

The Van Herick labels and TBUT/LOCS III bounds are provisional operator-reviewed configuration, not terminology codes. The SUN row records a clinical grading scale, not a terminology code. No diagnosis, procedure, medication, or laboratory codes are added by this slice.
