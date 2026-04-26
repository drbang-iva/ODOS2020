# USCDI v3 Capture Matrix

Access date: 2026-04-25

Scope: v0.35a documents capture posture for USCDI v3 (19 data classes / 94 data elements) against what OSOD v0.3 plus v0.35a actually writes. This is a capture matrix only; it is not a US Core conformance claim. CapabilityStatement language remains "Partial Conformance: Data Class Capture Only."

Primary sources:
- HHS/ONC Standards Bulletin 2022-2: https://healthit.gov/standards-onc-technology/onc-standards-bulletin/onc-standards-bulletin-2022-2/
- USCDI Version 3 October 2022 Errata: https://healthit.gov/wp-content/uploads/2025/03/USCDI-Version-3-October-2022-Errata-Final.pdf
- eCFR 45 CFR §170.213: https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-D/part-170/subpart-B/section-170.213

Status values: `captured`, `partial`, `stub`, `deferred`, `not-applicable`.

| USCDI v3 element | US Core 6.1.0 profile | OSOD FHIR resource | Builder/MCP tool | Status | Target milestone |
|---|---|---|---|---|---|
| Allergies and Intolerances - Substance (Medication) | US Core AllergyIntolerance | AllergyIntolerance.code | buildAllergyIntolerance / create_allergy_intolerance | partial | v0.35a |
| Allergies and Intolerances - Substance (Drug Class) | US Core AllergyIntolerance | AllergyIntolerance.code | buildAllergyIntolerance / create_allergy_intolerance | partial | v0.35a |
| Allergies and Intolerances - Reaction | US Core AllergyIntolerance | AllergyIntolerance.reaction.manifestation | buildAllergyIntolerance / create_allergy_intolerance | partial | v0.35a |
| Assessment and Plan of Treatment - Assessment and Plan of Treatment | US Core CarePlan | CarePlan | none | deferred | v0.5 |
| Assessment and Plan of Treatment - SDOH Assessment | US Core Observation Screening Assessment / QuestionnaireResponse | Observation / QuestionnaireResponse | none | deferred | v0.5 |
| Care Team Member(s) - Care Team Member Name | US Core CareTeam + PractitionerRole / Practitioner / RelatedPerson | CareTeam.participant.member reference | buildCareTeam / create_care_team | partial | v0.35a |
| Care Team Member(s) - Care Team Member Identifier | US Core CareTeam + PractitionerRole / Practitioner | CareTeam.participant.member reference | buildCareTeam / create_care_team | partial | v0.35a |
| Care Team Member(s) - Care Team Member Role | US Core CareTeam | CareTeam.participant.role | buildCareTeam / create_care_team | captured | v0.35a |
| Care Team Member(s) - Care Team Member Location | US Core CareTeam + PractitionerRole | CareTeam.participant.member -> PractitionerRole.location | buildCareTeam / create_care_team | partial | v0.35a |
| Care Team Member(s) - Care Team Member Telecom | US Core CareTeam + PractitionerRole | CareTeam.participant.member -> PractitionerRole.telecom | buildCareTeam / create_care_team | partial | v0.35a |
| Clinical Notes - Consultation Note | US Core DocumentReference | DocumentReference | create_raw_asset_reference | stub | v0.5 |
| Clinical Notes - Discharge Summary Note | US Core DocumentReference | DocumentReference | create_raw_asset_reference | stub | v0.5 |
| Clinical Notes - History & Physical | US Core DocumentReference | DocumentReference | create_raw_asset_reference | stub | v0.5 |
| Clinical Notes - Procedure Note | US Core DocumentReference | DocumentReference | create_raw_asset_reference | stub | v0.5 |
| Clinical Notes - Progress Note | US Core DocumentReference | DocumentReference | create_raw_asset_reference | stub | v0.5 |
| Clinical Tests - Clinical Test | US Core Observation Clinical Result / Simple Observation | Observation | OSOD eye Observations (VA / IOP / refraction) | partial | v0.3 |
| Clinical Tests - Clinical Test Result/Report | US Core DiagnosticReport for Report and Note Exchange | DiagnosticReport / Observation | OSOD eye Observations and raw asset builders | partial | v0.3 |
| Diagnostic Imaging - Diagnostic Imaging Test | US Core DiagnosticReport / DocumentReference | DiagnosticReport / DocumentReference / ImagingStudy | create_raw_asset_reference | partial | v0.6 |
| Diagnostic Imaging - Diagnostic Imaging Report | US Core DiagnosticReport for Report and Note Exchange | DiagnosticReport / DocumentReference | create_raw_asset_reference | partial | v0.6 |
| Encounter Information - Encounter Type | US Core Encounter | Encounter.class / Encounter.type | create_encounter | partial | v0.3 |
| Encounter Information - Encounter Diagnosis | US Core Condition Encounter Diagnosis | Condition + Encounter.diagnosis | buildEncounterDiagnosisCondition / create_condition_with_tier | captured | v0.35a |
| Encounter Information - Encounter Time | US Core Encounter | Encounter.period | create_encounter | captured | v0.3 |
| Encounter Information - Encounter Location | US Core Encounter | Encounter.location | none | deferred | v0.5 |
| Encounter Information - Encounter Disposition | US Core Encounter | Encounter.hospitalization.dischargeDisposition | none | deferred | v0.5 |
| Goals - Patient Goals | US Core Goal | Goal | none | deferred | v0.5 |
| Goals - SDOH Goals | US Core Goal | Goal | none | deferred | v0.5 |
| Health Insurance Information - Coverage Status | US Core Coverage | Coverage.status | none | deferred | v0.7 |
| Health Insurance Information - Coverage Type | US Core Coverage | Coverage.type | none | deferred | v0.7 |
| Health Insurance Information - Relationship to Subscriber | US Core Coverage | Coverage.relationship | none | deferred | v0.7 |
| Health Insurance Information - Member Identifier | US Core Coverage | Coverage.identifier | none | deferred | v0.7 |
| Health Insurance Information - Subscriber Identifier | US Core Coverage | Coverage.subscriberId | none | deferred | v0.7 |
| Health Insurance Information - Group Number | US Core Coverage | Coverage.class | none | deferred | v0.7 |
| Health Insurance Information - Payer Identifier | US Core Coverage | Coverage.payor.identifier/reference | none | deferred | v0.7 |
| Health Status/Assessments - Health Concerns | US Core Condition Problems and Health Concerns | Condition.category = health-concern | buildHealthConcernCondition | stub | v0.35a |
| Health Status/Assessments - Functional Status | US Core Observation Clinical Result / Screening Assessment | Observation | none | deferred | v0.5 |
| Health Status/Assessments - Disability Status | US Core Observation Clinical Result / Screening Assessment | Observation | none | deferred | v0.5 |
| Health Status/Assessments - Mental/Cognitive Status | US Core Observation Clinical Result / Screening Assessment | Observation | none | deferred | v0.5 |
| Health Status/Assessments - Pregnancy Status | US Core Observation Pregnancy Status | Observation | none | deferred | v0.5 |
| Health Status/Assessments - Smoking Status | US Core Smoking Status Observation | Observation.code LOINC 72166-2 | buildSmokingStatusObservation / create_smoking_status_observation | captured | v0.35a |
| Immunizations - Immunizations | US Core Immunization | Immunization | none | deferred | v0.6 |
| Laboratory - Tests | US Core Laboratory Result Observation / DiagnosticReport Laboratory Results | Observation / DiagnosticReport | none | deferred | v0.6 |
| Laboratory - Values/Results | US Core Laboratory Result Observation / DiagnosticReport Laboratory Results | Observation.value[x] / DiagnosticReport.result | none | deferred | v0.6 |
| Laboratory - Specimen Type | US Core Specimen | Specimen.type | none | deferred | v0.6 |
| Laboratory - Result Status | US Core Laboratory Result Observation | Observation.status | none | deferred | v0.6 |
| Medications - Medications | US Core MedicationRequest / MedicationDispense / Medication | MedicationRequest / MedicationDispense / Medication | none | deferred | v0.5 |
| Medications - Dose | US Core MedicationRequest / MedicationDispense | dosageInstruction.doseAndRate | none | deferred | v0.5 |
| Medications - Dose Units of Measure | US Core MedicationRequest / MedicationDispense | dosageInstruction.doseAndRate.doseQuantity.unit | none | deferred | v0.5 |
| Medications - Indication | US Core MedicationRequest | MedicationRequest.reasonCode / reasonReference | none | deferred | v0.5 |
| Medications - Fill Status | US Core MedicationDispense | MedicationDispense.status | none | deferred | v0.5 |
| Patient Demographics/Information - First Name | US Core Patient | Patient.name.given | update_patient | partial | v0.3 |
| Patient Demographics/Information - Last Name | US Core Patient | Patient.name.family | update_patient | partial | v0.3 |
| Patient Demographics/Information - Middle Name (Including middle initial) | US Core Patient | Patient.name.given | update_patient | partial | v0.3 |
| Patient Demographics/Information - Name Suffix | US Core Patient | Patient.name.suffix | update_patient | partial | v0.3 |
| Patient Demographics/Information - Previous Name | US Core Patient | Patient.name.use = old / period | update_patient | stub | v0.5 |
| Patient Demographics/Information - Date of Birth | US Core Patient | Patient.birthDate | update_patient | partial | v0.3 |
| Patient Demographics/Information - Date of Death | US Core Patient | Patient.deceased[x] | none | deferred | v0.5 |
| Patient Demographics/Information - Race | US Core Patient | US Core race extension | none | deferred | v0.5 |
| Patient Demographics/Information - Ethnicity | US Core Patient | US Core ethnicity extension | none | deferred | v0.5 |
| Patient Demographics/Information - Tribal Affiliation | US Core Patient | US Core tribal-affiliation extension | none | deferred | v0.5 |
| Patient Demographics/Information - Sex | US Core Patient | US Core sex extension | none | deferred | v0.5 |
| Patient Demographics/Information - Sexual Orientation | US Core Observation Sexual Orientation | Observation | none | deferred | v0.5 |
| Patient Demographics/Information - Gender Identity | US Core Patient | US Core genderIdentity extension | none | deferred | v0.5 |
| Patient Demographics/Information - Preferred Language | US Core Patient | Patient.communication.language | none | deferred | v0.5 |
| Patient Demographics/Information - Current Address | US Core Patient | Patient.address | update_patient | partial | v0.3 |
| Patient Demographics/Information - Previous Address | US Core Patient | Patient.address.use = old / period | update_patient | stub | v0.5 |
| Patient Demographics/Information - Phone Number | US Core Patient | Patient.telecom.value | update_patient | partial | v0.3 |
| Patient Demographics/Information - Phone Number Type | US Core Patient | Patient.telecom.use | update_patient | partial | v0.3 |
| Patient Demographics/Information - Email Address | US Core Patient | Patient.telecom(system=email) | update_patient | partial | v0.3 |
| Patient Demographics/Information - Related Person's Name | US Core RelatedPerson | RelatedPerson.name | none | deferred | v0.5 |
| Patient Demographics/Information - Related Person's Relationship | US Core RelatedPerson | RelatedPerson.relationship | none | deferred | v0.5 |
| Patient Demographics/Information - Occupation | US Core Observation Occupation | Observation | none | deferred | v0.5 |
| Patient Demographics/Information - Occupation Industry | US Core Observation Occupation | Observation | none | deferred | v0.5 |
| Problems - Problems | US Core Condition Problems and Health Concerns | Condition.category = problem-list-item | buildProblemListCondition / create_problem_list_condition | captured | v0.35a |
| Problems - SDOH Problems/Health Concerns | US Core Condition Problems and Health Concerns | Condition.category = health-concern | buildHealthConcernCondition | stub | v0.35a |
| Problems - Date of Diagnosis | US Core Condition Problems and Health Concerns | Condition.onset[x] / recordedDate | condition builders | partial | v0.35a |
| Problems - Date of Resolution | US Core Condition Problems and Health Concerns | Condition.abatement[x] | condition builders / update_condition_status | partial | v0.35a |
| Procedures - Procedures | US Core Procedure | Procedure | buildProcedure / create_procedure | captured | v0.35a |
| Procedures - SDOH Interventions | US Core Procedure | Procedure | buildProcedure / create_procedure | stub | v0.5 |
| Procedures - Reason for Referral | US Core ServiceRequest / Procedure | ServiceRequest.reasonCode / Procedure.reasonCode | none | deferred | v0.5 |
| Provenance - Author Time Stamp | US Core Provenance | Provenance.recorded | buildProvenance / default-on sidecars | captured | v0.3 |
| Provenance - Author Organization | US Core Provenance | Provenance.agent.who Organization | buildProvenance | partial | v0.35a |
| Unique Device Identifier(s) for a Patient's Implantable Device(s) - Unique Device Identifier(s) for a patient's implantable device(s) | US Core Implantable Device | Device.udiCarrier | none | deferred | v0.6 |
| Vital Signs - Systolic Blood Pressure | US Core Vital Signs | Observation | none | deferred | v0.5 |
| Vital Signs - Diastolic Blood Pressure | US Core Vital Signs | Observation | none | deferred | v0.5 |
| Vital Signs - Heart Rate | US Core Vital Signs | Observation | none | deferred | v0.5 |
| Vital Signs - Respiratory Rate | US Core Vital Signs | Observation | none | deferred | v0.5 |
| Vital Signs - Body Temperature | US Core Vital Signs | Observation | none | deferred | v0.5 |
| Vital Signs - Body Height | US Core Vital Signs | Observation | none | deferred | v0.5 |
| Vital Signs - Body Weight | US Core Vital Signs | Observation | none | deferred | v0.5 |
| Vital Signs - Pulse Oximetry | US Core Vital Signs | Observation | none | deferred | v0.5 |
| Vital Signs - Inhaled Oxygen Concentration | US Core Vital Signs | Observation | none | deferred | v0.5 |
| Vital Signs - BMI Percentile (2 - 20 years) | US Core Vital Signs | Observation | none | deferred | v0.5 |
| Vital Signs - Weight-for-length Percentile (Birth - 24 Months) | US Core Vital Signs | Observation | none | deferred | v0.5 |
| Vital Signs - Head Occipital-frontal Circumference Percentile (Birth-36 Months) | US Core Vital Signs | Observation | none | deferred | v0.5 |

## Notes

- VA, IOP, and refraction Observations are tracked under OSOD eye-observation / USCDI Clinical Tests coverage, not under USCDI Vital Signs. US Core Vital Signs is reserved here for general physiologic vitals such as blood pressure, pulse, temperature, height, and weight.
- `health-concern` builder support ships in v0.35a as a stubbed write path so v0.5 does not refactor the Condition model; Director UI for Health Concerns is not part of v0.35a or v0.35b.

## Future Tracking

USCDI v6 added ophthalmic LOINC codes for intraocular pressure (`79892-6`) and visual acuity (`78573-3`). Those codes are candidates for v0.5+ validator-pass consideration. Pulling them into v0.35 capture is out of scope; v0.35 preserves the v0.3 SNOMED + LOINC ophthalmology coding already shipped.
