# Patient Insurance and Vision Benefits Verification Ledger

Access date: 2026-07-10.

This slice adds no CPT, HCPCS, ICD-10, SNOMED CT, LOINC, RxNorm, NDC, or UCUM values. Benefit category names are staff-facing labels carried as `CodeableConcept.text`, not asserted terminology codes.

| Assertion | Chosen value | Source 1 | Source 2 | Status |
|---|---|---|---|---|
| FHIR R4 subscriber relationship vocabulary | `child`, `parent`, `spouse`, `common`, `other`, `self`, `injured`; system `http://terminology.hl7.org/CodeSystem/subscriber-relationship` | https://hl7.org/fhir/R4/valueset-subscriber-relationship.html | https://terminology.hl7.org/CodeSystem-subscriber-relationship.json | verified 2026-07-10 |
| Non-self subscriber persistence | `RelatedPerson.patient`, `.relationship`, `.name`, `.birthDate`, `.gender`, `.address`; `Coverage.subscriber` references the RelatedPerson | https://hl7.org/fhir/R4/relatedperson.html | https://hl7.org/fhir/R4/relatedperson-definitions.html | verified 2026-07-10; installed `RelatedPerson.d.ts` and `Coverage.d.ts` agree |
| Coverage group name | `Coverage.class[].value` = group number; `.name` = group name | https://hl7.org/fhir/R4/coverage.html | https://hl7.org/fhir/R4/coverage-definitions.html#Coverage.class | verified 2026-07-10; installed `Coverage.d.ts` agrees |
| Manual eligibility history pair | staff-authored `CoverageEligibilityRequest` plus `CoverageEligibilityResponse.request` reference | https://hl7.org/fhir/R4/coverageeligibilityrequest.html | https://hl7.org/fhir/R4/coverageeligibilityresponse.html | verified 2026-07-10 |
| Manual benefit money | `insurance.item[].benefit[].allowedMoney` and `.usedMoney` | https://hl7.org/fhir/R4/coverageeligibilityresponse.html | https://hl7.org/fhir/R4/coverageeligibilityresponse-definitions.html | verified 2026-07-10; installed `CoverageEligibilityResponse.d.ts` agrees |
| ODOS last-used extension | `https://osod.dev/fhir/StructureDefinition/osod-benefit-last-used` with `valueDate` | accepted Phase 7a design | `data/canonical-extensions/osod-benefit-last-used.json` | verified local |
| ODOS frequency extension | `https://osod.dev/fhir/StructureDefinition/osod-benefit-frequency-months` with `valueUnsignedInt` | accepted Phase 7a design | `data/canonical-extensions/osod-benefit-frequency-months.json` | verified local |
