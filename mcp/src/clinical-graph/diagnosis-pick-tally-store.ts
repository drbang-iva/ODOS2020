import type { Basic, Bundle } from "@medplum/fhirtypes";

export const DX_PICK_TALLY_CODE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/odos-dx-pick-tally";
export const DX_PICK_TALLY_CODE = "odos-dx-pick-tally";
export const DX_PICK_TALLY_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/dx-pick-tally-practitioner";
export const DX_PICK_TALLY_EXTENSION_URL = "https://odos2020.com/fhir/StructureDefinition/odos-dx-pick-tally-json";
export const DX_PICK_TALLY_WRITE_HEADERS = { "X-ODOS-Source": "diagnosis-pick-tally" } as const;

export interface DiagnosisPickTallyRow {
  counts: Record<string, Record<string, number>>;
  pinnedDiagnosisKeys: string[];
  updatedAt: string;
}

export interface DiagnosisPickTallyFhirClient {
  search<T extends Basic>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
  create<T extends Basic>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends Basic>(resourceType: T["resourceType"], id: string, resource: T, extraHeaders?: Record<string, string>): Promise<T>;
}

export class FhirDiagnosisPickTallyStore {
  constructor(private readonly fhir: DiagnosisPickTallyFhirClient) {}

  async read(practitionerReference: string): Promise<DiagnosisPickTallyRow | undefined> {
    return (await this.readResource(practitionerReference))?.row;
  }

  async increment(
    practitionerReference: string,
    findingDefinitionStableKey: string,
    diagnosisStableKey: string,
    updatedAt: string,
  ): Promise<DiagnosisPickTallyRow> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.readResource(practitionerReference);
      const current = existing?.row ?? { counts: {}, pinnedDiagnosisKeys: [], updatedAt };
      const findingCounts = current.counts[findingDefinitionStableKey] ?? {};
      const next: DiagnosisPickTallyRow = {
        counts: {
          ...current.counts,
          [findingDefinitionStableKey]: {
            ...findingCounts,
            [diagnosisStableKey]: (findingCounts[diagnosisStableKey] ?? 0) + 1,
          },
        },
        pinnedDiagnosisKeys: current.pinnedDiagnosisKeys,
        updatedAt,
      };
      try {
        if (!existing?.resource.id) {
          const created = await this.fhir.create(
            buildDiagnosisPickTallyResource(practitionerReference, next),
            {
              ...DX_PICK_TALLY_WRITE_HEADERS,
              "If-None-Exist": `identifier=${DX_PICK_TALLY_IDENTIFIER_SYSTEM}|${practitionerReference}`,
            },
          );
          return parseDiagnosisPickTallyResource(created, practitionerReference);
        }
        const versionId = existing.resource.meta?.versionId;
        const updated = await this.fhir.update(
          "Basic",
          existing.resource.id,
          buildDiagnosisPickTallyResource(practitionerReference, next, existing.resource),
          {
            ...DX_PICK_TALLY_WRITE_HEADERS,
            ...(versionId ? { "If-Match": `W/\"${versionId}\"` } : {}),
          },
        );
        return parseDiagnosisPickTallyResource(updated, practitionerReference);
      } catch (error) {
        if (attempt === 0 && isConflict(error)) continue;
        throw error;
      }
    }
    throw new Error("Diagnosis pick tally update retry was exhausted.");
  }

  async replacePinned(
    practitionerReference: string,
    pinnedDiagnosisKeys: readonly string[],
    updatedAt: string,
  ): Promise<DiagnosisPickTallyRow> {
    assertPinnedDiagnosisKeys(pinnedDiagnosisKeys);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.readResource(practitionerReference);
      const next: DiagnosisPickTallyRow = {
        counts: existing?.row.counts ?? {},
        pinnedDiagnosisKeys: [...pinnedDiagnosisKeys],
        updatedAt,
      };
      try {
        if (!existing?.resource.id) {
          const created = await this.fhir.create(
            buildDiagnosisPickTallyResource(practitionerReference, next),
            {
              ...DX_PICK_TALLY_WRITE_HEADERS,
              "If-None-Exist": `identifier=${DX_PICK_TALLY_IDENTIFIER_SYSTEM}|${practitionerReference}`,
            },
          );
          const persisted = parseDiagnosisPickTallyResource(created, practitionerReference);
          if (samePins(persisted.pinnedDiagnosisKeys, next.pinnedDiagnosisKeys)) return persisted;
          if (attempt === 0) continue;
          throw new Error("Diagnosis quick-list pins changed concurrently.");
        }
        const versionId = existing.resource.meta?.versionId;
        const updated = await this.fhir.update(
          "Basic",
          existing.resource.id,
          buildDiagnosisPickTallyResource(practitionerReference, next, existing.resource),
          {
            ...DX_PICK_TALLY_WRITE_HEADERS,
            ...(versionId ? { "If-Match": `W/\"${versionId}\"` } : {}),
          },
        );
        return parseDiagnosisPickTallyResource(updated, practitionerReference);
      } catch (error) {
        if (attempt === 0 && isConflict(error)) continue;
        throw error;
      }
    }
    throw new Error("Diagnosis quick-list update retry was exhausted.");
  }

  private async readResource(practitionerReference: string): Promise<{ resource: Basic; row: DiagnosisPickTallyRow } | undefined> {
    const bundle = await this.fhir.search<Basic>("Basic", {
      code: `${DX_PICK_TALLY_CODE_SYSTEM}|${DX_PICK_TALLY_CODE}`,
      identifier: `${DX_PICK_TALLY_IDENTIFIER_SYSTEM}|${practitionerReference}`,
      _count: "2",
    });
    const rows = (bundle.entry ?? []).flatMap((entry) => {
      if (!entry.resource) return [];
      try {
        return [{ resource: entry.resource, row: parseDiagnosisPickTallyResource(entry.resource, practitionerReference) }];
      } catch (error) {
        console.error(`Diagnosis pick tally Basic/${entry.resource.id ?? "unknown"} skipped: ${errorMessage(error)}`);
        return [];
      }
    });
    return rows.sort((left, right) =>
      (right.resource.meta?.lastUpdated ?? "").localeCompare(left.resource.meta?.lastUpdated ?? "") ||
      (right.resource.id ?? "").localeCompare(left.resource.id ?? "")
    )[0];
  }
}

