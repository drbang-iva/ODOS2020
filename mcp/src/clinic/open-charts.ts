import type { Appointment, Bundle, Encounter, Patient, Practitioner, Provenance, Resource } from "@medplum/fhirtypes";
import { searchAll, searchBounded, FhirSearchLimitError, FhirSearchPageLimitError, type FhirSearchClient } from "../fhir-search.js";
import { encounterContentByEncounter, readEncounterProtocolContent } from "../clinical-graph/encounter-content.js";
import { interpretationBlocks } from "../clinical-graph/interpretation-gate.js";
import { readImagingResources } from "../clinical-graph/follow-up-queue-endpoint.js";
import { listProcedureFeeScheduleSnapshot } from "../clinical-graph/procedure-fee-schedule.js";
import { isMigratedEncounter, type OverviewFhir } from "./patient-overview.js";
import { practiceDate } from "./clinic-summary.js";
import { signedEncounterIds } from "./encounter-sign-off.js";
import type { ResolvedPracticeTimeZone } from "./practice-time-zone-config.js";

export type Owner = { reference: string; name: string } | { unassigned: true };
export type Reason = { code: "needs-interpretation" | "unclassified-fee" | "duplicate-fee" | "no-interpreted-result" | "none-found" | "nothing-charted" | "signature-missing" | "checks-unavailable"; label?: string };
export interface DoctorRow {
  encounterId: string;
  patient: { reference: string; name: string };
  visitType?: string;
  serviceStart: string;
  serviceDate: string;
  liveState?: "waiting" | "roomed" | "with you" | "checked out";
  owner: Owner;
  kind: "open" | "nothing-charted" | "signature-missing";
  reasons: Reason[];
}
export interface ReviewRow { encounterId: string; patient: { reference: string; name: string }; serviceStart?: string; owner: Owner; reason: string }
export interface DeskRow { patient: { reference: string; name: string }; owner: Owner; serviceStart: string; serviceDate: string; status: "chart open"; priorDay: boolean }
type OwnerCount = { owner: Owner; count: number; oldestServiceDate: string };
interface Completeness { complete: boolean; incomplete?: string[] }
export interface Doctor extends Completeness {
  timeZone: string; timeZoneSource: "setting" | "environment"; caller: { practitioner?: string };
  today: { date: string; rows: DoctorRow[] };
  lastClinicDay: { date: string; rows: DoctorRow[] } | null;
  older: { count: number; oldestServiceDate?: string; byOwner: OwnerCount[]; rows?: DoctorRow[] };
  needsReview: ReviewRow[];
  counts: { open: number; nothingCharted: number; signatureMissing: number; needsReview: number };
  warnings?: string[];
}
export interface Desk extends Completeness {
  timeZone: string; timeZoneSource: "setting" | "environment";
  today: { date: string; count: number; rows: DeskRow[] };
  lastClinicDay: { date: string; count: number; rows: DeskRow[] } | null;
  older: { count: number; byOwner: OwnerCount[] };
}
type Checks = Pick<DoctorRow, "kind" | "reasons">;
export interface OpenChartsInput {
  encounters: Encounter[]; provenances: Provenance[]; clinicDays: Encounter[];
  appointments: Appointment[]; patients: Patient[]; practitioners: Practitioner[];
  now: string; zone: ResolvedPracticeTimeZone; shape: "doctor" | "desk"; expandOlder?: boolean;
  practitioner?: string; checks?: Map<string, Checks>; incomplete?: string[];
}
const unfinished = new Set(["arrived", "triaged", "in-progress"]);
const reviewStatuses = new Set(["planned", "onleave", "unknown"]);
const excludedAppointments = new Set(["noshow", "cancelled", "entered-in-error"]);
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
function startOfDate(date: string, zone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  let instant = target;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (let step = 0; step < 6; step++) {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(p => [p.type, p.value]));
    const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    if (local === target) return new Date(instant).toISOString();
    instant += target - local;
  }
  throw new Error("Practice date boundary could not be resolved.");
}
function name(resource: Patient | Practitioner | undefined, fallback: string): string {
  const value = resource?.name?.find(n => n.use === "usual") ?? resource?.name?.[0];
  return value?.text || [value?.given?.join(" "), value?.family].filter(Boolean).join(" ") || fallback;
}
function ownerCounts(rows: DoctorRow[]): OwnerCount[] {
  const counts = new Map<string, OwnerCount>();
  for (const row of rows) {
    const key = "reference" in row.owner ? row.owner.reference : "unassigned";
    const current = counts.get(key);
    if (current) { current.count++; if (row.serviceDate < current.oldestServiceDate) current.oldestServiceDate = row.serviceDate; }
    else counts.set(key, { owner: row.owner, count: 1, oldestServiceDate: row.serviceDate });
  }
  return [...counts.values()];
}
export function projectOpenCharts(input: OpenChartsInput): Doctor | Desk {
  const today = practiceDate(input.now, input.zone.timeZone);
  const firstFinishedDate = shiftDate(today, -6);
  const clinicDates = input.clinicDays.filter(e => !isMigratedEncounter(e) && !["cancelled", "entered-in-error"].includes(e.status) && e.period?.start).map(e => practiceDate(e.period!.start!, input.zone.timeZone)).filter(date => date < today).sort().reverse();
  const lastDate = clinicDates[0] ?? null;
  const signed = signedEncounterIds(input.encounters, input.provenances);
  const appointments = new Map(input.appointments.map(a => [`Appointment/${a.id}`, a]));
  const patients = new Map(input.patients.map(p => [`Patient/${p.id}`, p]));
  const practitioners = new Map(input.practitioners.map(p => [`Practitioner/${p.id}`, p]));
  const rows: DoctorRow[] = [], needsReview: ReviewRow[] = [];
  const ordered = [...input.encounters].sort((a, b) => (b.period?.start ? Date.parse(b.period.start) : -Infinity) - (a.period?.start ? Date.parse(a.period.start) : -Infinity));
  for (const encounter of ordered) {
    if (!encounter.id || isMigratedEncounter(encounter) || ["cancelled", "entered-in-error"].includes(encounter.status) || signed.has(encounter.id)) continue;
    const appointment = encounter.appointment?.map(ref => appointments.get(ref.reference ?? "")).find(Boolean);
    const reference = encounter.participant?.map(p => p.individual?.reference).find(ref => ref?.startsWith("Practitioner/")) ?? appointment?.participant?.map(p => p.actor?.reference).find(ref => ref?.startsWith("Practitioner/"));
    const owner: Owner = reference ? { reference, name: name(practitioners.get(reference), reference) } : { unassigned: true };
    const patientReference = encounter.subject?.reference ?? "";
    const patient = { reference: patientReference, name: name(patients.get(patientReference), "Unknown patient") };
    const serviceStart = encounter.period?.start;
    const reason = reviewStatuses.has(encounter.status) ? `Status ${encounter.status} is not one ODOS writes` : unfinished.has(encounter.status) && appointment && excludedAppointments.has(appointment.status) ? `Appointment ${appointment.status}, chart still open` : unfinished.has(encounter.status) && !serviceStart ? "No service date" : undefined;
    if (reason) { needsReview.push({ encounterId: encounter.id, patient, ...(serviceStart ? { serviceStart } : {}), owner, reason }); continue; }
    if (!serviceStart) continue;
    const serviceDate = practiceDate(serviceStart, input.zone.timeZone);
    const signatureMissing = encounter.status === "finished" && serviceDate >= firstFinishedDate && serviceDate <= today;
    if (!unfinished.has(encounter.status) && !signatureMissing) continue;
    const checks: Checks = signatureMissing ? { kind: "signature-missing", reasons: [{ code: "signature-missing" }] } : input.checks?.get(encounter.id) ?? { kind: "open", reasons: [{ code: "checks-unavailable" }] };
    const visitType = appointment?.appointmentType?.text ?? appointment?.appointmentType?.coding?.[0]?.display ?? encounter.type?.[0]?.text ?? encounter.type?.[0]?.coding?.[0]?.display;
    const liveState = appointment?.status === "fulfilled" ? "checked out" : encounter.status === "in-progress" ? "with you" : encounter.status === "triaged" ? "roomed" : encounter.status === "arrived" ? "waiting" : undefined;
    rows.push({ encounterId: encounter.id, patient, ...(visitType ? { visitType } : {}), serviceStart, serviceDate, ...(serviceDate === today && liveState ? { liveState } : {}), owner, ...checks });
  }
  const visible = input.shape === "desk" ? rows.filter(r => r.kind !== "signature-missing") : rows;
  const todayRows = visible.filter(r => r.serviceDate === today);
  const lastRows = lastDate ? visible.filter(r => r.serviceDate === lastDate) : [];
  const older = lastDate ? visible.filter(r => r.serviceDate < lastDate) : [];
  const completeness: Completeness = input.incomplete?.length ? { complete: false, incomplete: [...new Set(input.incomplete)] } : { complete: true };
  const common = { timeZone: input.zone.timeZone, timeZoneSource: input.zone.timeZoneSource, ...completeness };
  if (input.shape === "desk") {
    const desk = (row: DoctorRow): DeskRow => ({ patient: row.patient, owner: row.owner, serviceStart: row.serviceStart, serviceDate: row.serviceDate, status: "chart open", priorDay: row.serviceDate !== today });
    return { ...common, today: { date: today, count: todayRows.length, rows: todayRows.map(desk) }, lastClinicDay: lastDate ? { date: lastDate, count: lastRows.length, rows: lastRows.map(desk) } : null, older: { count: older.length, byOwner: ownerCounts(older) } };
  }
  const returned = [...todayRows, ...lastRows];
  return { ...common, caller: input.practitioner ? { practitioner: input.practitioner } : {}, today: { date: today, rows: todayRows }, lastClinicDay: lastDate ? { date: lastDate, rows: lastRows } : null, older: { count: older.length, ...(older.length ? { oldestServiceDate: older.map(r => r.serviceDate).sort()[0] } : {}), byOwner: ownerCounts(older), ...(input.expandOlder ? { rows: older } : {}) }, needsReview, counts: { open: returned.filter(r => r.kind === "open").length, nothingCharted: returned.filter(r => r.kind === "nothing-charted").length, signatureMissing: returned.filter(r => r.kind === "signature-missing").length, needsReview: needsReview.length }, ...(input.zone.warnings ? { warnings: input.zone.warnings } : {}) };
}
async function boundedRead<R extends Resource>(fhir: FhirSearchClient, resourceType: R["resourceType"], firstPage: Promise<Bundle<R>>, leg: string, incomplete: string[]): Promise<R[]> {
  const observed: Resource[] = [];
  const capture = <T extends Resource>(bundle: Bundle<T>): Bundle<T> => { observed.push(...(bundle.entry ?? []).flatMap(e => e.resource ? [e.resource] : [])); return bundle; };
  const reader: FhirSearchClient = {
    baseUrl: fhir.baseUrl,
    search: async <T extends Resource>() => capture(await firstPage) as unknown as Bundle<T>,
    ...(fhir.searchUrl ? { searchUrl: async <T extends Resource>(url: string, type: T["resourceType"]) => capture(await fhir.searchUrl!<T>(url, type)) } : {}),
  };
  try { return await searchBounded<R>(reader, resourceType, {}, { maxRows: 1000, maxPages: 10 }); }
  catch (error) {
    if (!(error instanceof FhirSearchLimitError || error instanceof FhirSearchPageLimitError)) throw error;
    incomplete.push(leg);
    return observed.slice(0, 1000) as R[];
  }
}
async function referenced<T extends Resource>(fhir: FhirSearchClient, type: T["resourceType"], references: (string | undefined)[]): Promise<T[]> {
  const ids = [...new Set(references.flatMap(ref => ref?.startsWith(`${type}/`) ? [ref.slice(type.length + 1)] : []))];
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += 50) rows.push(...await searchAll<T>(fhir, type, { _id: ids.slice(offset, offset + 50).join(",") }));
  return rows;
}
export async function loadOpenCharts(fhir: OverviewFhir, serviceFhir: FhirSearchClient, options: { now: string; zone: ResolvedPracticeTimeZone; shape: "doctor" | "desk"; expandOlder?: boolean; practitioner?: string }): Promise<Doctor | Desk> {
  const today = practiceDate(options.now, options.zone.timeZone), incomplete: string[] = [];
  const [open, review, finished, clinicDays] = await Promise.all([
    boundedRead<Encounter>(fhir, "Encounter", fhir.search<Encounter>("Encounter", { _count: "100", ...{ _sort: "-date", status: "arrived,triaged,in-progress" } }), "unfinished", incomplete),
    boundedRead<Encounter>(fhir, "Encounter", fhir.search<Encounter>("Encounter", { _count: "100", ...{ _sort: "-date", status: "planned,onleave,unknown" } }), "needs-review", incomplete),
    boundedRead<Encounter>(fhir, "Encounter", fhir.search<Encounter>("Encounter", { _count: "100", ...{ _sort: "-date", status: "finished", date: `ge${startOfDate(shiftDate(today, -6), options.zone.timeZone)}` } }), "finished", incomplete),
    boundedRead<Encounter>(fhir, "Encounter", fhir.search<Encounter>("Encounter", { _count: "100", ...{ _sort: "-date", date: `lt${startOfDate(today, options.zone.timeZone)}` } }), "last-clinic-day", incomplete),
  ]);
  const encounters = [...new Map([...open, ...review, ...finished].filter(e => !isMigratedEncounter(e)).map(e => [e.id, e])).values()];
  const provenances: Provenance[] = [];
  const finishedIds = encounters.filter(e => e.status === "finished" && e.id).map(e => e.id!);
  for (let offset = 0; offset < finishedIds.length; offset += 25) provenances.push(...await boundedRead<Provenance>(fhir, "Provenance", fhir.search<Provenance>("Provenance", { _count: "100", target: finishedIds.slice(offset, offset + 25).map(id => `Encounter/${id}`).join(","), _sort: "-_lastUpdated" }), "provenance", incomplete));
  const [appointments, patients] = await Promise.all([
    referenced<Appointment>(fhir, "Appointment", encounters.flatMap(e => e.appointment?.map(a => a.reference) ?? [])),
    referenced<Patient>(fhir, "Patient", encounters.map(e => e.subject?.reference)),
  ]);
  const practitioners = await referenced<Practitioner>(fhir, "Practitioner", [...encounters.flatMap(e => e.participant?.map(p => p.individual?.reference) ?? []), ...appointments.flatMap(a => a.participant?.map(p => p.actor?.reference) ?? [])]);
  const input: OpenChartsInput = { encounters, provenances, clinicDays, appointments, patients, practitioners, ...options, incomplete };
  if (options.shape === "desk") return projectOpenCharts(input);
  const preliminary = projectOpenCharts(input) as Doctor;
  const ids = [...new Set([...preliminary.today.rows, ...(preliminary.lastClinicDay?.rows ?? [])].filter(r => r.kind !== "signature-missing").map(r => r.encounterId).concat(preliminary.needsReview.map(r => r.encounterId)))];
  const checks = new Map<string, Checks>();
  const olderIds = (preliminary.older.rows ?? []).filter(row => row.kind !== "signature-missing").map(row => row.encounterId);
  let protocolRead: ReturnType<typeof readEncounterProtocolContent> | undefined;
  const loadProtocol = () => protocolRead ??= readEncounterProtocolContent(fhir);
  let feeRead: ReturnType<typeof listProcedureFeeScheduleSnapshot> | undefined;
  for (const groupIds of [ids, olderIds]) {
    if (!groupIds.length) continue;
    const ids = groupIds;
    try {
      const content = await encounterContentByEncounter(fhir, ids, loadProtocol);
      for (const id of ids) if (!content.contentByEncounter.get(id)?.length) checks.set(id, { kind: "nothing-charted", reasons: [{ code: "nothing-charted" }] });
      try {
        const fees = await (feeRead ??= listProcedureFeeScheduleSnapshot(serviceFhir));
        const cachedFhir = { ...fhir, search: async <T extends Resource>(type: T["resourceType"]): Promise<Bundle<T>> => ({ resourceType: "Bundle", type: "searchset", entry: (content.resources.get(type) ?? []).map(resource => ({ resource: resource as T })) }) };
        for (const id of ids) {
          if (checks.has(id)) continue;
          const imaging = await readImagingResources(cachedFhir as unknown as Parameters<typeof readImagingResources>[0], id);
          const blocks = interpretationBlocks({ encounterId: id, proposals: content.proposals, actions: content.actions, fees, ...imaging });
          checks.set(id, { kind: "open", reasons: blocks.length ? blocks.map(block => ({ code: block.reason, label: block.label })) : [{ code: "none-found", label: "No interpretation blockers found" }] });
        }
      } catch (error) {
        if (error instanceof FhirSearchLimitError || error instanceof FhirSearchPageLimitError) incomplete.push(`gate:${error.resourceType}`);
        for (const id of ids) if (!checks.has(id)) checks.set(id, { kind: "open", reasons: [{ code: "checks-unavailable" }] });
      }
    } catch (error) {
      if (error instanceof FhirSearchLimitError || error instanceof FhirSearchPageLimitError) incomplete.push(`content:${error.resourceType}`);
      for (const id of ids) checks.set(id, { kind: "open", reasons: [{ code: "checks-unavailable" }] });
    }
  }
  return projectOpenCharts({ ...input, checks });
}
