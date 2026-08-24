import { randomUUID } from "node:crypto";
import type { Observation, Provenance } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { odosConcept } from "../fhir/ophthalmology/extensions.js";
import { buildRefractionObservation } from "../fhir/ophthalmology/refraction.js";
import type { RefractionType } from "../fhir/ophthalmology/types.js";
import {
  captureGlaucomaFinding,
  patientScopedProvenanceTargets,
  type ClinicalFindingDefinition,
  type ClinicalFindingOption,
  type ClinicalGraphProvenance,
  type FindingInstance,
} from "./glaucoma-suspect.js";
import {
  buildRefractionFindingDefinitionStub,
  evaluateRefractiveErrorSuggestions,
  loadRefractiveErrorPhase0Ledger,
  resolveRefractiveErrorThreshold,
} from "./refraction-suspect.js";
import {
  appendCustomFieldComponentsToObservation,
  customFieldValueSchema,
  validateCustomFieldValues,
} from "./custom-fields.js";

export interface RefractionFhirClient {
  create<T extends Observation | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export interface RefractionAuthenticatedStaff {
  staffReference: string;
  actorRole: PracticeRoleId;
  fhir: RefractionFhirClient;
}

export interface RefractionEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<RefractionAuthenticatedStaff | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
}

export interface RefractionEndpointResult {
  status: number;
  body: unknown;
}

const WRITE_HEADERS = { "X-ODOS-Source": "mcp/save_section_observations" } as const;
const LEDGER_REF = "data/code-bindings/refractive-error-phase0-ledger.json";
const EYES = ["OD", "OS"] as const;
const SOURCE_TYPES = ["manual", "device"] as const;

const eyePayloadSchema = z.object({
  sphere: z.number().optional(),
  cylinder: z.number().optional(),
  axis: z.number().int().optional(),
  add: z.number().optional(),
  prismAmount: z.number().optional(),
  prismBase: z.string().trim().min(1).optional(),
  distanceVisualAcuity: z.string().trim().min(1).max(100).optional(),
  nearVisualAcuity: z.string().trim().min(1).max(100).optional(),
  distancePinholeVisualAcuity: z.string().trim().min(1).max(100).optional(),
  customFields: z.array(customFieldValueSchema).max(64).default([]),
}).strict();

const blockPayloadSchema = z.object({
  type: z.string().trim().min(1),
  purpose: z.string().trim().max(200).optional(),
  lensDesign: z.string().trim().min(1).max(100).optional(),
  overContacts: z.boolean().default(false),
  remarks: z.string().trim().max(2000).optional(),
  OD: eyePayloadSchema.optional(),
  OS: eyePayloadSchema.optional(),
}).strict();

const refractionRequestSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  sourceType: z.enum(SOURCE_TYPES).default("manual"),
  blocks: z.array(blockPayloadSchema).min(1),
}).strict();

type RefractionRequest = z.infer<typeof refractionRequestSchema>;
type RefractionEyePayload = z.infer<typeof eyePayloadSchema>;
type Eye = typeof EYES[number];

export async function handleRefractionDefinitionRequest(
  deps: Pick<RefractionEndpointDeps, "authenticate" | "findingDefinitions">,
  input: { authHeader: string | undefined },
): Promise<RefractionEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read refraction definition." } };
  }
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }

  const definition = resolveRefractionDefinition(deps.findingDefinitions?.());
  return {
    status: 200,
    body: {
      definition: definitionSummary(definition),
      diagnosisOptions: loadRefractiveErrorPhase0Ledger().diagnosisCodes,
      refractiveThreshold: resolveRefractiveErrorThreshold(definition),
    },
  };
}

