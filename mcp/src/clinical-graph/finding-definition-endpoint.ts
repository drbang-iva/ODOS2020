import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  assertBusinessActionAllowed,
  type BusinessAction,
  type PracticeRoleId,
} from "../authz/roles.js";
import {
  createCustomField,
  createCustomFieldInputSchema,
  customFieldEntries,
  pickerAllowsCreate,
  updateCustomField,
  updateCustomFieldInputSchema,
  updatePickerConfiguration,
  type CustomFieldEntry,
} from "./custom-fields.js";
import {
  FhirFindingDefinitionStore,
  type FindingDefinitionFhirClient,
} from "./finding-definition-store.js";
import { FhirDiagnosisCatalogStore } from "./diagnosis-catalog-store.js";
import {
  createDiagnosisCandidate,
  createDiagnosisCandidateSchema,
  updateDiagnosisCandidate,
  updateDiagnosisCandidateSchema,
} from "./diagnosis-mapping.js";
import {
  buildClinicalFindingDefinition,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
} from "./glaucoma-suspect.js";

export interface FindingDefinitionEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: FindingDefinitionFhirClient;
  } | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
  shortId?: () => string;
}

const createDefinitionSchema = z.object({
  action: z.literal("create-definition"),
  display: z.string().trim().min(1).max(120),
  fields: z.array(createCustomFieldInputSchema).min(1).max(64),
  perEye: z.boolean(),
}).strict();

const mutationSchema = z.discriminatedUnion("action", [
  createCustomFieldInputSchema.extend({
    action: z.literal("create-custom-field"),
  }),
  updateCustomFieldInputSchema.extend({
    action: z.literal("update-custom-field"),
    localCode: z.string().trim().min(1).max(100),
  }),
  z.object({
    action: z.literal("set-picker-config"),
    visibleCodes: z.array(z.string().trim().min(1).max(100)).max(64).optional(),
    allowCreate: z.boolean().optional(),
  }).strict(),
  z.object({
    action: z.literal("update-definition"),
    display: z.string().trim().min(1).max(120).optional(),
    active: z.boolean().optional(),
  }).strict(),
  createDiagnosisCandidateSchema.extend({
    action: z.literal("create-diagnosis-candidate"),
  }),
  updateDiagnosisCandidateSchema.extend({
    action: z.literal("update-diagnosis-candidate"),
    id: z.string().trim().min(1).max(100),
  }),
]);

