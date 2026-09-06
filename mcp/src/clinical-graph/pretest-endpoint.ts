import { randomUUID } from "node:crypto";
import type { Bundle, Observation, ObservationComponent, Provenance } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import { odosConcept } from "../fhir/ophthalmology/extensions.js";
import {
  buildClinicalFindingDefinition,
  captureGlaucomaFinding,
  patientScopedProvenanceTargets,
  type CapturedGlaucomaFinding,
  type ClinicalFindingDefinition,
  type ClinicalFindingOption,
  type ClinicalGraphProvenance,
  type FindingValue,
} from "./glaucoma-suspect.js";
import {
  codeCustomFieldComponents,
  customFieldComponents,
  customFieldEntries,
  customFieldValueSchema,
  validateCustomFieldValues,
} from "./custom-fields.js";
import { decimalField } from "./contact-lens-definition.js";
import { isLiveObservation } from "./observation-liveness.js";
export { registerPretestVitalsRoutes } from "./pretest-vitals-endpoint.js";

export interface PretestFhirClient {
  search<T extends Observation>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  create<T extends Observation | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export interface PretestAuthenticatedStaff {
  staffReference: string;
  actorRole: PracticeRoleId;
  fhir: PretestFhirClient;
}

export interface PretestEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<PretestAuthenticatedStaff | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
}

export interface PretestEndpointResult {
  status: number;
  body: unknown;
}

const WRITE_HEADERS = { "X-ODOS-Source": "mcp/save_section_observations" } as const;
const EYES = ["OD", "OS"] as const;
const SOURCE_TYPES = ["manual", "device"] as const;

const wearingEyeSchema = z.object({
  sphere: z.number().optional(),
  cylinder: z.number().optional(),
  axis: z.number().int().optional(),
  add: z.number().optional(),
  prismAmount: z.number().optional(),
  prismBase: z.string().trim().min(1).optional(),
  distanceVisualAcuity: z.string().trim().min(1).max(100).optional(),
  nearVisualAcuity: z.string().trim().min(1).max(100).optional(),
  customFields: z.array(customFieldValueSchema).max(64).default([]),
}).strict();

const wearingPairSchema = z.object({
  eyeglassType: z.string().trim().min(1),
  remarks: z.string().trim().max(2000).optional(),
  OD: wearingEyeSchema.optional(),
  OS: wearingEyeSchema.optional(),
}).strict();

const wearingRequestSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  sourceType: z.enum(SOURCE_TYPES).default("manual"),
  leftGlassesAtHome: z.boolean().default(false),
  pairs: z.array(wearingPairSchema).default([]),
}).strict();

const autoEyeSchema = z.object({
  sphere: z.number().optional(),
  cylinder: z.number().optional(),
  axis: z.number().int().optional(),
  flatK: z.number().optional(),
  flatAxis: z.number().int().optional(),
  steepK: z.number().optional(),
  steepAxis: z.number().int().optional(),
  customFields: z.array(customFieldValueSchema).max(64).default([]),
}).strict();

const autoRefractionRequestSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  sourceType: z.enum(SOURCE_TYPES).default("manual"),
  remarks: z.string().trim().max(2000).optional(),
  binocularPdDistance: z.number().optional(),
  binocularPdNear: z.number().optional(),
  eyes: z.object({
    OD: autoEyeSchema.optional(),
    OS: autoEyeSchema.optional(),
  }).strict(),
}).strict();

const autoRefractionHistoryQuerySchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
}).strict();

type Eye = typeof EYES[number];
type WearingRequest = z.infer<typeof wearingRequestSchema>;
type WearingEyePayload = z.infer<typeof wearingEyeSchema>;
type AutoRefractionRequest = z.infer<typeof autoRefractionRequestSchema>;
type AutoEyePayload = z.infer<typeof autoEyeSchema>;

