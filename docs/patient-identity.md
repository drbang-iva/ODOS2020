# Patient identity, responsibility, and chart numbers

## ODOS native MRN

The ODOS medical record number uses this local NamingSystem:

`https://odos2020.com/fhir/NamingSystem/odos-mrn`

The value is a six-digit base from `100001` through `999999`, followed by one Luhn check digit. Luhn was selected because it detects every single-digit error and nearly all adjacent transpositions while remaining easy to implement and validate at every display or import boundary. It is a human chart number, not a FHIR resource id and not a derivative of any legacy identifier.

Native registration reserves a candidate on the patient's FHIR `Account` using conditional create with:

`If-None-Exist: identifier=https://odos2020.com/fhir/NamingSystem/odos-mrn|{mrn}`

The pending Account also carries a one-use allocation token under `https://odos2020.com/fhir/NamingSystem/odos-mrn-allocation-token`. If another registration already won the candidate, conditional create returns that Account without the caller's token; the losing registration retries before creating a Patient. The reserved Account is then finalized in the same transaction that creates the Patient and any RelatedPerson resources. This keeps concurrent front-desk registrations unique without a custom Patient SearchParameter or Medplum schema migration.

## Legacy identifiers and search

Backfill appends the ODOS MRN and never replaces existing identifiers. Patient search recognizes:

- `https://odos2020.com/fhir/NamingSystem/odos-mrn`
- `https://odos2020.com/fhir/NamingSystem/eyefinity-ehr-patient-id`
- `https://odos2020.com/fhir/NamingSystem/eyefinity-epm-patient-id`

Number-looking input uses exact system-and-value token searches. Name-looking input keeps the existing Patient name search. Results state which identifier matched.

## Financial responsibility and consent authority

Each native registration creates a per-patient `Account`. Financially responsible parties become `Account.guarantor` entries:

- self-responsible patient: `Account.guarantor.party` references the Patient;
- another responsible person: `Account.guarantor.party` references a RelatedPerson.

RelatedPerson stores the relationship, contact address, and active `period`. ODOS extensions record consent authority, primary-party status, and court-order/custody notes:

- `https://odos2020.com/fhir/StructureDefinition/related-person-consent-authority`
- `https://odos2020.com/fhir/StructureDefinition/related-person-primary`
- `https://odos2020.com/fhir/StructureDefinition/related-person-court-order-notes`

Registration requires a valid birth date before responsible-party validation and refuses a minor without a currently effective consent-authority party. Coverage subscriber and relationship remain the insurance-linkage source of truth and are not duplicated here.

Statements resolve the active Account guarantor and mail to that person's name and address. An adult legacy chart without an Account may use the existing patient-address fallback until backfill runs. A minor without an unambiguous current guarantor, or a chart whose age cannot be determined from a valid birth date, is rejected from statement generation rather than addressed to the patient.

## Backfill

Run:

`npm run backfill-patient-mrns`

The script is restricted to local or private self-hosted Medplum URLs. It appends an MRN to every Patient that lacks one and finalizes the reserved per-patient Account in the same FHIR transaction. Adults default to self-responsibility. The script does not invent a guardian or consent authority for an existing minor; it creates the Account without a guarantor, counts that chart in `minorsNeedingResponsibleParty`, and statement generation remains blocked until staff records the real responsible party. A missing or invalid birth date never defaults to adult: the chart is counted in `patientsNeedingBirthDateResolution` and receives no invented self guarantor. Existing Account status and name are preserved; only an Account freshly reserved by this run transitions from `on-hold` to `active`. Re-running the script leaves already-complete Patient and Account resources unchanged.

## FHIR R4 verification

FHIR R4 primary sources were accessed 2026-07-30:

- Patient business identifiers and MRN guidance: https://hl7.org/fhir/R4/patient.html and https://hl7.org/fhir/R4/patient-definitions.html
- Conditional create and exact token search: https://hl7.org/fhir/R4/http.html#ccreate and https://hl7.org/fhir/R4/search.html#token
- Account subject and guarantor mapping: https://hl7.org/fhir/R4/account.html and https://hl7.org/fhir/R4/account-definitions.html
- RelatedPerson relationship, address, and active period: https://hl7.org/fhir/R4/relatedperson.html and https://hl7.org/fhir/R4/relatedperson-definitions.html
- Extension representation and canonical base: https://hl7.org/fhir/R4/extensibility.html and https://hl7.org/fhir/R4/extension.profile.json.html