export async function handleRefractionCaptureRequest(
  deps: RefractionEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<RefractionEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to save refraction findings." } };
  }
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }

  const parsed = refractionRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid refraction request." } };
  }

  const definition = resolveRefractionDefinition(deps.findingDefinitions?.());
  const validationError = validateRequest(parsed.data, definition);
  if (validationError) {
    return { status: 400, body: { error: validationError } };
  }

  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const provenance = refractionProvenance(staff.staffReference, recordedAt, parsed.data.sourceType);
  const captured = captureBlocks(parsed.data, definition, provenance);
  const persisted: Array<{
    blockIndex: number;
    blockId: string;
    type: string;
    eye: Eye;
    finding: FindingInstance;
    observationReference: string;
    provenanceReference?: string;
  }> = [];

  for (const item of captured) {
    const observation = await staff.fhir.create<Observation>(item.observation, WRITE_HEADERS);
    const observationReference = resourceReference(observation.id, item.observation.id);
    const provenanceResource = await staff.fhir.create<Provenance>(
      {
        ...item.provenance,
        target: patientScopedProvenanceTargets(
          observationReference,
          parsed.data.patientReference,
        ),
      },
      WRITE_HEADERS,
    );
    persisted.push({
      blockIndex: item.blockIndex,
      blockId: item.blockId,
      type: item.type,
      eye: item.eye,
      finding: { ...item.finding, observationReference },
      observationReference,
      provenanceReference: provenanceResource.id ? `Provenance/${provenanceResource.id}` : undefined,
    });
  }

  const suggestions = evaluateRefractiveErrorSuggestions({
    findings: persisted.map((item) => item.finding),
    findingDefinitions: [definition],
    encounterReference: parsed.data.encounterReference,
    provenance,
  });

  return {
    status: 200,
    body: {
      sourceType: parsed.data.sourceType,
      blocks: parsed.data.blocks.map((block, blockIndex) => {
        const items = persisted.filter((item) => item.blockIndex === blockIndex);
        return {
          blockId: items[0]?.blockId,
          type: block.type,
          purpose: block.purpose,
          lensDesign: block.lensDesign,
          overContacts: block.overContacts,
          eyes: Object.fromEntries(items.map((item) => [
            item.eye,
            {
              observationReference: item.observationReference,
              provenanceReference: item.provenanceReference,
            },
          ])),
        };
      }),
      suggestions: suggestions.map((suggestion) => ({
        id: suggestion.suggestionEdge.id,
        code: suggestion.diagnosisDefinition.icd10Code,
        display: suggestion.diagnosisDefinition.icd10Display ?? suggestion.diagnosisDefinition.display,
        family: suggestion.diagnosisDefinition.icd10Family,
        lateralityRequired: suggestion.diagnosisDefinition.lateralityRequired,
        explanation: suggestion.suggestionEdge.explanation,
        sourceFindingInstanceId: suggestion.suggestionEdge.sourceFindingInstanceId,
        evidenceFindingInstanceIds: suggestion.suggestionEdge.evidenceFindingInstanceIds,
        visitState: suggestion.suggestionEdge.visitState,
      })),
    },
  };
}

export function resolveRefractionDefinition(
  suppliedDefinitions: ClinicalFindingDefinition[] | undefined,
): ClinicalFindingDefinition {
  const definitions = suppliedDefinitions ?? [
    buildRefractionFindingDefinitionStub(
      refractionProvenance("Practitioner/odos-system", new Date(0).toISOString(), "manual"),
    ),
  ];
  const definition = definitions.find((candidate) => candidate.stableKey === "refraction");
  if (!definition) {
    throw new Error("Refraction finding definition seed is missing.");
  }
  return definition;
}