export async function handleWearingDefinitionRequest(
  deps: Pick<PretestEndpointDeps, "authenticate" | "findingDefinitions">,
  input: { authHeader: string | undefined },
): Promise<PretestEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read Wearing definition." } };
  }
  if (!staffHasBusinessAction(staff, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  return {
    status: 200,
    body: { definition: definitionSummary(resolveWearingDefinition(deps.findingDefinitions?.())) },
  };
}

export async function handleAutoRefractionDefinitionRequest(
  deps: Pick<PretestEndpointDeps, "authenticate" | "findingDefinitions">,
  input: { authHeader: string | undefined },
): Promise<PretestEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read auto-refraction definition." } };
  }
  if (!staffHasBusinessAction(staff, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const definitions = resolveAutoRefractionDefinitions(deps.findingDefinitions?.());
  return {
    status: 200,
    body: {
      definitions: {
        autoRefraction: definitionSummary(definitions.autoRefraction),
        autoKeratometry: definitionSummary(definitions.autoKeratometry),
      },
    },
  };
}

export async function handleAutoRefractionHistoryRequest(
  deps: PretestEndpointDeps,
  input: { authHeader: string | undefined; query: unknown },
): Promise<PretestEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read auto-refraction history." } };
  }
  if (!staffHasBusinessAction(staff, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const parsed = autoRefractionHistoryQuerySchema.safeParse(input.query);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid auto-refraction history request." } };
  }

  const bundle = await staff.fhir.search<Observation>("Observation", {
    subject: parsed.data.patientReference,
    encounter: parsed.data.encounterReference,
    code: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|auto_refraction,${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|auto_keratometry`,
    _sort: "-date",
    _count: "200",
  });
  const observations = (bundle.entry ?? []).flatMap((entry) => {
    const observation = entry.resource;
    return observation
      && observation.id
      && observation.subject?.reference === parsed.data.patientReference
      && observation.encounter?.reference === parsed.data.encounterReference
      && isLiveObservation(observation)
      ? [observation]
      : [];
  }).sort((left, right) => observationDate(right).localeCompare(observationDate(left)));

  const eyes: Partial<Record<Eye, Record<string, unknown>>> = {};
  let remarks: string | undefined;
  for (const eye of EYES) {
    const autoRefraction = latestPretestObservation(observations, "auto_refraction", eye);
    const autoKeratometry = latestPretestObservation(observations, "auto_keratometry", eye);
    if (!autoRefraction && !autoKeratometry) continue;
    const observationReferences = [autoRefraction, autoKeratometry]
      .flatMap((observation) => observation?.id ? [`Observation/${observation.id}`] : []);
    eyes[eye] = definedRecord({
      sphere: observationComponentNumber(autoRefraction, "SPHERE"),
      cylinder: observationComponentNumber(autoRefraction, "CYLINDER"),
      axis: observationComponentNumber(autoRefraction, "AXIS"),
      flatK: observationComponentNumber(autoKeratometry, "FLAT_K"),
      flatAxis: observationComponentNumber(autoKeratometry, "FLAT_AXIS"),
      steepK: observationComponentNumber(autoKeratometry, "STEEP_K"),
      steepAxis: observationComponentNumber(autoKeratometry, "STEEP_AXIS"),
      observationReferences,
    });
    remarks ??= observationComponentString(autoRefraction, "REMARKS")
      ?? observationComponentString(autoKeratometry, "REMARKS");
  }

  const binocularPd = latestPretestObservation(observations, "auto_refraction", "OU");
  return {
    status: 200,
    body: definedRecord({
      eyes,
      binocularPdDistance: observationComponentNumber(binocularPd, "BINOCULAR_PD_DISTANCE"),
      binocularPdNear: observationComponentNumber(binocularPd, "BINOCULAR_PD_NEAR"),
      binocularPdObservationReferences: binocularPd?.id ? [`Observation/${binocularPd.id}`] : undefined,
      remarks,
    }),
  };
}

export async function handleWearingHistoryRequest(
  deps: PretestEndpointDeps,
  input: { authHeader: string | undefined; query: unknown },
): Promise<PretestEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read Wearing history." } };
  if (!staffHasBusinessAction(staff, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const parsed = autoRefractionHistoryQuerySchema.safeParse(input.query);
  if (!parsed.success) return { status: 400, body: { error: "Patient and encounter references are required." } };
  const bundle = await staff.fhir.search<Observation>("Observation", {
    subject: parsed.data.patientReference,
    encounter: parsed.data.encounterReference,
    code: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|wearing_rx`,
    _sort: "-date",
    _count: "1000",
  });
  if (bundle.link?.some((link) => link.relation === "next")) {
    return { status: 409, body: { error: "Wearing history exceeds the read limit; no partial form was loaded." } };
  }
  const observations = (bundle.entry ?? []).flatMap(({ resource }) =>
    resource?.id && isLiveObservation(resource)
      && resource.subject?.reference === parsed.data.patientReference
      && resource.encounter?.reference === parsed.data.encounterReference
      && resource.code.coding?.some((coding) => coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && coding.code === "wearing_rx")
      ? [resource] : [])
    .sort((a, b) => Date.parse(observationDate(b)) - Date.parse(observationDate(a)));
  const latest = observations[0];
  if (!latest) return { status: 200, body: { pairs: [], leftGlassesAtHome: false } };
  const recordedAt = observationDate(latest);
  if (!Number.isFinite(Date.parse(recordedAt))) {
    return { status: 409, body: { error: "Wearing history has no recording date; the saved pairs could not be loaded." } };
  }
  const sameTime = observations.filter((observation) => Date.parse(observationDate(observation)) === Date.parse(recordedAt));
  const captureIds = new Set(sameTime.flatMap((observation) => observationComponentString(observation, "WEARING_CAPTURE_ID") ?? []));
  const hasLegacyRows = sameTime.some((observation) => !observationComponentString(observation, "WEARING_CAPTURE_ID"));
  if (captureIds.size > 1 || captureIds.size === 1 && hasLegacyRows || captureIds.size === 0 && sameTime.length > 1) {
    return { status: 409, body: { error: "Multiple Wearing captures have the same recording time; no potentially stale form was loaded." } };
  }
  const captureId = observationComponentString(latest, "WEARING_CAPTURE_ID");
  const snapshot = observations.filter((observation) => captureId
    ? observationComponentString(observation, "WEARING_CAPTURE_ID") === captureId
    : !observationComponentString(observation, "WEARING_CAPTURE_ID")
      && Date.parse(observationDate(observation)) === Date.parse(recordedAt));
  const leftGlassesAtHome = observationComponent(latest, "LEFT_GLASSES_AT_HOME")?.valueBoolean === true;
  const pairs = leftGlassesAtHome ? [] : snapshot.map((observation) => definedRecord({
    id: observationComponentString(observation, "PAIR_ID") ?? observation.id,
    eyeglassType: observationComponentString(observation, "EYEGLASS_TYPE"),
    remarks: observationComponentString(observation, "REMARKS"),
    ...Object.fromEntries(EYES.flatMap((eye) => {
      const values = definedRecord({
        sphere: observationComponentNumber(observation, `${eye}_SPHERE`),
        cylinder: observationComponentNumber(observation, `${eye}_CYLINDER`),
        axis: observationComponentNumber(observation, `${eye}_AXIS`),
        add: observationComponentNumber(observation, `${eye}_ADD`),
        prismAmount: observationComponentNumber(observation, `${eye}_PRISM_AMOUNT`),
        prismBase: observationComponentString(observation, `${eye}_PRISM_BASE`),
        distanceVisualAcuity: observationComponentString(observation, `${eye}_DISTANCE_VA`),
        nearVisualAcuity: observationComponentString(observation, `${eye}_NEAR_VA`),
      });
      return Object.keys(values).length ? [[eye, values]] : [];
    })),
  }));
  const sourceType = latest.note?.flatMap((note) => note.text.match(/(?:^|; )sourceType=(manual|device)(?:;|$)/)?.[1] ?? [])[0] ?? "manual";
  return { status: 200, body: { pairs, leftGlassesAtHome, sourceType, recordedAt } };
}

export async function handleWearingCaptureRequest(
  deps: PretestEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<PretestEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to save Wearing findings." } };
  }
  if (!staffHasBusinessAction(staff, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const parsed = wearingRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid Wearing request." } };
  }
  const definition = resolveWearingDefinition(deps.findingDefinitions?.());
  const validationError = validateWearingRequest(parsed.data, definition);
  if (validationError) {
    return { status: 400, body: { error: validationError } };
  }

  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const captureId = `wearing-capture-${randomUUID()}`;
  const provenance = pretestProvenance(staff.staffReference, recordedAt, parsed.data.sourceType);
  if (parsed.data.leftGlassesAtHome) {
    const capture = capturePretestFinding({
      definition,
      patientReference: parsed.data.patientReference,
      encounterReference: parsed.data.encounterReference,
      laterality: "OU",
      value: {
        type: "components",
        components: [
          { code: "WEARING_CAPTURE_ID", display: "Wearing capture ID", value: captureId },
          { code: "LEFT_GLASSES_AT_HOME", display: "Left glasses at home", value: true },
        ],
      },
      provenance,
      sourceType: parsed.data.sourceType,
    });
    const persisted = await persistCapture(staff.fhir, capture, parsed.data.patientReference);
    return {
      status: 200,
      body: {
        sourceType: parsed.data.sourceType,
        leftGlassesAtHome: true,
        pairs: [],
        observationReference: persisted.observationReference,
        provenanceReference: persisted.provenanceReference,
      },
    };
  }

  const pairs = [];
  for (const [pairIndex, pair] of parsed.data.pairs.entries()) {
    const pairId = `wearing-pair-${randomUUID()}`;
    let capture = capturePretestFinding({
      definition,
      patientReference: parsed.data.patientReference,
      encounterReference: parsed.data.encounterReference,
      laterality: "OU",
      value: {
        type: "components",
        components: wearingComponents(captureId, pairId, pair).concat(EYES.flatMap((eye) =>
          customFieldComponents(pair[eye]?.customFields ?? [], definition, `${eye}_`))),
      },
      provenance,
      sourceType: parsed.data.sourceType,
    });
    capture = {
      ...capture,
      observation: EYES.reduce(
        (observation, eye) => codeCustomFieldComponents(observation, definition, `${eye}_`),
        capture.observation,
      ),
    };
    const persisted = await persistCapture(staff.fhir, capture, parsed.data.patientReference);
    pairs.push({
      pairIndex,
      pairId,
      eyeglassType: pair.eyeglassType,
      observationReference: persisted.observationReference,
      provenanceReference: persisted.provenanceReference,
    });
  }

  return { status: 200, body: { sourceType: parsed.data.sourceType, leftGlassesAtHome: false, pairs } };
}

export async function handleAutoRefractionCaptureRequest(
  deps: PretestEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<PretestEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to save auto-refraction findings." } };
  }
  if (!staffHasBusinessAction(staff, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const parsed = autoRefractionRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid auto-refraction request." } };
  }
  const definitions = resolveAutoRefractionDefinitions(deps.findingDefinitions?.());
  const validationError = validateAutoRefractionRequest(parsed.data, definitions);
  if (validationError) {
    return { status: 400, body: { error: validationError } };
  }

  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const provenance = pretestProvenance(staff.staffReference, recordedAt, parsed.data.sourceType);
  const captureId = `auto-refraction-capture-${randomUUID()}`;
  const eyes: Partial<Record<Eye, Record<string, string | undefined>>> = {};
  for (const eye of EYES) {
    const payload = parsed.data.eyes[eye];
    if (!payload) continue;
    const result: Record<string, string | undefined> = {};
    if (autoRefractionTouched(payload, definitions.autoRefraction)) {
      let capture = capturePretestFinding({
        definition: definitions.autoRefraction,
        patientReference: parsed.data.patientReference,
        encounterReference: parsed.data.encounterReference,
        laterality: eye,
        value: {
          type: "components",
          components: autoRefractionComponents(captureId, payload, parsed.data.remarks).concat(
            customFieldComponents(customValuesForDefinition(payload, definitions.autoRefraction), definitions.autoRefraction),
          ),
        },
        provenance,
        sourceType: parsed.data.sourceType,
      });
      capture = {
        ...capture,
        observation: codeCustomFieldComponents(capture.observation, definitions.autoRefraction),
      };
      const persisted = await persistCapture(staff.fhir, capture, parsed.data.patientReference);
      result.autoRefractionObservationReference = persisted.observationReference;
      result.autoRefractionProvenanceReference = persisted.provenanceReference;
    }
    if (autoKeratometryTouched(payload, definitions.autoKeratometry)) {
      let capture = capturePretestFinding({
        definition: definitions.autoKeratometry,
        patientReference: parsed.data.patientReference,
        encounterReference: parsed.data.encounterReference,
        laterality: eye,
        value: {
          type: "components",
          components: autoKeratometryComponents(payload, parsed.data.remarks).concat(
            customFieldComponents(customValuesForDefinition(payload, definitions.autoKeratometry), definitions.autoKeratometry),
          ),
        },
        provenance,
        sourceType: parsed.data.sourceType,
      });
      capture = {
        ...capture,
        observation: codeCustomFieldComponents(capture.observation, definitions.autoKeratometry),
      };
      // Slice C query: Observation?subject=Patient/{id}&code=https://odos2020.com/fhir/CodeSystem/ophthalmology|auto_keratometry&body-site=https://odos2020.com/fhir/CodeSystem/ophthalmology|{OD|OS}&_sort=-date&_count=1
      const persisted = await persistCapture(staff.fhir, capture, parsed.data.patientReference);
      result.autoKeratometryObservationReference = persisted.observationReference;
      result.autoKeratometryProvenanceReference = persisted.provenanceReference;
    }
    eyes[eye] = result;
  }

  let binocularPd: Record<string, string | undefined> | undefined;
  if (binocularPdTouched(parsed.data)) {
    const capture = capturePretestFinding({
      definition: definitions.autoRefraction,
      patientReference: parsed.data.patientReference,
      encounterReference: parsed.data.encounterReference,
      laterality: "OU",
      value: {
        type: "components",
        components: binocularPdComponents(parsed.data),
      },
      provenance,
      sourceType: parsed.data.sourceType,
    });
    const persisted = await persistCapture(staff.fhir, capture, parsed.data.patientReference);
    binocularPd = {
      observationReference: persisted.observationReference,
      provenanceReference: persisted.provenanceReference,
    };
  }

  return { status: 200, body: { sourceType: parsed.data.sourceType, eyes, ...(binocularPd ? { binocularPd } : {}) } };
}

export function buildPretestFindingDefinitionStubs(
  provenance = pretestProvenance("Practitioner/odos-system", new Date(0).toISOString(), "manual"),
): ClinicalFindingDefinition[] {
  return [buildWearingDefinition(provenance), ...buildAutoDefinitions(provenance)];
}

export function resolveWearingDefinition(
  suppliedDefinitions: ClinicalFindingDefinition[] | undefined,
): ClinicalFindingDefinition {
  const definitions = suppliedDefinitions ?? buildPretestFindingDefinitionStubs();
  const definition = definitions.find((candidate) => candidate.stableKey === "wearing_rx");
  if (!definition) throw new Error("Wearing finding definition seed is missing.");
  return definition;
}

export function resolveAutoRefractionDefinitions(
  suppliedDefinitions: ClinicalFindingDefinition[] | undefined,
): { autoRefraction: ClinicalFindingDefinition; autoKeratometry: ClinicalFindingDefinition } {
  const definitions = suppliedDefinitions ?? buildPretestFindingDefinitionStubs();
  const autoRefraction = definitions.find((candidate) => candidate.stableKey === "auto_refraction");
  const autoKeratometry = definitions.find((candidate) => candidate.stableKey === "auto_keratometry");
  if (!autoRefraction) throw new Error("Auto-refraction finding definition seed is missing.");
  if (!autoKeratometry) throw new Error("Auto-keratometry finding definition seed is missing.");
  return { autoRefraction, autoKeratometry };
}

function buildWearingDefinition(provenance: ClinicalGraphProvenance): ClinicalFindingDefinition {
  return buildClinicalFindingDefinition({
    id: "finding-def-wearing-rx",
    stableKey: "wearing_rx",
    display: "Wearing spectacle prescription",
    sectionKey: "wearing",
    anatomyTarget: "eye",
    valueSchema: {
      valueKind: "wearing-rx-panel",
      fields: {
        eyeglassType: {
          display: "Eyeglass type",
          type: "single-select",
          editable: true,
          options: [
            { code: "single_vision_distance", display: "Single Vision Distance", active: true },
            { code: "single_vision_near", display: "Single Vision Near", active: true },
            { code: "single_vision_intermediate", display: "Single Vision Intermediate (Computer)", active: true },
            { code: "bifocal", display: "Bifocal", active: true },
            { code: "trifocal", display: "Trifocal", active: true },
            { code: "progressives", display: "Progressives", active: true },
          ] satisfies ClinicalFindingOption[],
        },
        sphere: powerField("Sphere"),
        cylinder: powerField("Cylinder"),
        axis: axisField("Axis"),
        add: powerField("Add"),
        prismAmount: { display: "Prism amount", type: "quarter-diopter-select", minimum: 0.25, maximum: 20, step: 0.25, unit: "PD" },
        prismBase: {
          display: "Prism base",
          type: "single-select",
          editable: true,
          options: [
            { code: "up", display: "Up", active: true },
            { code: "down", display: "Down", active: true },
            { code: "in", display: "In", active: true },
            { code: "out", display: "Out", active: true },
          ] satisfies ClinicalFindingOption[],
        },
        distanceVisualAcuity: { display: "Distance VA", type: "visual-acuity-select" },
        nearVisualAcuity: { display: "Near VA", type: "visual-acuity-select" },
        remarks: { display: "Remarks", type: "string", maximumLength: 2000 },
        leftGlassesAtHome: { display: "Left glasses at home", type: "boolean" },
        sourceType: {
          display: "Source type",
          type: "single-select",
          options: SOURCE_TYPES.map((code) => ({
            code,
            display: code === "manual" ? "Manual" : "Device",
            active: true,
          })),
        },
      },
    },
    normalSemantics: { diagnosisSuggestions: false },
    sourceStatus: "verified-seed",
    fhirObservationCode: odosConcept("wearing_rx", "Wearing spectacle prescription"),
    allowDiagnosisMapping: false,
    notBillReady: true,
    active: true,
    provenance,
  });
}

function buildAutoDefinitions(provenance: ClinicalGraphProvenance): ClinicalFindingDefinition[] {
  const sourceType = {
    display: "Source type",
    type: "single-select",
    options: SOURCE_TYPES.map((code) => ({
      code,
      display: code === "manual" ? "Manual" : "Device",
      active: true,
    })),
  };
  const autoRefraction = buildClinicalFindingDefinition({
    id: "finding-def-auto-refraction",
    stableKey: "auto_refraction",
    display: "Auto-refraction",
    sectionKey: "auto-refraction",
    anatomyTarget: "eye",
    valueSchema: {
      valueKind: "auto-refraction-panel",
      fields: {
        sphere: powerField("Sphere"),
        cylinder: powerField("Cylinder"),
        axis: axisField("Axis"),
        binocularPdDistance: decimalField("Binocular PD Dist", 35, 90, 2, "mm"),
        binocularPdNear: decimalField("Binocular PD Near", 35, 90, 2, "mm"),
        sourceType,
        remarks: { display: "Remarks", type: "string", maximumLength: 2000 },
      },
    },
    normalSemantics: { diagnosisSuggestions: false },
    sourceStatus: "verified-seed",
    fhirObservationCode: odosConcept("auto_refraction", "Auto-refraction"),
    allowDiagnosisMapping: false,
    notBillReady: true,
    active: true,
    provenance,
  });
  const keratometryField = (display: string) => ({
    display,
    type: "decimal-input",
    minimum: 30,
    maximum: 60,
    precision: 2,
    unit: "D",
  });
  const autoKeratometry = buildClinicalFindingDefinition({
    id: "finding-def-auto-keratometry",
    stableKey: "auto_keratometry",
    display: "Auto-keratometry",
    sectionKey: "auto-refraction",
    anatomyTarget: "cornea",
    valueSchema: {
      valueKind: "auto-keratometry-panel",
      fields: {
        flatK: keratometryField("Flat K"),
        flatAxis: axisField("Flat axis"),
        steepK: keratometryField("Steep K"),
        steepAxis: axisField("Steep axis"),
        sourceType,
        remarks: { display: "Remarks", type: "string", maximumLength: 2000 },
      },
    },
    normalSemantics: { diagnosisSuggestions: false },
    sourceStatus: "verified-seed",
    fhirObservationCode: odosConcept("auto_keratometry", "Auto-keratometry"),
    notBillReady: true,
    active: true,
    provenance,
  });
  return [autoRefraction, autoKeratometry];
}

function validateWearingRequest(request: WearingRequest, definition: ClinicalFindingDefinition): string | undefined {
  if (request.leftGlassesAtHome) {
    return request.pairs.length > 0 ? "Wearing pairs cannot be saved when leftGlassesAtHome is true." : undefined;
  }
  if (request.pairs.length === 0) return "At least one Wearing pair is required.";
  const eyeglassTypes = new Set(fieldOptions(definition, "eyeglassType").map((option) => option.code));
  const prismBases = new Set(fieldOptions(definition, "prismBase").map((option) => option.code));
  for (const [index, pair] of request.pairs.entries()) {
    if (!eyeglassTypes.has(pair.eyeglassType)) {
      return `Pair ${index + 1} eyeglassType contains an unknown option: ${pair.eyeglassType}.`;
    }
    const populatedEyes = EYES.filter((eye) => pair[eye] && wearingEyeTouched(pair[eye]));
    if (populatedEyes.length === 0) return `Pair ${index + 1} requires at least one populated eye.`;
    for (const eye of populatedEyes) {
      const payload = pair[eye];
      if (!payload) continue;
      const error = validateRefractionEye(payload, definition, `Pair ${index + 1} ${eye}`);
      if (error) return error;
      if ((payload.prismAmount === undefined) !== (payload.prismBase === undefined)) {
        return `Pair ${index + 1} ${eye} prism amount and base must be saved together.`;
      }
      const prismError = validateNumberField(payload.prismAmount, definition, "prismAmount", `Pair ${index + 1} ${eye} prism amount`);
      if (prismError) return prismError;
      if (payload.prismBase && !prismBases.has(payload.prismBase)) {
        return `Pair ${index + 1} ${eye} prismBase contains an unknown option: ${payload.prismBase}.`;
      }
      const customFieldError = validateCustomFieldValues(
        payload.customFields,
        definition,
        `Pair ${index + 1} ${eye}`,
      );
      if (customFieldError) return customFieldError;
    }
  }
  return undefined;
}

function validateAutoRefractionRequest(
  request: AutoRefractionRequest,
  definitions: { autoRefraction: ClinicalFindingDefinition; autoKeratometry: ClinicalFindingDefinition },
): string | undefined {
  const populatedEyes = EYES.filter((eye) => request.eyes[eye] && autoEyeTouched(request.eyes[eye]));
  if (populatedEyes.length === 0 && !binocularPdTouched(request)) {
    return "At least one populated eye or binocular PD value is required.";
  }
  for (const field of ["binocularPdDistance", "binocularPdNear"] as const) {
    const error = validateNumberField(request[field], definitions.autoRefraction, field, field);
    if (error) return error;
    if (request[field] !== undefined && !hasAtMostTwoDecimals(request[field])) {
      return `${field} must use no more than two decimal places.`;
    }
  }
  for (const eye of populatedEyes) {
    const payload = request.eyes[eye];
    if (!payload) continue;
    const customFieldError = validateAutoCustomFields(payload, definitions, eye);
    if (customFieldError) return customFieldError;
    if (autoRefractionTouched(payload, definitions.autoRefraction)) {
      const error = validateRefractionEye(payload, definitions.autoRefraction, eye);
      if (error) return error;
    }
    if (autoKeratometryMeasurementsTouched(payload)) {
      const fields = [payload.flatK, payload.flatAxis, payload.steepK, payload.steepAxis];
      if (fields.some((value) => value === undefined)) {
        return `${eye} Auto-K requires flat K, flat axis, steep K, and steep axis together.`;
      }
      for (const field of ["flatK", "steepK"] as const) {
        const error = validateNumberField(payload[field], definitions.autoKeratometry, field, `${eye} ${field}`);
        if (error) return error;
        if (payload[field] !== undefined && !hasAtMostTwoDecimals(payload[field])) {
          return `${eye} ${field} must use no more than two decimal places.`;
        }
      }
      for (const field of ["flatAxis", "steepAxis"] as const) {
        if (payload[field] !== undefined && (payload[field] < 0 || payload[field] > 180)) {
          return `${eye} ${field} must be an integer from 0 to 180.`;
        }
      }
    }
  }
  return undefined;
}

function validateRefractionEye(
  payload: Pick<WearingEyePayload, "sphere" | "cylinder" | "axis" | "add">,
  definition: ClinicalFindingDefinition,
  label: string,
): string | undefined {
  if ((payload.cylinder === undefined) !== (payload.axis === undefined)) {
    return `${label} cylinder and axis must be saved together.`;
  }
  for (const field of ["sphere", "cylinder", "add"] as const) {
    const error = validateNumberField(payload[field], definition, field, `${label} ${field}`);
    if (error) return error;
  }
  if (payload.axis !== undefined && (payload.axis < 0 || payload.axis > 180)) {
    return `${label} axis must be an integer from 0 to 180.`;
  }
  return undefined;
}

function validateNumberField(
  value: number | undefined,
  definition: ClinicalFindingDefinition,
  fieldKey: string,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  const field = asRecord(asRecord(definition.valueSchema.fields)[fieldKey]);
  const minimum = readNumber(field.minimum);
  const maximum = readNumber(field.maximum);
  const step = readNumber(field.step);
  if (minimum !== undefined && value < minimum || maximum !== undefined && value > maximum) {
    return `${label} must be from ${minimum} to ${maximum}.`;
  }
  if (step !== undefined) {
    const origin = minimum ?? 0;
    const steps = (value - origin) / step;
    if (Math.abs(steps - Math.round(steps)) > 1e-9) {
      return `${label} must use ${step.toFixed(2)} increments.`;
    }
  }
  return undefined;
}

function wearingComponents(
  captureId: string,
  pairId: string,
  pair: z.infer<typeof wearingPairSchema>,
): Extract<FindingValue, { type: "components" }>["components"] {
  const components: Extract<FindingValue, { type: "components" }>["components"] = [
    { code: "WEARING_CAPTURE_ID", display: "Wearing capture ID", value: captureId },
    { code: "PAIR_ID", display: "Wearing pair ID", value: pairId },
    { code: "EYEGLASS_TYPE", display: "Eyeglass type", value: pair.eyeglassType },
  ];
  if (pair.remarks) components.push({ code: "REMARKS", display: "Remarks", value: pair.remarks });
  for (const eye of EYES) {
    const payload = pair[eye];
    if (!payload) continue;
    pushNumber(components, `${eye}_SPHERE`, `${eye} sphere`, payload.sphere, "D");
    pushNumber(components, `${eye}_CYLINDER`, `${eye} cylinder`, payload.cylinder, "D");
    pushNumber(components, `${eye}_AXIS`, `${eye} axis`, payload.axis, "degrees");
    pushNumber(components, `${eye}_ADD`, `${eye} add`, payload.add, "D");
    pushNumber(components, `${eye}_PRISM_AMOUNT`, `${eye} prism amount`, payload.prismAmount, "PD");
    pushString(components, `${eye}_PRISM_BASE`, `${eye} prism base`, payload.prismBase);
    pushString(components, `${eye}_DISTANCE_VA`, `${eye} distance VA`, payload.distanceVisualAcuity);
    pushString(components, `${eye}_NEAR_VA`, `${eye} near VA`, payload.nearVisualAcuity);
  }
  return components;
}

function autoRefractionComponents(
  captureId: string,
  payload: AutoEyePayload,
  remarks: string | undefined,
): Extract<FindingValue, { type: "components" }>["components"] {
  const components: Extract<FindingValue, { type: "components" }>["components"] = [
    { code: "AUTO_REFRACTION_CAPTURE_ID", display: "Auto-refraction capture ID", value: captureId },
  ];
  pushNumber(components, "SPHERE", "Sphere", payload.sphere, "D");
  pushNumber(components, "CYLINDER", "Cylinder", payload.cylinder, "D");
  pushNumber(components, "AXIS", "Axis", payload.axis, "degrees");
  pushString(components, "REMARKS", "Remarks", remarks);
  return components;
}

function binocularPdComponents(
  request: Pick<AutoRefractionRequest, "binocularPdDistance" | "binocularPdNear">,
): Extract<FindingValue, { type: "components" }>["components"] {
  const components: Extract<FindingValue, { type: "components" }>["components"] = [];
  pushNumber(components, "BINOCULAR_PD_DISTANCE", "Binocular PD distance", request.binocularPdDistance, "mm", "mm");
  pushNumber(components, "BINOCULAR_PD_NEAR", "Binocular PD near", request.binocularPdNear, "mm", "mm");
  return components;
}

function autoKeratometryComponents(
  payload: AutoEyePayload,
  remarks: string | undefined,
): Extract<FindingValue, { type: "components" }>["components"] {
  const components: Extract<FindingValue, { type: "components" }>["components"] = [];
  pushNumber(components, "FLAT_K", "Flat K", payload.flatK, "D");
  pushNumber(components, "FLAT_AXIS", "Flat axis", payload.flatAxis, "degrees");
  pushNumber(components, "STEEP_K", "Steep K", payload.steepK, "D");
  pushNumber(components, "STEEP_AXIS", "Steep axis", payload.steepAxis, "degrees");
  pushString(components, "REMARKS", "Remarks", remarks);
  return components;
}

function capturePretestFinding(input: {
  definition: ClinicalFindingDefinition;
  patientReference: string;
  encounterReference: string;
  laterality: Eye | "OU";
  value: FindingValue;
  provenance: ClinicalGraphProvenance;
  sourceType: "manual" | "device";
}): CapturedGlaucomaFinding {
  const findingId = `finding-${input.definition.stableKey}-${randomUUID()}`;
  const captured = captureGlaucomaFinding({
    ...input,
    recordedAt: input.provenance.recordedAt,
    findingInstanceId: findingId,
    observationId: findingId,
    performerReferences: input.provenance.actorReference ? [input.provenance.actorReference] : [],
  });
  return {
    ...captured,
    provenance: {
      ...captured.provenance,
      activity: odosConcept("CREATE", `Capture ${input.definition.display} evidence`),
    },
  };
}

async function persistCapture(
  fhir: PretestFhirClient,
  capture: CapturedGlaucomaFinding,
  patientReference: string,
) {
  const observation = await fhir.create<Observation>(capture.observation, WRITE_HEADERS);
  const observationReference = resourceReference("Observation", observation.id, capture.observation.id);
  const provenance = await fhir.create<Provenance>({
    ...capture.provenance,
    target: patientScopedProvenanceTargets(
      observationReference,
      patientReference,
    ),
  }, WRITE_HEADERS);
  return {
    observationReference,
    provenanceReference: provenance.id ? `Provenance/${provenance.id}` : undefined,
  };
}

function pretestProvenance(
  staffReference: string,
  recordedAt: string,
  source: "manual" | "device",
): ClinicalGraphProvenance {
  return {
    source,
    recordedAt,
    actorReference: staffReference,
    note: "Pretest capture remains neutral measurement evidence and never emits diagnosis suggestions.",
  };
}

function definitionSummary(definition: ClinicalFindingDefinition) {
  return {
    id: definition.id,
    stableKey: definition.stableKey,
    display: definition.display,
    fields: asRecord(definition.valueSchema.fields),
    normalSemantics: definition.normalSemantics,
  };
}

function powerField(display: string) {
  return { display, type: "quarter-diopter-select", minimum: -20, maximum: 20, step: 0.25, unit: "D" };
}

function axisField(display: string) {
  return { display, type: "integer-select", minimum: 0, maximum: 180, step: 1, unit: "degrees" };
}

function fieldOptions(definition: ClinicalFindingDefinition, fieldKey: string): ClinicalFindingOption[] {
  const field = asRecord(asRecord(definition.valueSchema.fields)[fieldKey]);
  if (!Array.isArray(field.options)) return [];
  return field.options.flatMap((option) => {
    const row = asRecord(option);
    const code = typeof row.code === "string" ? row.code : undefined;
    const display = typeof row.display === "string" ? row.display : undefined;
    return code && display && row.active !== false ? [{ code, display, active: true }] : [];
  });
}

function wearingEyeTouched(payload: WearingEyePayload | undefined): boolean {
  return Boolean(payload && Object.entries(payload).some(([key, value]) =>
    key === "customFields"
      ? Array.isArray(value) && value.length > 0
      : value !== undefined && value !== ""));
}

function autoEyeTouched(payload: AutoEyePayload | undefined): boolean {
  return Boolean(payload && Object.entries(payload).some(([key, value]) =>
    key === "customFields"
      ? Array.isArray(value) && value.length > 0
      : value !== undefined));
}

function autoRefractionTouched(payload: AutoEyePayload, definition: ClinicalFindingDefinition): boolean {
  return payload.sphere !== undefined || payload.cylinder !== undefined || payload.axis !== undefined
    || customValuesForDefinition(payload, definition).length > 0;
}

function binocularPdTouched(
  request: Pick<AutoRefractionRequest, "binocularPdDistance" | "binocularPdNear">,
): boolean {
  return request.binocularPdDistance !== undefined || request.binocularPdNear !== undefined;
}

function autoKeratometryTouched(payload: AutoEyePayload, definition: ClinicalFindingDefinition): boolean {
  return autoKeratometryMeasurementsTouched(payload)
    || customValuesForDefinition(payload, definition).length > 0;
}

function autoKeratometryMeasurementsTouched(payload: AutoEyePayload): boolean {
  return payload.flatK !== undefined || payload.flatAxis !== undefined || payload.steepK !== undefined || payload.steepAxis !== undefined;
}

function customValuesForDefinition(payload: AutoEyePayload, definition: ClinicalFindingDefinition) {
  const codes = new Set(customFieldEntries(definition, true).map((field) => field.localCode));
  return payload.customFields.filter((field) => codes.has(field.code));
}

function validateAutoCustomFields(
  payload: AutoEyePayload,
  definitions: { autoRefraction: ClinicalFindingDefinition; autoKeratometry: ClinicalFindingDefinition },
  eye: Eye,
): string | undefined {
  const seen = new Set<string>();
  for (const value of payload.customFields) {
    if (seen.has(value.code)) return `${eye} custom field ${value.code} was supplied more than once.`;
    seen.add(value.code);
    const owners = [definitions.autoRefraction, definitions.autoKeratometry]
      .filter((definition) => customFieldEntries(definition, true).some((field) => field.localCode === value.code));
    if (owners.length !== 1) return `${eye} custom field contains an unknown or ambiguous code: ${value.code}.`;
  }
  for (const definition of [definitions.autoRefraction, definitions.autoKeratometry]) {
    const error = validateCustomFieldValues(customValuesForDefinition(payload, definition), definition, eye);
    if (error) return error;
  }
  return undefined;
}

function pushNumber(
  components: Extract<FindingValue, { type: "components" }>["components"],
  code: string,
  display: string,
  value: number | undefined,
  unit: string,
  unitCode?: string,
) {
  if (value !== undefined) components.push({ code, display, value, unit, ...(unitCode ? { unitCode } : {}) });
}

function pushString(
  components: Extract<FindingValue, { type: "components" }>["components"],
  code: string,
  display: string,
  value: string | undefined,
) {
  if (value) components.push({ code, display, value });
}

function hasAtMostTwoDecimals(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
}

function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}

