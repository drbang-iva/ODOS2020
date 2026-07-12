import type { Basic, Bundle } from "@medplum/fhirtypes";

export const WENO_MAPPING_CODE_SYSTEM =
  "https://osod.dev/fhir/CodeSystem/weno-mapping-kind";
export const WENO_PRESCRIBER_MAPPING_CODE = "osod-weno-prescriber-mapping";
export const WENO_LOCATION_MAPPING_CODE = "osod-weno-location-mapping";
export const WENO_MAPPING_IDENTIFIER_SYSTEM =
  "https://osod.dev/fhir/NamingSystem/weno-mapping-stable-key";
export const WENO_MAPPING_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-weno-mapping-json";
export const WENO_MAPPING_WRITE_HEADERS = {
  "X-OSOD-Source": "weno-mapping-catalog",
} as const;

export type WenoMappingKind = "prescriber" | "location";

interface WenoMappingRowBase {
  stableKey: string;
  localReference: string;
  wenoEntityId: string;
  syncStatus: string;
}

export interface WenoPrescriberMappingRow extends WenoMappingRowBase {
  kind: "prescriber";
  wenoUserEmail: string;
  wenoPasswordRef: string;
}

export interface WenoLocationMappingRow extends WenoMappingRowBase {
  kind: "location";
}

export type WenoMappingRow = WenoPrescriberMappingRow | WenoLocationMappingRow;

export interface WenoMappingFhirClient {
  search<T extends Basic>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Basic>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
  create<T extends Basic>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends Basic>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export const WENO_MAPPING_SEEDS: readonly WenoMappingRow[] = [];

export class FhirWenoMappingCatalog {
  constructor(
    private readonly fhir: WenoMappingFhirClient,
    private readonly seeds: readonly WenoMappingRow[] = WENO_MAPPING_SEEDS,
  ) {}

  async list(kind?: WenoMappingKind): Promise<WenoMappingRow[]> {
    const stored = await this.readStoredRows(kind);
    const storedKeys = new Set(stored.map((row) => `${row.mapping.kind}:${row.mapping.stableKey}`));
    return [
      ...this.seeds.filter((row) =>
        (!kind || row.kind === kind) && !storedKeys.has(`${row.kind}:${row.stableKey}`)
      ),
      ...stored.map((row) => row.mapping),
    ];
  }

  async hasPrescriberMapping(practitionerReference: string): Promise<boolean> {
    return (await this.list("prescriber")).some(
      (row) => row.localReference === practitionerReference,
    );
  }

  async save(mapping: WenoMappingRow): Promise<WenoMappingRow> {
    const validated = assertWenoMappingRow(mapping);
    const stored = await this.readStoredRows(validated.kind);
    const existing = stored.find((row) => row.mapping.stableKey === validated.stableKey)?.resource;
    const resource = buildWenoMappingResource(validated, existing);
    const persisted = existing?.id
      ? await this.fhir.update("Basic", existing.id, resource, WENO_MAPPING_WRITE_HEADERS)
      : await this.fhir.create(resource, {
        ...WENO_MAPPING_WRITE_HEADERS,
        "If-None-Exist":
          `identifier=${WENO_MAPPING_IDENTIFIER_SYSTEM}|${validated.stableKey}`,
      });
    return parseWenoMappingResource(persisted);
  }

  private async readStoredRows(
    kind?: WenoMappingKind,
  ): Promise<Array<{ resource: Basic; mapping: WenoMappingRow }>> {
    const codes = kind ? [codeForKind(kind)] : [
      WENO_PRESCRIBER_MAPPING_CODE,
      WENO_LOCATION_MAPPING_CODE,
    ];
    const rows = await Promise.all(codes.map(async (code) => {
      const resources = await this.searchAllBasic({
        code: `${WENO_MAPPING_CODE_SYSTEM}|${code}`,
        _count: "200",
      });
      return resources.flatMap((resource) => {
        try {
          return [{ resource, mapping: parseWenoMappingResource(resource) }];
        } catch (error) {
          console.error(
            `WENO mapping Basic/${resource.id ?? "unknown"} skipped: ${errorMessage(error)}`,
          );
          return [];
        }
      });
    }));
    return rows.flat().sort((left, right) =>
      left.mapping.stableKey.localeCompare(right.mapping.stableKey)
    );
  }

