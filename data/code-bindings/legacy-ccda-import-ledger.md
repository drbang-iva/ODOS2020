# Legacy C-CDA import verification ledger

Access date: 2026-08-01.

Scope: deterministic conversion of already-coded C-CDA parser output into FHIR R4
`Condition`, `AllergyIntolerance`, `MedicationStatement`, `Procedure`, and `Provenance`
resources. The fixture's `SYNTHETIC-*` values are explicit transport-test placeholders,
not asserted terminology concepts.

| Assertion | Source 1 | Source 2 | Access date | Status | Consumption |
|---|---|---|---|---|---|
| `MedicationStatement` is the R4 record of a medication a patient is or was taking; `status = unknown`, `context`, `dateAsserted`, and `identifier` are valid fields. | https://hl7.org/fhir/R4/medicationstatement.html | https://hl7.org/fhir/R4/medicationstatement.profile.json.html | 2026-08-01 | verified | `mcp/src/fhir/medicationStatement.ts`; C-CDA medication import |
| R4 supports encounter linkage on `Condition.encounter`, `AllergyIntolerance.encounter`, `MedicationStatement.context`, and `Procedure.encounter`. | https://hl7.org/fhir/R4/condition.html; https://hl7.org/fhir/R4/allergyintolerance.html | https://hl7.org/fhir/R4/medicationstatement.html; https://hl7.org/fhir/R4/procedure.html | 2026-08-01 | verified | `mcp/src/legacy-import/ccda-import.ts` |
| A Problems-section `Condition` can remain category `problem-list-item` while carrying `Condition.encounter`; linkage does not require category `encounter-diagnosis`. | https://hl7.org/fhir/R4/condition.html | https://terminology.hl7.org/1.0.0/CodeSystem-condition-category.html | 2026-08-01 | verified | `buildProblemListCondition` and C-CDA Problems mapping |
| `MedicationStatement.effective[x]` is a `0..1` choice describing when medication was taken, while `dateAsserted` is when the statement was asserted. The builder gives `effectiveDateTime` precedence so it cannot emit both `effectiveDateTime` and `effectivePeriod`. | https://hl7.org/fhir/R4/medicationstatement.html | https://hl7.org/fhir/R4/medicationstatement.profile.json.html | 2026-08-01 | verified | `buildMedicationStatement`; C-CDA medication date mapping |
| `CodeableConcept.coding` is `0..*`; multiple source codes and translations may represent the same concept, so grouped medication occurrences retain every distinct source coding. | https://hl7.org/fhir/R4/datatypes.html#CodeableConcept | https://hl7.org/fhir/R4/datatypes-definitions.html#CodeableConcept.coding | 2026-08-01 | verified | `distinctMedications`; `codeableConcept` |
| `Encounter.period` uses FHIR `dateTime`; when hours and minutes are present, conformant R4 values carry a timezone. The importer converts offset/Z instants to the locked migration timezone and treats non-conformant offset-less legacy values explicitly as local wall time rather than host time. | https://hl7.org/fhir/R4/encounter.html | https://hl7.org/fhir/R4/datatypes.html#dateTime | 2026-08-01 | verified | `localCalendarDate` |
| C-CDA source labels map to the registered FHIR coding-system URIs used by the importer: SNOMED CT, ICD-10-CM, ICD-9-CM, LOINC, RxNorm, and CPT. | https://hl7.org/fhir/R4/terminologies-systems.html | https://terminology.hl7.org/external_code_systems.html | 2026-08-01 | verified | `FHIR_CODE_SYSTEMS` in `mcp/src/legacy-import/ccda-import.ts` |
| RxNorm `860975` is `24 HR metformin hydrochloride 500 MG Extended Release Oral Tablet` (SCD). | https://rxnav.nlm.nih.gov/REST/rxcui/860975/properties.json | https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=d9e0816d-fd61-1ac2-e053-2995a90a4054 | 2026-08-01 | verified | Synthetic cross-document medication fixture |
