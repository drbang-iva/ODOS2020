import type { CommunicationPreferencesInput } from "./communications-client";
import type { Basic, Patient } from "@medplum/fhirtypes";
import type { PatientDraftPhone, PatientTelecomSnapshot, PatientTextableAnswer } from "../../../mcp/src/clinic/patient-telecom";
import { applyPhoneDraft, emptyPatientPhone, phoneDraft, telecomSnapshot, validatePatientPhones } from "../../../mcp/src/clinic/patient-telecom";
import { fhir } from "./fhir";
import { emptySubscriber, subscriberFromPatient } from "./patient-insurance";
import {
  emptySelfResponsibleParty,
  isR4Date,
  validateResponsibleParties,
  type ResponsiblePartyDraft,
} from "./patient-identity";

export type PatientGender = "male" | "female" | "other" | "unknown";
export type { PatientDraftPhone, PatientPhoneUse, PatientTelecomSnapshot } from "../../../mcp/src/clinic/patient-telecom";

export interface PatientDemographicsDraft {
  firstName: string;
  middleName: string;
  lastName: string;
  preferredName: string;
  birthDate: string;
  gender: PatientGender | "";
  phones: [PatientDraftPhone, PatientDraftPhone];
  textable: PatientTextableAnswer;
  email: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
}

export interface GuarantorRegistrationLink {
  relatedPersonId?: string;
  personId: string;
  taskId?: string;
  status: "linked" | "pending" | "failed" | "unconfirmed";
  message: string;
}

export type PatientRegistrationResult =
  | { kind: "duplicates"; patients: Patient[] }
  | {
      kind: "created";
      patient: Patient;
      guarantorLinks?: GuarantorRegistrationLink[];
      warning?: {
        code: "access-grant-repair-required";
        message: string;
        patientReference: string;
      };
    };
export type CreatedPatientRegistrationResult = Extract<PatientRegistrationResult, { kind: "created" }>;

export interface PatientRegistrationOptions {
  ageOfMajorityConfig?: Basic;
  responsibleParties?: readonly ResponsiblePartyDraft[];
  today?: string;
  communicationPreferences?: CommunicationPreferencesInput;
}

export function emptyPatientDemographics(): PatientDemographicsDraft {
  return {
    ...emptySubscriber(),
    gender: "",
    preferredName: "",
    phones: [emptyPatientPhone(), emptyPatientPhone()],
    textable: "",
    email: "",
  };
}

export function patientDemographicsFromPatient(patient: Patient, now = new Date().toISOString()): PatientDemographicsDraft {
  const subscriber = subscriberFromPatient(patient);
  const preferred = patient.name?.find((name) => name.use === "usual");
  const email = preferredTelecom(patient, "email");
  return {
    ...subscriber,
    preferredName: preferred?.given?.join(" ") ?? "",
    ...phoneDraft(patient, now),
    email: email?.value ?? "",
  };
}

export function validatePatientDemographics(draft: PatientDemographicsDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.firstName.trim()) errors.firstName = "Legal first name is required.";
  if (!draft.lastName.trim()) errors.lastName = "Legal last name is required.";
  if (!draft.birthDate) {
    errors.birthDate = "Date of birth is required.";
  } else if (!isR4Date(draft.birthDate)) {
    errors.birthDate = "Date of birth must be a valid YYYY-MM-DD date.";
  }
  if (!draft.gender) errors.gender = "Gender is required.";
  Object.assign(errors, validatePatientPhones(draft.phones, draft.textable));
  if (draft.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) {
    errors.email = "Enter a valid email address.";
  }
  return errors;
}

