import type { CodeableConcept, Observation, Provenance } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { odosConcept } from "../fhir/ophthalmology/extensions.js";
import {
  buildGlaucomaFindingDefinitionStubs,
  captureGlaucomaFinding,
  evaluateGlaucomaDiagnosisSuggestions,
  patientScopedProvenanceTargets,
  type ClinicalFindingDefinition,
  type ClinicalFindingOption,
  type ClinicalGraphProvenance,
  type DiagnosisSuggestionEvaluation,
  type FindingInstance,
  type FindingValue,
} from "./glaucoma-suspect.js";

export interface CupDiscFhirClient {
  create<T extends Observation | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export interface CupDiscAuthenticatedStaff {
  staffReference: string;
  actorRole: PracticeRoleId;
  fhir: CupDiscFhirClient;
}

export interface CupDiscEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<CupDiscAuthenticatedStaff | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
}

export interface CupDiscEndpointResult {
  status: number;
  body: unknown;
}

export type CupDiscRiskTier = "normal" | "low" | "high";

export interface CupDiscEyeResult {
  observationReference: string;
  provenanceReference?: string;
  riskTier: CupDiscRiskTier;
  icd10Code?: string;
  explanation: string;
  signals: string[];
  cupDiscAsymmetry?: number;
}

export interface CupDiscDefinitionResponse {
  definition: {
    id: string;
    stableKey: string;
    display: string;
    fields: Record<string, unknown>;
  };
}

const WRITE_HEADERS = { "X-ODOS-Source": "mcp/save_section_observations" } as const;
const LEDGER_REF = "data/code-bindings/glaucoma-suspect-phase0-ledger.json";
const EYES = ["OD", "OS"] as const;

const ratioSchema = z.number().min(0).max(1);
const eyePayloadSchema = z.object({
  verticalCupDiscRatio: ratioSchema.optional(),
  horizontalCupDiscRatio: ratioSchema.optional(),
  discNerveSize: z.string().min(1).optional(),
  discAppearanceDescriptors: z.array(z.string().min(1)).optional(),
  methodSource: z.string().min(1).optional(),
  notVisualized: z.boolean().optional(),
}).strict();

const cupDiscRequestSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  recordedAt: z.string().datetime().optional(),
  eyes: z.object({
    OD: eyePayloadSchema.optional(),
    OS: eyePayloadSchema.optional(),
  }).strict(),
}).strict();

type Eye = typeof EYES[number];
type CupDiscEyePayload = z.infer<typeof eyePayloadSchema>;

export async function handleCupDiscDefinitionRequest(
  deps: Pick<CupDiscEndpointDeps, "authenticate" | "findingDefinitions">,
  input: { authHeader: string | undefined },
): Promise<CupDiscEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read cup/disc definition." } };
  }
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }

  const definition = resolveCupDiscDefinition(deps.findingDefinitions?.());
  return { status: 200, body: cupDiscDefinitionResponse(definition) };
}

