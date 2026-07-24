import type { Bundle, CodeableConcept, Goal, Observation, Quantity } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import {
  ODOS_EXTENSION_URLS,
  lateralityExtension,
  odosConcept,
  quantity,
  reference,
} from "../fhir/ophthalmology/extensions.js";
import {
  resolveIopRiskThreshold,
  type ClinicalFindingDefinition,
} from "./glaucoma-suspect.js";
import { resolveIopDefinitions, type IopEndpointResult } from "./iop-endpoint.js";

type Eye = "OD" | "OS";

export interface IopHistoryFhirClient {
  search<T extends Goal | Observation>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  create<T extends Goal>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update?<T extends Goal>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export interface IopHistoryAuthenticatedStaff {
  staffReference: string;
  actorRole: PracticeRoleId;
  fhir: IopHistoryFhirClient;
}

export interface IopHistoryEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<IopHistoryAuthenticatedStaff | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
}

export interface IopHistoryReading {
  eye: Eye;
  value: number;
  unit: "mmHg";
  method: { code: string; display: string } | null;
  recordedAt: string;
  recordedBy: string | null;
  observationReference: string;
}

export interface IopHistoryCornealHysteresis {
  eye: Eye;
  value: number;
  recordedAt: string;
  observationReference: string;
}

export interface IopTargetResponse {
  percent: number | null;
  value: number;
  overridden: boolean;
}

export interface IopHistoryEyeSummary {
  average: number | null;
  tMax: number | null;
  count: number;
  target: IopTargetResponse | null;
}

export interface IopHistoryResponse {
  readings: IopHistoryReading[];
  cornealHysteresis: IopHistoryCornealHysteresis[];
  perEye: Record<Eye, IopHistoryEyeSummary>;
  threshold: number;
}

const EYES: Eye[] = ["OD", "OS"];
const TARGET_HEADERS = { "X-ODOS-Source": "mcp/iop_target" } as const;
const TARGET_CATEGORY_CODE = "iop-target";
const TARGET_NOTE_PREFIX = "ODOS_IOP_TARGET ";

const historyQuerySchema = z.object({
  patient: z.string().regex(/^Patient\/[^/]+$/),
}).strict();

const targetRequestSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  eye: z.enum(["OD", "OS"]),
  percent: z.number().min(0).max(100).optional(),
  value: z.number().min(3).max(80),
  overridden: z.boolean(),
}).strict();

export async function handleIopHistoryRequest(
  deps: IopHistoryEndpointDeps,
  input: { authHeader: string | undefined; query: unknown },
): Promise<IopEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read IOP history." } };
  }
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }

  const parsed = historyQuerySchema.safeParse(input.query);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid IOP history request." } };
  }

  const definitions = resolveIopDefinitions(deps.findingDefinitions?.());
  const [iopBundle, chBundle, goalBundle] = await Promise.all([
    staff.fhir.search<Observation>("Observation", observationSearchParams(parsed.data.patient, definitions.intraocularPressure)),
    staff.fhir.search<Observation>("Observation", observationSearchParams(parsed.data.patient, definitions.cornealHysteresis)),
    staff.fhir.search<Goal>("Goal", targetSearchParams(parsed.data.patient)),
  ]);
  const readings = bundleResources(iopBundle)
    .flatMap((observation) => observationToIopReading(observation))
    .sort(compareByRecordedAt);
  const cornealHysteresis = bundleResources(chBundle)
    .flatMap((observation) => observationToCornealHysteresis(observation))
    .sort(compareByRecordedAt);
  const targets = targetsByEye(bundleResources(goalBundle));
  const threshold = resolveIopRiskThreshold(definitions.intraocularPressure);

  return {
    status: 200,
    body: {
      readings,
      cornealHysteresis,
      perEye: {
        OD: summarizeEye(readings, "OD", targets.OD ?? null),
        OS: summarizeEye(readings, "OS", targets.OS ?? null),
      },
      threshold,
    } satisfies IopHistoryResponse,
  };
}

