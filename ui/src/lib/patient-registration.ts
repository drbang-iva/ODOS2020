import type { CommunicationPreferencesInput } from "./communications-client";
import type { Patient } from "@medplum/fhirtypes";
import type { PatientDraftPhone, PatientPhoneUse, PatientTelecomSnapshot, PatientTextableAnswer } from "../../../mcp/src/clinic/patient-telecom";
import { applyPatientTextableAnswer, createPatientPhone, validatePatientPhones, ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL, ODOS_TEXTABLE_NUMBER_EXTENSION_URL } from "../../../mcp/src/clinic/patient-telecom";
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
    ...patientPhoneDraft(patient, now),
    email: email?.value ?? "",
  };
}

function emptyPatientPhone(): PatientDraftPhone {
  return { value: "", use: "mobile", sourceIndex: null };
}

function patientPhoneDraft(patient: Patient, now: string): Pick<PatientDemographicsDraft, "phones" | "textable"> {
  const time = Date.parse(now);
  const marked = (point: NonNullable<Patient["telecom"]>[number]) => point.extension?.some(
    entry => entry.url === ODOS_TEXTABLE_NUMBER_EXTENSION_URL && entry.valueBoolean === true,
  ) ?? false;
  const priority = (point: NonNullable<Patient["telecom"]>[number]) => marked(point) ? 0 : point.system === "sms" ? 1 : point.use === "mobile" ? 2 : 3;
  const candidates = (patient.telecom ?? []).map((point, sourceIndex) => ({ point, sourceIndex })).filter(({ point }) =>
    (point.system === "sms" || point.system === "phone")
    && point.use !== "old"
    && Boolean(point.value?.trim())
    && (!point.period?.start || Date.parse(point.period.start) <= time)
    && (!point.period?.end || Date.parse(point.period.end) > time))
    .sort((a, b) => priority(a.point) - priority(b.point) || a.sourceIndex - b.sourceIndex);
  const slot = (index: number): PatientDraftPhone => {
    const candidate = candidates[index];
    if (!candidate) return emptyPatientPhone();
    const { point, sourceIndex } = candidate;
    return { value: point.value!, use: point.use === "mobile" || point.use === "home" || point.use === "work" ? point.use : "other", sourceIndex };
  };
  return {
    phones: [slot(0), slot(1)],
    textable: patient.extension?.some(entry => entry.url === ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL && entry.valueBoolean === true)
      ? "neither" : candidates[0] && marked(candidates[0].point) ? "phone1" : candidates[1] && marked(candidates[1].point) ? "phone2" : "",
  };
}

export function patientTelecomSnapshot(patient: Patient, now: string): PatientTelecomSnapshot {
  return Object.freeze({
    now,
    loadedTextable: patientPhoneDraft(patient, now).textable,
    entries: Object.freeze((patient.telecom ?? []).map(point => Object.freeze({
      ...(point.system === undefined ? {} : { system: point.system }),
      ...(point.value === undefined ? {} : { value: point.value }),
      ...(point.use === undefined ? {} : { use: point.use }),
    }))),
  });
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

  const phoneEntries = new Map<PatientDraftPhone, NonNullable<Patient["telecom"]>[number]>();
  for (const slot of draft.phones) {
    if (slot.sourceIndex === null) continue;
    const original = snapshot?.entries[slot.sourceIndex];
    const held = existing?.telecom?.[slot.sourceIndex];
    if (!original || !held || held.system !== original.system || held.value !== original.value || held.use !== original.use) {
      throw new Error("Contact information changed on the server. Reload before saving.");
    }
  }
  let telecom = (existing?.telecom ?? []).flatMap((point, index) => {
    const slot = draft.phones.find(phone => phone.sourceIndex === index);
    if (!slot) return [point];
    if (!slot.value.trim()) return [];
    const original = snapshot!.entries[index];
    const useChanged = slot.use !== "other" && slot.use !== original.use;
    const changed = slot.value !== original.value || useChanged;
    const entry = changed ? { ...point, value: slot.value.trim(), ...(useChanged ? { use: slot.use as PatientPhoneUse } : {}) } : point;
    phoneEntries.set(slot, entry);
    return [entry];
  });
  for (const slot of draft.phones) {
    if (slot.sourceIndex !== null) continue;
    const entry = createPatientPhone({ value: slot.value, use: slot.use as PatientPhoneUse });
    if (entry) { telecom.push(entry); phoneEntries.set(slot, entry); }
  }
  telecom = replacePreferredTelecom(telecom, "email", draft.email.trim());
  let patient: Patient = {
    ...(existing ?? {}),
    resourceType: "Patient",
    name: names,
    birthDate: draft.birthDate,
    gender: draft.gender as PatientGender,
    telecom: existing?.telecom === undefined && !telecom.length ? undefined : telecom,
    address: addresses,
  };
  if (draft.textable !== (snapshot?.loadedTextable ?? "") && draft.textable) {
    const answer = draft.textable === "neither" ? "neither" : phoneEntries.get(draft.phones[draft.textable === "phone1" ? 0 : 1])!;
    patient = applyPatientTextableAnswer(patient, answer);
  }
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
