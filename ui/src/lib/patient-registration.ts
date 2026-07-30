import type { Patient } from "@medplum/fhirtypes";
import { assertTransactionSuccess, createdIdFromEntry } from "./encounter-bundles";
import { fhir } from "./fhir";
import { emptySubscriber, subscriberFromPatient } from "./patient-insurance";
import {
  buildPatientIdentityTransaction,
  ODOS_MRN_MAX,
  ODOS_MRN_MIN,
  emptySelfResponsibleParty,
  reserveOdosMrn,
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
  | { kind: "created"; patient: Patient };

export interface PatientRegistrationOptions {
  responsibleParties?: readonly ResponsiblePartyDraft[];
  today?: string;
  nextMrnBase?: () => number;
  nextUuid?: () => string;
}

type PatientWriteApi = Pick<
  typeof fhir,
  "search" | "create" | "read" | "executeTransaction" | "update"
>;

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
  api: PatientWriteApi = fhir,
  options: PatientRegistrationOptions = {},
): Promise<PatientRegistrationResult> {
  const errors = validatePatientRegistration(draft, options);
  if (Object.keys(errors).length) throw new Error(Object.values(errors).join(" "));
  const bundle = await api.search<Patient>("Patient", {
    given: draft.firstName.trim(),
    family: draft.lastName.trim(),
    birthdate: draft.birthDate,
  });
  const patients = (bundle.entry ?? [])
    .flatMap((entry) => entry.resource ? [entry.resource] : [])
    .filter((patient) => isExactDuplicate(patient, draft));
  if (patients.length) return { kind: "duplicates", patients };
  return { kind: "created", patient: await createPatient(draft, api, options) };
}

export async function createPatient(
  draft: PatientDemographicsDraft,
  api: Pick<typeof fhir, "create" | "read" | "executeTransaction"> = fhir,
  options: PatientRegistrationOptions = {},
): Promise<Patient> {
  const errors = validatePatientRegistration(draft, options);
  if (Object.keys(errors).length) throw new Error(Object.values(errors).join(" "));
  const nextUuid = options.nextUuid ?? crypto.randomUUID.bind(crypto);
  const reservation = await reserveOdosMrn(
    {
      createReservation: (account, ifNoneExist) =>
        api.create(account, "patient-mrn-reservation", { "If-None-Exist": ifNoneExist }),
    },
    options.nextMrnBase ?? secureMrnBase,
    nextUuid,
  );
  const response = await api.executeTransaction(
    buildPatientIdentityTransaction({
      patient: buildPatientResource(draft),
      reservation,
      responsibleParties: registrationResponsibleParties(options),
      today: registrationToday(options),
      nextUuid,
    }),
    "patient-registration",
  );
  assertTransactionSuccess(response);
  return api.read<Patient>("Patient", createdIdFromEntry(response, 0, "Patient"));
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
    save: (draft: PatientDemographicsDraft) =>
      api.update(buildPatientResource(draft, patient), "patient-demographics-update"),
    discard: () => patientDemographicsFromPatient(patient),
  };
}

function isExactDuplicate(patient: Patient, draft: PatientDemographicsDraft): boolean {
  const name = patient.name?.find((candidate) => candidate.use === "official") ?? patient.name?.[0];
  return normalized(name?.given?.[0]) === normalized(draft.firstName)
    && normalized(name?.family) === normalized(draft.lastName)
    && patient.birthDate === draft.birthDate;
}

function normalized(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? "";
}

function isR4Date(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
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
  const next = telecom.filter((_, index) => index !== replaceIndex);
  if (value) next.push({ ...(replaceIndex >= 0 ? telecom[replaceIndex] : undefined), system, use: "home", value });
  return next;
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
  return options.today ?? new Date().toISOString().slice(0, 10);
}

function secureMrnBase(): number {
  const range = ODOS_MRN_MAX - ODOS_MRN_MIN + 1;
  const ceiling = 2 ** 32 - ((2 ** 32) % range);
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= ceiling);
  return ODOS_MRN_MIN + (value[0] % range);
}
