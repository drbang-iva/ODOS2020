import type { Bundle, Observation, Provenance } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import { patientScopedProvenanceTargets, captureGlaucomaFinding, type ClinicalFindingDefinition, type ClinicalGraphProvenance } from "./glaucoma-suspect.js";
import { isLiveObservation } from "./observation-liveness.js";
import { withDocumentationElements } from "./documentation-elements.js";
import { EOM_KEY } from "./entrance-definition.js";

type Eye = "OD" | "OS";

export interface EomFhirClient {
  create<T extends Observation | Provenance>(resource: T, headers?: Record<string, string>): Promise<T>;
  search<T extends Observation>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
}

export interface EomEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{ staffReference: string; actorRole: PracticeRoleId; fhir: EomFhirClient } | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
}

const WRITE_HEADERS = { "X-ODOS-Source": "mcp/save_section_observations" } as const;
const POSITIONS = ["up-left", "up", "up-right", "left", "primary", "right", "down-left", "down", "down-right"] as const;
const positionSchema = z.enum(POSITIONS);
const movementSchema = z.enum(["-4", "-3", "-2", "-1", "0", "+1", "+2", "+3", "+4"]);
const eyeSchema = z.record(positionSchema, movementSchema).refine((value) => Object.keys(value).length > 0, "Enter at least one gaze position.");
const nystagmusSchema = z.discriminatedUnion("present", [
  z.object({ present: z.literal(false) }).strict(),
  z.object({ present: z.literal(true), note: z.string().trim().max(2000).optional() }).strict(),
]);
const diplopiaSchema = z.discriminatedUnion("present", [
  z.object({ present: z.literal(false), note: z.string().trim().max(2000).optional() }).strict(),
  z.object({
    present: z.literal(true),
    type: z.enum(["monocular", "binocular"]),
    direction: z.enum(["horizontal", "vertical", "oblique", "torsional"]),
    comitancy: z.enum(["comitant", "incomitant"]),
    worstGaze: positionSchema,
    frequency: z.enum(["constant", "intermittent"]),
    onset: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    note: z.string().trim().max(2000).optional(),
  }).strict(),
]);
const captureSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  state: z.enum(["normal", "abnormal", "deferred"]),
  eyes: z.object({ OD: eyeSchema.optional(), OS: eyeSchema.optional() }).strict().optional(),
  nystagmus: nystagmusSchema.optional(),
  diplopia: diplopiaSchema.optional(),
}).strict();
const historySchema = z.object({ patient: z.string().regex(/^Patient\/[^/]+$/), encounter: z.string().regex(/^Encounter\/[^/]+$/).optional() }).strict();

