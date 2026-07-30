# Patient identity FHIR R4 verification ledger

Access date for every external source below: 2026-07-30.

| Contract | ODOS implementation | Primary source 1 | Primary source 2 | Status |
|---|---|---|---|---|
| A human MRN is a Patient business identifier rather than the immutable FHIR resource id | `Patient.identifier.system = https://odos2020.com/fhir/NamingSystem/odos-mrn` | https://hl7.org/fhir/R4/patient.html | https://hl7.org/fhir/R4/patient-definitions.html | verified |
| An exact identifier token query uses `system\|value`, and conditional create returns 201 for no match, 200 for one match, or 412 for multiple matches | Account reservation with `If-None-Exist: identifier={system}\|{mrn}` | https://hl7.org/fhir/R4/http.html#ccreate | https://hl7.org/fhir/R4/search.html#token | verified |
| Account identifies the patient subject and permits Patient or RelatedPerson as guarantor.party | Per-patient Account plus resolved statement recipient | https://hl7.org/fhir/R4/account.html | https://hl7.org/fhir/R4/account-definitions.html | verified |
| RelatedPerson links to one Patient and supports relationship, contact address, and effective period | Responsible-party RelatedPerson | https://hl7.org/fhir/R4/relatedperson.html | https://hl7.org/fhir/R4/relatedperson-definitions.html | verified |
| A simple extension has an absolute canonical URL, one value, and a StructureDefinition based on `http://hl7.org/fhir/StructureDefinition/Extension` | Consent-authority, primary-party, and court-order-note definitions under `data/canonical-extensions/` | https://hl7.org/fhir/R4/extensibility.html | https://hl7.org/fhir/R4/extension.profile.json.html | verified |
