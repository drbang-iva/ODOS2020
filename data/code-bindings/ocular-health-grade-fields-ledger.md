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
| 2 | ODOS uses a SUN-derived present-finding scale. The originating SUN criteria measure cells in a 1 × 1 mm slit-beam field; ODOS displays cells as Trace (1–5), 1+ (6–15), 2+ (16–25), 3+ (26–50), and 4+ (>50), and flare as 1+ (faint), 2+ (moderate; iris and lens clear), 3+ (marked; iris and lens hazy), and 4+ (intense; fibrin or plastic aqueous). Two operator-ruled deviations from published SUN notation are intentional: the 0 rung is omitted because selecting an Abnormal finding chip asserts presence, making a 0/none grade contradictory and unreachable in this model; and SUN 0.5+ is labeled Trace because that is practicing-optometrist vocabulary while retaining the same 1–5-cell criterion. This supersedes the 2026-08-09 operator ruling ("grade 1-4+ under cell and again under flare") only by adding the Trace cell rung; its 1+–4+ spine stands, and flare matches it exactly. | [SUN Working Group originating consensus paper, Tables 3-4](https://pmc.ncbi.nlm.nih.gov/articles/PMC8935739/) | [Roche protocol BP41321 v5, Appendix 6, corroborating adoption of the SUN scale](https://cdn.clinicaltrials.gov/large-docs/61/NCT04265261/Prot_SAP_000.pdf#page=122) | 2026-09-07 | verified | `mcp/src/clinical-graph/ocular-health-definition.ts`; Anterior Chamber `cells` and `flare` graded qualifiers |

The Van Herick labels and TBUT/LOCS III bounds are provisional operator-reviewed configuration, not terminology codes. The SUN row records a clinical grading scale, not a terminology code. No diagnosis, procedure, medication, or laboratory codes are added by this slice.