export async function handleIopTargetRequest(
  deps: IopHistoryEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<IopEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to save IOP target." } };
  }
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }

  const parsed = targetRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid IOP target request." } };
  }

  const goalBundle = await staff.fhir.search<Goal>("Goal", targetSearchParams(parsed.data.patientReference));
  const existing = latestTargetGoalForEye(bundleResources(goalBundle), parsed.data.eye);
  const goal = buildTargetGoal({
    existing,
    patientReference: parsed.data.patientReference,
    eye: parsed.data.eye,
    target: {
      percent: parsed.data.percent ?? null,
      value: parsed.data.value,
      overridden: parsed.data.overridden,
    },
    staffReference: staff.staffReference,
    recordedAt: deps.now?.() ?? new Date().toISOString(),
  });

  if (existing?.id && staff.fhir.update) {
    try {
      await staff.fhir.update<Goal>("Goal", existing.id, goal, {
        ...TARGET_HEADERS,
        ...(existing.meta?.versionId ? { "If-Match": `W/"${existing.meta.versionId}"` } : {}),
      });
    } catch (error) {
      if (isConcurrentEdit(error)) {
        return {
          status: 409,
          body: { error: CONCURRENT_EDIT_MESSAGE, code: "concurrent-edit" },
        };
      }
      throw error;
    }
  } else {
    await staff.fhir.create<Goal>(goal, TARGET_HEADERS);
  }

  return {
    status: 200,
    body: {
      target: {
        percent: parsed.data.percent ?? null,
        value: parsed.data.value,
        overridden: parsed.data.overridden,
      } satisfies IopTargetResponse,
    },
  };
}

function observationSearchParams(
  patientReference: string,
  definition: ClinicalFindingDefinition,
): Record<string, string> {
  return {
    subject: patientReference,
    code: observationCodeParam(definition),
    _count: "200",
  };
}

function observationCodeParam(definition: ClinicalFindingDefinition): string {
  const coding = definition.fhirObservationCode?.coding?.find((candidate) => candidate.system && candidate.code);
  return coding?.system && coding.code
    ? `${coding.system}|${coding.code}`
    : `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|${definition.stableKey}`;
}

