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

The Van Herick labels and TBUT/LOCS III bounds are provisional operator-reviewed configuration, not terminology codes. No diagnosis, procedure, medication, or laboratory codes are added by this slice.
