import { FhirFindingDefinitionStore } from "./finding-definition-store.js";
import { encounterContentSectionKeys } from "./finding-section-content.js";
import type { FhirSearchClient } from "../fhir-search.js";
import { randomUUID } from "node:crypto";
import type { Encounter } from "@medplum/fhirtypes";
import { z } from "zod";
import {
  assertBusinessActionAllowed,
  staffHasBusinessAction,
  type BusinessAction,
  type PracticeRoleId,
} from "../authz/roles.js";
import {
  FhirEncounterSectionOverrideStore,
  FhirFindingSectionGroupStore,
  FindingSectionGroupAlreadyExistsError,
  type FindingSectionGroup,
  type FindingSectionGroupFhirClient,
} from "./finding-section-group-store.js";

export interface FindingSectionGroupEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: FindingSectionGroupFhirClient & FhirSearchClient;
  } | null>;
  serviceFhir?: FindingSectionGroupFhirClient;
  newId?: () => string;
}

const groupFields = {
  label: z.string().trim().min(1).max(120),
  sectionKeyPrefixes: z.array(z.string().trim().min(1).max(120)).min(1).max(64),
  active: z.boolean(),
};

const createGroupSchema = z.object({
  groupKey: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  ...groupFields,
}).strict();

const updateGroupSchema = z.object({
  label: groupFields.label.optional(),
  sectionKeyPrefixes: groupFields.sectionKeyPrefixes.optional(),
  active: groupFields.active.optional(),
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one finding section group field is required.",
);

const overrideMutationSchema = z.object({
  action: z.enum(["add", "remove"]),
  groupKey: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
}).strict();

export async function handleFindingSectionGroupCatalogRequest(
  deps: FindingSectionGroupEndpointDeps,
  input: {
    authHeader: string | undefined;
    query?: { encounterId?: string };
  },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read finding section groups." } };
  }
  const canWrite = staffHasBusinessAction(staff, "finding-definitions.write");
  const canPullIn = staffHasBusinessAction(staff, "chart.write");
  if (!staffHasBusinessAction(staff, "chart.read") && !canWrite) {
    return { status: 403, body: { error: "chart.read or finding-definitions.write role required" } };
  }
  const serviceFhir = deps.serviceFhir ?? staff.fhir;
  const groups = await new FhirFindingSectionGroupStore(serviceFhir).list();
  const encounterId = input.query?.encounterId?.trim();
  if (!encounterId) {
    return { status: 200, body: { canWrite, canPullIn, groups } };
  }
  try {
    const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
    const override = await new FhirEncounterSectionOverrideStore(serviceFhir).get(encounterId);
    const activeGroupKeys = new Set(
      groups.filter((group) => group.active).map((group) => group.groupKey),
    );
    const pulledInGroupKeys = override.groupKeys.filter((groupKey) => activeGroupKeys.has(groupKey));
    const sectionKeys = await encounterContentSectionKeys(staff.fhir, encounter, await new FhirFindingDefinitionStore(serviceFhir).list());
    const contentPinnedGroupKeys = groups.filter(group => group.sectionKeyPrefixes.some(prefix => sectionKeys.some(key => key.startsWith(prefix)))).map(group => group.groupKey);
    const effectiveGroupKeys = [...new Set([...pulledInGroupKeys, ...contentPinnedGroupKeys])];
    return {
      status: 200,
      body: {
        canWrite,
        canPullIn,
        groups,
        overrideGroupKeys: override.groupKeys,
        pulledInGroupKeys,
        effectiveGroupKeys,
        contentPinnedGroupKeys,
      },
    };
  } catch (error) {
    const status = errorStatus(error) === 404 ? 404 : 400;
    return {
      status,
      body: {
        error: status === 404
          ? `Encounter/${encounterId} was not found.`
          : errorMessage(error),
      },
    };
  }
}

