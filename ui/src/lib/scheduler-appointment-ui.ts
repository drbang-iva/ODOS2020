import type { Appointment, HealthcareService, Patient, Schedule } from "@medplum/fhirtypes";
import {
  appointmentDurationMinutes,
  appointmentVisitTypeCode,
  confirmationStatusOf,
  isoFromDateAndMinutes,
  isFollowUpAppointment,
  isUrgentAppointment,
  medicalCoverageOf,
  osodAppointmentStatusOf,
  scheduleReference,
  scheduleReferenceForActor,
  timezoneOffsetMinutes,
  visitTypeCode,
  visitTypeDurationMinutes,
  visibleSchedulingVisitTypes,
  visionCoverageOf,
  type AppointmentConfirmationStatus,
  type BookSchedulingAppointmentInput,
  type ClinicMode,
  type CoverageInput,
  type OsodAppointmentStatus,
} from "./scheduling";
import type { AppointmentChangeInput } from "./scheduling-store";

export interface AppointmentModalDraft {
  patient?: { reference: string; display?: string };
  nonPatient: boolean;
  description: string;
  visitTypeCode: string;
  resourceScheduleReferences: string[];
  start: string;
  durationMinutes: number;
  status: OsodAppointmentStatus;
  confirmation: AppointmentConfirmationStatus;
  visionCoverageReference: string;
  visionCoverageDisplay: string;
  medicalCoverageReference: string;
  medicalCoverageDisplay: string;
  notes: string;
  urgent: boolean;
  followUp: boolean;
}

export interface PatientQuickCardViewModel {
  name: string;
  birthDate: string;
  age: number | undefined;
  birthSex: string;
  phones: string[];
  emails: string[];
  address: string;
  mrn: string;
  ssnLast4: string;
  provider: string;
}

export function defaultAppointmentModalDraft(input: {
  date: string;
  startMinutes: number;
  timezoneOffset: string;
  resources: Schedule[];
  visitTypes: HealthcareService[];
  clinicMode: ClinicMode | string;
  resource: Schedule;
  status?: OsodAppointmentStatus;
}): AppointmentModalDraft {
  const visibleVisitTypes = visibleSchedulingVisitTypes(input.visitTypes, input.clinicMode);
  const visitType = visibleVisitTypes[0];
  const visitTypeCodeValue = visitType ? visitTypeCode(visitType) : undefined;
  const resourceReference = scheduleReference(input.resource);
  return {
    nonPatient: false,
    description: "",
    visitTypeCode: visitTypeCodeValue ?? "",
    resourceScheduleReferences: resourceReference ? [resourceReference] : [],
    start: isoFromDateAndMinutes(input.date, input.startMinutes, input.timezoneOffset),
    durationMinutes: (visitType ? visitTypeDurationMinutes(visitType) : undefined) ?? 30,
    status: input.status ?? "scheduled",
    confirmation: "not-confirmed",
    visionCoverageReference: "",
    visionCoverageDisplay: "",
    medicalCoverageReference: "",
    medicalCoverageDisplay: "",
    notes: "",
    urgent: false,
    followUp: false,
  };
}

export function appointmentModalDraftFromAppointment(
  appointment: Appointment,
  resources: Schedule[],
): AppointmentModalDraft {
  const patient = patientInputOf(appointment);
  const vision = visionCoverageOf(appointment);
  const medical = medicalCoverageOf(appointment);
  return {
    ...(patient ? { patient } : {}),
    nonPatient: !patient,
    description: appointment.description ?? "",
    visitTypeCode: appointmentVisitTypeCode(appointment) ?? "",
    resourceScheduleReferences: resourceScheduleReferencesOf(resources, appointment),
    start: appointment.start ?? "",
    durationMinutes: appointmentDurationMinutes(appointment) ?? 30,
    status: osodAppointmentStatusOf(appointment) ?? "scheduled",
    confirmation: confirmationStatusOf(appointment) ?? "not-confirmed",
    visionCoverageReference: vision?.reference ?? "",
    visionCoverageDisplay: vision?.display ?? "",
    medicalCoverageReference: medical?.reference ?? "",
    medicalCoverageDisplay: medical?.display ?? "",
    notes: appointment.comment ?? "",
    urgent: isUrgentAppointment(appointment),
    followUp: isFollowUpAppointment(appointment),
  };
}

