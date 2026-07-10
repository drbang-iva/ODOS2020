# Visit-Type Category Verification Ledger

Access date: 2026-07-10.

This slice adds no CPT, HCPCS, ICD-10, SNOMED CT, LOINC, RxNorm, NDC, or UCUM values. Visit-type category codes are practice-authored local vocabulary under the registered OSOD CodeSystem.

| Assertion | Chosen value | Source 1 | Source 2 | Status |
|---|---|---|---|---|
| FHIR R4 visit-type category storage | `HealthcareService.category` carries the discipline and practice category as separate `CodeableConcept` entries; readers select each axis by coding system | Installed `@medplum/fhirtypes` 4.5.2 `HealthcareService.d.ts` (`category?: CodeableConcept[]`), package artifact https://registry.npmjs.org/@medplum/fhirtypes/-/fhirtypes-4.5.2.tgz | https://hl7.org/fhir/R4/healthcareservice-definitions.html (`HealthcareService.category`, cardinality `0..*`, type `CodeableConcept`) | verified 2026-07-10 |
| ODOS visit-type category vocabulary | `https://osod.dev/fhir/CodeSystem/visit-type-category`; codes are practice-defined and the canonical CodeSystem declares `content: not-present` | Accepted S3 architecture restated in the goal prompt | `data/terminology/visit-type-category-codesystem.json` | verified local 2026-07-10 |