  private async searchAllBasic(params: Record<string, string>): Promise<Basic[]> {
    let bundle = await this.fhir.search<Basic>("Basic", params);
    const resources: Basic[] = [];
    const followedLinks = new Set<string>();
    for (;;) {
      resources.push(...(bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []));
      const nextLink = bundle.link?.find((link) => link.relation === "next");
      if (!nextLink) return resources;
      if (!nextLink.url) {
        throw new Error("FHIR Basic search returned a next link without a URL.");
      }
      if (!this.fhir.searchUrl) {
        throw new Error("FHIR Basic search returned more rows, but the client cannot fetch them.");
      }
      if (followedLinks.has(nextLink.url)) {
        throw new Error("FHIR Basic search returned a repeated next link.");
      }
      followedLinks.add(nextLink.url);
      bundle = await this.fhir.searchUrl<Basic>(nextLink.url, "Basic");
    }
  }
}

export function buildWenoMappingResource(mapping: WenoMappingRow, existing?: Basic): Basic {
  const validated = assertWenoMappingRow(mapping);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{ system: WENO_MAPPING_IDENTIFIER_SYSTEM, value: validated.stableKey }],
    code: {
      coding: [{
        system: WENO_MAPPING_CODE_SYSTEM,
        code: codeForKind(validated.kind),
        display: validated.kind === "prescriber"
          ? "OSOD WENO prescriber mapping"
          : "OSOD WENO location mapping",
      }],
    },
    extension: [{
      url: WENO_MAPPING_EXTENSION_URL,
      valueString: JSON.stringify(validated),
    }],
  };
}

export function parseWenoMappingResource(resource: Basic): WenoMappingRow {
  const code = resource.code?.coding?.find((coding) =>
    coding.system === WENO_MAPPING_CODE_SYSTEM &&
    (coding.code === WENO_PRESCRIBER_MAPPING_CODE || coding.code === WENO_LOCATION_MAPPING_CODE)
  )?.code;
  if (!code) throw new Error("Basic resource is not an OSOD WENO mapping.");
  const raw = resource.extension?.find((extension) =>
    extension.url === WENO_MAPPING_EXTENSION_URL
  )?.valueString;
  if (!raw) throw new Error("WENO mapping Basic is missing its JSON extension.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("WENO mapping JSON is malformed and cannot be parsed.");
  }
  const mapping = assertWenoMappingRow(parsed);
  if (codeForKind(mapping.kind) !== code) {
    throw new Error("WENO mapping kind does not match its Basic code.");
  }
  const identifier = resource.identifier?.find((row) =>
    row.system === WENO_MAPPING_IDENTIFIER_SYSTEM
  )?.value;
  if (identifier !== mapping.stableKey) {
    throw new Error("WENO mapping identifier does not match its stableKey.");
  }
  return mapping;
}

function assertWenoMappingRow(value: unknown): WenoMappingRow {
  if (!isRecord(value)) throw new Error("WENO mapping must be an object.");
  for (const field of ["stableKey", "localReference", "wenoEntityId", "syncStatus"] as const) {
    if (!nonEmptyString(value[field])) {
      throw new Error(`WENO mapping ${field} must be a non-empty string.`);
    }
  }
  if (value.kind !== "prescriber" && value.kind !== "location") {
    throw new Error("WENO mapping kind must be prescriber or location.");
  }
  if (value.kind === "prescriber") {
    for (const field of ["wenoUserEmail", "wenoPasswordRef"] as const) {
      if (!nonEmptyString(value[field])) {
        throw new Error(`WENO prescriber mapping ${field} must be a non-empty string.`);
      }
    }
  }
  const expectedReference = value.kind === "prescriber" ? /^Practitioner\/[^/]+$/ : /^Location\/[^/]+$/;
  const localReference = value.localReference;
  if (typeof localReference !== "string" || !expectedReference.test(localReference)) {
    throw new Error(`WENO ${value.kind} mapping has an invalid local reference.`);
  }
  return value as unknown as WenoMappingRow;
}

function codeForKind(kind: WenoMappingKind): string {
  return kind === "prescriber" ? WENO_PRESCRIBER_MAPPING_CODE : WENO_LOCATION_MAPPING_CODE;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
