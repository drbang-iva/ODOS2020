import type { Basic, Extension } from "@medplum/fhirtypes";
import {
  resourceCatalogAdapter,
  type CatalogAdapter,
} from "./catalog-adapter";
import type { fhir } from "./fhir";

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

export type PlanProfileItem = {
  id: string;
  planKey: string;
  displayName: string;
  dispensingFeeCents?: number;
  frameAllowanceCents?: number;
  lensBaseReimbursementCents?: number;
  contactLensPerBoxCents?: number;
  active: boolean;
  resource?: Basic;
};

type PlanProfileClient = Pick<
  typeof fhir,
  "search" | "searchUrl" | "create" | "update"
>;

const RESOURCE_CAPABILITIES = {
  reorder: false,
  deactivate: true,
  presetSeed: false,
} as const;

export function planProfileAdapter(
  client: PlanProfileClient,
): CatalogAdapter<PlanProfileItem> {
  const base = resourceCatalogAdapter<PlanProfileItem, Basic>({
    resourceType: "Basic",
    searchParams: {
      code: `${PLAN_PROFILE_CODE_SYSTEM}|${PLAN_PROFILE_CODE}`,
    },
    client,
    sourceTag: "plan-profile-catalog",
    capabilities: RESOURCE_CAPABILITIES,
    toItem: planProfileItem,
    buildResource: buildPlanProfileResource,
    deactivateResource: (item) => buildPlanProfileResource({
      ...item,
      active: false,
    }),
  });
  return {
    ...base,
    async list() {
      return resolveStoredDuplicates(await base.list());
    },
    async save(item) {
      let row = item;
      if (!item.resource?.id) {
        const existing = (await base.list()).find(
          (candidate) =>
            candidate.planKey.toLocaleLowerCase()
            === item.planKey.trim().toLocaleLowerCase(),
        );
        if (existing?.resource?.id) {
          row = { ...item, resource: existing.resource };
        }
      }
      const saved = await base.save(row);
      return { ...saved, id: item.id };
    },
    async deactivate(item) {
      const saved = await base.deactivate(item);
      return { ...saved, id: item.id };
    },
  };
}

export function buildPlanProfileResource(item: PlanProfileItem): Basic {
  const validated = assertPlanProfile(item);
  const storedPlanKey = item.resource?.identifier?.find(
    (identifier) => identifier.system === PLAN_PROFILE_IDENTIFIER_SYSTEM,
  )?.value;
  if (storedPlanKey !== undefined && storedPlanKey !== validated.planKey) {
    throw new Error("Plan key cannot change after the profile is created.");
  }
  return {
    resourceType: "Basic",
    ...(item.resource?.id ? { id: item.resource.id } : {}),
    ...(item.resource?.meta ? { meta: item.resource.meta } : {}),
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

export function planProfileItem(resource: Basic): PlanProfileItem {
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
    resource,
    ...Object.fromEntries(
      MONEY_FIELDS.flatMap((field) => {
        const cents = moneyChildCents(profileExtension, MONEY_EXTENSION_NAMES[field]);
        return cents === undefined ? [] : [[field, cents]];
      }),
    ),
  } as PlanProfileItem);
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

function assertPlanProfile(item: PlanProfileItem): PlanProfileItem {
  if (!item.id.trim()) throw new Error("Plan profile id is required.");
  if (!item.planKey.trim()) throw new Error("Plan key is required.");
  if (!item.displayName.trim()) throw new Error("Display name is required.");
  if (typeof item.active !== "boolean") {
    throw new Error("Plan profile active state is required.");
  }
  for (const field of MONEY_FIELDS) {
    if (item[field] !== undefined) assertCents(item[field], field);
  }
  return {
    ...item,
    planKey: item.planKey.trim(),
    displayName: item.displayName.trim(),
  };
}

function assertCents(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative whole number of cents.`);
  }
}

function resolveStoredDuplicates(rows: PlanProfileItem[]): PlanProfileItem[] {
  const grouped = new Map<string, PlanProfileItem[]>();
  for (const row of rows) {
    const key = row.planKey.toLocaleLowerCase();
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return [...grouped.values()].map((group) =>
    group.reduce((winner, candidate) =>
      compareStored(candidate, winner) > 0 ? candidate : winner
    ),
  );
}

function compareStored(left: PlanProfileItem, right: PlanProfileItem): number {
  return (left.resource?.meta?.lastUpdated ?? "").localeCompare(
    right.resource?.meta?.lastUpdated ?? "",
  ) || (left.resource?.id ?? "").localeCompare(right.resource?.id ?? "");
}
