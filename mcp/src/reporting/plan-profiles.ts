import type { Basic, Bundle, Extension, Resource } from "@medplum/fhirtypes";
import { resolveBusinessActionRole, type PracticeRoleId } from "../authz/roles.js";
import { searchAll } from "../fhir-search.js";
import type { ReportingResult } from "./reporting.js";

export const PLAN_PROFILE_CODE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/plan-profile";
export const PLAN_PROFILE_CODE = "plan-profile";
export const PLAN_PROFILE_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/plan-profile-key";
export const PLAN_PROFILE_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-plan-profile";

const MONEY_FIELDS = [
  "dispensingFeeCents",
  "frameAllowanceCents",
  "lensBaseReimbursementCents",
  "contactLensPerBoxCents",
] as const;

type MoneyField = (typeof MONEY_FIELDS)[number];

const MONEY_EXTENSION_NAMES: Record<MoneyField, string> = {
  dispensingFeeCents: "dispensing-fee",
  frameAllowanceCents: "frame-allowance",
  lensBaseReimbursementCents: "lens-base-reimbursement",
  contactLensPerBoxCents: "contact-lens-per-box",
};

export interface PlanProfile {
  id: string;
  planKey: string;
  displayName: string;
  dispensingFeeCents?: number;
  frameAllowanceCents?: number;
  lensBaseReimbursementCents?: number;
  contactLensPerBoxCents?: number;
  active: boolean;
}

export interface PlanProfileFhirClient {
  readonly baseUrl: string;
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(
    url: string,
    resourceType: T["resourceType"],
  ): Promise<Bundle<T>>;
}

export interface PlanProfileEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    roles?: readonly PracticeRoleId[];
    fhir: PlanProfileFhirClient;
  } | null>;
}

export async function handlePlanProfilesRequest(
  deps: PlanProfileEndpointDeps,
  input: { authHeader: string | undefined },
): Promise<ReportingResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return {
      status: 401,
      body: { error: "Authentication required to view plan profiles." },
    };
  }
  if (!resolveBusinessActionRole(staff.roles ?? [], "margin.read")) {
    return { status: 403, body: { error: "margin.read role required" } };
  }
  try {
    return {
      status: 200,
      body: { items: await loadPlanProfiles(staff.fhir, { activeOnly: true }) },
    };
  } catch {
    return {
      status: 409,
      body: {
        status: "unavailable",
        reason: "Plan profiles are unavailable because one or more stored rows could not be read safely.",
      },
    };
  }
}

export async function loadPlanProfiles(
  client: PlanProfileFhirClient,
  options: { activeOnly?: boolean } = {},
): Promise<PlanProfile[]> {
  const resources = await searchAll<Basic>(
    client,
    "Basic",
    { code: `${PLAN_PROFILE_CODE_SYSTEM}|${PLAN_PROFILE_CODE}` },
    { maxRows: Number.POSITIVE_INFINITY },
  );
  const rows = resolveStoredDuplicates(resources.map((resource) => ({
    resource,
    profile: parsePlanProfileResource(resource),
  }))).map((row) => row.profile);
  return (options.activeOnly ? rows.filter((row) => row.active) : rows)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function buildPlanProfileResource(
  profile: PlanProfile,
  existing?: Basic,
): Basic {
  const validated = assertPlanProfile(profile);
  const storedPlanKey = existing?.identifier?.find(
    (identifier) => identifier.system === PLAN_PROFILE_IDENTIFIER_SYSTEM,
  )?.value;
  if (storedPlanKey !== undefined && storedPlanKey !== validated.planKey) {
    throw new Error("Plan profile planKey cannot change after creation.");
  }
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{
      system: PLAN_PROFILE_IDENTIFIER_SYSTEM,
      value: validated.planKey,
    }],
    code: {
      coding: [{
        system: PLAN_PROFILE_CODE_SYSTEM,
        code: PLAN_PROFILE_CODE,
        display: "ODOS plan reimbursement profile",
      }],
      text: validated.displayName,
    },
    extension: [{
      url: PLAN_PROFILE_EXTENSION_URL,
      extension: [
        { url: "active", valueBoolean: validated.active },
        ...MONEY_FIELDS.flatMap((field) => moneyChild(field, validated[field])),
      ],
    }],
  };
}

