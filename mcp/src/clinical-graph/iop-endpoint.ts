import type { CodeableConcept, Observation, Provenance } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import { iopMethodConcept } from "../fhir/ophthalmology/iop.js";
import { odosConcept } from "../fhir/ophthalmology/extensions.js";
import {
  buildGlaucomaFindingDefinitionStubs,
  captureGlaucomaFinding,
  evaluateIopDiagnosisSuggestions,
  evaluateIopFindingRisk,
  patientScopedProvenanceTargets,
  type ClinicalFindingDefinition,
  type ClinicalFindingOption,
  type ClinicalGraphProvenance,
  type DiagnosisSuggestionEvaluation,
  type FindingInstance,
  type FindingValue,
} from "./glaucoma-suspect.js";

export interface IopFhirClient {
  create<T extends Observation | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export interface IopAuthenticatedStaff {
  staffReference: string;
  actorRole: PracticeRoleId;
  fhir: IopFhirClient;
}

export interface IopEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<IopAuthenticatedStaff | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
}

export interface IopEndpointResult {
  status: number;
  body: unknown;
}

export type IopRiskTier = "normal" | "ohtn";

export interface IopEyeResult {
  observationReference: string;
  provenanceReference?: string;
  cornealHysteresisObservationReference?: string;
  cornealHysteresisProvenanceReference?: string;
  riskTier: IopRiskTier;
  icd10Code?: string;
  explanation: string;
  signals: string[];
  threshold: number;
  value?: number;
}

export interface IopDefinitionResponse {
  definitions: {
    intraocularPressure: {
      id: string;
      stableKey: string;
      display: string;
      fields: Record<string, unknown>;
      normalSemantics?: Record<string, unknown>;
    };
    cornealHysteresis: {
      id: string;
      stableKey: string;
      display: string;
      fields: Record<string, unknown>;
      normalSemantics?: Record<string, unknown>;
    };
  };
}

const WRITE_HEADERS = { "X-ODOS-Source": "mcp/save_section_observations" } as const;
const LEDGER_REF = "data/code-bindings/glaucoma-suspect-phase0-ledger.json";
const EYES = ["OD", "OS"] as const;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate, {
  message: "Date must be a valid calendar date.",
});
const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/);
const eyePayloadSchema = z.object({
  value: z.number().min(3).max(80).optional(),
  method: z.string().min(1).optional(),
  date: dateSchema.optional(),
  timeOfDay: timeOfDaySchema.optional(),
  cornealHysteresis: z.number().min(0).max(15).refine(isTenths, {
    message: "Corneal hysteresis must use 0.1 increments.",
  }).optional(),
  notVisualized: z.boolean().optional(),
}).strict();

const iopRequestSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  eyes: z.object({
    OD: eyePayloadSchema.optional(),
    OS: eyePayloadSchema.optional(),
  }).strict(),
}).strict();

type Eye = typeof EYES[number];
type IopEyePayload = z.infer<typeof eyePayloadSchema>;

export async function handleIopDefinitionRequest(
  deps: Pick<IopEndpointDeps, "authenticate" | "findingDefinitions">,
  input: { authHeader: string | undefined },
): Promise<IopEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read IOP definition." } };
  }
  if (!staffHasBusinessAction(staff, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }

  const definitions = resolveIopDefinitions(deps.findingDefinitions?.());
  return { status: 200, body: iopDefinitionResponse(definitions) };
}

