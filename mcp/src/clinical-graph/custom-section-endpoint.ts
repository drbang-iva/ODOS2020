import type { Bundle, Observation, ObservationComponent, Provenance } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import { ODOS_EXTENSION_URLS, odosConcept } from "../fhir/ophthalmology/extensions.js";
import {
  appendCustomFieldComponentsToObservation,
  customFieldEntries,
  customFieldValueSchema,
  observationCustomValue,
  validateCustomFieldValues,
  type ClockHourExtentValue,
  type FindingDetails,
  type FindingQualifierValue,
  type QualifierSeed,
} from "./custom-fields.js";
import {
  captureGlaucomaFinding,
  patientScopedProvenanceTargets,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
  type CapturedGlaucomaFinding,
} from "./glaucoma-suspect.js";
import { withDocumentationElements } from "./documentation-elements.js";

type Eye = "OD" | "OS";

export interface CustomSectionFhirClient {
  create<T extends Observation | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  search<T extends Observation>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
}

export interface CustomSectionEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: CustomSectionFhirClient;
  } | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
}

const WRITE_HEADERS = { "X-ODOS-Source": "mcp/save_section_observations" } as const;
const EYES: Eye[] = ["OD", "OS"];

const clockHourExtentSchema = z.object({
  from: z.number().finite().min(1).max(12),
  to: z.number().finite().min(1).max(12),
  clockwise: z.boolean(),
}).strict();

const findingQualifierValueSchema = z.union([
  z.number().finite(),
  z.string().trim().min(1).max(200),
  clockHourExtentSchema,
]);

const findingDetailsSchema = z.record(
  z.string().trim().min(1).max(100),
  z.record(z.string().trim().min(1).max(100), findingQualifierValueSchema),
).refine((value) => Object.keys(value).length <= 100, {
  message: "findingDetails supports at most 100 findings.",
}).refine((value) => Object.values(value).every((details) => Object.keys(details).length <= 100), {
  message: "Each finding supports at most 100 qualifier values.",
});

const eyePayloadSchema = z.object({
  customFields: z.array(customFieldValueSchema).max(64),
  state: z.enum(["normal", "abnormal", "deferred"]).optional(),
  other: z.string().trim().max(2000).optional(),
  findingDetails: findingDetailsSchema.optional(),
}).strict();

const captureSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  customFields: z.array(customFieldValueSchema).max(64).optional(),
  state: z.enum(["normal", "abnormal", "deferred"]).optional(),
  other: z.string().trim().max(2000).optional(),
  eyes: z.object({
    OD: eyePayloadSchema.optional(),
    OS: eyePayloadSchema.optional(),
  }).strict().optional(),
  remarks: z.string().trim().max(2000).optional(),
}).strict();

const historyQuerySchema = z.object({
  patient: z.string().regex(/^Patient\/[^/]+$/),
  encounter: z.string().regex(/^Encounter\/[^/]+$/).optional(),
}).strict();

