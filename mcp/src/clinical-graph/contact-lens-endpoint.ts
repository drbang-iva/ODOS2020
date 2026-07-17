import { randomUUID } from "node:crypto";
import type { Bundle, Observation, Provenance } from "@medplum/fhirtypes";
import { z } from "zod";
import {
  assertBusinessActionAllowed,
  type BusinessAction,
  type PracticeRoleId,
} from "../authz/roles.js";
import {
  CONTACT_LENS_MATERIAL_CODES,
  CONTACT_LENS_TYPE_CODES,
  contactLensMaterialConcept,
  contactLensParameterConcept,
  contactLensTypeConcept,
  type ContactLensMaterialCode,
  type ContactLensParameterCode,
  type ContactLensTypeCode,
  type UcumUnitCode,
  ucumQuantity,
} from "../fhir/contactLens.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import { odosConcept } from "../fhir/ophthalmology/extensions.js";
import {
  buildSoftContactLensFindingDefinitionStub,
  buildSpecialtyContactLensFindingDefinitionStub,
  type SpecialtyAdditionalFieldOption,
} from "./contact-lens-definition.js";
import { AUTO_KERATOMETRY_SEARCH_CODE } from "./pretest-endpoint.js";
import {
  codeCustomFieldComponents,
  customFieldComponents,
  customFieldValueSchema,
  validateCustomFieldValues,
} from "./custom-fields.js";
import {
  captureGlaucomaFinding,
  patientScopedProvenanceTargets,
  type CapturedGlaucomaFinding,
  type ClinicalFindingDefinition,
  type ClinicalFindingOption,
  type ClinicalGraphProvenance,
  type FindingValue,
} from "./glaucoma-suspect.js";

export interface ContactLensFhirClient {
  create<T extends Observation | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export interface ContactLensAuthenticatedStaff {
  staffReference: string;
  actorRole: PracticeRoleId;
  fhir: ContactLensFhirClient;
}

export interface SpecialtyContactLensFhirClient extends ContactLensFhirClient {
  search<T extends Observation>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
}

export interface SpecialtyContactLensAuthenticatedStaff {
  staffReference: string;
  actorRole: PracticeRoleId;
  fhir: SpecialtyContactLensFhirClient;
}

export interface SpecialtyContactLensEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<SpecialtyContactLensAuthenticatedStaff | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
}

export interface ContactLensEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<ContactLensAuthenticatedStaff | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
}

export interface ContactLensEndpointResult {
  status: number;
  body: unknown;
}

const WRITE_HEADERS = { "X-ODOS-Source": "mcp/save_section_observations" } as const;
const EYES = ["OD", "OS"] as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const overRefractionSchema = z.object({
  sphere: z.number().optional(),
  cylinder: z.number().optional(),
  axis: z.number().int().optional(),
  distanceVisualAcuity: z.string().trim().min(1).max(100).optional(),
  nearVisualAcuity: z.string().trim().min(1).max(100).optional(),
}).strict();

const softContactLensEyeSchema = z.object({
  underlyingCondition: z.string().trim().min(1).optional(),
  manufacturer: z.string().trim().min(1).max(200).optional(),
  product: z.string().trim().min(1).max(200).optional(),
  baseCurve: z.number().optional(),
  diameter: z.number().optional(),
  sphere: z.number().optional(),
  cylinder: z.number().optional(),
  axis: z.number().int().optional(),
  add: z.number().optional(),
  colorMfPower: z.string().trim().min(1).max(200).optional(),
  distanceVisualAcuity: z.string().trim().min(1).max(100).optional(),
  nearVisualAcuity: z.string().trim().min(1).max(100).optional(),
  distancePinholeVisualAcuity: z.string().trim().min(1).max(100).optional(),
  startDate: z.string().regex(DATE_PATTERN).optional(),
  expirationDate: z.string().regex(DATE_PATTERN).optional(),
  other: z.string().trim().max(500).optional(),
  manualEntry: z.boolean().default(false),
  overRefraction: overRefractionSchema.optional(),
  customFields: z.array(customFieldValueSchema).max(64).default([]),
}).strict();

const softContactLensRequestSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  usage: z.string().trim().min(1).optional(),
  status: z.string().trim().min(1).optional(),
  binocularPdDistance: z.number().optional(),
  binocularPdNear: z.number().optional(),
  ouDistanceVisualAcuity: z.string().trim().min(1).max(100).optional(),
  ouNearVisualAcuity: z.string().trim().min(1).max(100).optional(),
  remarks: z.string().trim().max(2000).optional(),
  assessmentRegimen: z.string().trim().max(2000).optional(),
  notes: z.string().trim().max(2000).optional(),
  eyes: z.object({
    OD: softContactLensEyeSchema.optional(),
    OS: softContactLensEyeSchema.optional(),
  }).strict(),
}).strict();

const specialtyAdditionalFieldSchema = z.object({
  code: z.string().trim().min(1),
  value: z.number(),
}).strict();