export function parsePlanProfileResource(resource: Basic): PlanProfile {
  if (!resource.code?.coding?.some(
    (coding) =>
      coding.system === PLAN_PROFILE_CODE_SYSTEM
      && coding.code === PLAN_PROFILE_CODE,
  )) {
    throw new Error("Basic resource is not an ODOS plan profile.");
  }
  const planKey = resource.identifier?.find(
    (identifier) => identifier.system === PLAN_PROFILE_IDENTIFIER_SYSTEM,
  )?.value;
  if (!planKey?.trim()) {
    throw new Error("Plan profile is missing its stable plan key.");
  }
  const displayName = resource.code.text?.trim();
  if (!displayName) {
    throw new Error("Plan profile is missing its display name.");
  }
  const profileExtension = resource.extension?.find(
    (extension) => extension.url === PLAN_PROFILE_EXTENSION_URL,
  );
  const active = childExtension(profileExtension, "active")?.valueBoolean;
  if (typeof active !== "boolean") {
    throw new Error("Plan profile is missing its active state.");
  }
  return assertPlanProfile({
    id: resource.id ?? planKey,
    planKey,
    displayName,
    active,
    ...Object.fromEntries(
      MONEY_FIELDS.flatMap((field) => {
        const cents = moneyChildCents(profileExtension, MONEY_EXTENSION_NAMES[field]);
        return cents === undefined ? [] : [[field, cents]];
      }),
    ),
  } as PlanProfile);
}

function moneyChild(field: MoneyField, cents: number | undefined): Extension[] {
  if (cents === undefined) return [];
  assertCents(cents, field);
  return [{
    url: MONEY_EXTENSION_NAMES[field],
    valueMoney: { value: cents / 100, currency: "USD" },
  }];
}

function moneyChildCents(
  extension: Extension | undefined,
  childUrl: string,
): number | undefined {
  const money = childExtension(extension, childUrl)?.valueMoney;
  if (money === undefined) return undefined;
  if (money.currency !== "USD" || typeof money.value !== "number") {
    throw new Error(`Plan profile ${childUrl} must be USD Money.`);
  }
  const cents = Math.round(money.value * 100);
  if (Math.abs(cents / 100 - money.value) > Number.EPSILON * 100) {
    throw new Error(`Plan profile ${childUrl} must resolve to whole cents.`);
  }
  assertCents(cents, childUrl);
  return cents;
}

function childExtension(
  extension: Extension | undefined,
  childUrl: string,
): Extension | undefined {
  return extension?.extension?.find((child) => child.url === childUrl);
}

function assertPlanProfile(profile: PlanProfile): PlanProfile {
  if (!profile.id.trim()) throw new Error("Plan profile id is required.");
  if (!profile.planKey.trim()) throw new Error("Plan profile planKey is required.");
  if (!profile.displayName.trim()) {
    throw new Error("Plan profile displayName is required.");
  }
  if (typeof profile.active !== "boolean") {
    throw new Error("Plan profile active state is required.");
  }
  for (const field of MONEY_FIELDS) {
    if (profile[field] !== undefined) assertCents(profile[field], field);
  }
  return {
    ...profile,
    planKey: profile.planKey.trim(),
    displayName: profile.displayName.trim(),
  };
}

function assertCents(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative whole number of cents.`);
  }
}

function resolveStoredDuplicates(
  rows: Array<{ resource: Basic; profile: PlanProfile }>,
): Array<{ resource: Basic; profile: PlanProfile }> {
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.profile.planKey.toLocaleLowerCase();
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return [...grouped.values()].map((group) =>
    group.reduce((winner, candidate) =>
      compareStored(candidate.resource, winner.resource) > 0 ? candidate : winner
    ),
  );
}

function compareStored(left: Basic, right: Basic): number {
  return (left.meta?.lastUpdated ?? "").localeCompare(
    right.meta?.lastUpdated ?? "",
  ) || (left.id ?? "").localeCompare(right.id ?? "");
}