export async function handleCupDiscCaptureRequest(
  deps: CupDiscEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<CupDiscEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to save cup/disc findings." } };
  }
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }

  const parsed = cupDiscRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid cup/disc request." } };
  }

  const definition = resolveCupDiscDefinition(deps.findingDefinitions?.());
  const validationError = validateCupDiscRequest(parsed.data.eyes, definition);
  if (validationError) {
    return { status: 400, body: { error: validationError } };
  }

  const recordedAt = parsed.data.recordedAt ?? deps.now?.() ?? new Date().toISOString();
  const provenance = cupDiscProvenance(staff.staffReference, recordedAt);
  const captured = EYES.flatMap((eye) => {
    const payload = parsed.data.eyes[eye];
    if (!payload) return [];
    return [{
      eye,
      payload,
      captured: captureGlaucomaFinding({
        definition,
        patientReference: parsed.data.patientReference,
        encounterReference: parsed.data.encounterReference,
        laterality: eye,
        value: cupDiscFindingValue(payload),
        method: methodConcept(definition, payload.methodSource),
        sourceType: "manual",
        performerReferences: [staff.staffReference],
        recordedAt,
        provenance,
      }),
    }];
  });

  const persisted = [];
  for (const item of captured) {
    const observation = await staff.fhir.create<Observation>(item.captured.observation, WRITE_HEADERS);
    const observationReference = resourceReference("Observation", observation.id, item.captured.observation.id);
    const provenance = await staff.fhir.create<Provenance>(
      {
        ...item.captured.provenance,
        target: patientScopedProvenanceTargets(
          observationReference,
          parsed.data.patientReference,
        ),
      },
      WRITE_HEADERS,
    );
    persisted.push({
      eye: item.eye,
      payload: item.payload,
      finding: {
        ...item.captured.finding,
        observationReference,
      },
      observationReference,
      provenanceReference: provenance.id ? `Provenance/${provenance.id}` : undefined,
    });
  }

  const suggestions = evaluateGlaucomaDiagnosisSuggestions({
    findings: persisted.map((item) => item.finding),
    findingDefinitions: [definition],
    encounterReference: parsed.data.encounterReference,
    provenance,
  });
  const suggestionsByFindingId = new Map(
    suggestions.map((suggestion) => [suggestion.suggestionEdge.sourceFindingInstanceId, suggestion]),
  );

  return {
    status: 200,
    body: {
      eyes: Object.fromEntries(
        persisted.map((item) => [
          item.eye,
          eyeResult(item, suggestionsByFindingId.get(item.finding.id)),
        ]),
      ),
    },
  };
}

export function resolveCupDiscDefinition(
  suppliedDefinitions: ClinicalFindingDefinition[] | undefined,
): ClinicalFindingDefinition {
  const definitions = suppliedDefinitions ?? buildGlaucomaFindingDefinitionStubs({
    provenance: cupDiscProvenance("Practitioner/odos-system", new Date(0).toISOString()),
  });
  const definition = definitions.find((row) => row.stableKey === "cup_disc_ratio");
  if (!definition) {
    throw new Error("Glaucoma cup/disc finding definition seed is missing.");
  }
  return definition;
}

function cupDiscDefinitionResponse(definition: ClinicalFindingDefinition): CupDiscDefinitionResponse {
  return {
    definition: {
      id: definition.id,
      stableKey: definition.stableKey,
      display: definition.display,
      fields: asRecord(definition.valueSchema.fields),
    },
  };
}

function validateCupDiscRequest(
  eyes: Partial<Record<Eye, CupDiscEyePayload>>,
  definition: ClinicalFindingDefinition,
): string | undefined {
  const supplied = EYES.filter((eye) => Boolean(eyes[eye]));
  if (supplied.length === 0) {
    return "At least one eye payload is required.";
  }

  for (const eye of supplied) {
    const payload = eyes[eye];
    if (!payload) continue;
    if (payload.notVisualized !== true && payload.verticalCupDiscRatio === undefined) {
      return `${eye} verticalCupDiscRatio is required unless notVisualized is true.`;
    }
    const sizeError = validateOption(definition, "discNerveSize", payload.discNerveSize, `${eye} discNerveSize`);
    if (sizeError) return sizeError;
    const methodError = validateOption(definition, "methodSource", payload.methodSource, `${eye} methodSource`);
    if (methodError) return methodError;
    const descriptorOptions = new Set(fieldOptions(definition, "discAppearanceDescriptors").map((option) => option.code));
    for (const descriptor of payload.discAppearanceDescriptors ?? []) {
      if (!descriptorOptions.has(descriptor)) {
        return `${eye} discAppearanceDescriptors contains an unknown option: ${descriptor}.`;
      }
    }
  }

  return undefined;
}

function validateOption(
  definition: ClinicalFindingDefinition,
  fieldKey: string,
  value: string | undefined,
  label: string,
): string | undefined {
  if (!value) return undefined;
  const allowed = new Set(fieldOptions(definition, fieldKey).map((option) => option.code));
  return allowed.has(value) ? undefined : `${label} contains an unknown option: ${value}.`;
}