export function draftToBookInput(
  draft: AppointmentModalDraft,
  allowDoubleBook = false,
): BookSchedulingAppointmentInput {
  const durationMinutes = validDurationMinutes(draft.durationMinutes);
  return {
    ...(draft.nonPatient ? {} : draft.patient ? { patient: draft.patient } : {}),
    ...(draft.nonPatient || draft.description.trim() ? { description: draft.description.trim() } : {}),
    visitTypeCode: draft.visitTypeCode,
    resourceScheduleReferences: draft.resourceScheduleReferences,
    start: draft.start,
    ...(durationMinutes ? { durationMinutes } : {}),
    status: draft.status,
    confirmation: draft.confirmation,
    ...(coverageInput(draft.visionCoverageReference, draft.visionCoverageDisplay)
      ? { visionCoverage: coverageInput(draft.visionCoverageReference, draft.visionCoverageDisplay) }
      : {}),
    ...(coverageInput(draft.medicalCoverageReference, draft.medicalCoverageDisplay)
      ? { medicalCoverage: coverageInput(draft.medicalCoverageReference, draft.medicalCoverageDisplay) }
      : {}),
    ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
    urgent: draft.urgent,
    followUp: draft.followUp,
    allowDoubleBook,
  };
}

export function draftToAppointmentChanges(
  draft: AppointmentModalDraft,
  allowDoubleBook = false,
): AppointmentChangeInput {
  const durationMinutes = validDurationMinutes(draft.durationMinutes);
  return {
    patient: draft.nonPatient ? null : draft.patient,
    description: draft.description,
    visitTypeCode: draft.visitTypeCode,
    resourceScheduleReferences: draft.resourceScheduleReferences,
    start: draft.start,
    ...(durationMinutes ? { durationMinutes } : {}),
    status: draft.status,
    confirmation: draft.confirmation,
    visionCoverage: coverageInput(draft.visionCoverageReference, draft.visionCoverageDisplay) ?? null,
    medicalCoverage: coverageInput(draft.medicalCoverageReference, draft.medicalCoverageDisplay) ?? null,
    notes: draft.notes,
    urgent: draft.urgent,
    followUp: draft.followUp,
    allowDoubleBook,
  };
}

export function patientQuickCardViewModel(input: {
  patient: Patient;
  onDate: string;
}): PatientQuickCardViewModel {
  const patient = input.patient;
  return {
    name: patientName(patient),
    birthDate: patient.birthDate ?? "unknown",
    age: patient.birthDate ? ageOnDate(patient.birthDate, input.onDate) : undefined,
    birthSex: patient.gender ?? "unknown",
    phones: (patient.telecom ?? [])
      .filter((telecom) => telecom.system === "phone" && telecom.value)
      .map((telecom) => telecom.value!),
    emails: (patient.telecom ?? [])
      .filter((telecom) => telecom.system === "email" && telecom.value)
      .map((telecom) => telecom.value!),
    address: addressLine(patient) ?? "none",
    mrn: mrnOf(patient) ?? "none",
    ssnLast4: maskedSsnLast4(patient) ?? "none",
    provider: patient.generalPractitioner?.[0]?.display ?? patient.generalPractitioner?.[0]?.reference ?? "none",
  };
}

export function patientName(patient: Patient): string {
  const name = patient.name?.[0];
  if (!name) {
    return "Unknown patient";
  }
  return `${name.given?.join(" ") ?? ""} ${name.family ?? ""}`.trim() || "Unknown patient";
}

export function maskedSsnLast4(patient: Patient): string | undefined {
  const identifier = patient.identifier?.find((candidate) => {
    const system = candidate.system?.toLowerCase() ?? "";
    const codes = candidate.type?.coding?.map((coding) => coding.code?.toUpperCase()) ?? [];
    return system.includes("ssn") || codes.includes("SS");
  });
  const digits = identifier?.value?.replace(/\D/g, "");
  if (!digits || digits.length < 4) {
    return undefined;
  }
  return `***-**-${digits.slice(-4)}`;
}

