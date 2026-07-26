# Dry-Eye Battery Verification Ledger

Access date: 2026-07-26.

This slice adds no CPT, HCPCS, ICD-10-CM, SNOMED CT, LOINC, RxNorm, or NDC values.
Diagnosis suggestions reuse already-verified ODOS diagnosis-catalog keys and remain
proposals requiring clinician confirmation. Grading schemes and product naming are
visibly provisional; no diagnostic cutoff or severity threshold is encoded.

| Assertion | Source 1 | Source 2 | Access date | Status | Consumption |
|---|---|---|---|---|---|
| The case-sensitive UCUM code `mosm/L` represents milliosmole per liter. The UI may display the familiar label `mOsm/L`, while FHIR Quantity coding uses `http://unitsofmeasure.org` and `mosm/L`. | [UCUM official unit table](https://ucum.org/ucum) | [HL7 FHIR R4 UCUM Codes ValueSet](https://hl7.org/fhir/R4/valueset-ucum-units.html) | 2026-07-26 | verified | Tear osmolarity custom-field Quantity |
