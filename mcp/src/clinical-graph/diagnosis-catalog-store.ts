import type { Basic, Bundle } from "@medplum/fhirtypes";
import type { ClinicalGraphProvenance, DiagnosisCatalogRow } from "./glaucoma-suspect.js";
import { buildDiagnosisCatalogSeeds } from "./diagnosis-catalog-seeds.js";
export { buildDiagnosisCatalogSeeds } from "./diagnosis-catalog-seeds.js";

export const DIAGNOSIS_DEFINITION_CODE_SYSTEM =
  "https://osod.dev/fhir/CodeSystem/osod-diagnosis-definition";
export const DIAGNOSIS_DEFINITION_CODE = "osod-diagnosis-definition";
export const DIAGNOSIS_DEFINITION_IDENTIFIER_SYSTEM =
  "https://osod.dev/fhir/NamingSystem/diagnosis-definition-stable-key";
export const DIAGNOSIS_DEFINITION_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-diagnosis-definition-json";
export const DIAGNOSIS_CATALOG_WRITE_HEADERS = {
  "X-OSOD-Source": "diagnosis-catalog",
} as const;

export interface DiagnosisCatalogFhirClient {
  search<T extends Basic>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  create<T extends Basic>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends Basic>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export class FhirDiagnosisCatalogStore {
  constructor(
    private readonly fhir: DiagnosisCatalogFhirClient,
    private readonly seeds: readonly DiagnosisCatalogRow[] = buildDiagnosisCatalogSeeds(),
  ) {
    assertUniqueStableKeys(seeds);
  }

  async list(): Promise<DiagnosisCatalogRow[]> {
    const stored = await this.readStoredRows();
    const storedByKey = new Map(stored.map((row) => [row.definition.stableKey, row.definition]));
    const seedKeys = new Set(this.seeds.map((row) => row.stableKey));
    return [
      ...this.seeds.map((seed) => storedByKey.get(seed.stableKey) ?? seed),
      ...stored.map((row) => row.definition)
        .filter((row) => !seedKeys.has(row.stableKey))
        .sort((left, right) => left.stableKey.localeCompare(right.stableKey)),
    ];
  }

  async save(definition: DiagnosisCatalogRow): Promise<DiagnosisCatalogRow> {
    const stored = await this.readStoredRows();
    let existing = stored.find((row) => row.definition.stableKey === definition.stableKey)?.resource;
    const validated = assertDiagnosisCatalogRow(definition);
    if (!existing?.id) {
      const refreshed = await this.readStoredRows();
      existing = refreshed.find((row) => row.definition.stableKey === definition.stableKey)?.resource;
    }
    const resource = buildDiagnosisCatalogResource(validated, existing);
    const persisted = existing?.id
      ? await this.fhir.update("Basic", existing.id, resource, DIAGNOSIS_CATALOG_WRITE_HEADERS)
      : await this.fhir.create(resource, DIAGNOSIS_CATALOG_WRITE_HEADERS);
    return parseDiagnosisCatalogResource(persisted);
  }

  async deactivate(stableKey: string, provenance: ClinicalGraphProvenance): Promise<DiagnosisCatalogRow> {
    const definition = (await this.list()).find((row) => row.stableKey === stableKey);
    if (!definition) throw new Error(`Diagnosis definition ${stableKey} does not exist.`);
    return this.save({ ...definition, active: false, provenance });
  }

  private async readStoredRows(): Promise<Array<{ resource: Basic; definition: DiagnosisCatalogRow }>> {
    const bundle = await this.fhir.search<Basic>("Basic", {
      code: `${DIAGNOSIS_DEFINITION_CODE_SYSTEM}|${DIAGNOSIS_DEFINITION_CODE}`,
      _count: "200",
    });
    const rows = (bundle.entry ?? []).flatMap((entry) => {
      if (!entry.resource) return [];
      try {
        return [{ resource: entry.resource, definition: parseDiagnosisCatalogResource(entry.resource) }];
      } catch (error) {
        console.error(`Diagnosis-definition Basic/${entry.resource.id ?? "unknown"} skipped: ${errorMessage(error)}`);
        return [];
      }
    });
    return resolveStoredDuplicates(rows);
  }
}

export function buildDiagnosisCatalogResource(definition: DiagnosisCatalogRow, existing?: Basic): Basic {
  const validated = assertDiagnosisCatalogRow(definition);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{ system: DIAGNOSIS_DEFINITION_IDENTIFIER_SYSTEM, value: validated.stableKey }],
    code: {
      coding: [{
        system: DIAGNOSIS_DEFINITION_CODE_SYSTEM,
        code: DIAGNOSIS_DEFINITION_CODE,
        display: "OSOD diagnosis definition",
      }],
      text: validated.display,
    },
    extension: [{ url: DIAGNOSIS_DEFINITION_EXTENSION_URL, valueString: JSON.stringify(validated) }],
  };
}

export function parseDiagnosisCatalogResource(resource: Basic): DiagnosisCatalogRow {
  if (!resource.code?.coding?.some((coding) =>
    coding.system === DIAGNOSIS_DEFINITION_CODE_SYSTEM && coding.code === DIAGNOSIS_DEFINITION_CODE
  )) {
    throw new Error("Basic resource is not an OSOD diagnosis definition.");
  }
  const raw = resource.extension?.find((extension) => extension.url === DIAGNOSIS_DEFINITION_EXTENSION_URL)?.valueString;
  if (!raw) throw new Error("Diagnosis-definition Basic is missing its JSON extension.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Diagnosis-definition JSON is malformed and cannot be parsed.");
  }
  const definition = assertDiagnosisCatalogRow(parsed);
  const identifier = resource.identifier?.find((row) => row.system === DIAGNOSIS_DEFINITION_IDENTIFIER_SYSTEM)?.value;
  if (identifier !== definition.stableKey) {
    throw new Error("Diagnosis-definition identifier does not match its stableKey.");
  }
  return definition;
}

