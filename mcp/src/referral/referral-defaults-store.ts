import type { Basic } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { searchAll } from "../fhir-search.js";
import {
  buildReferralIncludeListExtension,
  readReferralIncludeListExtension,
  REFERRAL_INCLUDE_LIST_EXTENSION_URL,
  type ReferralIncludeList,
} from "./referral-service.js";

export const REFERRAL_INCLUDE_DEFAULTS_CODE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/basic-kind";
export const REFERRAL_INCLUDE_DEFAULTS_CODE = "referral-include-defaults";
export const REFERRAL_INCLUDE_DEFAULTS_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/referral-include-defaults-provider";
export const REFERRAL_INCLUDE_DEFAULTS_WRITE_HEADERS = {
  "X-ODOS-Source": "mcp/referral-include-defaults",
} as const;

export const SYSTEM_REFERRAL_INCLUDE_DEFAULTS: Readonly<ReferralIncludeList> = {
  letter: true,
  demographics: true,
  history: true,
  clinical_summary: false,
  images: false,
  hipaa_cover_sheet: false,
  history_count: 2,
};

export type ReferralDefaultsFhirClient = Pick<
  MedplumClient,
  "baseUrl" | "search" | "searchUrl" | "create" | "update"
>;

export class ReferralDefaultsStore {
  constructor(private readonly fhir: ReferralDefaultsFhirClient) {}

  async read(providerReference: string): Promise<ReferralIncludeList> {
    return (await this.readResource(providerReference))?.includeList
      ?? { ...SYSTEM_REFERRAL_INCLUDE_DEFAULTS };
  }

  async save(
    providerReference: string,
    includeList: ReferralIncludeList,
  ): Promise<ReferralIncludeList> {
    const existing = await this.readResource(providerReference);
    const resource = buildReferralDefaultsResource(providerReference, includeList, existing?.resource);
    if (existing?.resource.id) {
      const updated = await this.fhir.update(
        "Basic",
        existing.resource.id,
        resource,
        REFERRAL_INCLUDE_DEFAULTS_WRITE_HEADERS,
      );
      return parseReferralDefaultsResource(updated, providerReference);
    }

    const created = await this.fhir.create(resource, {
      ...REFERRAL_INCLUDE_DEFAULTS_WRITE_HEADERS,
      "If-None-Exist": `identifier=${REFERRAL_INCLUDE_DEFAULTS_IDENTIFIER_SYSTEM}|${providerReference}`,
    });
    const createdIncludeList = parseReferralDefaultsResource(created, providerReference);
    if (includeListsEqual(createdIncludeList, includeList)) return createdIncludeList;
    if (!created.id) throw new Error("Conditional referral defaults create returned a resource without an id.");
    const updated = await this.fhir.update(
      "Basic",
      created.id,
      buildReferralDefaultsResource(providerReference, includeList, created),
      REFERRAL_INCLUDE_DEFAULTS_WRITE_HEADERS,
    );
    return parseReferralDefaultsResource(updated, providerReference);
  }

  private async readResource(providerReference: string): Promise<{
    resource: Basic;
    includeList: ReferralIncludeList;
  } | undefined> {
    assertProviderReference(providerReference);
    const resources = await searchAll<Basic>(this.fhir, "Basic", {
      code: `${REFERRAL_INCLUDE_DEFAULTS_CODE_SYSTEM}|${REFERRAL_INCLUDE_DEFAULTS_CODE}`,
      identifier: `${REFERRAL_INCLUDE_DEFAULTS_IDENTIFIER_SYSTEM}|${providerReference}`,
      _count: "2",
    });
    return resources
      .map((resource) => ({
        resource,
        includeList: parseReferralDefaultsResource(resource, providerReference),
      }))
      .sort((left, right) =>
        (right.resource.meta?.lastUpdated ?? "").localeCompare(left.resource.meta?.lastUpdated ?? "")
        || (right.resource.id ?? "").localeCompare(left.resource.id ?? ""))[0];
  }
}

export function buildReferralDefaultsResource(
  providerReference: string,
  includeList: ReferralIncludeList,
  existing?: Basic,
): Basic {
  assertProviderReference(providerReference);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{ system: REFERRAL_INCLUDE_DEFAULTS_IDENTIFIER_SYSTEM, value: providerReference }],
    code: {
      coding: [{
        system: REFERRAL_INCLUDE_DEFAULTS_CODE_SYSTEM,
        code: REFERRAL_INCLUDE_DEFAULTS_CODE,
        display: "Referral include defaults",
      }],
      text: REFERRAL_INCLUDE_DEFAULTS_CODE,
    },
    extension: [buildReferralIncludeListExtension(includeList)],
  };
}

export function parseReferralDefaultsResource(
  resource: Basic,
  providerReference?: string,
): ReferralIncludeList {
  if (!resource.code?.coding?.some((coding) =>
    coding.system === REFERRAL_INCLUDE_DEFAULTS_CODE_SYSTEM
    && coding.code === REFERRAL_INCLUDE_DEFAULTS_CODE)) {
    throw new Error("Basic resource is not referral include defaults.");
  }
  const identifier = resource.identifier?.find(
    (row) => row.system === REFERRAL_INCLUDE_DEFAULTS_IDENTIFIER_SYSTEM,
  )?.value;
  if (!identifier || (providerReference && identifier !== providerReference)) {
    throw new Error("Referral include defaults provider identifier does not match.");
  }
  const includeList = resource.extension?.find(
    (extension) => extension.url === REFERRAL_INCLUDE_LIST_EXTENSION_URL,
  );
  if (!includeList) throw new Error("Referral include defaults are missing the include-list extension.");
  return readReferralIncludeListExtension(includeList);
}

function assertProviderReference(value: string): void {
  if (!/^(Practitioner|PractitionerRole)\/[A-Za-z0-9.-]{1,64}$/.test(value)) {
    throw new Error("A provider reference is required for referral include defaults.");
  }
}

function includeListsEqual(left: ReferralIncludeList, right: ReferralIncludeList): boolean {
  return left.letter === right.letter
    && left.demographics === right.demographics
    && left.history === right.history
    && left.clinical_summary === right.clinical_summary
    && left.images === right.images
    && left.hipaa_cover_sheet === right.hipaa_cover_sheet
    && left.history_count === right.history_count;
}