const specialtyContactLensEyeSchema = z.object({
  underlyingCondition: z.string().trim().min(1).optional(),
  manufacturer: z.string().trim().min(1).max(200).optional(),
  product: z.string().trim().min(1).max(200).optional(),
  lensType: z.string().trim().min(1).optional(),
  material: z.string().trim().min(1).optional(),
  baseCurve: z.number().optional(),
  diameter: z.number().optional(),
  sphere: z.number().optional(),
  cylinder: z.number().optional(),
  axis: z.number().int().optional(),
  add: z.number().optional(),
  distanceVisualAcuity: z.string().trim().min(1).max(100).optional(),
  nearVisualAcuity: z.string().trim().min(1).max(100).optional(),
  distancePinholeVisualAcuity: z.string().trim().min(1).max(100).optional(),
  other: z.string().trim().max(500).optional(),
  manualEntry: z.boolean().default(false),
  additionalFields: z.array(specialtyAdditionalFieldSchema).max(64).default([]),
  customFields: z.array(customFieldValueSchema).max(64).default([]),
  overRefraction: overRefractionSchema.optional(),
}).strict();

const specialtyContactLensRequestSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  usage: z.string().trim().min(1).optional(),
  status: z.string().trim().min(1).optional(),
  remarks: z.string().trim().max(2000).optional(),
  eyes: z.object({
    OD: specialtyContactLensEyeSchema.optional(),
    OS: specialtyContactLensEyeSchema.optional(),
  }).strict(),
}).strict();

const keratometryQuerySchema = z.object({
  patient: z.string().regex(/^Patient\/[^/]+$/),
}).strict();

type SoftContactLensRequest = z.infer<typeof softContactLensRequestSchema>;
type SoftContactLensEyePayload = z.infer<typeof softContactLensEyeSchema>;
type SpecialtyContactLensRequest = z.infer<typeof specialtyContactLensRequestSchema>;
type SpecialtyContactLensEyePayload = z.infer<typeof specialtyContactLensEyeSchema>;
type Eye = typeof EYES[number];

interface ProductOption extends ClinicalFindingOption {
  manufacturerCode: string;
  design?: string;
  colorOptions?: ClinicalFindingOption[];
  mfPowerOptions?: ClinicalFindingOption[];
}

interface SpecialtyProductOption extends ClinicalFindingOption {
  manufacturerCode: string;
  lensTypeCode?: string;
}

export interface SpecialtyKeratometryReading {
  flatK: number | null;
  flatAxis: number | null;
  steepK: number | null;
  steepAxis: number | null;
  recordedAt: string;
  observationReference: string;
}

export async function handleSoftContactLensDefinitionRequest(
  deps: Pick<ContactLensEndpointDeps, "authenticate" | "findingDefinitions">,
  input: { authHeader: string | undefined },
): Promise<ContactLensEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read soft contact lens definition." } };
  }
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  return {
    status: 200,
    body: { definition: definitionSummary(resolveSoftContactLensDefinition(deps.findingDefinitions?.())) },
  };
}

export async function handleSoftContactLensCaptureRequest(
  deps: ContactLensEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<ContactLensEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to save soft contact lens findings." } };
  }
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const parsed = softContactLensRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid soft contact lens request." } };
  }
  const definition = resolveSoftContactLensDefinition(deps.findingDefinitions?.());
  const validationError = validateRequest(parsed.data, definition);
  if (validationError) return { status: 400, body: { error: validationError } };

  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const provenance = contactLensProvenance(staff.staffReference, recordedAt);
  const eyes: Partial<Record<Eye, Record<string, string | undefined>>> = {};

  for (const eye of EYES) {
    const payload = parsed.data.eyes[eye];
    if (!payload || !eyeTouched(payload)) continue;
    const lensEntryId = `soft-contact-lens-${randomUUID()}`;
    const capture = captureSoftContactLensFinding({
      definition,
      request: parsed.data,
      payload,
      eye,
      lensEntryId,
      provenance,
    });
    const persisted = await persistCapture(staff.fhir, capture, parsed.data.patientReference);
    eyes[eye] = {
      lensEntryId,
      observationReference: persisted.observationReference,
      provenanceReference: persisted.provenanceReference,
    };
  }

  return { status: 200, body: { eyes } };
}

export async function handleSpecialtyContactLensDefinitionRequest(
  deps: Pick<SpecialtyContactLensEndpointDeps, "authenticate" | "findingDefinitions">,
  input: { authHeader: string | undefined },
): Promise<ContactLensEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read specialty contact lens definition." } };
  }
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  return {
    status: 200,
    body: {
      definition: definitionSummary(resolveSpecialtyContactLensDefinition(deps.findingDefinitions?.())),
      canManageFields: staffMay(staff.actorRole, "finding-definitions.write"),
    },
  };
}