function targetSearchParams(patientReference: string): Record<string, string> {
  return {
    subject: patientReference,
    category: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|${TARGET_CATEGORY_CODE}`,
    _count: "50",
  };
}

function isConcurrentEdit(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  const status = Number(error.status);
  return status === 409 || status === 412;
}

const CONCURRENT_EDIT_MESSAGE =
  "This record was changed by someone else since you opened it. Reload and reapply your change.";

function observationToIopReading(observation: Observation): IopHistoryReading[] {
  const eye = observationEye(observation);
  const value = observation.valueQuantity?.value;
  const recordedAt = observation.effectiveDateTime;
  const id = observation.id;
  if (!eye || typeof value !== "number" || !Number.isFinite(value) || !recordedAt || !id) return [];
  return [{
    eye,
    value,
    unit: "mmHg",
    method: methodSummary(observation.method),
    recordedAt,
    recordedBy: observation.performer?.[0]?.reference ?? observation.performer?.[0]?.display ?? null,
    observationReference: `Observation/${id}`,
  }];
}

function observationToCornealHysteresis(observation: Observation): IopHistoryCornealHysteresis[] {
  const eye = observationEye(observation);
  const value = observation.valueQuantity?.value;
  const recordedAt = observation.effectiveDateTime;
  const id = observation.id;
  if (!eye || typeof value !== "number" || !Number.isFinite(value) || !recordedAt || !id) return [];
  return [{
    eye,
    value,
    recordedAt,
    observationReference: `Observation/${id}`,
  }];
}

function observationEye(observation: Observation): Eye | undefined {
  const extensionEye = observation.extension
    ?.find((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality)
    ?.valueCodeableConcept?.coding
    ?.find((coding) => coding.code === "OD" || coding.code === "OS")
    ?.code;
  if (extensionEye === "OD" || extensionEye === "OS") {
    return extensionEye;
  }
  const bodySiteEye = observation.bodySite?.coding?.find((coding) => coding.code === "OD" || coding.code === "OS")?.code;
  return bodySiteEye === "OD" || bodySiteEye === "OS" ? bodySiteEye : undefined;
}

function methodSummary(method: CodeableConcept | undefined): { code: string; display: string } | null {
  if (!method) return null;
  const coding = method.coding?.find((candidate) =>
    candidate.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && candidate.code,
  ) ?? method.coding?.find((candidate) => candidate.code);
  if (!coding?.code) return null;
  return {
    code: coding.code,
    display: coding.display ?? method.text ?? coding.code,
  };
}

function summarizeEye(
  readings: readonly IopHistoryReading[],
  eye: Eye,
  target: IopTargetResponse | null,
): IopHistoryEyeSummary {
  const values = readings.filter((reading) => reading.eye === eye).map((reading) => reading.value);
  const count = values.length;
  if (count === 0) {
    return { average: null, tMax: null, count, target };
  }
  const average = values.reduce((sum, value) => sum + value, 0) / count;
  return {
    average: roundedTenth(average),
    tMax: Math.max(...values),
    count,
    target,
  };
}

function buildTargetGoal(input: {
  existing?: Goal;
  patientReference: string;
  eye: Eye;
  target: IopTargetResponse;
  staffReference: string;
  recordedAt: string;
}): Goal {
  const targetQuantity: Quantity = quantity(
    input.target.value,
    "mmHg",
    "http://unitsofmeasure.org",
    "mm[Hg]",
  );
  return {
    ...(input.existing ?? {}),
    resourceType: "Goal",
    ...(input.existing?.id ? { id: input.existing.id } : {}),
    lifecycleStatus: "active",
    category: [targetCategory()],
    description: { text: `IOP target ${input.eye}` },
    subject: reference(input.patientReference),
    startDate: input.recordedAt.slice(0, 10),
    expressedBy: reference(input.staffReference),
    target: [{
      measure: targetCategory(),
      detailQuantity: targetQuantity,
    }],
    extension: [
      ...(input.existing?.extension ?? []).filter((extension) => extension.url !== ODOS_EXTENSION_URLS.eyeLaterality),
      lateralityExtension(input.eye),
    ],
    note: [
      ...(input.existing?.note ?? []).filter((note) => !note.text?.startsWith(TARGET_NOTE_PREFIX)),
      { text: `${TARGET_NOTE_PREFIX}${JSON.stringify(input.target)}` },
    ],
  };
}

function targetCategory(): CodeableConcept {
  return odosConcept(TARGET_CATEGORY_CODE, "IOP target");
}

function targetsByEye(goals: readonly Goal[]): Partial<Record<Eye, IopTargetResponse>> {
  return Object.fromEntries(
    EYES.flatMap((eye) => {
      const target = targetFromGoal(latestTargetGoalForEye(goals, eye));
      return target ? [[eye, target]] : [];
    }),
  );
}

function latestTargetGoalForEye(goals: readonly Goal[], eye: Eye): Goal | undefined {
  return goals
    .filter((goal) => goal.lifecycleStatus === "active")
    .filter((goal) => goalHasTargetCategory(goal))
    .filter((goal) => goalEye(goal) === eye)
    .sort(compareGoalsNewestFirst)[0];
}

function goalHasTargetCategory(goal: Goal): boolean {
  return Boolean(goal.category?.some((category) =>
    category.coding?.some((coding) =>
      coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM &&
      coding.code === TARGET_CATEGORY_CODE)));
}

function goalEye(goal: Goal): Eye | undefined {
  const code = goal.extension
    ?.find((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality)
    ?.valueCodeableConcept?.coding
    ?.find((coding) => coding.code === "OD" || coding.code === "OS")
    ?.code;
  return code === "OD" || code === "OS" ? code : undefined;
}

function targetFromGoal(goal: Goal | undefined): IopTargetResponse | undefined {
  if (!goal) return undefined;
  const value = goal.target?.[0]?.detailQuantity?.value;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const metadata = goal.note
    ?.flatMap((note) => parseTargetNote(note.text))
    ?.[0];
  return {
    percent: typeof metadata?.percent === "number" ? metadata.percent : null,
    value,
    overridden: typeof metadata?.overridden === "boolean" ? metadata.overridden : false,
  };
}

function parseTargetNote(text: string | undefined): IopTargetResponse[] {
  if (!text?.startsWith(TARGET_NOTE_PREFIX)) return [];
  try {
    const parsed = JSON.parse(text.slice(TARGET_NOTE_PREFIX.length)) as Partial<IopTargetResponse>;
    return typeof parsed.value === "number"
      ? [{
          percent: typeof parsed.percent === "number" ? parsed.percent : null,
          value: parsed.value,
          overridden: parsed.overridden === true,
        }]
      : [];
  } catch {
    return [];
  }
}

function compareByRecordedAt<T extends { recordedAt: string; observationReference: string }>(a: T, b: T): number {
  return a.recordedAt.localeCompare(b.recordedAt) || a.observationReference.localeCompare(b.observationReference);
}

function compareGoalsNewestFirst(a: Goal, b: Goal): number {
  const aTime = a.meta?.lastUpdated ?? a.startDate ?? "";
  const bTime = b.meta?.lastUpdated ?? b.startDate ?? "";
  return bTime.localeCompare(aTime) || (b.id ?? "").localeCompare(a.id ?? "");
}

function bundleResources<T extends Goal | Observation>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function roundedTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}