function assertDiagnosisCatalogRow(value: unknown): DiagnosisCatalogRow {
  if (!isRecord(value)) throw new Error("Diagnosis definition must be an object.");
  for (const field of ["id", "stableKey", "display", "clinicalFamily"] as const) requiredString(value[field], field);
  if (!["verified", "placeholder", "provisional"].includes(String(value.codingStatus))) {
    throw new Error("Diagnosis definition codingStatus is invalid.");
  }
  if (!['seed', 'practice'].includes(String(value.origin))) throw new Error("Diagnosis definition origin is invalid.");
  if (value.origin === "practice" && value.codingStatus !== "provisional") {
    throw new Error("Practice-created diagnosis definitions must remain provisional.");
  }
  if (typeof value.lateralityRequired !== "boolean" || typeof value.active !== "boolean") {
    throw new Error("Diagnosis definition lateralityRequired and active must be boolean.");
  }
  if (!Array.isArray(value.applicableFindingDefinitionIds)) throw new Error("Diagnosis definition applicableFindingDefinitionIds must be an array.");
  if (value.separatesSeverityStagePayerRisk !== true) throw new Error("Diagnosis definition must separate severity, stage, and payer risk.");
  if (!isRecord(value.provenance)) throw new Error("Diagnosis definition provenance must be an object.");
  if (value.icd10 !== undefined) assertIcd10(value.icd10);
  if (value.snomed !== undefined && (!isRecord(value.snomed) || !stringValue(value.snomed.code) || !stringValue(value.snomed.display))) {
    throw new Error("Diagnosis definition SNOMED coding is invalid.");
  }
  if (value.keyFindings !== undefined) {
    if (!Array.isArray(value.keyFindings)) throw new Error("Diagnosis definition keyFindings must be an array.");
    const findingKeys = new Set<string>();
    for (const entry of value.keyFindings) {
      if (!isRecord(entry) || !stringValue(entry.findingKey)) throw new Error("Diagnosis key finding must name a findingKey.");
      if (findingKeys.has(entry.findingKey)) throw new Error("Diagnosis key findings must use unique findingKeys.");
      findingKeys.add(entry.findingKey);
      if (entry.label !== undefined && !stringValue(entry.label)) throw new Error("Diagnosis key finding label must be a non-empty string.");
      if (!['this-encounter', 'any-on-file'].includes(String(entry.satisfiedBy))) throw new Error("Diagnosis key finding satisfiedBy is invalid.");
      if (entry.withinMonths !== undefined && (!Number.isInteger(entry.withinMonths) || Number(entry.withinMonths) <= 0)) {
        throw new Error("Diagnosis key finding withinMonths must be a positive integer.");
      }
      if (entry.satisfiedBy !== "any-on-file" && entry.withinMonths !== undefined) throw new Error("withinMonths is only valid for any-on-file key findings.");
      if (!['seed', 'practice'].includes(String(entry.origin)) || typeof entry.active !== "boolean") {
        throw new Error("Diagnosis key finding origin and active state are invalid.");
      }
    }
  }
  return value as unknown as DiagnosisCatalogRow;
}

function assertIcd10(value: unknown): void {
  if (!isRecord(value)) throw new Error("Diagnosis definition icd10 must be an object.");
  if ("code" in value) {
    requiredString(value.code, "icd10.code");
    return;
  }
  if (!isRecord(value.pattern) || !Object.values(value.pattern).some(stringValue)) {
    throw new Error("Diagnosis definition icd10 pattern must contain at least one code.");
  }
}

function resolveStoredDuplicates(rows: Array<{ resource: Basic; definition: DiagnosisCatalogRow }>) {
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) grouped.set(row.definition.stableKey, [...(grouped.get(row.definition.stableKey) ?? []), row]);
  return [...grouped.values()].map((group) => {
    const winner = group.reduce((current, candidate) =>
      compareStoredRows(candidate, current) > 0 ? candidate : current
    );
    for (const loser of group) {
      if (loser !== winner) console.error(`Duplicate diagnosis-definition stableKey ${winner.definition.stableKey}: Basic/${loser.resource.id ?? "unknown"} skipped in favor of Basic/${winner.resource.id ?? "unknown"}.`);
    }
    return winner;
  });
}

function compareStoredRows(left: { resource: Basic }, right: { resource: Basic }): number {
  return (left.resource.meta?.lastUpdated ?? "").localeCompare(right.resource.meta?.lastUpdated ?? "") ||
    (left.resource.id ?? "").localeCompare(right.resource.id ?? "");
}

function assertUniqueStableKeys(rows: readonly DiagnosisCatalogRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.stableKey)) throw new Error(`Duplicate diagnosis catalog stableKey ${row.stableKey}.`);
    seen.add(row.stableKey);
  }
}

function requiredString(value: unknown, field: string): asserts value is string {
  if (!stringValue(value)) throw new Error(`Diagnosis definition ${field} must be a non-empty string.`);
}

function stringValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