export async function handleSpecialtyContactLensCaptureRequest(
  deps: SpecialtyContactLensEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<ContactLensEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to save specialty contact lens findings." } };
  }
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const parsed = specialtyContactLensRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid specialty contact lens request." } };
  }
  const definition = resolveSpecialtyContactLensDefinition(deps.findingDefinitions?.());
  const validationError = validateSpecialtyRequest(parsed.data, definition);
  if (validationError) return { status: 400, body: { error: validationError } };

  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const provenance = specialtyContactLensProvenance(staff.staffReference, recordedAt);
  const eyes: Partial<Record<Eye, Record<string, string | undefined>>> = {};
  const catalogAdditions: Array<{ manufacturer: string; product: string; lensType?: string }> = [];

  for (const eye of EYES) {
    const payload = parsed.data.eyes[eye];
    if (!payload || !specialtyEyeTouched(payload)) continue;
    const lensEntryId = `specialty-contact-lens-${randomUUID()}`;
    const capture = captureSpecialtyContactLensFinding({
      definition,
      request: parsed.data,
      payload,
      eye,
      lensEntryId,
      provenance,
    });
    const persisted = await persistCapture(staff.fhir, capture, parsed.data.patientReference);
    eyes[eye] = {
      lensEntryId,
      observationReference: persisted.observationReference,
      provenanceReference: persisted.provenanceReference,
    };
    if (payload.manualEntry && payload.manufacturer && payload.product) {
      catalogAdditions.push({
        manufacturer: payload.manufacturer,
        product: payload.product,
        lensType: payload.lensType,
      });
    }
  }

  return { status: 200, body: { eyes, catalogAdditions } };
}

export async function handleSpecialtyKeratometryRequest(
  deps: Pick<SpecialtyContactLensEndpointDeps, "authenticate">,
  input: { authHeader: string | undefined; query: unknown },
): Promise<ContactLensEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read specialty contact lens keratometry." } };
  }
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const parsed = keratometryQuerySchema.safeParse(input.query);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid keratometry request." } };
  }

  const bundle = await staff.fhir.search<Observation>("Observation", {
    subject: parsed.data.patient,
    code: AUTO_KERATOMETRY_SEARCH_CODE,
    _sort: "-date",
    _count: "200",
  });
  const observations = bundleResources(bundle);
  const eyes = Object.fromEntries(EYES.map((eye) => [
    eye,
    latestKeratometryReading(observations, eye),
  ])) as Record<Eye, SpecialtyKeratometryReading | null>;

  return { status: 200, body: { eyes } };
}

export function resolveSoftContactLensDefinition(
  suppliedDefinitions: ClinicalFindingDefinition[] | undefined,
): ClinicalFindingDefinition {
  const definitions = suppliedDefinitions ?? [
    buildSoftContactLensFindingDefinitionStub(
      contactLensProvenance("Practitioner/odos-system", new Date(0).toISOString()),
    ),
  ];
  const definition = definitions.find((candidate) => candidate.stableKey === "soft_contact_lens");
  if (!definition) throw new Error("Soft contact lens finding definition seed is missing.");
  return definition;
}

export function resolveSpecialtyContactLensDefinition(
  suppliedDefinitions: ClinicalFindingDefinition[] | undefined,
): ClinicalFindingDefinition {
  const definitions = suppliedDefinitions ?? [
    buildSpecialtyContactLensFindingDefinitionStub(
      specialtyContactLensProvenance("Practitioner/odos-system", new Date(0).toISOString()),
    ),
  ];
  const definition = definitions.find((candidate) => candidate.stableKey === "specialty_contact_lens");
  if (!definition) throw new Error("Specialty contact lens finding definition seed is missing.");
  return definition;
}

function captureSoftContactLensFinding(input: {
  definition: ClinicalFindingDefinition;
  request: SoftContactLensRequest;
  payload: SoftContactLensEyePayload;
  eye: Eye;
  lensEntryId: string;
  provenance: ClinicalGraphProvenance;
}): CapturedGlaucomaFinding {
  const findingId = `finding-soft-contact-lens-${randomUUID()}`;
  const capture = captureGlaucomaFinding({
    definition: input.definition,
    patientReference: input.request.patientReference,
    encounterReference: input.request.encounterReference,
    laterality: input.eye,
    value: {
      type: "components",
      components: [
        ...softContactLensComponents(input.request, input.payload, input.lensEntryId),
        ...customFieldComponents(input.payload.customFields, input.definition),
      ],
    },
    recordedAt: input.provenance.recordedAt,
    provenance: input.provenance,
    findingInstanceId: findingId,
    observationId: findingId,
    sourceType: "manual",
    performerReferences: input.provenance.actorReference ? [input.provenance.actorReference] : [],
  });
  return {
    ...capture,
    observation: codeCustomFieldComponents(
      codeLensParameterComponents(capture.observation),
      input.definition,
    ),
    provenance: {
      ...capture.provenance,
      activity: odosConcept("CREATE", "Capture soft contact lens prescription evidence"),
    },
  };
}

