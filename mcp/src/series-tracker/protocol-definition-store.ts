import { randomUUID } from "node:crypto";
import type {
  ActivityDefinition,
  Bundle,
  PlanDefinition,
  Resource,
} from "@medplum/fhirtypes";
import { ODOS_FHIR_BASE } from "../fhir/contactLens.js";

export const SERIES_PROTOCOL_IDENTIFIER_SYSTEM =
  `${ODOS_FHIR_BASE}/NamingSystem/series-protocol`;
export const SERIES_PROTOCOL_ACTIVITY_IDENTIFIER_SYSTEM =
  `${ODOS_FHIR_BASE}/NamingSystem/series-protocol-activity`;
export const SERIES_PROTOCOL_TYPE_SYSTEM =
  `${ODOS_FHIR_BASE}/CodeSystem/plan-definition-type`;
export const SERIES_PROTOCOL_TYPE_CODE = "treatment-series";
export const SERIES_PROCEDURE_TYPE_SYSTEM =
  `${ODOS_FHIR_BASE}/CodeSystem/procedure-type`;

const MAINTENANCE_USAGE = "Maintenance is expected after the initial series.";
const NO_MAINTENANCE_USAGE = "No maintenance phase is defined after the initial series.";

export interface SeriesProtocolDefinition {
  id: string;
  name: string;
  eligibleProcedureTypeCodes: string[];
  sessionCount: number;
  intervalMinDays: number;
  intervalMaxDays: number;
  maintenanceAfter: boolean;
  active: boolean;
  planDefinitionCanonical: string;
  activityDefinitionCanonical: string;
  updatedAt: string;
}

export type SeriesProtocolDefinitionDraft = Pick<
  SeriesProtocolDefinition,
  | "name"
  | "eligibleProcedureTypeCodes"
  | "sessionCount"
  | "intervalMinDays"
  | "intervalMaxDays"
  | "maintenanceAfter"
> & { id?: string };

export interface ProtocolDefinitionFhirClient {
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  executeTransaction(bundle: Bundle): Promise<Bundle>;
}

export class FhirSeriesProtocolDefinitionStore {
  constructor(
    private readonly fhir: ProtocolDefinitionFhirClient,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async list(options: { includeArchived?: boolean } = {}): Promise<SeriesProtocolDefinition[]> {
    const bundle = await this.fhir.search<PlanDefinition>("PlanDefinition", {
      identifier: `${SERIES_PROTOCOL_IDENTIFIER_SYSTEM}|`,
      _count: "200",
    });
    return (bundle.entry ?? [])
      .flatMap((entry) => {
        if (!entry.resource) return [];
        try {
          return [parseSeriesProtocolPlanDefinition(entry.resource)];
        } catch (error) {
          console.error(`PlanDefinition/${entry.resource.id ?? "?"} skipped: ${messageOf(error)}`);
          return [];
        }
      })
      .filter((definition) => options.includeArchived || definition.active)
      .sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name));
  }

  async save(draft: SeriesProtocolDefinitionDraft): Promise<SeriesProtocolDefinition> {
    assertSeriesProtocolDraft(draft);
    const id = draft.id ?? randomUUID();
    const existing = (await this.list({ includeArchived: true })).find((candidate) => candidate.id === id);
    if (existing && !existing.active) {
      throw new SeriesProtocolConflictError("Archived protocol definitions cannot be edited.");
    }
    const updatedAt = this.now();
    const activity = buildSeriesActivityDefinition(id, draft, updatedAt, "active");
    const plan = buildSeriesPlanDefinition(id, draft, activity.url!, updatedAt, "active");
    await this.fhir.executeTransaction(definitionTransaction(plan, activity));
    return parseSeriesProtocolPlanDefinition(plan);
  }

  async archive(id: string): Promise<SeriesProtocolDefinition | undefined> {
    assertIdentifier(id);
    const existing = (await this.list({ includeArchived: true })).find((candidate) => candidate.id === id);
    if (!existing) return undefined;
    if (!existing.active) return existing;
    const updatedAt = this.now();
    const draft = draftFromDefinition(existing);
    const activity = buildSeriesActivityDefinition(id, draft, updatedAt, "retired");
    const plan = buildSeriesPlanDefinition(id, draft, activity.url!, updatedAt, "retired");
    await this.fhir.executeTransaction(definitionTransaction(plan, activity));
    return parseSeriesProtocolPlanDefinition(plan);
  }
}

