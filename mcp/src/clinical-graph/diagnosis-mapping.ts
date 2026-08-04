import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ClinicalFindingDefinition,
  ClinicalGraphProvenance,
  DiagnosisCandidateEntry,
  DiagnosisCatalogRow,
  FindingInstance,
  MappingTrigger,
} from "./glaucoma-suspect.js";

const fieldSchema = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const optionSchema = z.string().trim().min(1).max(200);
export const mappingTriggerSchema: z.ZodType<MappingTrigger> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("always") }).strict(),
    z.object({ kind: z.literal("abnormal") }).strict(),
    z.object({
      kind: z.literal("numeric"),
      field: fieldSchema,
      op: z.enum([">=", "<=", ">", "<", "=="]),
      value: z.number().finite(),
    }).strict(),
    z.object({
      kind: z.literal("option"),
      field: fieldSchema,
      anyOf: z.array(optionSchema).min(1).max(100),
    }).strict(),
    z.object({
      kind: z.literal("qualifier"),
      field: fieldSchema,
      option: optionSchema,
      qualifiers: z.record(fieldSchema, optionSchema).refine(
        (qualifiers) => Object.keys(qualifiers).length >= 1 && Object.keys(qualifiers).length <= 20,
        "Qualifier triggers require 1 to 20 qualifier values.",
      ),
    }).strict(),
    z.object({
      kind: z.literal("allOf"),
      triggers: z.array(mappingTriggerSchema).min(1).max(20),
    }).strict(),
  ])
);

export const createDiagnosisCandidateSchema = z.object({
  diagnosisKey: z.string().trim().min(1).max(160),
  trigger: mappingTriggerSchema,
  priority: z.boolean().optional(),
}).strict();

export const updateDiagnosisCandidateSchema = z.object({
  diagnosisKey: z.string().trim().min(1).max(160).optional(),
  trigger: mappingTriggerSchema.optional(),
  priority: z.boolean().optional(),
  active: z.boolean().optional(),
}).strict();

export function createDiagnosisCandidate(
  definition: ClinicalFindingDefinition,
  input: z.infer<typeof createDiagnosisCandidateSchema>,
  catalog: readonly DiagnosisCatalogRow[],
  provenance: ClinicalGraphProvenance,
  shortId = () => randomUUID().replaceAll("-", "").slice(0, 8),
): { definition: ClinicalFindingDefinition; candidate: DiagnosisCandidateEntry } {
  assertMappingAllowed(definition, input.trigger);
  assertActiveDiagnosis(input.diagnosisKey, catalog);
  const candidate: DiagnosisCandidateEntry = {
    id: `CUSTOM_${slugify(input.diagnosisKey)}_${shortId()}`,
    diagnosisKey: input.diagnosisKey,
    trigger: input.trigger,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    origin: "practice",
    active: true,
  };
  if ((definition.diagnosisCandidates ?? []).some((row) => row.id === candidate.id)) {
    throw new Error(`Diagnosis mapping id collision: ${candidate.id}.`);
  }
  return {
    candidate,
    definition: withCandidates(definition, [...(definition.diagnosisCandidates ?? []), candidate], provenance),
  };
}

export function updateDiagnosisCandidate(
  definition: ClinicalFindingDefinition,
  id: string,
  input: z.infer<typeof updateDiagnosisCandidateSchema>,
  catalog: readonly DiagnosisCatalogRow[],
  provenance: ClinicalGraphProvenance,
): { definition: ClinicalFindingDefinition; candidate: DiagnosisCandidateEntry } {
  const current = (definition.diagnosisCandidates ?? []).find((row) => row.id === id);
  if (!current) throw new Error(`Diagnosis mapping ${id} does not exist.`);
  const candidate: DiagnosisCandidateEntry = {
    ...current,
    ...(input.diagnosisKey !== undefined ? { diagnosisKey: input.diagnosisKey } : {}),
    ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.active !== undefined ? { active: input.active } : {}),
  };
  assertMappingAllowed(definition, candidate.trigger);
  assertActiveDiagnosis(candidate.diagnosisKey, catalog);
  return {
    candidate,
    definition: withCandidates(
      definition,
      (definition.diagnosisCandidates ?? []).map((row) => row.id === id ? candidate : row),
      provenance,
    ),
  };
}