function captureSpecialtyContactLensFinding(input: {
  definition: ClinicalFindingDefinition;
  request: SpecialtyContactLensRequest;
  payload: SpecialtyContactLensEyePayload;
  eye: Eye;
  lensEntryId: string;
  provenance: ClinicalGraphProvenance;
}): CapturedGlaucomaFinding {
  const findingId = `finding-specialty-contact-lens-${randomUUID()}`;
  const additionalOptions = specialtyAdditionalFieldOptions(input.definition);
  const capture = captureGlaucomaFinding({
    definition: input.definition,
    patientReference: input.request.patientReference,
    encounterReference: input.request.encounterReference,
    laterality: input.eye,
    value: {
      type: "components",
      components: specialtyContactLensComponents(
        input.request,
        input.payload,
        input.lensEntryId,
        additionalOptions,
      ).concat(customFieldComponents(input.payload.customFields, input.definition)),
    },
    recordedAt: input.provenance.recordedAt,
    provenance: input.provenance,
    findingInstanceId: findingId,
    observationId: findingId,
    sourceType: "manual",
    performerReferences: input.provenance.actorReference ? [input.provenance.actorReference] : [],
  });
  const additionalParameters = Object.fromEntries(additionalOptions
    .filter((option) => option.parameterCode)
    .map((option) => [option.localCode, { code: option.parameterCode as ContactLensParameterCode, unit: option.unit }]));
  return {
    ...capture,
    observation: codeCustomFieldComponents(
      codeSpecialtyLensComponents(
        codeLensParameterComponents(capture.observation, additionalParameters),
      ),
      input.definition,
    ),
    provenance: {
      ...capture.provenance,
      activity: odosConcept("CREATE", "Capture specialty contact lens prescription evidence"),
    },
  };
}

function softContactLensComponents(
  request: SoftContactLensRequest,
  eye: SoftContactLensEyePayload,
  lensEntryId: string,
): Extract<FindingValue, { type: "components" }>["components"] {
  const components: Extract<FindingValue, { type: "components" }>["components"] = [
    { code: "LENS_ENTRY_ID", display: "Soft contact lens entry ID", value: lensEntryId },
    { code: "MANUAL_ENTRY", display: "Manual entry", value: eye.manualEntry },
  ];
  pushString(components, "USAGE", "Usage", request.usage);
  pushString(components, "STATUS", "Status", request.status);
  pushNumber(components, "BINOCULAR_PD_DISTANCE", "Binocular PD distance", request.binocularPdDistance, "mm", "mm");
  pushNumber(components, "BINOCULAR_PD_NEAR", "Binocular PD near", request.binocularPdNear, "mm", "mm");
  pushString(components, "UNDERLYING_CONDITION", "Underlying condition", eye.underlyingCondition);
  pushString(components, "MANUFACTURER", "Manufacturer", eye.manufacturer);
  pushString(components, "PRODUCT", "Product", eye.product);
  pushNumber(components, "CL_BASE_CURVE", "Base curve", eye.baseCurve, "mm", "mm");
  pushNumber(components, "CL_DIAMETER", "Diameter", eye.diameter, "mm", "mm");
  pushNumber(components, "CL_SPHERE", "Sphere", eye.sphere, "D", "[diop]");
  pushNumber(components, "CL_CYLINDER", "Cylinder", eye.cylinder, "D", "[diop]");
  pushNumber(components, "CL_AXIS", "Axis", eye.axis, "degrees", "deg");
  pushNumber(components, "CL_ADD", "Add", eye.add, "D", "[diop]");
  pushString(components, "COLOR_MF_POWER", "Color/MF-PWR", eye.colorMfPower);
  pushString(components, "DISTANCE_VA", "Distance visual acuity", eye.distanceVisualAcuity);
  pushString(components, "NEAR_VA", "Near visual acuity", eye.nearVisualAcuity);
  pushString(components, "DISTANCE_PINHOLE_VA", "Distance pinhole visual acuity", eye.distancePinholeVisualAcuity);
  pushString(components, "START_DATE", "Start date", eye.startDate);
  pushString(components, "EXPIRATION_DATE", "Expiration date", eye.expirationDate);
  pushString(components, "OTHER", "Other", eye.other);
  pushString(components, "OU_DISTANCE_VA", "OU distance visual acuity", request.ouDistanceVisualAcuity);
  pushString(components, "OU_NEAR_VA", "OU near visual acuity", request.ouNearVisualAcuity);
  pushString(components, "REMARKS", "Remarks", request.remarks);
  pushString(components, "ASSESSMENT_REGIMEN", "Assessment and CL regimen", request.assessmentRegimen);
  pushString(components, "NOTES", "Notes", request.notes);
  if (eye.overRefraction && overRefractionTouched(eye.overRefraction)) {
    components.push({ code: "OVER_REFRACTION_LENS_ENTRY_ID", display: "Over-refraction lens entry ID", value: lensEntryId });
    pushNumber(components, "OVER_REFRACTION_SPHERE", "Over-refraction sphere", eye.overRefraction.sphere, "D", "[diop]");
    pushNumber(components, "OVER_REFRACTION_CYLINDER", "Over-refraction cylinder", eye.overRefraction.cylinder, "D", "[diop]");
    pushNumber(components, "OVER_REFRACTION_AXIS", "Over-refraction axis", eye.overRefraction.axis, "degrees", "deg");
    pushString(components, "OVER_REFRACTION_DISTANCE_VA", "Over-refraction distance visual acuity", eye.overRefraction.distanceVisualAcuity);
    pushString(components, "OVER_REFRACTION_NEAR_VA", "Over-refraction near visual acuity", eye.overRefraction.nearVisualAcuity);
  }
  return components;
}