function captureBlocks(
  request: RefractionRequest,
  definition: ClinicalFindingDefinition,
  provenance: ClinicalGraphProvenance,
) {
  return request.blocks.flatMap((block, blockIndex) => {
    const blockId = `refraction-block-${randomUUID()}`;
    const typeDisplay = fieldOptions(definition, "type")
      .find((option) => option.code === block.type)?.display ?? block.type;
    return EYES.flatMap((eye) => {
      const payload = block[eye];
      if (!payload || !eyeTouched(payload)) return [];
      const findingInstanceId = `finding-refraction-${randomUUID()}`;
      const capture = captureGlaucomaFinding({
        definition,
        patientReference: request.patientReference,
        encounterReference: request.encounterReference,
        laterality: eye,
        value: {
          type: "json",
          value: definedRecord({
            blockId,
            refractionType: block.type,
            purpose: block.purpose,
            lensDesign: block.lensDesign,
            overContacts: block.overContacts,
            remarks: block.remarks,
            sphere: payload.sphere,
            cylinder: payload.cylinder,
            axis: payload.axis,
            add: payload.add,
            prismAmount: payload.prismAmount,
            prismBase: payload.prismBase,
            distanceVisualAcuity: payload.distanceVisualAcuity,
            nearVisualAcuity: payload.nearVisualAcuity,
            distancePinholeVisualAcuity: payload.distancePinholeVisualAcuity,
            customFields: payload.customFields,
          }),
        },
        recordedAt: provenance.recordedAt,
        provenance,
        findingInstanceId,
        observationId: findingInstanceId,
        sourceType: request.sourceType,
        performerReferences: provenance.actorReference ? [provenance.actorReference] : [],
      });
      const baseObservation = appendCustomFieldComponentsToObservation(buildRefractionObservation({
        patientReference: request.patientReference,
        encounterReference: request.encounterReference,
        eye,
        measuredAt: provenance.recordedAt,
        refractionType: block.type as RefractionType,
        refractionTypeDisplay: typeDisplay,
        blockId,
        purpose: block.purpose,
        remarks: block.remarks,
        sphere: payload.sphere,
        cylinder: payload.cylinder,
        axis: payload.axis,
        add: payload.add,
        prism: payload.prismAmount === undefined
          ? undefined
          : { amount: payload.prismAmount, base: payload.prismBase },
        visualAcuity: {
          distance: payload.distanceVisualAcuity,
          near: payload.nearVisualAcuity,
          distancePinhole: payload.distancePinholeVisualAcuity,
        },
        performerReferences: provenance.actorReference ? [provenance.actorReference] : [],
        sourceType: request.sourceType,
      }).resource, payload.customFields, definition);
      const observation: Observation = {
        ...baseObservation,
        component: [
          ...(baseObservation.component ?? []),
          ...(block.lensDesign
            ? [{ code: odosConcept("LENS_DESIGN", "Lens design"), valueString: block.lensDesign }]
            : []),
          { code: odosConcept("OVER_CONTACTS", "Over contacts"), valueBoolean: block.overContacts },
        ],
      };
      return [{
        blockIndex,
        blockId,
        type: block.type,
        eye,
        finding: capture.finding,
        observation: { ...observation, id: capture.observation.id },
        provenance: {
          ...capture.provenance,
          activity: odosConcept("CREATE", "Capture refraction finding evidence"),
        },
      }];
    });
  });
}

function validateRequest(request: RefractionRequest, definition: ClinicalFindingDefinition): string | undefined {
  const allowedTypes = new Set(fieldOptions(definition, "type").map((option) => option.code));
  const allowedPurposes = new Set(fieldOptions(definition, "purpose").map((option) => option.code));
  const prismBases = new Set(fieldOptions(definition, "prismBase").map((option) => option.code));
  for (const [index, block] of request.blocks.entries()) {
    if (!allowedTypes.has(block.type)) {
      return `Block ${index + 1} type contains an unknown option: ${block.type}.`;
    }
    if (block.purpose && !allowedPurposes.has(block.purpose)) {
      return `Block ${index + 1} purpose contains an unknown option: ${block.purpose}.`;
    }
    const populatedEyes = EYES.filter((eye) => block[eye] && eyeTouched(block[eye]));
    if (populatedEyes.length === 0) {
      return `Block ${index + 1} requires at least one populated eye.`;
    }
    for (const eye of populatedEyes) {
      const payload = block[eye];
      if (!payload) continue;
      const cylinderSupplied = payload.cylinder !== undefined;
      const axisSupplied = payload.axis !== undefined;
      if (cylinderSupplied !== axisSupplied) {
        return `Block ${index + 1} ${eye} cylinder and axis must be saved together.`;
      }
      for (const field of ["sphere", "cylinder", "add"] as const) {
        const error = validatePower(payload[field], definition, field, `Block ${index + 1} ${eye} ${field}`);
        if (error) return error;
      }
      if (payload.axis !== undefined && (payload.axis < 0 || payload.axis > 180)) {
        return `Block ${index + 1} ${eye} axis must be an integer from 0 to 180.`;
      }
      if ((payload.prismAmount === undefined) !== (payload.prismBase === undefined)) {
        return `Block ${index + 1} ${eye} prism amount and base must be saved together.`;
      }
      const prismError = validatePrismAmount(
        payload.prismAmount,
        definition,
        `Block ${index + 1} ${eye} prism amount`,
      );
      if (prismError) return prismError;
      if (payload.prismBase && !prismBases.has(payload.prismBase)) {
        return `Block ${index + 1} ${eye} prismBase contains an unknown option: ${payload.prismBase}.`;
      }
      const customFieldError = validateCustomFieldValues(
        payload.customFields,
        definition,
        `Block ${index + 1} ${eye}`,
      );
      if (customFieldError) return customFieldError;
    }
  }
  return undefined;
}

