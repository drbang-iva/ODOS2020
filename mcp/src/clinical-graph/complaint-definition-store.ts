import type { Basic, Bundle } from "@medplum/fhirtypes";
import {
  buildComplaintDefinitionSeeds,
  type ComplaintDefinition,
  type ComplaintOption,
} from "./complaint-model.js";
import type { ClinicalGraphProvenance } from "./glaucoma-suspect.js";

const BASE = "https://odos2020.com/fhir";
export const COMPLAINT_DEFINITION_CODE = "osod-complaint-definition";
export const COMPLAINT_DEFINITION_CODE_SYSTEM = `${BASE}/CodeSystem/osod-complaint-definition`;
export const COMPLAINT_DEFINITION_IDENTIFIER_SYSTEM = `${BASE}/NamingSystem/complaint-definition-stable-key`;
export const COMPLAINT_DEFINITION_EXTENSION_URL = `${BASE}/StructureDefinition/osod-complaint-definition-json`;
export const COMPLAINT_DEFINITION_WRITE_HEADERS = { "X-ODOS-Source": "complaint-definitions" } as const;

export interface ComplaintDefinitionFhirClient {
  search<T extends Basic>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
  create<T extends Basic>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends Basic>(resourceType: T["resourceType"], id: string, resource: T, extraHeaders?: Record<string, string>): Promise<T>;
}

export class FhirComplaintDefinitionStore {
  constructor(
    private readonly fhir: ComplaintDefinitionFhirClient,
    private readonly seeds: readonly ComplaintDefinition[] = buildComplaintDefinitionSeeds(),
  ) {
    assertUniqueKeys(seeds);
  }

  async list(): Promise<ComplaintDefinition[]> {
    const stored = await this.readStoredRows();
    const storedByKey = new Map(stored.map((row) => [row.definition.stableKey, row.definition]));
    const seedKeys = new Set(this.seeds.map((seed) => seed.stableKey));
    return [
      ...this.seeds.map((seed) => storedByKey.get(seed.stableKey) ?? seed),
      ...stored.map((row) => row.definition)
        .filter((definition) => !seedKeys.has(definition.stableKey))
        .sort((left, right) => left.stableKey.localeCompare(right.stableKey)),
    ];
  }

  async save(definition: ComplaintDefinition, provenance: ClinicalGraphProvenance): Promise<ComplaintDefinition> {
    const stored = await this.readStoredRows();
    let existing = stored.find((row) => row.definition.stableKey === definition.stableKey)?.resource;
    const local = assertComplaintDefinition({ ...definition, sourceStatus: "local-practice", provenance });
    if (!existing?.id) {
      const refreshed = await this.readStoredRows();
      existing = refreshed.find((row) => row.definition.stableKey === definition.stableKey)?.resource;
    }
    const resource = buildComplaintDefinitionResource(local, existing);
    const persisted = existing?.id
      ? await this.fhir.update("Basic", existing.id, resource, COMPLAINT_DEFINITION_WRITE_HEADERS)
      : await this.fhir.create(resource, {
          ...COMPLAINT_DEFINITION_WRITE_HEADERS,
          "If-None-Exist": `identifier=${COMPLAINT_DEFINITION_IDENTIFIER_SYSTEM}|${local.stableKey}`,
        });
    return parseComplaintDefinitionResource(persisted);
  }

  async addOption(input: {
    stableKey: string;
    list: "conditionOptions" | "qualityOptions" | "treatmentOptions";
    option: ComplaintOption;
    provenance: ClinicalGraphProvenance;
  }): Promise<ComplaintDefinition> {
    const definition = (await this.list()).find((candidate) => candidate.stableKey === input.stableKey);
    if (!definition) throw new Error(`Complaint definition ${input.stableKey} does not exist.`);
    const current = definition[input.list];
    if (current.some((option) => option.code === input.option.code)) {
      throw new Error(`Complaint option ${input.option.code} already exists.`);
    }
    return this.save({ ...definition, [input.list]: [...current, input.option] }, input.provenance);
  }

  private async readStoredRows(): Promise<Array<{ resource: Basic; definition: ComplaintDefinition }>> {
    const bundle = await this.fhir.search<Basic>("Basic", {
      code: `${COMPLAINT_DEFINITION_CODE_SYSTEM}|${COMPLAINT_DEFINITION_CODE}`,
      _count: "200",
    });
    const rows = (bundle.entry ?? []).flatMap((entry) => {
      if (!entry.resource) return [];
      try {
        return [{ resource: entry.resource, definition: parseComplaintDefinitionResource(entry.resource) }];
      } catch (error) {
        console.error(`Complaint-definition Basic/${entry.resource.id ?? "unknown"} skipped: ${errorMessage(error)}`);
        return [];
      }
    });
    return resolveStoredDuplicates(rows);
  }
}