export async function handleIopCaptureRequest(
  deps: IopEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<IopEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to save IOP findings." } };
  }
  if (!staffHasBusinessAction(staff, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }

  const parsed = iopRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    return { status: 400, body: { error: issue ? `${field || "IOP request"}: ${issue.message}` : "Invalid IOP request." } };
  }

  const definitions = resolveIopDefinitions(deps.findingDefinitions?.());
  const validationError = validateIopRequest(parsed.data.eyes, definitions.intraocularPressure);
  if (validationError) {
    return { status: 400, body: { error: validationError } };
  }

  const captured = EYES.flatMap((eye) => {
    const payload = parsed.data.eyes[eye];
    if (!payload) return [];
    const recordedAt = recordedAtForPayload(payload, deps.now);
    const provenance = iopProvenance(staff.staffReference, recordedAt);
    const method = methodConcept(definitions.intraocularPressure, payload.method);
    const iop = captureGlaucomaFinding({
      definition: definitions.intraocularPressure,
      patientReference: parsed.data.patientReference,
      encounterReference: parsed.data.encounterReference,
      laterality: eye,
      value: iopFindingValue(payload),
      method,
      sourceType: "manual",
      performerReferences: [staff.staffReference],
      recordedAt,
      provenance,
    });
    const cornealHysteresis = payload.cornealHysteresis === undefined || payload.notVisualized === true
      ? undefined
      : captureGlaucomaFinding({
          definition: definitions.cornealHysteresis,
          patientReference: parsed.data.patientReference,
          encounterReference: parsed.data.encounterReference,
          laterality: eye,
          value: {
            type: "quantity",
            value: payload.cornealHysteresis,
            unit: "corneobiomechanics score",
          },
          method,
          sourceType: "manual",
          performerReferences: [staff.staffReference],
          recordedAt,
          provenance,
        });
    return [{ eye, payload, iop, cornealHysteresis }];
  });

  const persisted = [];
  for (const item of captured) {
    const observation = await staff.fhir.create<Observation>(item.iop.observation, WRITE_HEADERS);
    const observationReference = resourceReference("Observation", observation.id, item.iop.observation.id);
    const provenance = await staff.fhir.create<Provenance>(
      {
        ...item.iop.provenance,
        target: patientScopedProvenanceTargets(
          observationReference,
          parsed.data.patientReference,
        ),
      },
      WRITE_HEADERS,
    );
    let cornealHysteresisObservationReference: string | undefined;
    let cornealHysteresisProvenanceReference: string | undefined;
    if (item.cornealHysteresis) {
      const chObservation = await staff.fhir.create<Observation>(item.cornealHysteresis.observation, WRITE_HEADERS);
      cornealHysteresisObservationReference = resourceReference(
        "Observation",
        chObservation.id,
        item.cornealHysteresis.observation.id,
      );
      const chProvenance = await staff.fhir.create<Provenance>(
        {
          ...item.cornealHysteresis.provenance,
          target: patientScopedProvenanceTargets(
            cornealHysteresisObservationReference,
            parsed.data.patientReference,
          ),
        },
        WRITE_HEADERS,
      );
      cornealHysteresisProvenanceReference = chProvenance.id
        ? `Provenance/${chProvenance.id}`
        : undefined;
    }

    persisted.push({
      eye: item.eye,
      payload: item.payload,
      finding: {
        ...item.iop.finding,
        observationReference,
      },
      observationReference,
      provenanceReference: provenance.id ? `Provenance/${provenance.id}` : undefined,
      cornealHysteresisObservationReference,
      cornealHysteresisProvenanceReference,
    });
  }

  const suggestions = evaluateIopDiagnosisSuggestions({
    findings: persisted.map((item) => item.finding),
    findingDefinitions: [definitions.intraocularPressure],
    encounterReference: parsed.data.encounterReference,
    provenance: iopProvenance(staff.staffReference, deps.now?.() ?? new Date().toISOString()),
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
          eyeResult(item, definitions.intraocularPressure, suggestionsByFindingId.get(item.finding.id)),
        ]),
      ),
    },
  };
}

export function resolveIopDefinitions(
  suppliedDefinitions: ClinicalFindingDefinition[] | undefined,
): { intraocularPressure: ClinicalFindingDefinition; cornealHysteresis: ClinicalFindingDefinition } {
  const definitions = suppliedDefinitions ??
    buildGlaucomaFindingDefinitionStubs({
      provenance: iopProvenance("Practitioner/odos-system", new Date(0).toISOString()),
    });
  const intraocularPressure = definitions.find((row) => row.stableKey === "intraocular_pressure");
  const cornealHysteresis = definitions.find((row) => row.stableKey === "corneal_hysteresis");
  if (!intraocularPressure) {
    throw new Error("Glaucoma IOP finding definition seed is missing.");
  }
  if (!cornealHysteresis) {
    throw new Error("Corneal hysteresis finding definition seed is missing.");
  }
  return { intraocularPressure, cornealHysteresis };
}