export async function handleEomCaptureRequest(deps: EomEndpointDeps, input: { authHeader: string | undefined; body: unknown }) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to save EOM findings." } };
  if (!staffHasBusinessAction(staff, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = captureSchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid EOM request." } };
  const definition = deps.findingDefinitions?.().find((row) => row.stableKey === EOM_KEY && row.active);
  if (!definition) return { status: 404, body: { error: "Active EOM definition not found." } };
  const data = parsed.data;
  if (data.state !== "abnormal" && (data.eyes || data.nystagmus || data.diplopia)) {
    return { status: 400, body: { error: "Only an abnormal EOM state may carry gaze, nystagmus, or diplopia details." } };
  }
  const hasGaze = (["OD", "OS"] as Eye[]).some((eye) => Object.keys(data.eyes?.[eye] ?? {}).length > 0);
  if (data.state === "abnormal" && !hasGaze && !data.nystagmus?.present && !data.diplopia?.present) {
    return { status: 400, body: { error: "Abnormal EOM requires a gaze, nystagmus, or diplopia finding." } };
  }
  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const components = [
    { code: "EXAM_STATE", display: "Exam state", value: data.state },
    ...(data.state === "normal" && typeof definition.normalSemantics?.template === "string"
      ? [{ code: "NORMAL_TEMPLATE", display: "Normal template", value: definition.normalSemantics.template }]
      : []),
    ...(["OD", "OS"] as Eye[]).flatMap((eye) => Object.entries(data.eyes?.[eye] ?? {}).map(([position, value]) => ({
      code: `${eye}_CUSTOM_EOM_POS_${position.replaceAll("-", "_").toUpperCase()}`,
      display: `${eye} ${position}`,
      value,
    }))),
    ...(data.nystagmus ? [{ code: "NYSTAGMUS_PRESENT", display: "Nystagmus present", value: data.nystagmus.present }] : []),
    ...(data.nystagmus?.present && data.nystagmus.note ? [{ code: "NYSTAGMUS_NOTE", display: "Nystagmus note", value: data.nystagmus.note }] : []),
    ...(data.diplopia ? [{ code: "DIPLOPIA_PRESENT", display: "Diplopia present", value: data.diplopia.present }] : []),
    ...(data.diplopia?.present ? [
      { code: `${data.diplopia.type}::yes`, display: data.diplopia.type, value: true },
      { code: `${data.diplopia.comitancy}::yes`, display: data.diplopia.comitancy, value: true },
      { code: "DIPLOPIA_DIRECTION", display: "Diplopia direction", value: data.diplopia.direction },
      { code: "DIPLOPIA_WORST_GAZE", display: "Worst gaze", value: data.diplopia.worstGaze },
      { code: "DIPLOPIA_FREQUENCY", display: "Frequency", value: data.diplopia.frequency },
      ...(data.diplopia.onset ? [{ code: "DIPLOPIA_ONSET", display: "Onset", value: data.diplopia.onset }] : []),
      ...(data.diplopia.note ? [{ code: "DIPLOPIA_NOTE", display: "Diplopia note", value: data.diplopia.note }] : []),
    ] : []),
  ];
  const provenance: ClinicalGraphProvenance = { source: "manual", recordedAt, actorReference: staff.staffReference, note: "EOM and diplopia capture." };
  const captured = captureGlaucomaFinding({
    definition,
    patientReference: data.patientReference,
    encounterReference: data.encounterReference,
    laterality: "OU",
    value: { type: "components", components },
    interpretation: data.state === "normal" ? "normal" : data.state === "abnormal" ? "abnormal" : "unknown",
    sourceType: "manual",
    performerReferences: [staff.staffReference],
    recordedAt,
    provenance,
  });
  const observation = await staff.fhir.create(withDocumentationElements(captured.observation, definition, data.state), WRITE_HEADERS);
  const observationReference = `Observation/${observation.id ?? captured.observation.id}`;
  await staff.fhir.create({ ...captured.provenance, target: patientScopedProvenanceTargets(observationReference, data.patientReference) }, WRITE_HEADERS);
  return { status: 200, body: { observationReference } };
}

export async function handleEomHistoryRequest(deps: EomEndpointDeps, input: { authHeader: string | undefined; query: unknown }) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read EOM history." } };
  if (!staffHasBusinessAction(staff, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const parsed = historySchema.safeParse(input.query);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid EOM history request." } };
  const bundle = await staff.fhir.search<Observation>("Observation", {
    subject: parsed.data.patient,
    ...(parsed.data.encounter ? { encounter: parsed.data.encounter } : {}),
    code: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|${EOM_KEY}`,
    _sort: "-date",
    _count: "200",
  });
  return { status: 200, body: { rows: (bundle.entry ?? []).flatMap((entry) => entry.resource && isLiveObservation(entry.resource) ? [{
    ...(entry.resource.id ? { observationReference: `Observation/${entry.resource.id}` } : {}),
    recordedAt: entry.resource.effectiveDateTime ?? "",
    state: componentValue(entry.resource, "EXAM_STATE") ?? "",
    summary: summarize(entry.resource),
  }] : []) } };
}

function summarize(observation: Observation): string {
  const normal = componentValue(observation, "NORMAL_TEMPLATE");
  if (normal) return normal;
  return (observation.component ?? []).flatMap((component) => {
    const code = component.code.coding?.[0]?.code;
    const value = component.valueString ?? component.valueBoolean ?? component.valueCodeableConcept?.coding?.[0]?.code;
    return code && value !== undefined && !["EXAM_STATE", "entrance.eom"].includes(code) ? [`${component.code.text ?? code}: ${value}`] : [];
  }).join(" · ");
}

function componentValue(observation: Observation, code: string): string | undefined {
  const component = observation.component?.find((row) => row.code.coding?.some((coding) => coding.code === code));
  return component?.valueString ?? component?.valueCodeableConcept?.coding?.[0]?.code;
}

function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try { assertBusinessActionAllowed(role, action); return true; } catch { return false; }
}