export function buildDiagnosisPickTallyResource(
  practitionerReference: string,
  row: DiagnosisPickTallyRow,
  existing?: Basic,
): Basic {
  assertPractitionerReference(practitionerReference);
  assertDiagnosisPickTallyRow(row);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{ system: DX_PICK_TALLY_IDENTIFIER_SYSTEM, value: practitionerReference }],
    code: {
      coding: [{ system: DX_PICK_TALLY_CODE_SYSTEM, code: DX_PICK_TALLY_CODE, display: "ODOS diagnosis pick tally" }],
      text: "Diagnosis pick tally",
    },
    extension: [{ url: DX_PICK_TALLY_EXTENSION_URL, valueString: JSON.stringify(row) }],
  };
}

export function parseDiagnosisPickTallyResource(resource: Basic, practitionerReference?: string): DiagnosisPickTallyRow {
  if (!resource.code?.coding?.some((coding) => coding.system === DX_PICK_TALLY_CODE_SYSTEM && coding.code === DX_PICK_TALLY_CODE)) {
    throw new Error("Basic resource is not an ODOS diagnosis pick tally.");
  }
  const identifier = resource.identifier?.find((row) => row.system === DX_PICK_TALLY_IDENTIFIER_SYSTEM)?.value;
  if (!identifier || (practitionerReference && identifier !== practitionerReference)) {
    throw new Error("Diagnosis pick tally practitioner identifier does not match.");
  }
  const raw = resource.extension?.find((extension) => extension.url === DX_PICK_TALLY_EXTENSION_URL)?.valueString;
  if (!raw) throw new Error("Diagnosis pick tally is missing its JSON extension.");
  const parsed = JSON.parse(raw) as unknown;
  const compatible = isRecord(parsed) && parsed.pinnedDiagnosisKeys === undefined
    ? { ...parsed, pinnedDiagnosisKeys: [] }
    : parsed;
  assertDiagnosisPickTallyRow(compatible);
  return compatible;
}

function assertDiagnosisPickTallyRow(value: unknown): asserts value is DiagnosisPickTallyRow {
  if (!isRecord(value) || !isRecord(value.counts) || typeof value.updatedAt !== "string") {
    throw new Error("Diagnosis pick tally JSON is invalid.");
  }
  for (const findingCounts of Object.values(value.counts)) {
    if (!isRecord(findingCounts) || Object.values(findingCounts).some((count) => !Number.isInteger(count) || Number(count) < 0)) {
      throw new Error("Diagnosis pick tally counts are invalid.");
    }
  }
  assertPinnedDiagnosisKeys(value.pinnedDiagnosisKeys);
}

function assertPinnedDiagnosisKeys(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((key) => typeof key !== "string" || !key.trim())) {
    throw new Error("Diagnosis quick-list pins must be non-empty diagnosis keys.");
  }
  if (new Set(value).size !== value.length) {
    throw new Error("Diagnosis quick-list pins must be unique.");
  }
}

function assertPractitionerReference(value: string): void {
  if (!/^Practitioner\/[A-Za-z0-9.-]+$/.test(value)) throw new Error("A Practitioner reference is required for a diagnosis pick tally.");
}

function samePins(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function isConflict(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return status === 409 || status === 412 || /FHIR (409|412)\b/.test(errorMessage(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