export async function handleFindingSectionGroupCreationRequest(
  deps: FindingSectionGroupEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to manage finding section groups." } };
  }
  if (!staffHasBusinessAction(staff, "finding-definitions.write")) {
    return { status: 403, body: { error: "finding-definitions.write role required" } };
  }
  const parsed = createGroupSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid finding section group." } };
  }
  try {
    const group = await new FhirFindingSectionGroupStore(deps.serviceFhir ?? staff.fhir).create({
      id: deps.newId?.() ?? randomUUID(),
      ...parsed.data,
    });
    return { status: 201, body: { group } };
  } catch (error) {
    const duplicate = error instanceof FindingSectionGroupAlreadyExistsError;
    return { status: duplicate ? 409 : 400, body: { error: errorMessage(error) } };
  }
}

export async function handleFindingSectionGroupMutationRequest(
  deps: FindingSectionGroupEndpointDeps,
  input: {
    authHeader: string | undefined;
    params: { groupKey?: string };
    body: unknown;
  },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to manage finding section groups." } };
  }
  if (!staffHasBusinessAction(staff, "finding-definitions.write")) {
    return { status: 403, body: { error: "finding-definitions.write role required" } };
  }
  const groupKey = input.params.groupKey?.trim();
  if (!groupKey) {
    return { status: 400, body: { error: "A valid finding section group key is required." } };
  }
  const parsed = updateGroupSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid finding section group update." } };
  }
  const store = new FhirFindingSectionGroupStore(deps.serviceFhir ?? staff.fhir);
  const existing = (await store.list()).find((group) => group.groupKey === groupKey);
  if (!existing) {
    return { status: 404, body: { error: `Finding section group ${groupKey} does not exist.` } };
  }
  try {
    const group = await store.save({ ...existing, ...parsed.data });
    return { status: 200, body: { group } };
  } catch (error) {
    if (isConcurrentEdit(error)) {
      return {
        status: 409,
        body: {
          error: "This section group changed concurrently — reload and retry.",
          code: "concurrent-edit",
        },
      };
    }
    return { status: 400, body: { error: errorMessage(error) } };
  }
}

export async function handleEncounterSectionOverrideMutationRequest(
  deps: FindingSectionGroupEndpointDeps,
  input: {
    authHeader: string | undefined;
    params: { encounterId?: string };
    body: unknown;
  },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to manage encounter section groups." } };
  }
  if (!staffHasBusinessAction(staff, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const encounterId = input.params.encounterId?.trim();
  if (!encounterId) {
    return { status: 400, body: { error: "A valid encounter id is required." } };
  }
  const parsed = overrideMutationSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid encounter section override." } };
  }
  try {
    const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
    const serviceFhir = deps.serviceFhir ?? staff.fhir;
    const groups = await new FhirFindingSectionGroupStore(serviceFhir).list();
    const group = groups.find((candidate) => candidate.groupKey === parsed.data.groupKey);
    if (parsed.data.action === "add" && (!group || !group.active)) {
      return {
        status: 404,
        body: { error: `Active finding section group ${parsed.data.groupKey} does not exist.` },
      };
    }
    if (parsed.data.action === "remove" && group) {
      const content = await encounterContentSectionKeys(staff.fhir, encounter, await new FhirFindingDefinitionStore(serviceFhir).list());
      const sectionKeys = content.filter(key => group.sectionKeyPrefixes.some(prefix => key.startsWith(prefix)));
      if (sectionKeys.length) return { status: 409, body: { code: "section-group-has-content", sectionKeys } };
    }
    const store = new FhirEncounterSectionOverrideStore(serviceFhir);
    const current = await store.get(encounterId);
    const groupKeys = parsed.data.action === "add"
      ? [...current.groupKeys, parsed.data.groupKey]
      : current.groupKeys.filter((groupKey) => groupKey !== parsed.data.groupKey);
    const override = await store.setGroupKeys(encounterId, groupKeys);
    return { status: 200, body: { override } };
  } catch (error) {
    if (isConcurrentEdit(error)) {
      return {
        status: 409,
        body: {
          error: "Encounter section groups changed concurrently — reload and retry.",
          code: "concurrent-edit",
        },
      };
    }
    const status = errorStatus(error) === 404 ? 404 : 400;
    return { status, body: { error: errorMessage(error) } };
  }
}

function staffMay(role: PracticeRoleId, action: BusinessAction): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}

function isConcurrentEdit(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 409 || status === 412;
}