export function buildSeriesActivityDefinition(
  id: string,
  draft: SeriesProtocolDefinitionDraft,
  updatedAt: string,
  status: ActivityDefinition["status"] = "active",
): ActivityDefinition {
  assertIdentifier(id);
  assertSeriesProtocolDraft(draft);
  return {
    resourceType: "ActivityDefinition",
    url: activityCanonical(id),
    identifier: [{ system: SERIES_PROTOCOL_ACTIVITY_IDENTIFIER_SYSTEM, value: id }],
    version: versionFromInstant(updatedAt),
    title: `${draft.name.trim()} session`,
    status,
    date: updatedAt,
    publisher: "ODOS practice",
    description: `One session in the ${draft.name.trim()} treatment protocol.`,
    kind: "ServiceRequest",
    code: procedureTypeConcept(draft.eligibleProcedureTypeCodes),
  };
}

export function buildSeriesPlanDefinition(
  id: string,
  draft: SeriesProtocolDefinitionDraft,
  activityDefinitionCanonical: string,
  updatedAt: string,
  status: PlanDefinition["status"] = "active",
): PlanDefinition {
  assertIdentifier(id);
  assertSeriesProtocolDraft(draft);
  return {
    resourceType: "PlanDefinition",
    url: planCanonical(id),
    identifier: [{ system: SERIES_PROTOCOL_IDENTIFIER_SYSTEM, value: id }],
    version: versionFromInstant(updatedAt),
    title: draft.name.trim(),
    type: {
      coding: [{
        system: SERIES_PROTOCOL_TYPE_SYSTEM,
        code: SERIES_PROTOCOL_TYPE_CODE,
        display: "Treatment series",
      }],
      text: "Treatment series",
    },
    status,
    date: updatedAt,
    publisher: "ODOS practice",
    usage: draft.maintenanceAfter ? MAINTENANCE_USAGE : NO_MAINTENANCE_USAGE,
    action: Array.from({ length: draft.sessionCount }, (_, index) => ({
      id: `session-${index + 1}`,
      prefix: String(index + 1),
      title: `Session ${index + 1} of ${draft.sessionCount}`,
      code: [procedureTypeConcept(draft.eligibleProcedureTypeCodes)],
      definitionCanonical: activityDefinitionCanonical,
      ...(index > 0
        ? {
            relatedAction: [{
              actionId: `session-${index}`,
              relationship: "after-end" as const,
              offsetRange: {
                low: { value: draft.intervalMinDays, unit: "days", system: "http://unitsofmeasure.org", code: "d" },
                high: { value: draft.intervalMaxDays, unit: "days", system: "http://unitsofmeasure.org", code: "d" },
              },
            }],
          }
        : {}),
    })),
  };
}

export function parseSeriesProtocolPlanDefinition(plan: PlanDefinition): SeriesProtocolDefinition {
  const id = plan.identifier?.find((identifier) => identifier.system === SERIES_PROTOCOL_IDENTIFIER_SYSTEM)?.value;
  if (!id) throw new Error("Series protocol is missing its stable identifier.");
  assertIdentifier(id);
  const type = plan.type?.coding?.some((coding) =>
    coding.system === SERIES_PROTOCOL_TYPE_SYSTEM && coding.code === SERIES_PROTOCOL_TYPE_CODE
  );
  if (!type) throw new Error("PlanDefinition is not an ODOS treatment series.");
  const actions = plan.action ?? [];
  if (actions.length === 0) throw new Error("Series protocol has no session actions.");
  const codes = [...new Set(actions.flatMap((action) =>
    action.code?.flatMap((concept) => concept.coding ?? [])
      .filter((coding) => coding.system === SERIES_PROCEDURE_TYPE_SYSTEM)
      .flatMap((coding) => coding.code ? [coding.code] : []) ?? []
  ))];
  if (codes.length === 0) throw new Error("Series protocol has no eligible procedure types.");
  const interval = actions[1]?.relatedAction?.[0]?.offsetRange;
  const intervalMinDays = wholeNumber(interval?.low?.value, "Protocol minimum interval");
  const intervalMaxDays = wholeNumber(interval?.high?.value, "Protocol maximum interval");
  if (intervalMinDays > intervalMaxDays) throw new Error("Series protocol interval is reversed.");
  const activityDefinitionCanonical = actions[0]?.definitionCanonical;
  if (!activityDefinitionCanonical) throw new Error("Series protocol has no ActivityDefinition canonical.");
  return {
    id,
    name: plan.title?.trim() || "Untitled treatment series",
    eligibleProcedureTypeCodes: codes,
    sessionCount: actions.length,
    intervalMinDays,
    intervalMaxDays,
    maintenanceAfter: plan.usage === MAINTENANCE_USAGE,
    active: plan.status === "active",
    planDefinitionCanonical: plan.url ?? planCanonical(id),
    activityDefinitionCanonical,
    updatedAt: plan.date ?? plan.meta?.lastUpdated ?? "",
  };
}