export function buildPatientResource(draft: PatientDemographicsDraft, existing?: Patient, snapshot?: PatientTelecomSnapshot): Patient {
  const errors = validatePatientDemographics(draft);
  if (Object.keys(errors).length) throw new Error(Object.values(errors).join(" "));
  let officialIndex = existing?.name?.findIndex((name) => name.use === "official") ?? -1;
  if (officialIndex < 0) {
    officialIndex = existing?.name?.findIndex((name) => name.use !== "usual") ?? -1;
  }
  const official = officialIndex >= 0 ? existing?.name?.[officialIndex] : undefined;
  const usualIndex = existing?.name?.findIndex((name) => name.use === "usual") ?? -1;
  const usual = usualIndex >= 0 ? existing?.name?.[usualIndex] : undefined;
  const names = (existing?.name ?? []).filter((_, index) => index !== officialIndex && index !== usualIndex);
  names.push({
    ...official,
    use: "official",
    given: [draft.firstName.trim(), draft.middleName.trim()].filter(Boolean),
    family: draft.lastName.trim(),
  });
  if (draft.preferredName.trim()) {
    names.push({ ...usual, use: "usual", given: [draft.preferredName.trim()] });
  }

  const homeAddressIndex = preferredAddressIndex(existing);
  const addresses = (existing?.address ?? []).filter((_, index) => index !== homeAddressIndex);
  if ([draft.address, draft.city, draft.state, draft.postalCode].some((value) => value.trim())) {
    addresses.push({
      ...(homeAddressIndex >= 0 ? existing?.address?.[homeAddressIndex] : undefined),
      use: "home",
      line: draft.address.trim() ? [draft.address.trim()] : undefined,
      city: draft.city.trim() || undefined,
      state: draft.state.trim() || undefined,
      postalCode: draft.postalCode.trim() || undefined,
    });
  }

  const phonePatient = applyPhoneDraft(existing ?? { resourceType: "Patient" }, draft, snapshot);
  const telecom = replacePreferredTelecom(phonePatient.telecom ?? [], "email", draft.email.trim());
  let patient: Patient = {
    ...phonePatient,
    resourceType: "Patient",
    name: names,
    birthDate: draft.birthDate,
    gender: draft.gender as PatientGender,
    telecom: existing?.telecom === undefined && !telecom.length ? undefined : telecom,
    address: addresses,
  };
  return patient;
}