export async function handleCustomSectionCaptureRequest(
  deps: CustomSectionEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to save custom section findings." } };
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const definition = resolveCustomDefinition(deps.findingDefinitions?.(), input.params, true);
  if (!definition) return { status: 404, body: { error: "Active custom section not found." } };
  const parsed = captureSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid custom section request." } };
  }
  const perEye = definition.valueSchema.perEye === true;
  const ocularHealth = definition.valueSchema.type === "ocular-health-structure";
  const stateSection = ocularHealth || definition.valueSchema.type === "entrance-state-section";
  if (perEye !== Boolean(parsed.data.eyes) || perEye === Boolean(parsed.data.customFields)) {
    return { status: 400, body: { error: perEye ? "This section requires eyes payloads." : "This section requires a per-record customFields payload." } };
  }
  if (perEye && (parsed.data.state !== undefined || parsed.data.other !== undefined)) {
    return { status: 400, body: { error: "Per-eye sections require state and note inside each eye payload." } };
  }
  const eyeRows = EYES.flatMap((eye) => parsed.data.eyes?.[eye]
    ? [{
        eye,
        values: parsed.data.eyes[eye]!.customFields,
        state: parsed.data.eyes[eye]!.state,
        other: parsed.data.eyes[eye]!.other,
        findingDetails: parsed.data.eyes[eye]!.findingDetails,
      }]
    : []);
  if (perEye && eyeRows.length === 0) {
    return { status: 400, body: { error: "At least one eye payload is required." } };
  }
  const rows = perEye
    ? eyeRows
    : [{
        eye: "UNKNOWN" as const,
        values: parsed.data.customFields ?? [],
        state: parsed.data.state,
        other: parsed.data.other,
        findingDetails: undefined,
      }];
  if (definition.stableKey === "dry-eye:symptoms" && rows.some((row) => {
    const supplied = new Set(row.values.map((value) => value.code));
    return supplied.has("CUSTOM_TOTAL_SCORE") && !supplied.has("CUSTOM_INSTRUMENT");
  })) {
    return { status: 400, body: { error: "Dry-eye total score requires its questionnaire instrument." } };
  }
  if (stateSection && rows.some((row) => row.other && !row.state)) {
    return { status: 400, body: { error: "Ocular-health Other text requires choosing Normal, Abnormal, or Deferred for that eye, or clearing the text." } };
  }
  if (stateSection && rows.some((row) => !row.state)) {
    return { status: 400, body: { error: "Ocular-health eye payloads require an explicit normal, abnormal, or deferred state." } };
  }
  if (stateSection && rows.some((row) => row.state === "deferred") && definition.normalSemantics?.allowDeferred !== true) {
    return { status: 400, body: { error: "Deferred is not enabled for this ocular-health structure." } };
  }
  const ocularFields = new Map(customFieldEntries(definition).map((field) => [field.localCode, field]));
  if (stateSection && rows.some((row) => row.state !== "abnormal" && row.values.some((value) =>
    ocularFields.get(value.code)?.valueType === "multi-select"
  ))) {
    return { status: 400, body: { error: "Only an abnormal ocular-health state may carry abnormal findings." } };
  }
  if (stateSection && rows.some((row) => row.state !== "abnormal" && hasFindingDetails(row.findingDetails))) {
    return { status: 400, body: { error: "Only an abnormal ocular-health state may carry finding details." } };
  }
  if (!ocularHealth && rows.some((row) => hasFindingDetails(row.findingDetails))) {
    return { status: 400, body: { error: "Finding details are only supported for ocular-health structures." } };
  }
  if (!stateSection && rows.some((row) => row.state !== undefined || row.other !== undefined)) {
    return { status: 400, body: { error: "Exam state and other text are only supported for ocular-health structures." } };
  }
  if (rows.every((row) => row.values.length === 0 && !row.state && !row.other && !hasFindingDetails(row.findingDetails)) && !parsed.data.remarks) {
    return { status: 400, body: { error: "Enter at least one custom field or note before saving." } };
  }
  for (const row of rows) {
    const validationError = validateCustomFieldValues(row.values, definition, row.eye);
    if (validationError) return { status: 400, body: { error: validationError } };
    const findingDetailsError = validateFindingDetails(
      row.findingDetails,
      row.values,
      definition,
      row.eye,
    );
    if (findingDetailsError) return { status: 400, body: { error: findingDetailsError } };
    if (definition.stableKey === "manual_keratometry") {
      const required = ["CUSTOM_FLAT_K", "CUSTOM_FLAT_AXIS", "CUSTOM_STEEP_K", "CUSTOM_STEEP_AXIS"];
      const supplied = new Set(row.values.map((value) => value.code));
      const anyK = required.some((code) => supplied.has(code));
      const allK = required.every((code) => supplied.has(code));
      if (anyK && !allK) {
        return { status: 400, body: { error: `${row.eye} Manual K requires flat K, flat axis, steep K, and steep axis together.` } };
      }
    }
  }

  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const provenance: ClinicalGraphProvenance = {
    source: "manual",
    recordedAt,
    actorReference: staff.staffReference,
    note: "Practice-created custom section capture.",
  };
  const results = [];
  for (const row of rows) {
    const captured = captureGlaucomaFinding({
      definition,
      patientReference: parsed.data.patientReference,
      encounterReference: parsed.data.encounterReference,
      laterality: row.eye,
      value: {
        type: "components",
        components: [
          ...(parsed.data.remarks
            ? [{ code: "REMARKS", display: "Remarks", value: parsed.data.remarks }]
            : []),
          ...(stateSection && row.state
            ? [{ code: "EXAM_STATE", display: "Exam state", value: row.state }]
            : []),
          ...(stateSection && row.state === "normal" && typeof definition.normalSemantics?.template === "string"
            ? [{ code: "NORMAL_TEMPLATE", display: "Normal template", value: definition.normalSemantics.template }]
            : []),
          ...(stateSection && row.other
            ? [{ code: "OTHER", display: "Other", value: row.other }]
            : []),
        ],
      },
      sourceType: "manual",
      performerReferences: [staff.staffReference],
      recordedAt,
      provenance,
    });
    const coded = {
      ...captured,
      observation: {
        ...withDocumentationElements(
          appendCustomFieldComponentsToObservation(
            captured.observation,
            row.values,
            definition,
            perEye ? `${row.eye}_` : "",
          ),
          definition,
          row.state ?? "normal",
        ),
        ...(row.state === "normal" || row.state === "abnormal"
          ? {
              interpretation: [{
                coding: [{
                  system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
                  code: row.state === "normal" ? "N" : "A",
                  display: row.state === "normal" ? "Normal" : "Abnormal",
                }],
              }],
            }
          : {}),
      },
    };
    coded.observation = appendFindingDetailComponentsToObservation(
      coded.observation,
      row.findingDetails,
      definition,
      perEye ? `${row.eye}_` : "",
    );
    results.push(await persistCapture(
      staff.fhir,
      coded,
      row.eye,
      parsed.data.patientReference,
    ));
  }
  return { status: 200, body: perEye ? { eyes: Object.fromEntries(results.map((row) => [row.eye, row])) } : results[0] };
}