export function assertSeriesProtocolDraft(draft: SeriesProtocolDefinitionDraft): void {
  if (!draft.name.trim()) throw new SeriesProtocolInputError("Protocol name is required.");
  const codes = draft.eligibleProcedureTypeCodes.map((code) => code.trim()).filter(Boolean);
  if (codes.length === 0) throw new SeriesProtocolInputError("At least one eligible procedure type is required.");
  assertPositiveWholeNumber(draft.sessionCount, "Session count");
  if (draft.sessionCount < 2) throw new SeriesProtocolInputError("A treatment series requires at least two sessions.");
  assertPositiveWholeNumber(draft.intervalMinDays, "Minimum interval");
  assertPositiveWholeNumber(draft.intervalMaxDays, "Maximum interval");
  if (draft.intervalMinDays > draft.intervalMaxDays) {
    throw new SeriesProtocolInputError("Minimum interval cannot exceed maximum interval.");
  }
}

export class SeriesProtocolInputError extends Error {}
export class SeriesProtocolConflictError extends Error {}

function definitionTransaction(plan: PlanDefinition, activity: ActivityDefinition): Bundle {
  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      {
        resource: activity,
        request: {
          method: "PUT",
          url: conditionalUrl("ActivityDefinition", SERIES_PROTOCOL_ACTIVITY_IDENTIFIER_SYSTEM, activity.identifier![0]!.value!),
        },
      },
      {
        resource: plan,
        request: {
          method: "PUT",
          url: conditionalUrl("PlanDefinition", SERIES_PROTOCOL_IDENTIFIER_SYSTEM, plan.identifier![0]!.value!),
        },
      },
    ],
  };
}

function conditionalUrl(resourceType: string, system: string, value: string): string {
  return `${resourceType}?identifier=${encodeURIComponent(`${system}|${value}`)}`;
}

function draftFromDefinition(definition: SeriesProtocolDefinition): SeriesProtocolDefinitionDraft {
  return {
    id: definition.id,
    name: definition.name,
    eligibleProcedureTypeCodes: definition.eligibleProcedureTypeCodes,
    sessionCount: definition.sessionCount,
    intervalMinDays: definition.intervalMinDays,
    intervalMaxDays: definition.intervalMaxDays,
    maintenanceAfter: definition.maintenanceAfter,
  };
}

function procedureTypeConcept(codes: readonly string[]) {
  return {
    coding: [...new Set(codes.map((code) => code.trim()).filter(Boolean))].map((code) => ({
      system: SERIES_PROCEDURE_TYPE_SYSTEM,
      code,
      display: code,
    })),
    text: [...new Set(codes.map((code) => code.trim()).filter(Boolean))].join(", "),
  };
}

function planCanonical(id: string): string {
  return `${ODOS_FHIR_BASE}/PlanDefinition/series-protocol-${id}`;
}

function activityCanonical(id: string): string {
  return `${ODOS_FHIR_BASE}/ActivityDefinition/series-protocol-${id}-session`;
}

function versionFromInstant(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new SeriesProtocolInputError("Protocol update time is invalid.");
  return String(parsed);
}

function assertIdentifier(value: string): void {
  if (!/^[A-Za-z0-9.-]+$/.test(value)) throw new SeriesProtocolInputError("Protocol id is invalid.");
}

function assertPositiveWholeNumber(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SeriesProtocolInputError(`${label} must be a positive whole number.`);
  }
}

function wholeNumber(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || value === undefined || value <= 0) throw new Error(`${label} is invalid.`);
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
