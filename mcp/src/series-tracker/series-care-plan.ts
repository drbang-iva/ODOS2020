import type { CarePlan, Procedure, Reference } from "@medplum/fhirtypes";
import { reference } from "../fhir/ophthalmology/extensions.js";
import {
  SERIES_PROCEDURE_TYPE_SYSTEM,
  type SeriesProtocolDefinition,
} from "./protocol-definition-store.js";

export interface SeriesDueWindow {
  start: string;
  end: string;
  minWeeks: number;
  maxWeeks: number;
}

export interface SeriesSessionView {
  number: number;
  status: "completed" | "next" | "future";
  actualDate?: string;
  procedureReference?: string;
  dueWindow?: SeriesDueWindow;
}

export interface SeriesTrackerView {
  carePlanReference: string;
  title: string;
  status: CarePlan["status"];
  maintenanceAfter: boolean;
  eligibleProcedureTypeCodes: string[];
  sessions: SeriesSessionView[];
}

export interface SeriesRebookingPrompt {
  carePlanReference: string;
  patientReference: string;
  protocolTitle: string;
  nextSessionNumber: number;
  totalSessions: number;
  dueWindow: SeriesDueWindow;
  procedureTypeCode?: string;
}

export function buildSeriesCarePlan(input: {
  protocol: SeriesProtocolDefinition;
  patientReference: string;
  authorReference: string;
  created?: string;
}): CarePlan {
  const { protocol } = input;
  if (!protocol.active) throw new Error("Archived protocols cannot be prescribed.");
  return {
    resourceType: "CarePlan",
    instantiatesCanonical: [protocol.planDefinitionCanonical],
    status: "active",
    intent: "plan",
    category: [{ text: "Treatment series" }],
    title: protocol.name,
    subject: reference(input.patientReference),
    author: reference(input.authorReference),
    created: input.created ?? new Date().toISOString(),
    activity: Array.from({ length: protocol.sessionCount }, (_, index) => ({
      detail: {
        status: "not-started",
        instantiatesCanonical: [protocol.activityDefinitionCanonical],
        code: {
          coding: protocol.eligibleProcedureTypeCodes.map((code) => ({
            system: SERIES_PROCEDURE_TYPE_SYSTEM,
            code,
            display: code,
          })),
          text: protocol.eligibleProcedureTypeCodes.join(", "),
        },
        description: `Session ${index + 1} of ${protocol.sessionCount}`,
        ...(index > 0
          ? {
              scheduledTiming: {
                repeat: {
                  frequency: 1,
                  period: protocol.intervalMinDays,
                  periodMax: protocol.intervalMaxDays,
                  periodUnit: "d" as const,
                },
              },
            }
          : {}),
      },
    })),
    note: [{
      text: protocol.maintenanceAfter
        ? "Maintenance is expected after the initial series."
        : "No maintenance phase is defined after the initial series.",
    }],
  };
}

export function buildSeriesTrackerView(
  carePlan: CarePlan,
  procedures: readonly Procedure[],
): SeriesTrackerView {
  const carePlanReference = `CarePlan/${requiredId(carePlan)}`;
  const activities = carePlan.activity ?? [];
  const completedByReference = new Map(
    procedures
      .filter((procedure) => procedure.status === "completed" && procedure.id)
      .map((procedure) => [`Procedure/${procedure.id}`, procedure]),
  );
  const completedCount = activities.filter((activity) => activity.detail?.status === "completed").length;
  const latestCompleted = [...activities]
    .reverse()
    .flatMap((activity) => activity.outcomeReference ?? [])
    .map((outcome) => outcome.reference ? completedByReference.get(outcome.reference) : undefined)
    .find(Boolean);
  const latestDate = latestCompleted ? performedDate(latestCompleted) : undefined;
  const eligibleProcedureTypeCodes = [...new Set(activities.flatMap((activity) =>
    activity.detail?.code?.coding
      ?.filter((coding) => coding.system === SERIES_PROCEDURE_TYPE_SYSTEM)
      .flatMap((coding) => coding.code ? [coding.code] : []) ?? []
  ))];
  return {
    carePlanReference,
    title: carePlan.title ?? "Treatment series",
    status: carePlan.status,
    maintenanceAfter: carePlan.note?.some((note) => note.text?.startsWith("Maintenance is expected")) ?? false,
    eligibleProcedureTypeCodes,
    sessions: activities.map((activity, index) => {
      const outcome = activity.outcomeReference?.find((candidate) => candidate.reference?.startsWith("Procedure/"));
      const procedure = outcome?.reference ? completedByReference.get(outcome.reference) : undefined;
      const completed = activity.detail?.status === "completed";
      const next = !completed && index === completedCount;
      return {
        number: index + 1,
        status: completed ? "completed" : next ? "next" : "future",
        ...(procedure ? { actualDate: performedDate(procedure), procedureReference: outcome?.reference } : {}),
        ...(next && index > 0 && latestDate
          ? { dueWindow: dueWindowFromActivity(latestDate, activity) }
          : {}),
      };
    }),
  };
}