export async function handleCustomSectionHistoryRequest(
  deps: CustomSectionEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; query: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read custom section history." } };
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const definition = resolveCustomDefinition(deps.findingDefinitions?.(), input.params, false);
  if (!definition) return { status: 404, body: { error: "Custom section not found." } };
  const parsed = historyQuerySchema.safeParse(input.query);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid custom section history request." } };
  }
  const bundle = await staff.fhir.search<Observation>("Observation", {
    subject: parsed.data.patient,
    code: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|${definition.stableKey}`,
    ...(parsed.data.encounter ? { encounter: parsed.data.encounter } : {}),
    _sort: "-date",
    _count: "200",
  });
  const rows = (bundle.entry ?? []).flatMap((entry) => {
    const observation = entry.resource;
    if (!observation) return [];
    const eye = observationEye(observation);
    const perEye = definition.valueSchema.perEye === true;
    const prefix = perEye && (eye === "OD" || eye === "OS") ? `${eye}_` : "";
    const values = customFieldEntries(definition, true).flatMap((field) => {
      const value = observationCustomValue(observation, field, prefix);
      return value === undefined ? [] : [{
        code: field.localCode,
        label: field.display,
        value,
        ...(field.unit ? { unit: field.unit } : {}),
      }];
    });
    const findingDetails = observationFindingDetails(observation, definition, prefix);
    return [{
      ...(definition.stableKey === "entrance:visual-field-defect" && observation.id
        ? { observationReference: `Observation/${observation.id}` }
        : {}),
      recordedAt: observation.effectiveDateTime ?? observation.issued ?? observation.meta?.lastUpdated ?? "",
      ...(perEye && (eye === "OD" || eye === "OS") ? { eye } : {}),
      values,
      ...(findingDetails ? { findingDetails } : {}),
      ...(componentString(observation, "EXAM_STATE") ? { state: componentString(observation, "EXAM_STATE") } : {}),
      ...(componentString(observation, "NORMAL_TEMPLATE") ? { normalTemplate: componentString(observation, "NORMAL_TEMPLATE") } : {}),
      ...(componentString(observation, "OTHER") ? { other: componentString(observation, "OTHER") } : {}),
      ...(componentString(observation, "REMARKS") ? { remarks: componentString(observation, "REMARKS") } : {}),
    }];
  });
  return { status: 200, body: { rows } };
}

function validateFindingDetails(
  findingDetails: FindingDetails | undefined,
  values: Array<{ code: string; value: number | string | string[] }>,
  definition: ClinicalFindingDefinition,
  label: string,
): string | undefined {
  if (!hasFindingDetails(findingDetails)) return undefined;
  const field = customFieldEntries(definition).find((candidate) => candidate.valueType === "multi-select");
  if (!field) return `${label} finding details require an ocular-health findings field.`;
  const selectedValue = values.find((value) => value.code === field.localCode)?.value;
  const selected = Array.isArray(selectedValue) ? new Set(selectedValue) : new Set<string>();
  for (const [optionCode, details] of Object.entries(findingDetails)) {
    const option = field.options?.find((candidate) => candidate.code === optionCode && candidate.active);
    if (!option) return `${label} finding details contain an unknown or inactive finding: ${optionCode}.`;
    if (!selected.has(optionCode)) return `${label} finding details require the finding selection: ${optionCode}.`;
    for (const [qualifierKey, value] of Object.entries(details)) {
      const qualifier = option.qualifiers?.find((candidate) => candidate.key === qualifierKey);
      if (!qualifier) return `${label} finding ${optionCode} contains an unknown qualifier: ${qualifierKey}.`;
      const error = validateFindingQualifierValue(value, qualifier);
      if (error) return `${label} finding ${optionCode} qualifier ${qualifierKey} ${error}`;
    }
  }
  return undefined;
}

function validateFindingQualifierValue(
  value: FindingQualifierValue,
  qualifier: QualifierSeed,
): string | undefined {
  if (qualifier.kind === "graded") {
    return typeof value === "string" && qualifier.options.includes(value)
      ? undefined
      : "requires a configured grade option.";
  }
  if (qualifier.kind === "enum") {
    return typeof value === "string" && qualifier.options.some((option) => option.code === value)
      ? undefined
      : "requires a configured enum option code.";
  }
  if (qualifier.kind === "numeric") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "requires a number.";
    if (value < qualifier.min) return `must be at least ${qualifier.min}.`;
    if (value > qualifier.max) return `must be at most ${qualifier.max}.`;
    const steps = (value - qualifier.min) / qualifier.step;
    return Math.abs(steps - Math.round(steps)) > 1e-9
      ? `must use ${qualifier.step} increments.`
      : undefined;
  }
  return isClockHourExtent(value) ? undefined : "requires a clock-hour range.";
}

function appendFindingDetailComponentsToObservation(
  observation: Observation,
  findingDetails: FindingDetails | undefined,
  definition: ClinicalFindingDefinition,
  codePrefix: string,
): Observation {
  if (!hasFindingDetails(findingDetails)) return observation;
  const field = customFieldEntries(definition, true).find((candidate) => candidate.valueType === "multi-select");
  if (!field) return observation;
  const additions: ObservationComponent[] = [];
  for (const [optionCode, details] of Object.entries(findingDetails)) {
    const option = field.options?.find((candidate) => candidate.code === optionCode);
    if (!option) continue;
    for (const [qualifierKey, value] of Object.entries(details)) {
      const qualifier = option.qualifiers?.find((candidate) => candidate.key === qualifierKey);
      if (!qualifier) continue;
      additions.push({
        code: odosConcept(
          findingDetailComponentCode(codePrefix, field.localCode, optionCode, qualifierKey),
          `${option.display} — ${qualifier.display}`,
        ),
        ...findingQualifierObservationValue(value, qualifier),
      });
    }
  }
  return additions.length === 0
    ? observation
    : { ...observation, component: [...(observation.component ?? []), ...additions] };
}

function findingQualifierObservationValue(
  value: FindingQualifierValue,
  qualifier: QualifierSeed,
): Pick<ObservationComponent, "valueCodeableConcept" | "valueQuantity" | "valueString"> {
  if (qualifier.kind === "numeric" && typeof value === "number") {
    return {
      valueQuantity: {
        value,
        ...(qualifier.unit ? { unit: qualifier.unit } : {}),
      },
    };
  }
  if (qualifier.kind === "extent" && isClockHourExtent(value)) {
    return { valueString: JSON.stringify(value) };
  }
  const code = String(value);
  const display = qualifier.kind === "enum"
    ? qualifier.options.find((option) => option.code === code)?.display ?? code
    : code;
  return { valueCodeableConcept: odosConcept(code, display) };
}

function observationFindingDetails(
  observation: Observation,
  definition: ClinicalFindingDefinition,
  codePrefix: string,
): FindingDetails | undefined {
  const field = customFieldEntries(definition, true).find((candidate) => candidate.valueType === "multi-select");
  if (!field) return undefined;
  const findingDetails: FindingDetails = {};
  for (const option of field.options ?? []) {
    const details: Record<string, FindingQualifierValue> = {};
    for (const qualifier of option.qualifiers ?? []) {
      const component = findComponent(
        observation,
        findingDetailComponentCode(codePrefix, field.localCode, option.code, qualifier.key),
      );
      const value = component ? observationFindingQualifierValue(component, qualifier) : undefined;
      if (value !== undefined) details[qualifier.key] = value;
    }
    if (Object.keys(details).length > 0) findingDetails[option.code] = details;
  }
  return hasFindingDetails(findingDetails) ? findingDetails : undefined;
}

function observationFindingQualifierValue(
  component: ObservationComponent,
  qualifier: QualifierSeed,
): FindingQualifierValue | undefined {
  if (qualifier.kind === "numeric") {
    const value = component.valueQuantity?.value;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }
  if (qualifier.kind === "extent") {
    if (!component.valueString) return undefined;
    try {
      const parsed: unknown = JSON.parse(component.valueString);
      return isClockHourExtent(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return component.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code ??
    (component.valueString?.trim() || undefined);
}

function findingDetailComponentCode(
  codePrefix: string,
  fieldCode: string,
  optionCode: string,
  qualifierKey: string,
): string {
  return `${codePrefix}${fieldCode}::${optionCode}::${qualifierKey}`;
}

function findComponent(observation: Observation, code: string): ObservationComponent | undefined {
  return observation.component?.find((component) =>
    component.code.coding?.some((coding) => coding.code === code)
  );
}

function hasFindingDetails(value: FindingDetails | undefined): value is FindingDetails {
  return value !== undefined && Object.values(value).some((details) => Object.keys(details).length > 0);
}

function isClockHourExtent(value: unknown): value is ClockHourExtentValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).from === "number" &&
    Number.isFinite((value as Record<string, unknown>).from) &&
    (value as Record<string, number>).from >= 1 &&
    (value as Record<string, number>).from <= 12 &&
    typeof (value as Record<string, unknown>).to === "number" &&
    Number.isFinite((value as Record<string, unknown>).to) &&
    (value as Record<string, number>).to >= 1 &&
    (value as Record<string, number>).to <= 12 &&
    typeof (value as Record<string, unknown>).clockwise === "boolean";
}

function resolveCustomDefinition(
  definitions: ClinicalFindingDefinition[] | undefined,
  params: unknown,
  requireActive: boolean,
): ClinicalFindingDefinition | undefined {
  const stableKey = readStableKey(params);
  if (
    !stableKey?.startsWith("custom:") &&
    !stableKey?.startsWith("ocular-health:") &&
    !stableKey?.startsWith("entrance:") &&
    !stableKey?.startsWith("dry-eye:") &&
    stableKey !== "pachymetry_um" &&
    stableKey !== "manual_keratometry"
  ) return undefined;
  return definitions?.find((definition) =>
    definition.stableKey === stableKey &&
    (definition.sectionKey === stableKey || definition.sectionKey?.startsWith("entrance:")) &&
    (!requireActive || definition.active)
  );
}

async function persistCapture(
  fhir: CustomSectionFhirClient,
  captured: CapturedGlaucomaFinding,
  eye: Eye | "UNKNOWN",
  patientReference: string,
) {
  const observation = await fhir.create(captured.observation, WRITE_HEADERS);
  const observationReference = `Observation/${observation.id ?? captured.observation.id}`;
  const provenance = await fhir.create({
    ...captured.provenance,
    target: patientScopedProvenanceTargets(
      observationReference,
      patientReference,
    ),
  }, WRITE_HEADERS);
  return {
    eye,
    observationReference,
    ...(provenance.id ? { provenanceReference: `Provenance/${provenance.id}` } : {}),
  };
}

function observationEye(observation: Observation): string | undefined {
  return observation.extension?.find((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality)
    ?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
}

function componentString(observation: Observation, code: string): string | undefined {
  const value = observation.component?.find((component) =>
    component.code.coding?.some((coding) => coding.code === code)
  )?.valueString;
  return value?.trim() || undefined;
}

function readStableKey(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const stableKey = (value as Record<string, unknown>).stableKey;
  return typeof stableKey === "string" && stableKey.trim() ? stableKey.trim() : undefined;
}

function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}