function specialtyContactLensComponents(
  request: SpecialtyContactLensRequest,
  eye: SpecialtyContactLensEyePayload,
  lensEntryId: string,
  additionalOptions: SpecialtyAdditionalFieldOption[],
): Extract<FindingValue, { type: "components" }>["components"] {
  const components: Extract<FindingValue, { type: "components" }>["components"] = [
    { code: "LENS_ENTRY_ID", display: "Specialty contact lens entry ID", value: lensEntryId },
    { code: "MANUAL_ENTRY", display: "Manual entry", value: eye.manualEntry },
  ];
  pushString(components, "USAGE", "Usage", request.usage);
  pushString(components, "STATUS", "Status", request.status);
  pushString(components, "UNDERLYING_CONDITION", "Underlying condition", eye.underlyingCondition);
  pushString(components, "MANUFACTURER", "Manufacturer", eye.manufacturer);
  pushString(components, "PRODUCT", "Product", eye.product);
  pushString(components, "LENS_TYPE", "Lens type", eye.lensType);
  pushString(components, "MATERIAL", "Material", eye.material);
  pushNumber(components, "CL_BASE_CURVE", "Base curve", eye.baseCurve, "mm", "mm");
  pushNumber(components, "CL_DIAMETER", "Diameter", eye.diameter, "mm", "mm");
  pushNumber(components, "CL_SPHERE", "Sphere", eye.sphere, "D", "[diop]");
  pushNumber(components, "CL_CYLINDER", "Cylinder", eye.cylinder, "D", "[diop]");
  pushNumber(components, "CL_AXIS", "Axis", eye.axis, "degrees", "deg");
  pushNumber(components, "CL_ADD", "Add", eye.add, "D", "[diop]");
  pushString(components, "DISTANCE_VA", "Distance visual acuity", eye.distanceVisualAcuity);
  pushString(components, "NEAR_VA", "Near visual acuity", eye.nearVisualAcuity);
  pushString(components, "DISTANCE_PINHOLE_VA", "Distance pinhole visual acuity", eye.distancePinholeVisualAcuity);
  pushString(components, "OTHER", "Other", eye.other);
  pushString(components, "REMARKS", "Remarks", request.remarks);

  const optionsByCode = new Map(additionalOptions.map((option) => [option.code, option]));
  for (const field of eye.additionalFields) {
    const option = optionsByCode.get(field.code);
    if (option) pushNumber(components, option.localCode, option.display, field.value, option.unit, option.unit);
  }

  if (eye.overRefraction && overRefractionTouched(eye.overRefraction)) {
    components.push({ code: "OVER_REFRACTION_LENS_ENTRY_ID", display: "Over-refraction lens entry ID", value: lensEntryId });
    pushNumber(components, "OVER_REFRACTION_SPHERE", "Over-refraction sphere", eye.overRefraction.sphere, "D", "[diop]");
    pushNumber(components, "OVER_REFRACTION_CYLINDER", "Over-refraction cylinder", eye.overRefraction.cylinder, "D", "[diop]");
    pushNumber(components, "OVER_REFRACTION_AXIS", "Over-refraction axis", eye.overRefraction.axis, "degrees", "deg");
    pushString(components, "OVER_REFRACTION_DISTANCE_VA", "Over-refraction distance visual acuity", eye.overRefraction.distanceVisualAcuity);
    pushString(components, "OVER_REFRACTION_NEAR_VA", "Over-refraction near visual acuity", eye.overRefraction.nearVisualAcuity);
  }
  return components;
}

const PARAMETER_COMPONENTS: Record<string, { code: ContactLensParameterCode; unit: UcumUnitCode }> = {
  CL_BASE_CURVE: { code: "base-curve-mm", unit: "mm" },
  CL_DIAMETER: { code: "diameter-mm", unit: "mm" },
  CL_SPHERE: { code: "sphere-power", unit: "[diop]" },
  CL_CYLINDER: { code: "cylinder-power", unit: "[diop]" },
  CL_AXIS: { code: "axis-degree", unit: "deg" },
  CL_ADD: { code: "add-power", unit: "[diop]" },
};

