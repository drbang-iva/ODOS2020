# Patient identity FHIR R4 verification ledger

Access date for the original entries below: 2026-07-30.

| Contract | ODOS implementation | Primary source 1 | Primary source 2 | Status |
|---|---|---|---|---|
| A human MRN is a Patient business identifier rather than the immutable FHIR resource id | `Patient.identifier.system = https://odos2020.com/fhir/NamingSystem/odos-mrn` | https://hl7.org/fhir/R4/patient.html | https://hl7.org/fhir/R4/patient-definitions.html | verified |
| An exact identifier token query uses `system\|value`, and conditional create returns 201 for no match, 200 for one match, or 412 for multiple matches | Account reservation with `If-None-Exist: identifier={system}\|{mrn}` | https://hl7.org/fhir/R4/http.html#ccreate | https://hl7.org/fhir/R4/search.html#token | verified |
| Account identifies the patient subject and permits Patient or RelatedPerson as guarantor.party | Per-patient Account plus resolved statement recipient | https://hl7.org/fhir/R4/account.html | https://hl7.org/fhir/R4/account-definitions.html | verified |
| RelatedPerson links to one Patient and supports relationship, contact address, and effective period | Responsible-party RelatedPerson | https://hl7.org/fhir/R4/relatedperson.html | https://hl7.org/fhir/R4/relatedperson-definitions.html | verified |
| A simple extension has an absolute canonical URL, one value, and a StructureDefinition based on `http://hl7.org/fhir/StructureDefinition/Extension` | Consent-authority, primary-party, and court-order-note definitions under `data/canonical-extensions/` | https://hl7.org/fhir/R4/extensibility.html | https://hl7.org/fhir/R4/extension.profile.json.html | verified |

## Guarantor Person entries

Access date for both primary sources in each row: 2026-09-13.

| Contract | ODOS implementation | Primary source 1 | Primary source 2 | Status |
|---|---|---|---|---|
| Person.link.target permits a RelatedPerson reference | Each new non-self responsible-party Person links to its RelatedPerson | https://hl7.org/fhir/R4/person-definitions.html#Person.link.target | https://www.medplum.com/docs/api/fhir/resources/person | verified |
| Person.link.assurance permits level2, meaning some confidence in the asserted identity | Registration records the explicitly asserted link with assurance level2 | https://hl7.org/fhir/R4/valueset-identity-assuranceLevel.html | https://hl7.org/fhir/R4/codesystem-identity-assuranceLevel.html | verified |
| Account.guarantor.party permits Patient, RelatedPerson, or Organization; Person is not a permitted target | Registration retains the RelatedPerson guarantor reference | https://hl7.org/fhir/R4/account-definitions.html#Account.guarantor.party | https://www.medplum.com/docs/api/fhir/resources/account | verified |
