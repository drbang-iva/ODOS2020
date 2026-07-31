import type {
  AllergyIntolerance,
  CarePlan,
  Condition,
  Encounter,
  MedicationRequest,
  MedicationStatement,
  Observation,
  Patient,
} from "@medplum/fhirtypes";

export interface CorrespondenceClinicalSummary {
  conditions: Condition[];
  medicationRequests: MedicationRequest[];
  medicationStatements: MedicationStatement[];
  allergies: AllergyIntolerance[];
}

export interface CorrespondenceTokenContext {
  patient: Patient;
  encounter: Encounter;
  recipientName: string;
  senderName: string;
  senderCredentials: string;
  practicePhone: string;
  consultQuestion?: string;
  findings: Observation[];
  plans: CarePlan[];
  history: Encounter[];
  clinicalSummary: CorrespondenceClinicalSummary;
}