function codeLensParameterComponents(
  observation: Observation,
  additionalParameters: Record<string, { code: ContactLensParameterCode; unit: UcumUnitCode }> = {},
): Observation {
  return {
    ...observation,
    component: observation.component?.map((component) => {
      const localCode = component.code.coding?.[0]?.code;
      const parameter = localCode ? PARAMETER_COMPONENTS[localCode] ?? additionalParameters[localCode] : undefined;
      if (!parameter || component.valueQuantity?.value === undefined) return component;
      return {
        ...component,
        code: contactLensParameterConcept(parameter.code),
        valueQuantity: ucumQuantity(component.valueQuantity.value, parameter.unit),
      };
    }),
  };
}

function codeSpecialtyLensComponents(observation: Observation): Observation {
  return {
    ...observation,
    component: observation.component?.map((component) => {
      const localCode = component.code.coding?.[0]?.code;
      const selectedCode = component.valueString;
      if (localCode === "LENS_TYPE" && selectedCode && CONTACT_LENS_TYPE_CODES.includes(selectedCode as ContactLensTypeCode)) {
        const { valueString: _valueString, ...rest } = component;
        return { ...rest, valueCodeableConcept: contactLensTypeConcept(selectedCode as ContactLensTypeCode) };
      }
      if (localCode === "MATERIAL" && selectedCode && CONTACT_LENS_MATERIAL_CODES.includes(selectedCode as ContactLensMaterialCode)) {
        const { valueString: _valueString, ...rest } = component;
        return { ...rest, valueCodeableConcept: contactLensMaterialConcept(selectedCode as ContactLensMaterialCode) };
      }
      return component;
    }),
  };
}

function validateRequest(request: SoftContactLensRequest, definition: ClinicalFindingDefinition): string | undefined {
  if (!EYES.some((eye) => request.eyes[eye] && eyeTouched(request.eyes[eye]))) {
    return "At least one populated soft contact lens eye is required.";
  }
  for (const field of ["usage", "status"] as const) {
    const value = request[field];
    if (value && !optionCodes(definition, field).has(value)) return `${field} contains an unknown option: ${value}.`;
  }
  for (const field of ["binocularPdDistance", "binocularPdNear"] as const) {
    const error = validateNumberField(request[field], definition, field, field);
    if (error) return error;
  }
  const manufacturerCodes = optionCodes(definition, "manufacturer");
  const underlyingCodes = optionCodes(definition, "underlyingCondition");
  const products = productOptions(definition);
  for (const eye of EYES) {
    const payload = request.eyes[eye];
    if (!payload || !eyeTouched(payload)) continue;
    if (payload.underlyingCondition && !underlyingCodes.has(payload.underlyingCondition)) {
      return `${eye} underlyingCondition contains an unknown option: ${payload.underlyingCondition}.`;
    }
    if (!payload.manualEntry) {
      if (payload.manufacturer && !manufacturerCodes.has(payload.manufacturer)) {
        return `${eye} manufacturer contains an unknown option: ${payload.manufacturer}.`;
      }
      const product = payload.product ? products.find((option) => option.code === payload.product) : undefined;
      if (payload.product && !product) return `${eye} product contains an unknown option: ${payload.product}.`;
      if (product && product.manufacturerCode !== payload.manufacturer) {
        return `${eye} product ${payload.product} does not belong to manufacturer ${payload.manufacturer}.`;
      }
      if (payload.colorMfPower) {
        if (!product) return `${eye} Color/MF-PWR requires a selected catalog product.`;
        const cascadeCodes = new Set([...(product.colorOptions ?? []), ...(product.mfPowerOptions ?? [])].map((option) => option.code));
        if (!cascadeCodes.has(payload.colorMfPower)) {
          return `${eye} colorMfPower contains an unknown option for product ${payload.product}: ${payload.colorMfPower}.`;
        }
      }
    }
    if ((payload.cylinder === undefined) !== (payload.axis === undefined)) {
      return `${eye} cylinder and axis must be saved together.`;
    }
    for (const field of ["baseCurve", "diameter", "sphere", "cylinder", "axis", "add"] as const) {
      const error = validateNumberField(payload[field], definition, field, `${eye} ${field}`);
      if (error) return error;
    }
    if (payload.startDate && payload.expirationDate && payload.expirationDate < payload.startDate) {
      return `${eye} expirationDate cannot precede startDate.`;
    }
    if (payload.overRefraction) {
      if ((payload.overRefraction.cylinder === undefined) !== (payload.overRefraction.axis === undefined)) {
        return `${eye} over-refraction cylinder and axis must be saved together.`;
      }
      for (const field of ["sphere", "cylinder", "axis"] as const) {
        const definitionField = `overRefraction${field[0]?.toUpperCase()}${field.slice(1)}`;
        const error = validateNumberField(payload.overRefraction[field], definition, definitionField, `${eye} over-refraction ${field}`);
        if (error) return error;
      }
    }
    const customFieldError = validateCustomFieldValues(payload.customFields, definition, eye);
    if (customFieldError) return customFieldError;
  }
  return undefined;
}