export function dateInputValue(isoDateTime: string, timezoneOffset: string): string {
  return localIsoDateTime(isoDateTime, timezoneOffset).slice(0, 10);
}

export function timeInputValue(isoDateTime: string, timezoneOffset: string): string {
  return localIsoDateTime(isoDateTime, timezoneOffset).slice(11, 16);
}

export function withDateAndTime(
  draft: AppointmentModalDraft,
  date: string,
  time: string,
  timezoneOffset: string,
): AppointmentModalDraft {
  return { ...draft, start: `${date}T${time}:00${timezoneOffset}` };
}

export async function confirmDoubleBookAndRetry(
  err: unknown,
  retry: () => Promise<void>,
): Promise<boolean> {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes("Pass allowDoubleBook to overbook")) {
    return false;
  }
  const ok = window.confirm(`${message}\n\nBook anyway (double-book)?`);
  if (!ok) {
    return false;
  }
  await retry();
  return true;
}

export function appointmentModalDurationError(draft: AppointmentModalDraft): string | undefined {
  return validDurationMinutes(draft.durationMinutes) ? undefined : "Duration must be >= 1 minute.";
}

export function patientInputOf(appointment: Appointment): { reference: string; display?: string } | undefined {
  const actor = appointment.participant.find((participant) =>
    participant.actor?.reference?.startsWith("Patient/"),
  )?.actor;
  if (!actor?.reference) {
    return undefined;
  }
  return {
    reference: actor.reference,
    ...(actor.display ? { display: actor.display } : {}),
  };
}

export function resourceScheduleReferencesOf(resources: Schedule[], appointment: Appointment): string[] {
  return appointment.participant
    .map((participant) => participant.actor?.reference)
    .filter(
      (reference): reference is string =>
        typeof reference === "string" && !reference.startsWith("Patient/"),
    )
    .map((actorReference) => scheduleReferenceForActor(resources, actorReference))
    .filter((reference): reference is string => Boolean(reference));
}

function coverageInput(reference: string, display: string): CoverageInput | undefined {
  const cleanReference = reference.trim();
  const cleanDisplay = display.trim();
  return cleanReference || cleanDisplay
    ? {
        ...(cleanReference ? { reference: cleanReference } : {}),
        ...(cleanDisplay ? { display: cleanDisplay } : {}),
      }
    : undefined;
}

function validDurationMinutes(value: number): number | undefined {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function localIsoDateTime(isoDateTime: string, timezoneOffset: string): string {
  const timestamp = Date.parse(isoDateTime);
  if (!Number.isFinite(timestamp)) {
    return isoDateTime;
  }
  return new Date(timestamp + timezoneOffsetMinutes(timezoneOffset) * 60_000).toISOString();
}

function ageOnDate(birthDate: string, onDate: string): number {
  const birth = new Date(`${birthDate}T00:00:00Z`);
  const on = new Date(`${onDate}T00:00:00Z`);
  let age = on.getUTCFullYear() - birth.getUTCFullYear();
  const birthdayPassed =
    on.getUTCMonth() > birth.getUTCMonth() ||
    (on.getUTCMonth() === birth.getUTCMonth() && on.getUTCDate() >= birth.getUTCDate());
  if (!birthdayPassed) {
    age -= 1;
  }
  return age;
}

function addressLine(patient: Patient): string | undefined {
  const address = patient.address?.[0];
  if (!address) {
    return undefined;
  }
  const street = address.line?.join(" ");
  const cityStateZip = [address.city, address.state, address.postalCode].filter(Boolean).join(", ");
  return [street, cityStateZip].filter(Boolean).join(" ") || undefined;
}

function mrnOf(patient: Patient): string | undefined {
  const identifier = patient.identifier?.find((candidate) => {
    const system = candidate.system?.toLowerCase() ?? "";
    const codes = candidate.type?.coding?.map((coding) => coding.code?.toUpperCase()) ?? [];
    return system.includes("mrn") || codes.includes("MR");
  });
  return identifier?.value;
}