export function procedureMatchesCarePlan(procedure: Procedure, carePlan: CarePlan): boolean {
  const procedureCodes = new Set(procedure.code?.coding?.flatMap((coding) => coding.code ? [coding.code] : []) ?? []);
  return (carePlan.activity ?? []).some((activity) =>
    activity.detail?.status !== "completed" &&
    activity.detail?.code?.coding?.some((coding) => coding.code && procedureCodes.has(coding.code))
  );
}

export function completeNextSeriesSession(input: {
  carePlan: CarePlan;
  procedure: Procedure;
  patientReference: string;
  completedAt: string;
}): { carePlan: CarePlan; procedure: Procedure; prompt?: SeriesRebookingPrompt } {
  const activities = structuredClone(input.carePlan.activity ?? []);
  const nextIndex = activities.findIndex((activity) => activity.detail?.status !== "completed");
  if (nextIndex < 0) return { carePlan: input.carePlan, procedure: input.procedure };
  const procedureReference = `Procedure/${requiredId(input.procedure)}`;
  const carePlanReference = `CarePlan/${requiredId(input.carePlan)}`;
  const nextActivity = activities[nextIndex]!;
  nextActivity.detail = { ...nextActivity.detail!, status: "completed" };
  nextActivity.outcomeReference = uniqueReferences([
    ...(nextActivity.outcomeReference ?? []),
    { reference: procedureReference },
  ]);
  const procedure = {
    ...input.procedure,
    status: "completed" as const,
    basedOn: uniqueReferences([
      ...(input.procedure.basedOn ?? []),
      { reference: carePlanReference },
    ]) as Procedure["basedOn"],
    ...(performedDate(input.procedure) ? {} : { performedDateTime: input.completedAt }),
  };
  const carePlan = {
    ...input.carePlan,
    activity: activities,
    status: nextIndex === activities.length - 1 ? "completed" as const : input.carePlan.status,
  };
  const following = activities[nextIndex + 1];
  if (!following) return { carePlan, procedure };
  const completedDate = performedDate(procedure) ?? input.completedAt;
  return {
    carePlan,
    procedure,
    prompt: {
      carePlanReference,
      patientReference: input.patientReference,
      protocolTitle: carePlan.title ?? "Treatment series",
      nextSessionNumber: nextIndex + 2,
      totalSessions: activities.length,
      dueWindow: dueWindowFromActivity(completedDate, following),
      procedureTypeCode: following.detail?.code?.coding?.find((coding) => coding.code)?.code,
    },
  };
}

export function dueWindowFromActivity(
  completedAt: string,
  activity: NonNullable<CarePlan["activity"]>[number],
): SeriesDueWindow {
  const repeat = activity.detail?.scheduledTiming?.repeat;
  const minDays = positiveWholeNumber(repeat?.period, "Minimum interval");
  const maxDays = positiveWholeNumber(repeat?.periodMax, "Maximum interval");
  if (repeat?.periodUnit !== "d" || minDays > maxDays) {
    throw new Error("Series activity interval must be a valid day range.");
  }
  return {
    start: addUtcDays(completedAt, minDays),
    end: addUtcDays(completedAt, maxDays),
    minWeeks: roundWeeks(minDays),
    maxWeeks: roundWeeks(maxDays),
  };
}

function performedDate(procedure: Procedure): string | undefined {
  return procedure.performedDateTime ?? procedure.performedPeriod?.end ?? procedure.performedPeriod?.start;
}

function addUtcDays(value: string, days: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Completed procedure date is invalid.");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function roundWeeks(days: number): number {
  return Math.round((days / 7) * 10) / 10;
}

function positiveWholeNumber(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || value === undefined || value <= 0) throw new Error(`${label} is invalid.`);
  return value;
}

function requiredId(resource: CarePlan | Procedure): string {
  if (!resource.id) throw new Error(`${resource.resourceType} id is required.`);
  return resource.id;
}

function uniqueReferences(values: Reference[]): Reference[] {
  return [...new Map(values.map((value) => [value.reference, value])).values()];
}