function cupDiscFindingValue(payload: CupDiscEyePayload): FindingValue {
  const hasExtendedPayload =
    payload.notVisualized === true ||
    payload.horizontalCupDiscRatio !== undefined ||
    payload.discNerveSize !== undefined ||
    payload.methodSource !== undefined ||
    (payload.discAppearanceDescriptors?.length ?? 0) > 0;

  if (!hasExtendedPayload && payload.verticalCupDiscRatio !== undefined) {
    return { type: "quantity", value: payload.verticalCupDiscRatio, unit: "ratio", code: "1" };
  }

  return {
    type: "json",
    value: definedRecord({
      verticalCupDiscRatio: payload.verticalCupDiscRatio,
      horizontalCupDiscRatio: payload.horizontalCupDiscRatio,
      discAppearanceDescriptors: payload.discAppearanceDescriptors ?? [],
      discNerveSize: payload.discNerveSize,
      methodSource: payload.methodSource,
      notVisualized: payload.notVisualized === true,
    }),
  };
}

function methodConcept(
  definition: ClinicalFindingDefinition,
  methodSource: string | undefined,
): CodeableConcept | undefined {
  if (!methodSource) return undefined;
  const option = fieldOptions(definition, "methodSource").find((candidate) => candidate.code === methodSource);
  return option ? odosConcept(option.code, option.display) : undefined;
}

function eyeResult(
  item: {
    payload: CupDiscEyePayload;
    finding: FindingInstance;
    observationReference: string;
    provenanceReference?: string;
  },
  suggestion: DiagnosisSuggestionEvaluation | undefined,
): CupDiscEyeResult {
  if (!suggestion) {
    return {
      observationReference: item.observationReference,
      provenanceReference: item.provenanceReference,
      riskTier: "normal",
      explanation: item.payload.notVisualized
        ? "Not visualized/deferred cup/disc finding: no glaucoma-suspect suggestion edge emitted."
        : "Normal cup/disc finding: no glaucoma-suspect suggestion edge emitted.",
      signals: [],
    };
  }

  const expression = suggestion.suggestionEdge.predicateExpression;
  const riskTier = riskTierFromExpression(expression.riskTier);
  return {
    observationReference: item.observationReference,
    provenanceReference: item.provenanceReference,
    riskTier,
    ...(suggestion.diagnosisDefinition.icd10Code ? { icd10Code: suggestion.diagnosisDefinition.icd10Code } : {}),
    explanation: suggestion.suggestionEdge.explanation,
    signals: signalKeys(expression),
    cupDiscAsymmetry: cupDiscAsymmetry(expression),
  };
}

function riskTierFromExpression(value: unknown): CupDiscRiskTier {
  return value === "high" || value === "low" ? value : "normal";
}

function signalKeys(expression: Record<string, unknown>): string[] {
  return [
    ...stringArray(expression.highRiskSignals),
    ...stringArray(expression.lowRiskSignals),
  ];
}

function cupDiscAsymmetry(expression: Record<string, unknown>): number | undefined {
  const observed = asRecord(expression.observed);
  const value = observed.cupDiscAsymmetry;
  return typeof value === "number" ? value : undefined;
}

function fieldOptions(definition: ClinicalFindingDefinition, fieldKey: string): ClinicalFindingOption[] {
  const field = asRecord(asRecord(definition.valueSchema.fields)[fieldKey]);
  const options = field.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    const record = asRecord(option);
    const code = typeof record.code === "string" ? record.code : undefined;
    const display = typeof record.display === "string" ? record.display : undefined;
    if (!code || !display || record.active === false) return [];
    return [{
      code,
      display,
      ...(typeof record.highRiskDriver === "boolean" ? { highRiskDriver: record.highRiskDriver } : {}),
    }];
  });
}

function cupDiscProvenance(
  staffReference: string,
  recordedAt: string,
): ClinicalGraphProvenance {
  return {
    source: "manual",
    recordedAt,
    actorReference: staffReference,
    ledgerRefs: [LEDGER_REF],
    note: "Cup/disc charting endpoint captured neutral finding evidence and evaluated suggestion edges without confirming a diagnosis.",
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

function resourceReference(resourceType: "Observation", actualId: string | undefined, fallbackId: string | undefined): string {
  const id = actualId ?? fallbackId;
  if (!id) {
    throw new Error(`${resourceType} create response did not include an id.`);
  }
  return `${resourceType}/${id}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function definedRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) =>
      item !== undefined &&
      (!Array.isArray(item) || item.length > 0)),
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
