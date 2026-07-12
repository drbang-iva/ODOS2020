import type {
  Appointment,
  Encounter,
  Patient,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";

const FLOOR_STATE_URL = "https://osod.dev/fhir/StructureDefinition/osod-floor-state";

export type ClinicFlowState = "with-you" | "roomed" | "waiting" | "checked-out" | "scheduled";

export interface ClinicFlowRow {
  appointmentId?: string;
  encounterId?: string;
  patientId?: string;
  time: string;
  patient: string;
  age?: number;
  sex?: "F" | "M" | "X" | "U";
  visitType: string;
  state: ClinicFlowState;
  stateDetail: string;
  room?: string;
  timeInOfficeMinutes?: number;
  waitingMinutes?: number;
  arrivedLateMinutes?: number;
  flags: { unsigned: boolean };
}

export interface ClinicSignatureRow {
  encounterId: string;
  patientId?: string;
  patient: string;
  visitType: string;
  checkoutAt: string;
  ageMinutes: number;
  olderThan24Hours: boolean;
}

export interface ClinicSummary {
  flow: ClinicFlowRow[];
  signatures: {
    count: number;
    olderThan24Hours: number;
    rows: ClinicSignatureRow[];
  };
  erx: { available: false; message: string };
  review: { available: false; message: string };
}

export interface ClinicSummaryInput {
  appointments: Appointment[];
  encounters: Encounter[];
  patients: Patient[];
  provenances: Provenance[];
  now: string;
  date: string;
  timeZone?: string;
}

export function projectClinicSummary(input: ClinicSummaryInput): ClinicSummary {
  const nowMs = Date.parse(input.now);
  const patients = new Map<string, Patient>(input.patients.flatMap((patient) => patient.id ? [[`Patient/${patient.id}`, patient] as const] : []));
  const currentAppointments = input.appointments.filter((appointment) =>
    appointment.status !== "cancelled" && appointment.status !== "noshow" && appointment.status !== "entered-in-error",
  );
  const encountersByAppointment = new Map<string, Encounter>();
  const encountersByPatient = new Map<string, Encounter[]>();

  for (const encounter of input.encounters) {
    for (const appointment of encounter.appointment ?? []) {
      if (appointment.reference) encountersByAppointment.set(appointment.reference, encounter);
    }
    if (encounter.subject?.reference) {
      const current = encountersByPatient.get(encounter.subject.reference) ?? [];
      current.push(encounter);
      encountersByPatient.set(encounter.subject.reference, current);
    }
  }

  const checkoutTimes = new Map(input.encounters.flatMap((encounter) =>
    encounter.id && encounter.status === "finished" && encounter.period?.end
      ? [[encounter.id, encounter.period.end] as const]
      : [],
  ));
  // EncounterHeader passes one instant to both Encounter.period.end and the transaction's
  // Provenance.recorded. Exact equality is the persisted sign-off contract; a nearby audit
  // event must not silently sign a chart.
  const signedEncounterIds = new Set(input.provenances.flatMap((provenance) =>
    (provenance.target ?? []).flatMap((target) => {
      const encounterId = target.reference?.match(/^Encounter\/([^/]+)$/)?.[1];
      const checkoutAt = encounterId ? checkoutTimes.get(encounterId) : undefined;
      return encounterId && checkoutAt && sameInstant(provenance.recorded, checkoutAt) ? [encounterId] : [];
    }),
  ));

  const flow = currentAppointments.map((appointment) => {
    const patientReference = patientReferenceOf(appointment);
    const patient = patientReference ? patients.get(patientReference) : undefined;
    const encounter = encounterForAppointment(appointment, patientReference, encountersByAppointment, encountersByPatient);
    const floorState = floorStateOf(appointment);
    const state = flowState(encounter, appointment);
    const checkedInAt = floorState?.checkedInAt ?? floorState?.since ?? (encounter?.status === "arrived" ? encounter.period?.start : undefined);
    const checkoutAt = encounter?.status === "finished" ? encounter.period?.end : undefined;
    const endMs = checkoutAt ? Date.parse(checkoutAt) : nowMs;
    const timeInOfficeMinutes = checkedInAt ? minutesBetween(Date.parse(checkedInAt), endMs) : undefined;
    const waitingSince = floorState?.since ?? checkedInAt;
    const waitingMinutes = (state === "waiting" || state === "roomed") && waitingSince
      ? minutesBetween(Date.parse(waitingSince), nowMs)
      : undefined;
    const arrivedLateMinutes = checkedInAt && appointment.start
      ? Math.max(0, minutesBetween(Date.parse(appointment.start), Date.parse(checkedInAt)))
      : undefined;
    const row = {
      ...(appointment.id ? { appointmentId: appointment.id } : {}),
      ...(encounter?.id ? { encounterId: encounter.id } : {}),
      ...(patientReference?.match(/^Patient\/([^/]+)$/)?.[1] ? { patientId: patientReference.split("/")[1] } : {}),
      time: timeLabel(appointment.start, input.timeZone),
      patient: patientName(appointment, patient),
      ...(patient?.birthDate ? { age: ageOnDate(patient.birthDate, input.date) } : {}),
      ...(patient?.gender ? { sex: sexLabel(patient.gender) } : {}),
      visitType: visitTypeOf(appointment, encounter),
      state,
      stateDetail: stateDetail(state, encounter, input.timeZone),
      ...(floorState?.station ? { room: roomLabel(floorState.station) } : {}),
      ...(timeInOfficeMinutes !== undefined ? { timeInOfficeMinutes } : {}),
      ...(waitingMinutes !== undefined ? { waitingMinutes } : {}),
      ...(arrivedLateMinutes !== undefined ? { arrivedLateMinutes } : {}),
      flags: { unsigned: encounter?.status === "finished" && encounter.id !== undefined && !signedEncounterIds.has(encounter.id) },
    } satisfies ClinicFlowRow;
    return { row, startMs: Date.parse(appointment.start ?? "") };
  }).sort((left, right) => compareFlowRows(left.row, right.row) || finiteSortTime(left.startMs) - finiteSortTime(right.startMs))
    .map(({ row }) => row);

  const signatures = input.encounters
    .filter((encounter) => encounter.status === "finished" && encounter.id && !signedEncounterIds.has(encounter.id))
    .flatMap((encounter): ClinicSignatureRow[] => {
      if (!encounter.id) return [];
      const checkoutAt = encounter.period?.end ?? encounter.meta?.lastUpdated;
      if (!checkoutAt || !Number.isFinite(Date.parse(checkoutAt))) return [];
      const ageMinutes = Math.max(0, minutesBetween(Date.parse(checkoutAt), nowMs));
      const patientReference = encounter.subject?.reference;
      const patient = patientReference ? patients.get(patientReference) : undefined;
      return [{
        encounterId: encounter.id,
        ...(patientReference?.match(/^Patient\/([^/]+)$/)?.[1] ? { patientId: patientReference.split("/")[1] } : {}),
        patient: patientResourceName(patient) ?? encounter.subject?.display ?? "Patient",
        visitType: encounter.type?.[0]?.text ?? encounter.type?.[0]?.coding?.[0]?.display ?? encounter.type?.[0]?.coding?.[0]?.code ?? "Visit",
        checkoutAt,
        ageMinutes,
        olderThan24Hours: ageMinutes > 24 * 60,
      }];
    })
    .sort((left, right) => right.ageMinutes - left.ageMinutes);

  return {
    flow,
    signatures: {
      count: signatures.length,
      olderThan24Hours: signatures.filter((row) => row.olderThan24Hours).length,
      rows: signatures,
    },
    erx: {
      available: false,
      message: "E-prescribing and refill queues arrive with the WENO integration — not wired yet.",
    },
    review: {
      available: false,
      message: "Captured results do not yet persist a clinician-reviewed event — review queue not wired yet.",
    },
  };
}

export async function loadClinicSummary(
  fhir: Pick<MedplumClient, "search">,
  options: { now?: string; date?: string; timeZone?: string } = {},
): Promise<ClinicSummary> {
  const now = options.now ?? new Date().toISOString();
  const date = options.date ?? practiceDate(now, options.timeZone);
  const [appointments, encounters] = await Promise.all([
    searchOnePage<Appointment>(fhir, "Appointment", { date, _count: "1000", _sort: "date" }),
    searchOnePage<Encounter>(fhir, "Encounter", { date, _count: "1000", _sort: "date" }),
  ]);
  const encounterReferences = encounters.flatMap((encounter) => encounter.id ? [`Encounter/${encounter.id}`] : []);
  const patientIds = unique([
    ...appointments.flatMap((appointment) => patientReferenceOf(appointment)?.match(/^Patient\/([^/]+)$/)?.[1] ?? []),
    ...encounters.flatMap((encounter) => encounter.subject?.reference?.match(/^Patient\/([^/]+)$/)?.[1] ?? []),
  ]);
  const [provenances, patients] = await Promise.all([
    encounterReferences.length === 0 ? Promise.resolve([]) : searchOnePage<Provenance>(fhir, "Provenance", {
      target: encounterReferences.join(","),
      _count: "1000",
      _sort: "-recorded",
    }),
    patientIds.length === 0 ? Promise.resolve([]) : searchOnePage<Patient>(fhir, "Patient", {
      _id: patientIds.join(","),
      _count: String(patientIds.length),
    }),
  ]);
  return projectClinicSummary({ appointments, encounters, patients, provenances, now, date, timeZone: options.timeZone });
}

async function searchOnePage<T extends Resource>(
  fhir: Pick<MedplumClient, "search">,
  resourceType: T["resourceType"],
  params: Record<string, string>,
): Promise<T[]> {
  const bundle = await fhir.search<T>(resourceType, params);
  if (bundle.link?.some((link) => link.relation === "next")) {
    throw new Error(`${resourceType} clinic-summary query exceeded one FHIR page; refusing partial counts.`);
  }
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function encounterForAppointment(
  appointment: Appointment,
  patientReference: string | undefined,
  byAppointment: ReadonlyMap<string, Encounter>,
  byPatient: ReadonlyMap<string, Encounter[]>,
): Encounter | undefined {
  if (appointment.id) {
    const explicit = byAppointment.get(`Appointment/${appointment.id}`);
    if (explicit) return explicit;
  }
  if (!patientReference) return undefined;
  const candidates = byPatient.get(patientReference) ?? [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

function flowState(encounter: Encounter | undefined, appointment: Appointment): ClinicFlowState {
  if (encounter?.status === "in-progress") return "with-you";
  if (encounter?.status === "triaged") return "roomed";
  if (encounter?.status === "arrived") return "waiting";
  if (encounter?.status === "finished" || appointment.status === "fulfilled") return "checked-out";
  if (appointment.status === "arrived" || appointment.status === "checked-in") return "waiting";
  return "scheduled";
}

function compareFlowRows(left: ClinicFlowRow, right: ClinicFlowRow): number {
  const rank: Record<ClinicFlowState, number> = { "with-you": 0, roomed: 1, waiting: 2, "checked-out": 3, scheduled: 4 };
  return rank[left.state] - rank[right.state];
}

function finiteSortTime(value: number): number {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function stateDetail(state: ClinicFlowState, encounter: Encounter | undefined, timeZone?: string): string {
  if (state === "with-you") return "with you";
  if (state === "roomed") return "roomed · workup done";
  if (state === "waiting") return "checked in";
  if (state === "checked-out") return `checked out${encounter?.period?.end ? ` ${timeLabel(encounter.period.end, timeZone)}` : ""}`;
  return "scheduled · not arrived";
}

function floorStateOf(appointment: Appointment): { station: string; since: string; checkedInAt?: string } | undefined {
  const values = appointment.extension?.find((extension) => extension.url === FLOOR_STATE_URL)?.extension;
  const station = values?.find((extension) => extension.url === "station")?.valueString;
  const since = values?.find((extension) => extension.url === "since")?.valueInstant;
  const checkedInAt = values?.find((extension) => extension.url === "checkedInAt")?.valueInstant;
  return station && since ? { station, since, ...(checkedInAt ? { checkedInAt } : {}) } : undefined;
}

function roomLabel(station: string): string {
  return station.split(/[-_\s]+/).map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : "").join(" ");
}

function patientReferenceOf(appointment: Appointment): string | undefined {
  return appointment.participant?.find((participant) => participant.actor?.reference?.startsWith("Patient/"))?.actor?.reference;
}

function patientName(appointment: Appointment, patient: Patient | undefined): string {
  return patientResourceName(patient)
    ?? appointment.participant?.find((participant) => participant.actor?.reference?.startsWith("Patient/"))?.actor?.display
    ?? "Patient";
}

function patientResourceName(patient: Patient | undefined): string | undefined {
  const name = patient?.name?.find((candidate) => candidate.use === "usual") ?? patient?.name?.[0];
  const value = [name?.given?.join(" "), name?.family].filter(Boolean).join(" ");
  return value || undefined;
}

function visitTypeOf(appointment: Appointment, encounter: Encounter | undefined): string {
  return appointment.serviceType?.[0]?.text
    ?? appointment.serviceType?.[0]?.coding?.[0]?.display
    ?? appointment.serviceType?.[0]?.coding?.[0]?.code
    ?? encounter?.type?.[0]?.text
    ?? encounter?.type?.[0]?.coding?.[0]?.display
    ?? encounter?.type?.[0]?.coding?.[0]?.code
    ?? "Visit";
}

function ageOnDate(birthDate: string, onDate: string): number {
  const [year, month, day] = birthDate.split("-").map(Number);
  const [onYear, onMonth, onDay] = onDate.split("-").map(Number);
  return onYear - year - (onMonth < month || (onMonth === month && onDay < day) ? 1 : 0);
}

function sexLabel(gender: Patient["gender"]): "F" | "M" | "X" | "U" {
  if (gender === "female") return "F";
  if (gender === "male") return "M";
  if (gender === "other") return "X";
  return "U";
}

function timeLabel(value: string | undefined, timeZone: string | undefined): string {
  if (!value) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function minutesBetween(startMs: number, endMs: number): number {
  return Math.max(0, Math.floor((endMs - startMs) / 60_000));
}

function sameInstant(left: string | undefined, right: string): boolean {
  const leftMs = Date.parse(left ?? "");
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && leftMs === rightMs;
}

function practiceDate(now: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