function resourceReference(resourceType: string, actualId: string | undefined, fallbackId: string | undefined): string {
  const id = actualId ?? fallbackId;
  if (!id) throw new Error(`${resourceType} create response did not include an id.`);
  return `${resourceType}/${id}`;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function latestPretestObservation(
  observations: readonly Observation[],
  code: "auto_refraction" | "auto_keratometry",
  laterality: Eye | "OU",
): Observation | undefined {
  return observations.find((observation) =>
    observation.code?.coding?.some((coding) =>
      coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && coding.code === code)
    && observation.bodySite?.coding?.some((coding) =>
      coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && coding.code === laterality));
}

function observationComponent(
  observation: Observation | undefined,
  code: string,
): ObservationComponent | undefined {
  return observation?.component?.find((candidate) =>
    candidate.code.coding?.some((coding) =>
      coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && coding.code === code));
}

function observationComponentNumber(observation: Observation | undefined, code: string): number | undefined {
  const component = observationComponent(observation, code);
  return component?.valueQuantity?.value ?? component?.valueInteger;
}

function observationComponentString(observation: Observation | undefined, code: string): string | undefined {
  return observationComponent(observation, code)?.valueString;
}

function observationDate(observation: Observation): string {
  return observation.effectiveDateTime ?? observation.issued ?? observation.meta?.lastUpdated ?? "";
}

function definedRecord<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export const AUTO_KERATOMETRY_SEARCH_CODE = `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|auto_keratometry`;