function validateSpecialtyRequest(
  request: SpecialtyContactLensRequest,
  definition: ClinicalFindingDefinition,
): string | undefined {
  if (!EYES.some((eye) => request.eyes[eye] && specialtyEyeTouched(request.eyes[eye]))) {
    return "At least one populated specialty contact lens eye is required.";
  }
  for (const field of ["usage", "status"] as const) {
    const value = request[field];
    if (value && !optionCodes(definition, field).has(value)) return `${field} contains an unknown option: ${value}.`;
  }

  const manufacturerCodes = optionCodes(definition, "manufacturer");
  const underlyingCodes = optionCodes(definition, "underlyingCondition");
  const lensTypeCodes = optionCodes(definition, "lensType");
  const materialCodes = optionCodes(definition, "material");
  const products = specialtyProductOptions(definition);
  const additionalOptions = specialtyAdditionalFieldOptions(definition);
  const additionalCodes = new Set(additionalOptions.map((option) => option.code));

  for (const eye of EYES) {
    const payload = request.eyes[eye];
    if (!payload || !specialtyEyeTouched(payload)) continue;
    if (payload.underlyingCondition && !underlyingCodes.has(payload.underlyingCondition)) {
      return `${eye} underlyingCondition contains an unknown option: ${payload.underlyingCondition}.`;
    }
    if (payload.lensType && !lensTypeCodes.has(payload.lensType)) {
      return `${eye} lensType contains an unknown option: ${payload.lensType}.`;
    }
    if (payload.material && !materialCodes.has(payload.material)) {
      return `${eye} material contains an unknown option: ${payload.material}.`;
    }
    if (!payload.manualEntry) {
      if (payload.manufacturer && !manufacturerCodes.has(payload.manufacturer)) {
        return `${eye} manufacturer contains an unknown option: ${payload.manufacturer}.`;
      }
      const product = payload.product ? products.find((option) => option.code === payload.product) : undefined;
      if (payload.product && !product) return `${eye} product contains an unknown option: ${payload.product}.`;
      if (product && product.manufacturerCode !== payload.manufacturer) {
        return `${eye} product ${payload.product} does not belong to manufacturer ${payload.manufacturer}.`;
      }
    }
    if ((payload.cylinder === undefined) !== (payload.axis === undefined)) {
      return `${eye} cylinder and axis must be saved together.`;
    }
    for (const field of ["baseCurve", "diameter", "sphere", "cylinder", "axis", "add"] as const) {
      const error = validateNumberField(payload[field], definition, field, `${eye} ${field}`);
      if (error) return error;
    }
    const seenAdditional = new Set<string>();
    for (const field of payload.additionalFields) {
      if (!additionalCodes.has(field.code)) return `${eye} additional field contains an unknown option: ${field.code}.`;
      if (seenAdditional.has(field.code)) return `${eye} additional field ${field.code} was supplied more than once.`;
      seenAdditional.add(field.code);
    }
    const customFieldError = validateCustomFieldValues(payload.customFields, definition, eye);
    if (customFieldError) return customFieldError;
    if (payload.overRefraction) {
      if ((payload.overRefraction.cylinder === undefined) !== (payload.overRefraction.axis === undefined)) {
        return `${eye} over-refraction cylinder and axis must be saved together.`;
      }
      for (const field of ["sphere", "cylinder", "axis"] as const) {
        const definitionField = `overRefraction${field[0]?.toUpperCase()}${field.slice(1)}`;
        const error = validateNumberField(payload.overRefraction[field], definition, definitionField, `${eye} over-refraction ${field}`);
        if (error) return error;
      }
    }
  }
  return undefined;
}

function productOptions(definition: ClinicalFindingDefinition): ProductOption[] {
  const field = asRecord(asRecord(definition.valueSchema.fields).product);
  if (!Array.isArray(field.options)) return [];
  return field.options.flatMap((raw) => {
    const row = asRecord(raw);
    if (row.active === false || typeof row.code !== "string" || typeof row.display !== "string" || typeof row.manufacturerCode !== "string") return [];
    return [{
      code: row.code,
      display: row.display,
      active: true,
      manufacturerCode: row.manufacturerCode,
      design: typeof row.design === "string" ? row.design : undefined,
      colorOptions: readOptions(row.colorOptions),
      mfPowerOptions: readOptions(row.mfPowerOptions),
    }];
  });
}

function specialtyProductOptions(definition: ClinicalFindingDefinition): SpecialtyProductOption[] {
  const field = asRecord(asRecord(definition.valueSchema.fields).product);
  if (!Array.isArray(field.options)) return [];
  return field.options.flatMap((raw) => {
    const row = asRecord(raw);
    if (row.active === false || typeof row.code !== "string" || typeof row.display !== "string" || typeof row.manufacturerCode !== "string") return [];
    return [{
      code: row.code,
      display: row.display,
      active: true,
      manufacturerCode: row.manufacturerCode,
      lensTypeCode: typeof row.lensTypeCode === "string" ? row.lensTypeCode : undefined,
    }];
  });
}