export async function handleFindingDefinitionCreationRequest(
  deps: FindingDefinitionEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to manage finding definitions." } };
  if (!staffMay(staff.actorRole, "finding-definitions.write")) {
    return { status: 403, body: { error: "finding-definitions.write role required" } };
  }
  const parsed = createDefinitionSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid finding-definition creation." } };
  }
  const provenance = mutationProvenance(staff.staffReference, deps.now?.());
  const store = new FhirFindingDefinitionStore(staff.fhir);
  const stableKey = `custom:${slug(parsed.data.display)}-${deps.shortId?.() ?? randomShortId()}`;
  if ((await store.list()).some((definition) => definition.stableKey === stableKey)) {
    return { status: 409, body: { error: `Finding definition ${stableKey} already exists.` } };
  }
  try {
    let definition = buildClinicalFindingDefinition({
      stableKey,
      display: parsed.data.display,
      sectionKey: stableKey,
      anatomyTarget: parsed.data.perEye ? "eye" : "other",
      valueSchema: { type: "component-panel", perEye: parsed.data.perEye, fields: {} },
      sourceStatus: "local-practice",
      provenance,
    });
    const fields: CustomFieldEntry[] = [];
    for (const fieldInput of parsed.data.fields) {
      const created = createCustomField(definition, fieldInput, provenance);
      definition = created.definition;
      fields.push(created.field);
    }
    const saved = await store.save(definition, provenance);
    return { status: 201, body: { definition: definitionSummary(saved), fields } };
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

export async function handleFindingDefinitionCatalogRequest(
  deps: FindingDefinitionEndpointDeps,
  input: { authHeader: string | undefined },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read finding definitions." } };
  const canWrite = staffMay(staff.actorRole, "finding-definitions.write");
  if (!staffMay(staff.actorRole, "chart.read") && !canWrite) {
    return { status: 403, body: { error: "chart.read or finding-definitions.write role required" } };
  }
  return {
    status: 200,
    body: {
      canWrite,
      definitions: (deps.findingDefinitions?.() ?? await new FhirFindingDefinitionStore(staff.fhir).list())
        .map(definitionSummary),
    },
  };
}

export async function handleFindingDefinitionMutationRequest(
  deps: FindingDefinitionEndpointDeps,
  input: {
    authHeader: string | undefined;
    params: unknown;
    body: unknown;
  },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to manage finding definitions." } };
  if (!staffMay(staff.actorRole, "finding-definitions.write")) {
    return { status: 403, body: { error: "finding-definitions.write role required" } };
  }
  const stableKey = readStableKey(input.params);
  if (!stableKey) return { status: 400, body: { error: "A valid finding-definition stableKey is required." } };
  const parsed = mutationSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid finding-definition mutation." } };
  }
  if (
    parsed.data.action === "set-picker-config" &&
    parsed.data.visibleCodes === undefined &&
    parsed.data.allowCreate === undefined
  ) {
    return { status: 400, body: { error: "Picker configuration requires visibleCodes or allowCreate." } };
  }
  if (
    parsed.data.action === "update-definition" &&
    parsed.data.display === undefined &&
    parsed.data.active === undefined
  ) {
    return { status: 400, body: { error: "Definition update requires display or active." } };
  }
  const store = new FhirFindingDefinitionStore(staff.fhir);
  const definition = (await store.list())
    .find((candidate) => candidate.stableKey === stableKey);
  if (!definition) return { status: 404, body: { error: `Finding definition ${stableKey} does not exist.` } };
  const provenance = mutationProvenance(staff.staffReference, deps.now?.());
  try {
    if (parsed.data.action === "create-diagnosis-candidate") {
      const catalog = await new FhirDiagnosisCatalogStore(staff.fhir).list();
      const { action: _action, ...candidateInput } = parsed.data;
      const created = createDiagnosisCandidate(
        definition,
        candidateInput,
        catalog,
        provenance,
        deps.shortId,
      );
      const saved = await store.save(created.definition, provenance);
      return { status: 200, body: { definition: definitionSummary(saved), candidate: created.candidate } };
    }
    if (parsed.data.action === "update-diagnosis-candidate") {
      const catalog = await new FhirDiagnosisCatalogStore(staff.fhir).list();
      const { action: _action, id, ...candidateInput } = parsed.data;
      const updated = updateDiagnosisCandidate(definition, id, candidateInput, catalog, provenance);
      const saved = await store.save(updated.definition, provenance);
      return { status: 200, body: { definition: definitionSummary(saved), candidate: updated.candidate } };
    }
    if (parsed.data.action === "create-custom-field") {
      if (hasPicker(definition) && !pickerAllowsCreate(definition)) {
        return { status: 409, body: { error: "This definition does not currently grant custom-field creation." } };
      }
      const { action: _action, ...fieldInput } = parsed.data;
      const created = createCustomField(definition, fieldInput, provenance);
      const saved = await store.save(created.definition, provenance);
      return { status: 200, body: { definition: definitionSummary(saved), field: created.field } };
    }
    if (parsed.data.action === "update-custom-field") {
      const { action: _action, localCode, ...fieldInput } = parsed.data;
      const updated = updateCustomField(definition, localCode, fieldInput, provenance);
      const saved = await store.save(updated.definition, provenance);
      return { status: 200, body: { definition: definitionSummary(saved), field: updated.field } };
    }
    if (parsed.data.action === "update-definition") {
      if (!isCustomSection(definition)) {
        return { status: 409, body: { error: "Only practice-created sections support section lifecycle updates." } };
      }
      const saved = await store.save({
        ...definition,
        ...(parsed.data.display !== undefined ? { display: parsed.data.display } : {}),
        ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
        provenance,
      }, provenance);
      return { status: 200, body: { definition: definitionSummary(saved) } };
    }
    const saved = await store.save(updatePickerConfiguration(definition, parsed.data, provenance), provenance);
    return { status: 200, body: { definition: definitionSummary(saved) } };
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

function definitionSummary(definition: ClinicalFindingDefinition) {
  return {
    id: definition.id,
    stableKey: definition.stableKey,
    display: definition.display,
    sectionKey: definition.sectionKey,
    active: definition.active,
    sourceStatus: definition.sourceStatus,
    perEye: definition.valueSchema.perEye === true,
    fields: asRecord(definition.valueSchema.fields),
    customFields: customFieldEntries(definition, true),
    allowDiagnosisMapping: definition.allowDiagnosisMapping !== false,
    diagnosisCandidates: definition.diagnosisCandidates ?? [],
  };
}

function mutationProvenance(
  staffReference: string,
  recordedAt: string | undefined,
): ClinicalGraphProvenance {
  return {
    source: "manual",
    recordedAt: recordedAt ?? new Date().toISOString(),
    actorReference: staffReference,
    note: "Practice finding-definition catalog update.",
  };
}

function isCustomSection(definition: ClinicalFindingDefinition): boolean {
  return definition.stableKey.startsWith("custom:") && definition.sectionKey === definition.stableKey;
}

function slug(value: string): string {
  return value.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 84) || "section";
}

function randomShortId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 8);
}

function hasPicker(definition: ClinicalFindingDefinition): boolean {
  return asRecord(asRecord(definition.valueSchema.fields).additionalFields).type === "visible-hidden-field-picker";
}

function readStableKey(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const stableKey = (value as Record<string, unknown>).stableKey;
  return typeof stableKey === "string" && stableKey.trim() ? stableKey.trim() : undefined;
}

function staffMay(role: PracticeRoleId, action: BusinessAction): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
