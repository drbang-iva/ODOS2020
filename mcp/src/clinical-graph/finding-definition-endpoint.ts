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
} from "./custom-fields.js";
import {
  FhirFindingDefinitionStore,
  type FindingDefinitionFhirClient,
} from "./finding-definition-store.js";
import type {
  ClinicalFindingDefinition,
  ClinicalGraphProvenance,
} from "./glaucoma-suspect.js";

export interface FindingDefinitionEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: FindingDefinitionFhirClient;
  } | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
}

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
]);

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
  const store = new FhirFindingDefinitionStore(staff.fhir);
  const definition = (await store.list())
    .find((candidate) => candidate.stableKey === stableKey);
  if (!definition) return { status: 404, body: { error: `Finding definition ${stableKey} does not exist.` } };
  const provenance: ClinicalGraphProvenance = {
    source: "manual",
    recordedAt: deps.now?.() ?? new Date().toISOString(),
    actorReference: staff.staffReference,
    note: "Practice finding-definition catalog update.",
  };
  try {
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
    fields: asRecord(definition.valueSchema.fields),
    customFields: customFieldEntries(definition, true),
  };
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