function specialtyAdditionalFieldOptions(definition: ClinicalFindingDefinition): SpecialtyAdditionalFieldOption[] {
  const field = asRecord(asRecord(definition.valueSchema.fields).additionalFields);
  if (!Array.isArray(field.options)) return [];
  return field.options.flatMap((raw) => {
    const row = asRecord(raw);
    if (
      row.active === false ||
      typeof row.code !== "string" ||
      typeof row.display !== "string" ||
      typeof row.localCode !== "string" ||
      typeof row.unit !== "string"
    ) return [];
    return [{
      code: row.code,
      display: row.display,
      active: true,
      localCode: row.localCode,
      unit: row.unit as UcumUnitCode,
      parameterCode: typeof row.parameterCode === "string"
        ? row.parameterCode as ContactLensParameterCode
        : undefined,
    }];
  });
}

function readOptions(value: unknown): ClinicalFindingOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((raw) => {
    const row = asRecord(raw);
    return row.active !== false && typeof row.code === "string" && typeof row.display === "string"
      ? [{ code: row.code, display: row.display, active: true }]
      : [];
  });
}

function optionCodes(definition: ClinicalFindingDefinition, fieldKey: string): Set<string> {
  const field = asRecord(asRecord(definition.valueSchema.fields)[fieldKey]);
  return new Set(readOptions(field.options)?.map((option) => option.code) ?? []);
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
    const steps = (value - (minimum ?? 0)) / step;
    if (Math.abs(steps - Math.round(steps)) > 1e-9) return `${label} must use ${step.toFixed(2)} increments.`;
  }
  return undefined;
}

async function persistCapture(
  fhir: ContactLensFhirClient,
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

function contactLensProvenance(staffReference: string, recordedAt: string): ClinicalGraphProvenance {
  return {
    source: "manual",
    recordedAt,
    actorReference: staffReference,
    note: "Soft contact lens capture remains neutral clinical evidence and never emits diagnosis suggestions.",
  };
}

function specialtyContactLensProvenance(staffReference: string, recordedAt: string): ClinicalGraphProvenance {
  return {
    source: "manual",
    recordedAt,
    actorReference: staffReference,
    note: "Specialty contact lens capture remains neutral clinical evidence and never emits diagnosis suggestions.",
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

function eyeTouched(payload: SoftContactLensEyePayload | undefined): boolean {
  return Boolean(payload && Object.entries(payload).some(([key, value]) =>
    key === "manualEntry" ? value === true : value !== undefined && value !== "" && (typeof value !== "object" || overRefractionTouched(value))));
}

function specialtyEyeTouched(payload: SpecialtyContactLensEyePayload | undefined): boolean {
  return Boolean(payload && Object.entries(payload).some(([key, value]) => {
    if (key === "manualEntry") return value === true;
    if (key === "additionalFields") return Array.isArray(value) && value.length > 0;
    if (key === "customFields") return Array.isArray(value) && value.length > 0;
    return value !== undefined && value !== "" && (typeof value !== "object" || overRefractionTouched(value));
  }));
}

function latestKeratometryReading(
  observations: Observation[],
  eye: Eye,
): SpecialtyKeratometryReading | null {
  const observation = observations
    .filter((candidate) => candidate.bodySite?.coding?.some((coding) =>
      coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && coding.code === eye))
    .filter((candidate) => candidate.effectiveDateTime && candidate.id)
    .sort((a, b) => String(b.effectiveDateTime).localeCompare(String(a.effectiveDateTime)))[0];
  if (!observation?.effectiveDateTime || !observation.id) return null;
  return {
    flatK: observationComponentNumber(observation, "FLAT_K"),
    flatAxis: observationComponentNumber(observation, "FLAT_AXIS"),
    steepK: observationComponentNumber(observation, "STEEP_K"),
    steepAxis: observationComponentNumber(observation, "STEEP_AXIS"),
    recordedAt: observation.effectiveDateTime,
    observationReference: `Observation/${observation.id}`,
  };
}

function observationComponentNumber(observation: Observation, code: string): number | null {
  const value = observation.component?.find((component) =>
    component.code.coding?.some((coding) => coding.code === code))?.valueQuantity?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bundleResources<T extends Observation>(bundle: Bundle<T> | undefined): T[] {
  return bundle?.entry?.flatMap((entry) => entry.resource ? [entry.resource] : []) ?? [];
}

function overRefractionTouched(value: object): boolean {
  return Object.values(value).some((item) => item !== undefined && item !== "");
}

function pushNumber(
  components: Extract<FindingValue, { type: "components" }>["components"],
  code: string,
  display: string,
  value: number | undefined,
  unit: string,
  unitCode: string,
) {
  if (value !== undefined) components.push({ code, display, value, unit, unitCode });
}

function pushString(
  components: Extract<FindingValue, { type: "components" }>["components"],
  code: string,
  display: string,
  value: string | undefined,
) {
  if (value) components.push({ code, display, value });
}

function staffMay(role: PracticeRoleId, action: BusinessAction): boolean {
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
