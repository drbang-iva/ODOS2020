import { createHash } from "node:crypto";
import type { Bundle, Encounter, Observation, ObservationComponent, Provenance, Resource } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import { ODOS_EXTENSION_URLS, odosConcept } from "../fhir/ophthalmology/extensions.js";
import {
  appendCustomFieldComponentsToObservation,
  customFieldEntries,
  customFieldValueSchema,
  observationCustomValue,
  validateCustomFieldValues,
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
import {
  translateRetiredFindingRead,
} from "./finding-read-compatibility.js";
import { isLiveObservation } from "./observation-liveness.js";

import { observationFindingDetails, observationNegativeAct, componentString, findingDetailComponentCode, hasFindingDetails, isClockHourExtent, negativeActSchema, NEGATIVE_ACT_IDENTIFIER_SYSTEM, type NegativeAct } from "./finding-section-helpers.js";

import { collectAllFhirSearchPages } from "../fhir-search.js";
import { isClosedEncounter , observePostCommandClosure } from "./encounter-sign-gate.js";
import { loadDiagnosisFindingContext, findingTargetReadOnlyReason, projectRow, offeredRow, findingCommandResponse, type DiagnosisFindingContext } from "./diagnosis-findings-endpoint.js";
import { currentFindingKeySchema, currentFindingPanelKeySchema, currentFindingIdentifier, findingPanelIdentifier, findingPanelTargetId, ownsFact, normalizeFindingPanelState, type CurrentFindingKey, type FindingPanelKey } from "./current-finding-identity.js";
import { classifyReplay, executeFindingCommand, type FindingCommand, type FindingCommandDeps, type FindingCommandTarget, type FindingCommandResult, type FindingOutcome } from "./current-finding-writer.js";

type Eye = "OD" | "OS";

export interface CustomSectionFhirClient extends Partial<Pick<FindingCommandDeps["fhir"], "baseUrl" | "read" | "searchUrl" | "createWithOutcome" | "update">> {
  create<T extends Observation | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  search<T extends Resource>(
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
  negativeAct: negativeActSchema.optional(),
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
): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to save custom section findings." } };
  if (!staffHasBusinessAction(staff, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const definition = resolveCustomDefinition(deps.findingDefinitions?.(), input.params, true);
  if (!definition) return { status: 404, body: { error: "Active custom section not found." } };
  if (definition.valueSchema.type === "ocular-health-structure") return saveOcularHealth(deps, staff, definition, input.body);
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
        negativeAct: parsed.data.eyes[eye]!.negativeAct,
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
        negativeAct: undefined,
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
    if (row.negativeAct && (!ocularHealth || row.state !== "normal" || row.other ||
      row.negativeAct.definitionStableKey !== definition.stableKey || row.negativeAct.eye !== row.eye)) {
      return { status: 400, body: { error: "Negative acts require a matching ocular-health definition and eye, normal state, and no Other finding." } };
    }
    if (row.negativeAct) {
      const identifier = negativeIdentifier(row.negativeAct, parsed.data.patientReference, parsed.data.encounterReference, staff.staffReference);
      const previous = await staff.fhir.search<Observation>("Observation", {
        identifier: `${identifier.system}|${identifier.value}`,
        subject: parsed.data.patientReference, encounter: parsed.data.encounterReference, _count: "2",
      });
      const existing = previous.entry?.map((entry) => entry.resource).find((observation) => observation?.identifier?.some((item) =>
        item.system === identifier.system && item.value === identifier.value));
      const activeCodes = new Set(customFieldEntries(definition).filter((field) => field.valueType === "multi-select")
        .flatMap((field) => (field.options ?? []).filter((option) => option.active).map((option) => option.code)));
      if (!existing && [...row.negativeAct.optionCodes, ...row.negativeAct.exclusions].some((code) => !activeCodes.has(code))) {
        return { status: 400, body: { error: "Negative scope must use active finding option codes from this definition." } };
      }
      if (existing && !isLiveObservation(existing)) {
        return { status: 409, body: { error: "This negative act has been voided; it cannot be replayed as current." } };
      }
    }
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
    if (row.negativeAct) {
      const negativeAct: NegativeAct = { ...row.negativeAct, actorReference: staff.staffReference };
      coded.observation.identifier = [negativeIdentifier(negativeAct, parsed.data.patientReference, parsed.data.encounterReference, staff.staffReference)];
      coded.observation.component = [...(coded.observation.component ?? []), {
        code: odosConcept("NEGATIVE_ACT", "Explicit negative act"), valueString: JSON.stringify(negativeAct),
      }, {
        code: odosConcept("NEGATIVE_CAPTURE_INPUT", "Negative capture input"),
        valueString: JSON.stringify({ values: [...row.values].sort((left, right) => left.code.localeCompare(right.code)), remarks: parsed.data.remarks ?? "" }),
      }, ...negativeAct.optionCodes.map((code) => ({
        code: odosConcept(`NEGATIVE_OPTION::${code}`, code), valueBoolean: false,
      }))];
    }
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
): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read custom section history." } };
  if (!staffHasBusinessAction(staff, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const definition = resolveCustomDefinition(deps.findingDefinitions?.(), input.params, false);
  if (!definition) return { status: 404, body: { error: "Custom section not found." } };
  const parsed = historyQuerySchema.safeParse(input.query);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid custom section history request." } };
  }
  if (definition.valueSchema.type === "ocular-health-structure") return readOcularHealth(deps, staff, definition, parsed.data);
  const bundle = await staff.fhir.search<Observation>("Observation", {
    subject: parsed.data.patient,
    code: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|${definition.stableKey}`,
    ...(parsed.data.encounter ? { encounter: parsed.data.encounter } : {}),
    _sort: "-date",
    _count: "200",
  });
  const rows = snapshotHistoryRows((bundle.entry ?? []).flatMap(entry => entry.resource ? [entry.resource] : []), definition);
  return { status: 200, body: { rows } };
}

function snapshotHistoryRows(observations: Observation[], definition: ClinicalFindingDefinition) {
  return observations.flatMap((observation) => {
    if (!observation || !isLiveObservation(observation)) return [];
    const eye = observationEye(observation);
    const perEye = definition.valueSchema.perEye === true;
    const prefix = perEye && (eye === "OD" || eye === "OS") ? `${eye}_` : "";
    const values = customFieldEntries(definition, true).flatMap((field) => {
      const value = translateRetiredFindingRead(
        observation,
        definition.stableKey,
        field,
        prefix,
      ).value;
      return value === undefined ? [] : [{
        code: field.localCode,
        label: field.display,
        value,
        ...(field.unit ? { unit: field.unit } : {}),
      }];
    });
    const findingDetails = observationFindingDetails(observation, definition, prefix);
    return [{
      ...(observation.id
        ? { observationReference: `Observation/${observation.id}` }
        : {}),
      recordedAt: observation.effectiveDateTime ?? observation.issued ?? observation.meta?.lastUpdated ?? "",
      ...(perEye && (eye === "OD" || eye === "OS") ? { eye } : {}),
      values,
      ...(findingDetails ? { findingDetails } : {}),
      ...(observationNegativeAct(observation) ? { negativeAct: observationNegativeAct(observation) } : {}),
      ...(componentString(observation, "EXAM_STATE") ? { state: componentString(observation, "EXAM_STATE") } : {}),
      ...(componentString(observation, "NORMAL_TEMPLATE") ? { normalTemplate: componentString(observation, "NORMAL_TEMPLATE") } : {}),
      ...(componentString(observation, "OTHER") ? { other: componentString(observation, "OTHER") } : {}),
      ...(componentString(observation, "REMARKS") ? { remarks: componentString(observation, "REMARKS") } : {}),
    }];
  });
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
  const negativeAct = observationNegativeAct(captured.observation);
  const identifier = captured.observation.identifier?.find((item) => item.system === NEGATIVE_ACT_IDENTIFIER_SYSTEM);
  const observation = await fhir.create({ ...captured.observation, ...(negativeAct ? { id: undefined } : {}) }, {
    ...WRITE_HEADERS,
    ...(identifier ? { "If-None-Exist": `identifier=${encodeURIComponent(`${identifier.system}|${identifier.value}`)}` } : {}),
  });
  if (negativeAct && (JSON.stringify(observationNegativeAct(observation)) !== JSON.stringify(negativeAct) ||
    componentString(observation, "NEGATIVE_CAPTURE_INPUT") !== componentString(captured.observation, "NEGATIVE_CAPTURE_INPUT"))) {
    throw new Error("Negative act replay conflicts with its original frozen scope.");
  }
  const observationReference = `Observation/${observation.id ?? captured.observation.id}`;
  const provenance = await fhir.create({
    ...captured.provenance,
    ...(negativeAct ? { id: undefined } : {}),
    target: patientScopedProvenanceTargets(
      observationReference,
      patientReference,
    ),
  }, {
    ...WRITE_HEADERS,
    ...(negativeAct ? { "If-None-Exist": `target=${encodeURIComponent(observationReference)}` } : {}),
  });
  return {
    eye,
    ...(negativeAct ? { negativeAct } : {}),
    observationReference,
    ...(provenance.id ? { provenanceReference: `Provenance/${provenance.id}` } : {}),
  };
}

function observationEye(observation: Observation): string | undefined {
  return observation.extension?.find((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality)
    ?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
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


function negativeIdentifier(act: z.infer<typeof negativeActSchema>, patient: string, encounter: string, actor: string) {
  return { system: NEGATIVE_ACT_IDENTIFIER_SYSTEM, value: createHash("sha256")
    .update(JSON.stringify([patient, encounter, act.definitionStableKey, act.eye, actor, act.id])).digest("hex") };
}

const canonicalBaselineSchema = z.object({ kind: z.literal("canonical"), reference: z.string().regex(/^Observation\/[A-Za-z0-9.-]+$/), versionId: z.string().min(1) }).strict();
const claimSchema = z.object({ key: currentFindingKeySchema, baseline: z.union([canonicalBaselineSchema, z.object({ kind: z.literal("absent"), key: currentFindingKeySchema }).strict()]).optional(), presence: z.literal("present"), qualifiers: z.record(findingQualifierValueSchema), homes: z.array(z.string().regex(/^Condition\/[A-Za-z0-9.-]+$/)), fromPresence: z.literal("absent").optional() }).strict();
const ocularNegativeSchema = z.object({ id: z.string().uuid(), scope: z.array(z.string().min(1)).min(1).max(300), exclusions: z.array(z.string().min(1)).max(300) }).strict().refine(n => new Set([...n.scope, ...n.exclusions]).size === n.scope.length + n.exclusions.length);
const ocularEyeSchema = z.object({ loaded: z.array(claimSchema).max(500), selected: z.array(claimSchema).max(500), panel: z.object({ baseline: z.union([canonicalBaselineSchema, z.object({ kind: z.literal("absent"), key: currentFindingPanelKeySchema }).strict()]).optional(), state: z.unknown() }).strict().optional(), negativeAct: ocularNegativeSchema.optional() }).strict();
const ocularSaveSchema = z.object({ commandId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i), patientReference: z.string().regex(/^Patient\/[A-Za-z0-9.-]+$/), encounterReference: z.string().regex(/^Encounter\/[A-Za-z0-9.-]+$/), eyes: z.object({ OD: ocularEyeSchema.optional(), OS: ocularEyeSchema.optional() }).strict().refine(e => !!e.OD || !!e.OS) }).strict();
type OcularStaff = NonNullable<Awaited<ReturnType<CustomSectionEndpointDeps["authenticate"]>>>;
type OcularClaim = z.infer<typeof claimSchema>;
type OcularResponse = { status: number; body: unknown; headers?: Record<string, string> };
type OcularStep = { eye: Eye; target: FindingCommandTarget } | { eye: Eye; negative: z.infer<typeof ocularNegativeSchema>; existing?: Observation };
const canonicalJson = (value: unknown): string => JSON.stringify(normalizeJson(value));
function normalizeJson(value: unknown): unknown { return Array.isArray(value) ? value.map(normalizeJson) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalizeJson(v)])) : value; }
const sameValue = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sameHomes = (a: string[], b: string[]) => sameValue([...a].sort(), [...b].sort()) && new Set(a).size === a.length;
const factId = (key: CurrentFindingKey) => `finding:${currentFindingIdentifier(key).value}`;
const ocularError = (status: number, reason: string, fresh?: unknown): OcularResponse => ({ status, body: { result: "invalid", reason, ...(fresh ? { fresh } : {}) } });
function ocularReadFhir(staff: OcularStaff): Pick<FindingCommandDeps["fhir"], "read" | "baseUrl" | "search" | "searchUrl"> {
  if (!staff.fhir.read || !staff.fhir.baseUrl) throw new Error("Ocular Health requires the finding read transport.");
  return staff.fhir as Pick<FindingCommandDeps["fhir"], "read" | "baseUrl" | "search" | "searchUrl">;
}
function ocularFhir(staff: OcularStaff): FindingCommandDeps["fhir"] {
  if (!staff.fhir.read || !staff.fhir.createWithOutcome || !staff.fhir.update || !staff.fhir.baseUrl) throw new Error("Ocular Health requires the conditional finding transport.");
  return staff.fhir as FindingCommandDeps["fhir"];
}
function panelKey(context: DiagnosisFindingContext, definition: ClinicalFindingDefinition, eye: Eye): FindingPanelKey {
  return { v: 1, patientId: context.state.patientReference.slice(8), encounterId: context.state.encounterReference.slice(10), stableKey: definition.stableKey, eye };
}
function panelOwner(context: DiagnosisFindingContext, key: FindingPanelKey): Observation | undefined {
  const id = findingPanelIdentifier(key);
  return context.state.observations.find(o => o.identifier?.some(i => i.system === id.system && i.value === id.value));
}
function baselineMatches(baseline: unknown, current: { baseline?: unknown } | undefined): boolean {
  const supplied = baseline as { kind?: string } | undefined;
  return supplied?.kind === "absent" ? !current : !!current && sameValue(baseline, current.baseline);
}
function claimMatches(claim: OcularClaim, context: DiagnosisFindingContext): boolean {
  const current = context.projection.currentFacts.find(f => f.projectionKey === factId(claim.key));
  return !!current && current.status === "live" && current.presence === claim.presence && sameValue(current.qualifiers, claim.qualifiers) && sameHomes(current.homes, claim.homes) && baselineMatches(claim.baseline, current);
}
function keyInScope(key: CurrentFindingKey | FindingPanelKey, context: DiagnosisFindingContext, definition: ClinicalFindingDefinition, eye: Eye): boolean {
  return key.patientId === context.state.patientReference.slice(8) && key.encounterId === context.state.encounterReference.slice(10) && key.stableKey === definition.stableKey && key.eye === eye;
}
function negativeMatches(observation: Observation, negative: z.infer<typeof ocularNegativeSchema>, actor: string): boolean {
  const act = observationNegativeAct(observation);
  return !!act && act.actorReference === actor && sameValue([...act.optionCodes].sort(), [...negative.scope].sort()) && sameValue([...act.exclusions].sort(), [...negative.exclusions].sort());
}
function positiveInScope(context: DiagnosisFindingContext, definition: ClinicalFindingDefinition, eye: Eye, scope: string[], omitted = new Set<string>()): boolean {
  return context.projection.currentFacts.some(f => f.key.stableKey === definition.stableKey && f.eye === eye && f.status === "live" && f.presence === "present" && scope.includes(f.key.optionCode) && !omitted.has(f.projectionKey));
}

async function saveOcularHealth(deps: CustomSectionEndpointDeps, staff: OcularStaff, definition: ClinicalFindingDefinition, input: unknown): Promise<OcularResponse> {
  const parsed = ocularSaveSchema.safeParse(input);
  if (!parsed.success) return ocularError(400, "invalid");
  const body = parsed.data;
  if (EYES.some(eye => { const row = body.eyes[eye]; return row && ([...row.loaded, ...row.selected].some(c => !c.baseline) || row.panel && !row.panel.baseline); })) return { status: 428, headers: { "Cache-Control": "no-store" }, body: { result: "precondition", reason: "missing-baseline" } };
  const fhir = ocularFhir(staff);
  const definitions = deps.findingDefinitions?.() ?? [];
  const context = await loadDiagnosisFindingContext(fhir, body.encounterReference.slice(10), definitions);
  if (context.incomplete) return ocularError(context.kind === "refused" ? 403 : context.kind === "missing" ? 404 : 503, context.kind);
  if (isClosedEncounter(context.encounter)) return ocularError(409, "encounter-closed");
  if (body.patientReference !== context.state.patientReference) return ocularError(400, "patient-mismatch");
  if (context.projection.preRebuild) return ocularError(409, "pre-rebuild-test-encounter");
  const writerDeps: FindingCommandDeps = { fhir, definitions, catalog: context.catalog, staffReference: staff.staffReference, now: deps.now };
  const command: FindingCommand = { commandId: body.commandId, patientReference: body.patientReference, encounterReference: body.encounterReference, surface: "ocular-health", targets: [] };
  const steps: OcularStep[] = [];
  for (const eye of EYES) {
    const row = body.eyes[eye]; if (!row) continue;
    const loaded = new Map(row.loaded.map(c => [factId(c.key), c])), selected = new Map(row.selected.map(c => [factId(c.key), c]));
    if (loaded.size !== row.loaded.length || selected.size !== row.selected.length) return ocularError(400, "invalid");
    for (const claim of [...row.loaded, ...row.selected]) {
      const field = customFieldEntries(definition, true).find(f => f.localCode === claim.key.fieldCode);
      if (!keyInScope(claim.key, context, definition, eye) || !field || !ownsFact(definition, field)) return ocularError(400, "invalid");
      if (claim.baseline?.kind === "absent" && !sameValue(claim.baseline.key, claim.key)) return ocularError(400, "invalid");
      if (new Set(claim.homes).size !== claim.homes.length) return ocularError(400, "invalid");
      const other = loaded.get(factId(claim.key));
      if (other && selected.has(factId(claim.key)) && !sameValue(other.baseline, selected.get(factId(claim.key))!.baseline)) return ocularError(400, "invalid");
    }
    let panelState;
    try { if (row.panel) panelState = normalizeFindingPanelState(row.panel.state, definition); }
    catch { return ocularError(400, "invalid"); }
    const clears: FindingCommandTarget[] = [], assertions: FindingCommandTarget[] = [];
    for (const [id, claim] of loaded) if (!selected.has(id) && !panelState?.deferred) clears.push({ kind: "fact", key: claim.key, baseline: claim.baseline, state: { status: "retired", presence: claim.presence, qualifiers: claim.qualifiers, homes: claim.homes } });
    for (const [id, claim] of selected) {
      const before = loaded.get(id);
      if (!before && claim.homes.length) return ocularError(400, "invalid");
      if (before && !sameHomes(before.homes, claim.homes)) return ocularError(400, "invalid");
      if (!before || !sameValue(before.qualifiers, claim.qualifiers)) assertions.push({ kind: "fact", key: claim.key, baseline: claim.baseline, state: { status: "live", presence: "present", qualifiers: claim.qualifiers, homes: before?.homes ?? [] } });
    }
    const targets = [...clears, ...assertions];
    if (row.panel && panelState) {
      const key = panelKey(context, definition, eye), current = context.projection.panels.find(p => p.stableKey === definition.stableKey && p.eye === eye);
      if (row.panel.baseline?.kind === "absent" && !sameValue(row.panel.baseline.key, key)) return ocularError(400, "invalid");
      const owner = panelOwner(context, key);
      const reason = current?.conflict ? "conflict" : owner && !["preliminary", "entered-in-error"].includes(owner.status) ? "signed-or-cancelled" : !definition.active ? "inactive-definition" : undefined;
      if (reason) return ocularError(reason === "signed-or-cancelled" ? 422 : 409, reason);
      targets.push({ kind: "panel", key, baseline: row.panel.baseline, state: panelState });
    }
    const exact = new Set<string>();
    for (const target of targets) {
      if (target.kind !== "fact" && target.kind !== "panel") continue;
      const id = target.kind === "fact" ? factId(target.key) : findingPanelTargetId(target.key);
      if (target.kind === "fact") {
        const reason = findingTargetReadOnlyReason(context, target.key);
        if (reason) return ocularError(reason === "signed-or-cancelled" ? 422 : 409, reason);
      }
      const replay = await classifyReplay({ ...context.state, fhir, staffReference: staff.staffReference }, command, target);
      if (replay === "reused-with-different-content") return ocularError(409, "command-reused");
      if (replay === "exact-replay") { exact.add(id); continue; }
      if (target.kind === "fact") {
        const reason = findingTargetReadOnlyReason(context, target.key);
        if (reason) return ocularError(reason === "signed-or-cancelled" ? 422 : 409, reason);
        const current = context.projection.currentFacts.find(f => f.projectionKey === id);
        if (!baselineMatches(target.baseline, current)) return ocularError(409, "stale-baseline", context.projection);
        const option = customFieldEntries(definition).find(f => f.localCode === target.key.fieldCode)?.options?.find(o => o.code === target.key.optionCode && o.active);
        if (!option) return ocularError(409, "inactive-definition");
        if (Object.entries(target.state.qualifiers).some(([name, value]) => { const q = option.qualifiers?.find(q => q.key === name); return !q || !!validateFindingQualifierValue(value, q); })) return ocularError(400, "invalid");
        const claim = selected.get(id);
        if (current?.status === "live" && current.presence === "absent" && claim && claim.fromPresence !== "absent") return ocularError(400, "invalid");
      } else {
        const current = context.projection.panels.find(p => p.stableKey === definition.stableKey && p.eye === eye);
        if (!baselineMatches(target.baseline, current?.panelBaseline ? { baseline: current.panelBaseline } : undefined)) return ocularError(409, "stale-baseline", context.projection);
      }
    }
    for (const claim of row.loaded) {
      const reason = findingTargetReadOnlyReason(context, claim.key);
      const submitted = selected.get(factId(claim.key));
      const witness = submitted && sameValue(claim.qualifiers, submitted.qualifiers) && sameHomes(claim.homes, submitted.homes);
      if (reason && !(witness && ["signed-or-cancelled", "inactive-definition"].includes(reason))) return ocularError(reason === "signed-or-cancelled" ? 422 : 409, reason);
      if (!exact.has(factId(claim.key)) && !claimMatches(claim, context)) return ocularError(409, "stale-baseline", context.projection);
    }
    steps.push(...targets.map(target => ({ eye, target })));
    if (row.negativeAct) {
      const negative = row.negativeAct;
      const existing = context.state.observations.filter(o => { const n = observationNegativeAct(o); return n && n.id === negative.id && n.definitionStableKey === definition.stableKey && n.eye === eye; });
      if (existing.length > 1 || existing.length === 1 && !negativeMatches(existing[0], negative, staff.staffReference)) return ocularError(409, "command-reused");
      if (existing[0] && !isLiveObservation(existing[0])) return ocularError(409, "negative-act-voided");
      if (!existing.length) {
        const active = new Set(customFieldEntries(definition).filter(f => ownsFact(definition, f)).flatMap(f => f.options?.filter(o => o.active).map(o => o.code) ?? []));
        if ([...negative.scope, ...negative.exclusions].some(code => !active.has(code))) return ocularError(400, "invalid");
        const retired = new Set(clears.filter(t => t.kind === "fact").map(t => factId(t.key)));
        if (row.selected.some(c => negative.scope.includes(c.key.optionCode)) || positiveInScope(context, definition, eye, negative.scope, retired)) return ocularError(409, "positive-in-negative-scope");
      }
      steps.push({ eye, negative, ...(existing[0] ? { existing: existing[0] } : {}) });
    }
  }
  const outcomes: Array<FindingOutcome & { kind?: "negative-act" }> = [];
  let stopped = false;
  for (const step of steps) {
    const target = "negative" in step ? `negative:${step.eye}` : step.target.kind === "panel" ? findingPanelTargetId(step.target.key) : step.target.kind === "legacy-retire" ? step.target.sourceReference : factId(step.target.key);
    if (stopped) { outcomes.push({ target, ...("negative" in step ? { kind: "negative-act" as const } : {}), status: "not-attempted", clinicalWrite: "none", cause: "halted-by-earlier-target" }); continue; }
    const outcome = "negative" in step ? await executeOcularNegative(deps, writerDeps, context, definition, step) : (await executeFindingCommand(writerDeps, { ...command, targets: [step.target] })).outcomes[0];
    outcomes.push(outcome);
    stopped = !["applied", "unchanged", "already-applied"].includes(outcome.status) || outcome.auditPending === true;
  }
  const result: FindingCommandResult = { commandId: command.commandId, complete: !stopped, executionOrder: outcomes.map((_, index) => index), outcomes };
  const response = findingCommandResponse(result);
  const closure = await observePostCommandClosure(() => fhir.read<Encounter>("Encounter", body.encounterReference.slice(10)));
  return { ...response, body: { ...(response.body as object), ...closure } };
}

async function executeOcularNegative(deps: CustomSectionEndpointDeps, writerDeps: FindingCommandDeps, context: DiagnosisFindingContext, definition: ClinicalFindingDefinition, step: Extract<OcularStep, { negative: unknown }>): Promise<FindingOutcome & { kind: "negative-act" }> {
  const base = { target: `negative:${step.eye}`, kind: "negative-act" as const };
  let observation = step.existing;
  let clinicalWrite: FindingOutcome["clinicalWrite"] = "none";
  if (!observation) {
    const fresh = await loadDiagnosisFindingContext(writerDeps.fhir, context.encounter.id!, [...context.state.definitions]);
    if (fresh.incomplete) return { ...base, status: "not-attempted", cause: "refresh", clinicalWrite, fresh };
    if (positiveInScope(fresh, definition, step.eye, step.negative.scope)) return { ...base, status: "conflict", clinicalWrite, reason: "positive-in-negative-scope" };
    const recordedAt = deps.now?.() ?? new Date().toISOString();
    const act: NegativeAct = { id: step.negative.id, definitionStableKey: definition.stableKey, eye: step.eye, optionCodes: step.negative.scope, exclusions: step.negative.exclusions, assertedAt: recordedAt, actorReference: writerDeps.staffReference };
    const captured = captureGlaucomaFinding({ definition, patientReference: context.state.patientReference, encounterReference: context.state.encounterReference, laterality: step.eye, value: { type: "components", components: [] }, sourceType: "manual", performerReferences: [act.actorReference], recordedAt, provenance: { source: "manual", recordedAt, actorReference: act.actorReference, note: "Practice-created custom section capture." } });
    const identifier = negativeIdentifier(act, context.state.patientReference, context.state.encounterReference, act.actorReference);
    const resource: Observation = { ...captured.observation, id: undefined, identifier: [identifier], component: [{ code: odosConcept("NEGATIVE_ACT"), valueString: JSON.stringify(act) }, ...act.optionCodes.map(code => ({ code: odosConcept(`NEGATIVE_OPTION::${code}`), valueBoolean: false }))] };
    try {
      const created = await writerDeps.fhir.createWithOutcome(resource, { ...WRITE_HEADERS, "If-None-Exist": `identifier=${encodeURIComponent(`${identifier.system}|${identifier.value}`)}` });
      observation = created.resource; clinicalWrite = created.created ? "confirmed" : "none";
    } catch {
      try { const found = await writerDeps.fhir.search<Observation>("Observation", { identifier: `${identifier.system}|${identifier.value}`, encounter: context.state.encounterReference, subject: context.state.patientReference }); observation = found.entry?.length === 1 ? found.entry[0].resource : undefined; }
      catch { return { ...base, status: "unconfirmed", clinicalWrite: "unknown", cause: "verify-read" }; }
      if (!observation) return { ...base, status: "unconfirmed", clinicalWrite: "unknown", cause: "verify-read" };
      clinicalWrite = "confirmed";
    }
  }
  const reference = `Observation/${observation.id}`;
  if (!negativeMatches(observation, step.negative, writerDeps.staffReference)) return { ...base, status: "conflict", clinicalWrite, reference, reason: "command-reused" };
  if (!isLiveObservation(observation)) return { ...base, status: "conflict", clinicalWrite, reference, reason: "negative-act-voided" };
  const act = observationNegativeAct(observation)!;
  const original = captureGlaucomaFinding({ definition, patientReference: context.state.patientReference, encounterReference: context.state.encounterReference, laterality: step.eye, value: { type: "components", components: [] }, sourceType: "manual", performerReferences: [act.actorReference], recordedAt: act.assertedAt, provenance: { source: "manual", recordedAt: act.assertedAt, actorReference: act.actorReference, note: "Practice-created custom section capture." } });
  try {
    await writerDeps.fhir.createWithOutcome({ ...original.provenance, id: undefined, target: patientScopedProvenanceTargets(reference, context.state.patientReference) }, { ...WRITE_HEADERS, "If-None-Exist": `target=${encodeURIComponent(reference)}` });
    return { ...base, status: step.existing ? "already-applied" : "applied", clinicalWrite, reference };
  } catch { return { ...base, status: "not-attempted", cause: "audit-repair", clinicalWrite, reference, auditPending: true }; }
}

function ocularHistoryEye(context: DiagnosisFindingContext, definition: ClinicalFindingDefinition, eye: Eye) {
  const reason = isClosedEncounter(context.encounter) ? "encounter-closed" : context.projection.preRebuild ? "pre-rebuild-test-encounter" : undefined;
  const current = context.projection.panels.find(p => p.stableKey === definition.stableKey && p.eye === eye);
  const facts = context.projection.currentFacts.filter(f => f.key.stableKey === definition.stableKey && f.eye === eye).map(f => projectRow(context, f, "fact"));
  const conflicts = context.projection.conflicts.filter(f => f.key.stableKey === definition.stableKey && f.eye === eye).map(f => projectRow(context, f, "conflict"));
  const rows = [...facts, ...conflicts];
  const offered = context.catalog.filter(c => c.findingDefinitionKey === definition.stableKey && !rows.some(r => r.atomicFindingId === c.atomicFindingId)).map(c => ({ ...offeredRow(context, c, eye), status: "absent" as const }));
  const key = panelKey(context, definition, eye), owner = panelOwner(context, key);
  const panelReason = reason ?? (current?.conflict ? "conflict" : owner && !["preliminary", "entered-in-error"].includes(owner.status) ? "signed-or-cancelled" : !definition.active ? "inactive-definition" : undefined);
  return { encounterEditable: !reason, ...(reason ? { readOnlyReason: reason } : {}), facts: [...rows, ...offered], panel: { deferred: current?.deferred ?? false, ...(current?.other ? { other: current.other } : {}), ...(current?.remarks ? { remarks: current.remarks } : {}), values: current?.values ?? {}, baseline: current?.panelBaseline ?? { kind: "absent", key }, editable: !panelReason, ...(panelReason ? { readOnlyReason: panelReason } : {}), ...(current?.auditPending ? { auditPending: true } : {}) }, negativeActs: current?.negativeActs ?? [], ...(context.projection.preRebuild ? { legacySnapshots: current?.snapshots ?? [] } : {}) };
}
async function readOcularHealth(deps: CustomSectionEndpointDeps, staff: OcularStaff, definition: ClinicalFindingDefinition, query: z.infer<typeof historyQuerySchema>): Promise<OcularResponse> {
  const fhir = ocularReadFhir(staff), definitions = deps.findingDefinitions?.() ?? [];
  let references = query.encounter ? [query.encounter] : [];
  let unscopedCount = 0;
  if (!query.encounter) {
    const codes = new Set([definition.stableKey, ...customFieldEntries(definition, true).flatMap(field => [
      `${definition.stableKey}::${field.localCode}`,
      ...(field.options ?? []).map(option => `${definition.stableKey}::${field.localCode}::${option.code}`),
    ])]);
    const first = await fhir.search<Observation>("Observation", { subject: query.patient, code: [...codes].join(","), _count: "200" });
    const observations = await collectAllFhirSearchPages(fhir, "Observation", first, fhir.baseUrl);
    const contributing = observations.filter(o => o.code.coding?.some(c => c.code && codes.has(c.code)));
    if (contributing.some(o => o.subject?.reference !== query.patient)) return ocularError(409, "foreign-or-unscoped");
    const scoped = contributing.filter(o => {
      if (o.encounter?.reference?.match(/^Encounter\/[A-Za-z0-9.-]+$/)) return true;
      unscopedCount++;
      return false;
    });
    references = [...new Set(scoped.map(o => o.encounter!.reference!))];
  }
  const encounters = [];
  const rows: ReturnType<typeof snapshotHistoryRows> = [];
  for (const reference of references) {
    const context = await loadDiagnosisFindingContext(fhir, reference.slice(10), definitions);
    if (context.incomplete) return ocularError(context.kind === "refused" ? 403 : context.kind === "missing" ? 404 : 503, context.kind);
    if (context.state.patientReference !== query.patient) return ocularError(409, "patient-mismatch");
    const reason = isClosedEncounter(context.encounter) ? "encounter-closed" : context.projection.preRebuild ? "pre-rebuild-test-encounter" : undefined;
    if (context.projection.preRebuild) rows.push(...snapshotHistoryRows(context.state.observations.filter(o => o.code.coding?.some(c => c.code === definition.stableKey)), definition));
    encounters.push({ encounterReference: reference, recordedAt: context.encounter.period?.start ?? "", encounterEditable: !reason, ...(reason ? { readOnlyReason: reason } : {}), eyes: { OD: ocularHistoryEye(context, definition, "OD"), OS: ocularHistoryEye(context, definition, "OS") } });
  }
  return { status: 200, body: query.encounter ? { ...encounters[0], rows } : { encounters, rows, unscopedCount } };
}
