import { randomUUID } from "node:crypto";
import type { Basic, Encounter } from "@medplum/fhirtypes";
import { z } from "zod";
import {
  assertBusinessActionAllowed,
  type BusinessAction,
  type PracticeRoleId,
} from "../authz/roles.js";
import { resolveVisitTypeCategoryForEncounter } from "../clinic/clinic-summary.js";
import {
  DEFAULT_VISIT_TYPE_CATEGORIES,
  ODOS_VISIT_TYPE_CONFIG_CODE,
  ODOS_VISIT_TYPE_CONFIG_SYSTEM,
  parseVisitTypeConfig,
  type VisitTypeCategoryConfig,
} from "../scheduling/visit-type-config.js";
import {
  FhirEncounterSectionOverrideStore,
  FhirFindingSectionGroupStore,
  resolveDefaultSectionGroups,
  type FindingSectionGroup,
  type FindingSectionGroupFhirClient,
} from "./finding-section-group-store.js";

export interface FindingSectionGroupEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: FindingSectionGroupFhirClient;
  } | null>;
  serviceFhir?: FindingSectionGroupFhirClient;
  newId?: () => string;
}

const groupFields = {
  label: z.string().trim().min(1).max(120),
  sectionKeyPrefixes: z.array(z.string().trim().min(1).max(120)).min(1).max(64),
  defaultForVisitTypeCategories: z.array(
    z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  ).max(64),
  active: z.boolean(),
};

const createGroupSchema = z.object({
  groupKey: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  ...groupFields,
}).strict();

const updateGroupSchema = z.object({
  label: groupFields.label.optional(),
  sectionKeyPrefixes: groupFields.sectionKeyPrefixes.optional(),
  defaultForVisitTypeCategories: groupFields.defaultForVisitTypeCategories.optional(),
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
  const canWrite = staffMay(staff.actorRole, "finding-definitions.write");
  const canPullIn = staffMay(staff.actorRole, "chart.write");
  if (!staffMay(staff.actorRole, "chart.read") && !canWrite) {
    return { status: 403, body: { error: "chart.read or finding-definitions.write role required" } };
  }
  const serviceFhir = deps.serviceFhir ?? staff.fhir;
  const groups = await new FhirFindingSectionGroupStore(serviceFhir).list();
  const visitTypeCategories = await loadVisitTypeCategories(serviceFhir);
  const encounterId = input.query?.encounterId?.trim();
  if (!encounterId) {
    return { status: 200, body: { canWrite, canPullIn, groups, visitTypeCategories } };
  }
  try {
    const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
    const visitTypeCategory = await resolveVisitTypeCategoryForEncounter(
      encounter,
      undefined,
      serviceFhir,
    );
    const defaultGroupKeys = resolveDefaultSectionGroups(groups, visitTypeCategory)
      .map((group) => group.groupKey);
    const override = await new FhirEncounterSectionOverrideStore(serviceFhir).get(encounterId);
    const activeGroupKeys = new Set(
      groups.filter((group) => group.active).map((group) => group.groupKey),
    );
    const pulledInGroupKeys = override.groupKeys.filter((groupKey) => activeGroupKeys.has(groupKey));
    const effectiveGroupKeys = [...new Set([...defaultGroupKeys, ...pulledInGroupKeys])];
    return {
      status: 200,
      body: {
        canWrite,
        canPullIn,
        groups,
        visitTypeCategories,
        visitTypeCategory,
        defaultGroupKeys,
        pulledInGroupKeys,
        effectiveGroupKeys,
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
  if (!staffMay(staff.actorRole, "finding-definitions.write")) {
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
    const duplicate = /already exists/.test(errorMessage(error));
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
  if (!staffMay(staff.actorRole, "finding-definitions.write")) {
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
  if (!staffMay(staff.actorRole, "chart.write")) {
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
    await staff.fhir.read<Encounter>("Encounter", encounterId);
    const serviceFhir = deps.serviceFhir ?? staff.fhir;
    const groups = await new FhirFindingSectionGroupStore(serviceFhir).list();
    const group = groups.find((candidate) => candidate.groupKey === parsed.data.groupKey);
    if (!group || !group.active) {
      return {
        status: 404,
        body: { error: `Active finding section group ${parsed.data.groupKey} does not exist.` },
      };
    }
    const store = new FhirEncounterSectionOverrideStore(serviceFhir);
    const current = await store.get(encounterId);
    const groupKeys = parsed.data.action === "add"
      ? [...current.groupKeys, parsed.data.groupKey]
      : current.groupKeys.filter((groupKey) => groupKey !== parsed.data.groupKey);
    const override = await store.setGroupKeys(encounterId, groupKeys);
    return { status: 200, body: { override } };
  } catch (error) {
    const status = errorStatus(error) === 404 ? 404 : 400;
    return { status, body: { error: errorMessage(error) } };
  }
}

async function loadVisitTypeCategories(
  fhir: FindingSectionGroupFhirClient,
): Promise<VisitTypeCategoryConfig[]> {
  const bundle = await fhir.search<Basic>("Basic", {
    code: `${ODOS_VISIT_TYPE_CONFIG_SYSTEM}|${ODOS_VISIT_TYPE_CONFIG_CODE}`,
    _count: "10",
  });
  const resources = (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .filter((resource): resource is Basic => resource?.resourceType === "Basic")
    .sort((left, right) =>
      (right.meta?.lastUpdated ?? "").localeCompare(left.meta?.lastUpdated ?? "")
    );
  if (resources[0]) {
    try {
      return parseVisitTypeConfig(resources[0]).categories;
    } catch (error) {
      console.error(`Visit-type config unavailable to section groups: ${errorMessage(error)}`);
    }
  }
  return DEFAULT_VISIT_TYPE_CATEGORIES;
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