function validatePower(
  value: number | undefined,
  definition: ClinicalFindingDefinition,
  fieldKey: "sphere" | "cylinder" | "add",
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  const field = asRecord(asRecord(definition.valueSchema.fields)[fieldKey]);
  const minimum = readNumber(field.minimum) ?? -20;
  const maximum = readNumber(field.maximum) ?? 20;
  const step = readNumber(field.step) ?? 0.25;
  if (value < minimum || value > maximum) {
    return `${label} must be from ${minimum} to ${maximum} D.`;
  }
  const steps = (value - minimum) / step;
  if (Math.abs(steps - Math.round(steps)) > 1e-9) {
    return `${label} must use ${step.toFixed(2)} D increments.`;
  }
  return undefined;
}

function validatePrismAmount(
  value: number | undefined,
  definition: ClinicalFindingDefinition,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  const field = asRecord(asRecord(definition.valueSchema.fields).prismAmount);
  const minimum = readNumber(field.minimum) ?? 0.25;
  const maximum = readNumber(field.maximum) ?? 20;
  const step = readNumber(field.step) ?? 0.25;
  if (value < minimum || value > maximum) {
    return `${label} must be from ${minimum} to ${maximum} PD.`;
  }
  const steps = (value - minimum) / step;
  if (Math.abs(steps - Math.round(steps)) > 1e-9) {
    return `${label} must use ${step.toFixed(2)} PD increments.`;
  }
  return undefined;
}

function eyeTouched(payload: RefractionEyePayload): boolean {
  return Object.entries(payload).some(([key, value]) =>
    key === "customFields"
      ? Array.isArray(value) && value.length > 0
      : value !== undefined && value !== "");
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

function fieldOptions(definition: ClinicalFindingDefinition, fieldKey: string): ClinicalFindingOption[] {
  const field = asRecord(asRecord(definition.valueSchema.fields)[fieldKey]);
  if (!Array.isArray(field.options)) return [];
  return field.options.flatMap((option) => {
    const row = asRecord(option);
    const code = typeof row.code === "string" ? row.code : undefined;
    const display = typeof row.display === "string" ? row.display : undefined;
    if (!code || !display || row.active === false) return [];
    return [{ code, display }];
  });
}

function refractionProvenance(
  staffReference: string,
  recordedAt: string,
  sourceType: "manual" | "device",
): ClinicalGraphProvenance {
  return {
    source: sourceType,
    recordedAt,
    actorReference: staffReference,
    ledgerRefs: [LEDGER_REF],
    note: "Refraction charting endpoint captured neutral typed findings and evaluated Manifest-only refractive-error suggestion edges without confirming a diagnosis.",
  };
}

function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}

function resourceReference(actualId: string | undefined, fallbackId: string | undefined): string {
  const id = actualId ?? fallbackId;
  if (!id) {
    throw new Error("Observation create response did not include an id.");
  }
  return `Observation/${id}`;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function definedRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