export async function registerPatient(
  draft: PatientDemographicsDraft,
  options: PatientRegistrationOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<PatientRegistrationResult> {
  const errors = validatePatientRegistration(draft, options);
  if (Object.keys(errors).length) throw new Error(Object.values(errors).join(" "));
  return requestPatientRegistration(draft, options, false, fetchImpl);
}

export async function createPatient(
  draft: PatientDemographicsDraft,
  options: PatientRegistrationOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<CreatedPatientRegistrationResult> {
  const errors = validatePatientRegistration(draft, options);
  if (Object.keys(errors).length) throw new Error(Object.values(errors).join(" "));
  const result = await requestPatientRegistration(draft, options, true, fetchImpl);
  if (result.kind !== "created") {
    throw new Error("The server did not honor the confirmed duplicate registration.");
  }
  return result;
}

export function validatePatientRegistration(
  draft: PatientDemographicsDraft,
  options: PatientRegistrationOptions = {},
): Record<string, string> {
  return {
    ...validatePatientDemographics(draft),
    ...validateResponsibleParties(
      registrationResponsibleParties(options),
      draft.birthDate,
      registrationToday(options),
      options.ageOfMajorityConfig,
    ),
  };
}

export function createPatientDemographicsActions(
  patient: Patient,
  api: Pick<typeof fhir, "update"> = fhir,
) {
  return {
    save: (draft: PatientDemographicsDraft, snapshot: PatientTelecomSnapshot) => {
      const versionId = patient.meta?.versionId;
      if (!versionId) throw new Error("Patient version is unavailable. Reload before saving demographics.");
      return api.update(buildPatientResource(draft, patient, snapshot), "patient-demographics-update", versionId);
    },
    discard: () => patientDemographicsFromPatient(patient),
  };
}

async function requestPatientRegistration(
  draft: PatientDemographicsDraft,
  options: PatientRegistrationOptions,
  confirmDuplicate: boolean,
  fetchImpl: typeof fetch,
): Promise<PatientRegistrationResult> {
  const authorization = fhir.authHeader();
  const response = await fetchImpl("/clinic/patients", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({
      demographics: { ...draft, phones: draft.phones.map(({ value, use }) => ({ value, use })) },
      responsibleParties: registrationResponsibleParties(options).map(registrationPartyPayload),
      confirmDuplicate,
      ...(options.communicationPreferences?.cells.length ? { communicationPreferences: options.communicationPreferences } : {}),
    }),
  });
  const body = await readRegistrationResponse(response);
  if (isDuplicateResult(body) && response.status === 409) return body;
  if (!response.ok) {
    if (response.status === 403 && isErrorResponse(body) && body.error.includes("communications.preferences.manage")) {
      throw new Error("You don't have permission to change communication preferences during registration. Ask a practice administrator.");
    }
    throw new Error(
      isErrorResponse(body)
        ? body.error
        : response.status === 403
          ? "You do not have permission to register patients. Ask a practice administrator to review your role."
          : "Patient registration could not be confirmed. Check patient search before trying again, or ask a practice administrator for help.",
    );
  }
  if (!isCreatedResult(body)) {
    throw new Error("Patient registration returned an invalid response. Ask an administrator for help.");
  }
  return body;
}

async function readRegistrationResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isDuplicateResult(value: unknown): value is Extract<PatientRegistrationResult, { kind: "duplicates" }> {
  return isObject(value)
    && value.kind === "duplicates"
    && Array.isArray(value.patients)
    && value.patients.every(isPatient);
}

function isCreatedResult(value: unknown): value is Extract<PatientRegistrationResult, { kind: "created" }> {
  if (!isObject(value) || value.kind !== "created" || !isPatient(value.patient)) return false;
  const warningValid = value.warning === undefined || (isObject(value.warning)
    && value.warning.code === "access-grant-repair-required"
    && typeof value.warning.message === "string"
    && typeof value.warning.patientReference === "string");
  const linksValid = value.guarantorLinks === undefined || (Array.isArray(value.guarantorLinks) && value.guarantorLinks.every(link => isObject(link)
    && (link.relatedPersonId === undefined || typeof link.relatedPersonId === "string")
    && typeof link.personId === "string"
    && (link.taskId === undefined || typeof link.taskId === "string")
    && typeof link.status === "string"
    && ["linked", "pending", "failed", "unconfirmed"].includes(link.status)
    && typeof link.message === "string"));
  return warningValid && linksValid;
}

function isErrorResponse(value: unknown): value is { error: string } {
  return isObject(value) && typeof value.error === "string" && value.error.trim().length > 0;
}

function isPatient(value: unknown): value is Patient {
  return isObject(value) && value.resourceType === "Patient";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function preferredTelecom(patient: Patient, system: "phone" | "email") {
  return patient.telecom?.find((entry) => entry.system === system && entry.use === "home")
    ?? patient.telecom?.find((entry) => entry.system === system && entry.use !== "old");
}

function replacePreferredTelecom(
  telecom: NonNullable<Patient["telecom"]>,
  system: "phone" | "email",
  value: string,
): NonNullable<Patient["telecom"]> {
  const preferredIndex = telecom.findIndex((entry) => entry.system === system && entry.use === "home");
  const fallbackIndex = telecom.findIndex((entry) => entry.system === system && entry.use !== "old");
  const replaceIndex = preferredIndex >= 0 ? preferredIndex : fallbackIndex;
  if (!value.trim()) return telecom.filter((_, index) => index !== replaceIndex);
  if (replaceIndex < 0) return [...telecom, { system, use: "home", value }];
  return telecom.map((entry, index) => index === replaceIndex ? { ...entry, value } : entry);
}

function preferredAddressIndex(patient: Patient | undefined): number {
  const homeIndex = patient?.address?.findIndex((address) => address.use === "home") ?? -1;
  if (homeIndex >= 0) return homeIndex;
  return patient?.address?.length ? 0 : -1;
}

function registrationResponsibleParties(
  options: PatientRegistrationOptions,
): readonly ResponsiblePartyDraft[] {
  return options.responsibleParties ?? [emptySelfResponsibleParty("self")];
}

function registrationPartyPayload(party: ResponsiblePartyDraft) {
  if (party.kind === "self") return party;
  if (party.kind === "person") { return { ...party, phones: party.phones.map(({ value, use }) => ({ value, use })) }; }
  const { card: _card, previous: _previous, ...payload } = party;
  return payload;
}

function registrationToday(options: PatientRegistrationOptions): string {
  return options.today ?? localCalendarDate();
}

export function localCalendarDate(date = new Date()): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export const patientTelecomSnapshot = (patient: Patient, now: string): PatientTelecomSnapshot => telecomSnapshot(patient, now);