function iopDefinitionResponse(
  definitions: { intraocularPressure: ClinicalFindingDefinition; cornealHysteresis: ClinicalFindingDefinition },
): IopDefinitionResponse {
  return {
    definitions: {
      intraocularPressure: definitionSummary(definitions.intraocularPressure),
      cornealHysteresis: definitionSummary(definitions.cornealHysteresis),
    },
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

function validateIopRequest(
  eyes: Partial<Record<Eye, IopEyePayload>>,
  definition: ClinicalFindingDefinition,
): string | undefined {
  const supplied = EYES.filter((eye) => Boolean(eyes[eye]));
  if (supplied.length === 0) {
    return "At least one eye payload is required.";
  }

  for (const eye of supplied) {
    const payload = eyes[eye];
    if (!payload) continue;
    if (payload.notVisualized === true) {
      if (payload.value !== undefined || payload.cornealHysteresis !== undefined) {
        return `${eye} cannot include IOP or CH values when notVisualized is true.`;
      }
      continue;
    }
    if (payload.value === undefined) {
      return `${eye} value is required unless notVisualized is true.`;
    }
    if (!payload.method) {
      return `${eye} method is required unless notVisualized is true.`;
    }
    if (!payload.date) {
      return `${eye} date is required unless notVisualized is true.`;
    }
    if (!payload.timeOfDay) {
      return `${eye} timeOfDay is required unless notVisualized is true.`;
    }
    const methodError = validateOption(definition, "method", payload.method, `${eye} method`);
    if (methodError) return methodError;
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
  const allowed = fieldOptions(definition, fieldKey).map((option) => option.code);
  return allowed.includes(value)
    ? undefined
    : `${label} contains an unknown option: ${value}. Valid options: ${allowed.join(", ")}.`;
}

function iopFindingValue(payload: IopEyePayload): FindingValue {
  if (payload.notVisualized === true) {
    return {
      type: "json",
      value: definedRecord({
        notVisualized: true,
        date: payload.date,
        timeOfDay: payload.timeOfDay,
      }),
    };
  }
  if (payload.value === undefined) {
    throw new Error("IOP value is required unless notVisualized is true.");
  }
  return {
    type: "quantity",
    value: payload.value,
    unit: "mmHg",
    system: "http://unitsofmeasure.org",
    code: "mm[Hg]",
  };
}

function methodConcept(
  definition: ClinicalFindingDefinition,
  method: string | undefined,
): CodeableConcept | undefined {
  if (!method) return undefined;
  const option = fieldOptions(definition, "method").find((candidate) => candidate.code === method);
  return option ? iopMethodConcept(odosConcept(option.code, option.display)) : undefined;
}

function eyeResult(
  item: {
    payload: IopEyePayload;
    finding: FindingInstance;
    observationReference: string;
    provenanceReference?: string;
    cornealHysteresisObservationReference?: string;
    cornealHysteresisProvenanceReference?: string;
  },
  definition: ClinicalFindingDefinition,
  suggestion: DiagnosisSuggestionEvaluation | undefined,
): IopEyeResult {
  const risk = evaluateIopFindingRisk(item.finding, definition);
  if (!suggestion) {
    return {
      observationReference: item.observationReference,
      provenanceReference: item.provenanceReference,
      cornealHysteresisObservationReference: item.cornealHysteresisObservationReference,
      cornealHysteresisProvenanceReference: item.cornealHysteresisProvenanceReference,
      riskTier: "normal",
      explanation: item.payload.notVisualized
        ? "Not visualized/deferred IOP finding: no ocular-hypertension suggestion edge emitted."
        : risk.value === undefined
          ? "No IOP value captured: no ocular-hypertension suggestion edge emitted."
          : `Normal IOP ${risk.value} mmHg < threshold ${risk.threshold} mmHg: no ocular-hypertension suggestion edge emitted.`,
      signals: [],
      threshold: risk.threshold,
      ...(risk.value !== undefined ? { value: risk.value } : {}),
    };
  }

  const expression = suggestion.suggestionEdge.predicateExpression;
  return {
    observationReference: item.observationReference,
    provenanceReference: item.provenanceReference,
    cornealHysteresisObservationReference: item.cornealHysteresisObservationReference,
    cornealHysteresisProvenanceReference: item.cornealHysteresisProvenanceReference,
    riskTier: expression.riskTier === "ohtn" ? "ohtn" : "normal",
    ...(suggestion.diagnosisDefinition.icd10Code ? { icd10Code: suggestion.diagnosisDefinition.icd10Code } : {}),
    explanation: suggestion.suggestionEdge.explanation,
    signals: stringArray(expression.signals),
    threshold: risk.threshold,
    ...(risk.value !== undefined ? { value: risk.value } : {}),
  };
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
    return [{ code, display }];
  });
}

function recordedAtForPayload(payload: IopEyePayload, now: IopEndpointDeps["now"]): string {
  if (!payload.date || !payload.timeOfDay) {
    return now?.() ?? new Date().toISOString();
  }
  const seconds = payload.timeOfDay.length === 5 ? `${payload.timeOfDay}:00` : payload.timeOfDay;
  const date = new Date(`${payload.date}T${seconds}`);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid IOP date/time.");
  }
  return date.toISOString();
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function isTenths(value: number): boolean {
  return Math.abs(value * 10 - Math.round(value * 10)) < 1e-9;
}

function iopProvenance(
  staffReference: string,
  recordedAt: string,
): ClinicalGraphProvenance {
  return {
    source: "manual",
    recordedAt,
    actorReference: staffReference,
    ledgerRefs: [LEDGER_REF],
    note: "IOP charting endpoint captured neutral finding evidence and evaluated ocular-hypertension suggestion edges without confirming a diagnosis.",
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