export function evaluateMappingTrigger(trigger: unknown, finding: FindingInstance): boolean {
  const parsed = mappingTriggerSchema.safeParse(trigger);
  if (!parsed.success) return false;
  if (parsed.data.kind === "allOf") {
    return parsed.data.triggers.every((nested) => evaluateMappingTrigger(nested, finding));
  }
  if (parsed.data.kind === "always") return true;
  if (parsed.data.kind === "abnormal") {
    return finding.interpretation === "abnormal" || finding.interpretation === "borderline";
  }
  if (parsed.data.kind === "qualifier") {
    if (finding.value.type !== "components") return false;
    const prefix = `${parsed.data.field}::${parsed.data.option}::`;
    return Object.entries(parsed.data.qualifiers).every(([qualifier, expected]) =>
      finding.value.type === "components" && finding.value.components.some((component) =>
        (component.code === `${prefix}${qualifier}` || component.code.endsWith(`_${prefix}${qualifier}`)) &&
        component.value === expected
      )
    );
  }
  const value = findingFieldValue(finding, parsed.data.field);
  if (parsed.data.kind === "option") {
    if (typeof value === "string" && parsed.data.anyOf.includes(value)) return true;
    if (finding.value.type !== "components") return false;
    const { field, anyOf } = parsed.data;
    return finding.value.components.some((component) => component.value === true && anyOf.some((option) =>
      component.code === `${field}::${option}` ||
      component.code.endsWith(`_${field}::${option}`)
    ));
  }
  if (value === undefined) return false;
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (parsed.data.op === ">=") return value >= parsed.data.value;
  if (parsed.data.op === "<=") return value <= parsed.data.value;
  if (parsed.data.op === ">") return value > parsed.data.value;
  if (parsed.data.op === "<") return value < parsed.data.value;
  return value === parsed.data.value;
}

export function matchingQualifierGroups(trigger: MappingTrigger, finding: FindingInstance): string[] {
  if (!evaluateMappingTrigger(trigger, finding)) return [];
  if (trigger.kind === "qualifier") return [qualifierGroup(trigger.field, trigger.option)];
  if (trigger.kind === "allOf") {
    return trigger.triggers.flatMap((nested) => matchingQualifierGroups(nested, finding));
  }
  return [];
}

export function qualifierGroup(field: string, option: string): string {
  return `${field}\u0000${option}`;
}

function findingFieldValue(finding: FindingInstance, field: string): number | string | boolean | undefined {
  if (finding.value.type === "quantity") {
    return field === "value" ? finding.value.value : undefined;
  }
  if (finding.value.type === "components") {
    return finding.value.components.find((component) =>
      component.code === field || component.code.endsWith(`_${field}`)
    )?.value;
  }
  if (finding.value.type === "json") {
    const direct = finding.value.value[field] ?? (field === "type" ? finding.value.value.refractionType : undefined);
    if (typeof direct === "number" || typeof direct === "string" || typeof direct === "boolean") return direct;
    const customFields = finding.value.value.customFields;
    if (Array.isArray(customFields)) {
      const row = customFields.find((candidate) =>
        isRecord(candidate) && (candidate.code === field || String(candidate.code).endsWith(`_${field}`))
      );
      const value = isRecord(row) ? row.value : undefined;
      if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
    }
    return undefined;
  }
  return field === "value" ? finding.value.value : undefined;
}

function assertMappingAllowed(definition: ClinicalFindingDefinition, trigger: MappingTrigger): void {
  if (definition.allowDiagnosisMapping === false) {
    throw new Error(`Finding definition ${definition.stableKey} does not allow diagnosis mapping.`);
  }
  if (
    definition.stableKey === "refraction" &&
    !(trigger.kind === "option" && trigger.field === "type" && trigger.anyOf.length > 0 && trigger.anyOf.every((value) => value === "MANIFEST"))
  ) {
    throw new Error("Refraction diagnosis mappings must be restricted to the Manifest block type.");
  }
}

function assertActiveDiagnosis(stableKey: string, catalog: readonly DiagnosisCatalogRow[]): void {
  const diagnosis = catalog.find((row) => row.stableKey === stableKey);
  if (!diagnosis) throw new Error(`Diagnosis definition ${stableKey} does not exist.`);
  if (!diagnosis.active) throw new Error(`Diagnosis definition ${stableKey} is inactive.`);
}

function withCandidates(
  definition: ClinicalFindingDefinition,
  diagnosisCandidates: DiagnosisCandidateEntry[],
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition {
  return { ...definition, diagnosisCandidates, provenance };
}

function slugify(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 72) || "DIAGNOSIS";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