export function buildComplaintDefinitionResource(definition: ComplaintDefinition, existing?: Basic): Basic {
  const validated = assertComplaintDefinition(definition);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{ system: COMPLAINT_DEFINITION_IDENTIFIER_SYSTEM, value: validated.stableKey }],
    code: { coding: [{
      system: COMPLAINT_DEFINITION_CODE_SYSTEM,
      code: COMPLAINT_DEFINITION_CODE,
      display: "ODOS complaint definition",
    }], text: validated.display },
    extension: [{ url: COMPLAINT_DEFINITION_EXTENSION_URL, valueString: JSON.stringify(validated) }],
  };
}

export function parseComplaintDefinitionResource(resource: Basic): ComplaintDefinition {
  if (!resource.code?.coding?.some((coding) =>
    coding.system === COMPLAINT_DEFINITION_CODE_SYSTEM && coding.code === COMPLAINT_DEFINITION_CODE
  )) throw new Error("Basic resource is not an ODOS complaint definition.");
  const raw = resource.extension?.find((extension) => extension.url === COMPLAINT_DEFINITION_EXTENSION_URL)?.valueString;
  if (!raw) throw new Error("Complaint-definition Basic is missing its JSON extension.");
  const parsed = assertComplaintDefinition(JSON.parse(raw));
  const identifier = resource.identifier?.find((row) => row.system === COMPLAINT_DEFINITION_IDENTIFIER_SYSTEM)?.value;
  if (identifier !== parsed.stableKey) throw new Error("Complaint-definition identifier does not match stableKey.");
  if (parsed.sourceStatus !== "local-practice") throw new Error("Stored complaint definitions must be local-practice rows.");
  return parsed;
}

export function assertComplaintDefinition(value: unknown): ComplaintDefinition {
  if (!isRecord(value)) throw new Error("Complaint definition must be an object.");
  for (const field of ["id", "stableKey", "display"] as const) requiredString(value[field], field);
  if (!/^[a-z][a-z0-9-]{0,99}$/.test(String(value.stableKey))) throw new Error("Complaint definition stableKey is invalid.");
  if (!['patient-symptom', 'evaluation-reason'].includes(String(value.kind))) throw new Error("Complaint definition kind is invalid.");
  for (const field of ["conditionOptions", "qualityOptions", "treatmentOptions"] as const) assertOptions(value[field], field);
  if (value.narrativeTemplate !== undefined && (typeof value.narrativeTemplate !== "string" || !value.narrativeTemplate.trim())) {
    throw new Error("Complaint definition narrativeTemplate must be a non-empty string.");
  }
  if (!Number.isInteger(value.seedRank) || Number(value.seedRank) < 1) throw new Error("Complaint definition seedRank must be a positive integer.");
  if (!['seed', 'local-practice'].includes(String(value.sourceStatus))) throw new Error("Complaint definition sourceStatus is invalid.");
  if (!['active', 'retired'].includes(String(value.status))) throw new Error("Complaint definition status is invalid.");
  if (!isRecord(value.provenance)) throw new Error("Complaint definition provenance is required.");
  return value as unknown as ComplaintDefinition;
}

function assertOptions(value: unknown, field: string): void {
  if (!Array.isArray(value)) throw new Error(`Complaint definition ${field} must be an array.`);
  const codes = new Set<string>();
  for (const option of value) {
    if (!isRecord(option)) throw new Error(`Complaint definition ${field} option is invalid.`);
    requiredString(option.code, `${field}.code`);
    requiredString(option.display, `${field}.display`);
    if (!/^[a-z][a-z0-9-]{0,99}$/.test(String(option.code)) || typeof option.active !== "boolean") {
      throw new Error(`Complaint definition ${field} option is invalid.`);
    }
    if (codes.has(String(option.code))) throw new Error(`Complaint definition ${field} has duplicate option ${option.code}.`);
    codes.add(String(option.code));
  }
}

function resolveStoredDuplicates(rows: Array<{ resource: Basic; definition: ComplaintDefinition }>) {
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) grouped.set(row.definition.stableKey, [...(grouped.get(row.definition.stableKey) ?? []), row]);
  return [...grouped.values()].map((group) => group.reduce((winner, candidate) =>
    compareRows(candidate, winner) > 0 ? candidate : winner
  ));
}

function compareRows(left: { resource: Basic }, right: { resource: Basic }): number {
  return (left.resource.meta?.lastUpdated ?? "").localeCompare(right.resource.meta?.lastUpdated ?? "") ||
    (left.resource.id ?? "").localeCompare(right.resource.id ?? "");
}

function assertUniqueKeys(rows: readonly ComplaintDefinition[]): void {
  const keys = new Set<string>();
  for (const row of rows) {
    if (keys.has(row.stableKey)) throw new Error(`Duplicate complaint-definition stableKey ${row.stableKey}.`);
    keys.add(row.stableKey);
  }
}

function requiredString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Complaint definition ${field} must be a non-empty string.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
