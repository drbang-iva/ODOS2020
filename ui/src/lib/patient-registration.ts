import type { CommunicationPreferencesInput } from "./communications-client";
import type { Patient } from "@medplum/fhirtypes";
import { fhir } from "./fhir";
import { emptySubscriber, subscriberFromPatient } from "./patient-insurance";
import {
  emptySelfResponsibleParty,
  isR4Date,
  validateResponsibleParties,
  type ResponsiblePartyDraft,
} from "./patient-identity";

export type PatientGender = "male" | "female" | "other" | "unknown";

export interface PatientDemographicsDraft {
  firstName: string;
  middleName: string;
  lastName: string;
  preferredName: string;
  birthDate: string;
  gender: PatientGender | "";
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
}

export type PatientRegistrationResult =
  | { kind: "duplicates"; patients: Patient[] }
  | {
      kind: "created";
      patient: Patient;
      warning?: {
        code: "access-grant-repair-required";
        message: string;
        patientReference: string;
      };
    };
export type CreatedPatientRegistrationResult = Extract<PatientRegistrationResult, { kind: "created" }>;

export interface PatientRegistrationOptions {
  responsibleParties?: readonly ResponsiblePartyDraft[];
  today?: string;
  communicationPreferences?: CommunicationPreferencesInput;
}

export function emptyPatientDemographics(): PatientDemographicsDraft {
  return {
    ...emptySubscriber(),
    gender: "",
    preferredName: "",
    phone: "",
    email: "",
  };
}

export function patientDemographicsFromPatient(patient: Patient): PatientDemographicsDraft {
  const subscriber = subscriberFromPatient(patient);
  const preferred = patient.name?.find((name) => name.use === "usual");
  const phone = preferredTelecom(patient, "phone");
  const email = preferredTelecom(patient, "email");
  return {
    ...subscriber,
    preferredName: preferred?.given?.join(" ") ?? "",
    phone: phone?.value ?? "",
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
  if (!draft.phone.trim()) {
    errors.phone = "Phone number is required.";
  } else if (!isPhoneNumber(draft.phone)) {
    errors.phone = "Enter a valid phone number.";
  }
  if (draft.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) {
    errors.email = "Enter a valid email address.";
  }
  return errors;
}

export function buildPatientResource(draft: PatientDemographicsDraft, existing?: Patient): Patient {
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

  return {
    ...(existing ?? {}),
    resourceType: "Patient",
    name: names,
    birthDate: draft.birthDate,
    gender: draft.gender as PatientGender,
    telecom: replacePreferredTelecom(
      replacePreferredTelecom(existing?.telecom ?? [], "phone", draft.phone.trim()),
      "email",
      draft.email.trim(),
    ),
    address: addresses,
  };
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
    ),
  };
}

export function createPatientDemographicsActions(
  patient: Patient,
  api: Pick<typeof fhir, "update"> = fhir,
) {
  return {
    save: (draft: PatientDemographicsDraft) => {
      const versionId = patient.meta?.versionId;
      if (!versionId) throw new Error("Patient version is unavailable. Reload before saving demographics.");
      return api.update(buildPatientResource(draft, patient), "patient-demographics-update", versionId);
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
      demographics: draft,
      responsibleParties: registrationResponsibleParties(options),
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
  if (value.warning === undefined) return true;
  return isObject(value.warning)
    && value.warning.code === "access-grant-repair-required"
    && typeof value.warning.message === "string"
    && typeof value.warning.patientReference === "string";
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

function isPhoneNumber(value: string): boolean {
  if (!/^\+?[\d\s().-]+(?:\s*(?:x|ext\.?)\s*\d+)?$/i.test(value.trim())) return false;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

function preferredTelecom(patient: Patient, system: "phone" | "email") {
  return patient.telecom?.find((entry) => entry.system === system && entry.use === "home")
    ?? patient.telecom?.find((entry) => entry.system === system);
}

function replacePreferredTelecom(
  telecom: NonNullable<Patient["telecom"]>,
  system: "phone" | "email",
  value: string,
): NonNullable<Patient["telecom"]> {
  const preferredIndex = telecom.findIndex((entry) => entry.system === system && entry.use === "home");
  const fallbackIndex = telecom.findIndex((entry) => entry.system === system);
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
