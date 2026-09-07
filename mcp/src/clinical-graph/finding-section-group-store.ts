import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";

export const FINDING_SECTION_GROUP_CODE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/odos-finding-section-group";
export const FINDING_SECTION_GROUP_CODE = "odos-finding-section-group";
export const FINDING_SECTION_GROUP_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/finding-section-group-key";
export const FINDING_SECTION_GROUP_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-finding-section-group-json";
export const ENCOUNTER_SECTION_OVERRIDE_CODE =
  "odos-encounter-section-override";
export const ENCOUNTER_SECTION_OVERRIDE_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-encounter-section-override-json";
export const FINDING_SECTION_GROUP_WRITE_HEADERS = {
  "X-ODOS-Source": "finding-section-groups",
} as const;

export class FindingSectionGroupAlreadyExistsError extends Error {
  override readonly name = "FindingSectionGroupAlreadyExistsError";
}

export interface FindingSectionGroup {
  id: string;
  groupKey: string;
  label: string;
  sectionKeyPrefixes: string[];
  defaultForVisitTypeCategories: string[];
  active: boolean;
}

export const DRY_EYE_WORKUP_SECTION_GROUP: FindingSectionGroup = {
  id: "finding-section-group-dry-eye-workup",
  groupKey: "dry-eye-workup",
  label: "Dry Eye Workup",
  sectionKeyPrefixes: ["dry-eye:"],
  defaultForVisitTypeCategories: [],
  active: true,
};

export interface EncounterSectionOverride {
  encounterId: string;
  groupKeys: string[];
}

export interface FindingSectionGroupFhirClient {
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  create<T extends Resource>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export class FhirFindingSectionGroupStore {
  constructor(
    private readonly fhir: FindingSectionGroupFhirClient,
    private readonly seeds: readonly FindingSectionGroup[] = [
      DRY_EYE_WORKUP_SECTION_GROUP,
    ],
  ) {}

  async list(): Promise<FindingSectionGroup[]> {
    const stored = (await this.readStoredRows()).map((row) => row.group);
    const storedByKey = new Map(stored.map((group) => [group.groupKey, group]));
    const seedKeys = new Set(this.seeds.map((group) => group.groupKey));
    return [
      ...this.seeds.map((seed) => storedByKey.get(seed.groupKey) ?? seed),
      ...stored.filter((group) => !seedKeys.has(group.groupKey)),
    ]
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  async create(group: FindingSectionGroup): Promise<FindingSectionGroup> {
    const validated = assertFindingSectionGroup(group);
    if ((await this.list()).some((group) => group.groupKey === validated.groupKey)) {
      throw new FindingSectionGroupAlreadyExistsError(
        `Finding section group ${validated.groupKey} already exists.`,
      );
    }
    const persisted = await this.fhir.create(
      buildFindingSectionGroupResource(validated),
      FINDING_SECTION_GROUP_WRITE_HEADERS,
    );
    return parseFindingSectionGroupResource(persisted);
  }

  async save(group: FindingSectionGroup): Promise<FindingSectionGroup> {
    const validated = assertFindingSectionGroup(group);
    const rows = await this.readStoredRows();
    const existing = rows.find((row) => row.group.groupKey === validated.groupKey)?.resource;
    const resource = buildFindingSectionGroupResource(validated, existing);
    const persisted = existing?.id
      ? await this.fhir.update(
          "Basic",
          existing.id,
          resource,
          guardedWriteHeaders(existing),
        )
      : await this.fhir.create(resource, FINDING_SECTION_GROUP_WRITE_HEADERS);
    return parseFindingSectionGroupResource(persisted);
  }

  private async readStoredRows(): Promise<Array<{
    resource: Basic;
    group: FindingSectionGroup;
  }>> {
    const bundle = await this.fhir.search<Basic>("Basic", {
      code: `${FINDING_SECTION_GROUP_CODE_SYSTEM}|${FINDING_SECTION_GROUP_CODE}`,
      _count: "200",
    });
    const rows = (bundle.entry ?? []).flatMap((entry) => {
      if (!entry.resource) return [];
      try {
        return [{
          resource: entry.resource,
          group: parseFindingSectionGroupResource(entry.resource),
        }];
      } catch (error) {
        console.error(
          `Finding-section-group Basic/${entry.resource.id ?? "unknown"} skipped: ${errorMessage(error)}`,
        );
        return [];
      }
    });
    return resolveDuplicates(rows, (row) => row.group.groupKey, "finding section group");
  }
}

export class FhirEncounterSectionOverrideStore {
  constructor(private readonly fhir: FindingSectionGroupFhirClient) {}

  async get(encounterId: string): Promise<EncounterSectionOverride> {
    requiredId(encounterId, "Encounter id");
    const row = (await this.readStoredRows(encounterId))[0];
    return row?.override ?? { encounterId, groupKeys: [] };
  }

  async setGroupKeys(
    encounterId: string,
    groupKeys: readonly string[],
  ): Promise<EncounterSectionOverride> {
    requiredId(encounterId, "Encounter id");
    const value = assertEncounterSectionOverride({
      encounterId,
      groupKeys: [...new Set(groupKeys)].sort(),
    });
    const existing = (await this.readStoredRows(encounterId))[0]?.resource;
    const resource = buildEncounterSectionOverrideResource(value, existing);
    const persisted = existing?.id
      ? await this.fhir.update(
          "Basic",
          existing.id,
          resource,
          guardedWriteHeaders(existing),
        )
      : await this.fhir.create(resource, FINDING_SECTION_GROUP_WRITE_HEADERS);
    return parseEncounterSectionOverrideResource(persisted);
  }

  private async readStoredRows(encounterId: string): Promise<Array<{
    resource: Basic;
    override: EncounterSectionOverride;
  }>> {
    const bundle = await this.fhir.search<Basic>("Basic", {
      code: `${FINDING_SECTION_GROUP_CODE_SYSTEM}|${ENCOUNTER_SECTION_OVERRIDE_CODE}`,
      subject: `Encounter/${encounterId}`,
      _count: "10",
    });
    const rows = (bundle.entry ?? []).flatMap((entry) => {
      if (!entry.resource) return [];
      try {
        const override = parseEncounterSectionOverrideResource(entry.resource);
        return override.encounterId === encounterId
          ? [{ resource: entry.resource, override }]
          : [];
      } catch (error) {
        console.error(
          `Encounter-section-override Basic/${entry.resource.id ?? "unknown"} skipped: ${errorMessage(error)}`,
        );
        return [];
      }
    });
    return resolveDuplicates(rows, (row) => row.override.encounterId, "encounter section override");
  }
}

export function resolveDefaultSectionGroups(
  groups: readonly FindingSectionGroup[],
  visitTypeCategory: string | undefined,
): FindingSectionGroup[] {
  if (!visitTypeCategory) return [];
  return groups.filter(
    (group) =>
      group.active &&
      group.defaultForVisitTypeCategories.includes(visitTypeCategory),
  );
}

export function buildFindingSectionGroupResource(
  group: FindingSectionGroup,
  existing?: Basic,
): Basic {
  const validated = assertFindingSectionGroup(group);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{
      system: FINDING_SECTION_GROUP_IDENTIFIER_SYSTEM,
      value: validated.groupKey,
    }],
    code: {
      coding: [{
        system: FINDING_SECTION_GROUP_CODE_SYSTEM,
        code: FINDING_SECTION_GROUP_CODE,
        display: "ODOS finding section group",
      }],
      text: validated.label,
    },
    extension: [{
      url: FINDING_SECTION_GROUP_EXTENSION_URL,
      valueString: JSON.stringify(validated),
    }],
  };
}

export function parseFindingSectionGroupResource(resource: Basic): FindingSectionGroup {
  assertBasicCode(resource, FINDING_SECTION_GROUP_CODE);
  const raw = resource.extension?.find(
    (extension) => extension.url === FINDING_SECTION_GROUP_EXTENSION_URL,
  )?.valueString;
  if (!raw) throw new Error("Finding-section-group Basic is missing its JSON extension.");
  const group = assertFindingSectionGroup(parseJson(raw, "Finding-section-group"));
  const identifier = resource.identifier?.find(
    (candidate) => candidate.system === FINDING_SECTION_GROUP_IDENTIFIER_SYSTEM,
  )?.value;
  if (identifier !== group.groupKey) {
    throw new Error("Finding-section-group identifier does not match its groupKey.");
  }
  return group;
}

export function buildEncounterSectionOverrideResource(
  override: EncounterSectionOverride,
  existing?: Basic,
): Basic {
  const validated = assertEncounterSectionOverride(override);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    subject: { reference: `Encounter/${validated.encounterId}` },
    code: {
      coding: [{
        system: FINDING_SECTION_GROUP_CODE_SYSTEM,
        code: ENCOUNTER_SECTION_OVERRIDE_CODE,
        display: "ODOS encounter section override",
      }],
      text: "Encounter section groups",
    },
    extension: [{
      url: ENCOUNTER_SECTION_OVERRIDE_EXTENSION_URL,
      valueString: JSON.stringify({ groupKeys: validated.groupKeys }),
    }],
  };
}

export function parseEncounterSectionOverrideResource(
  resource: Basic,
): EncounterSectionOverride {
  assertBasicCode(resource, ENCOUNTER_SECTION_OVERRIDE_CODE);
  const encounterId = resource.subject?.reference?.match(/^Encounter\/([^/]+)$/)?.[1];
  if (!encounterId) {
    throw new Error("Encounter-section-override Basic must reference an Encounter subject.");
  }
  const raw = resource.extension?.find(
    (extension) => extension.url === ENCOUNTER_SECTION_OVERRIDE_EXTENSION_URL,
  )?.valueString;
  if (!raw) throw new Error("Encounter-section-override Basic is missing its JSON extension.");
  const parsed = parseJson(raw, "Encounter-section-override");
  if (!isRecord(parsed)) throw new Error("Encounter section override must be an object.");
  return assertEncounterSectionOverride({
    encounterId,
    groupKeys: parsed.groupKeys,
  });
}

function assertFindingSectionGroup(value: unknown): FindingSectionGroup {
  if (!isRecord(value)) throw new Error("Finding section group must be an object.");
  requiredId(value.id, "Finding section group id");
  kebabCase(value.groupKey, "Finding section group groupKey");
  requiredId(value.label, "Finding section group label");
  const sectionKeyPrefixes = stringList(value.sectionKeyPrefixes, "sectionKeyPrefixes");
  if (sectionKeyPrefixes.length === 0) {
    throw new Error("Finding section group requires at least one sectionKey prefix.");
  }
  for (const prefix of sectionKeyPrefixes) {
    if (/\s/.test(prefix)) {
      throw new Error(`Finding section group prefix "${prefix}" cannot contain whitespace.`);
    }
  }
  const defaultForVisitTypeCategories = stringList(
    value.defaultForVisitTypeCategories,
    "defaultForVisitTypeCategories",
  );
  for (const category of defaultForVisitTypeCategories) {
    kebabCase(category, "Visit-type category id");
  }
  if (typeof value.active !== "boolean") {
    throw new Error("Finding section group active must be boolean.");
  }
  return {
    id: value.id,
    groupKey: value.groupKey,
    label: value.label.trim(),
    sectionKeyPrefixes,
    defaultForVisitTypeCategories,
    active: value.active,
  };
}

function assertEncounterSectionOverride(value: unknown): EncounterSectionOverride {
  if (!isRecord(value)) throw new Error("Encounter section override must be an object.");
  requiredId(value.encounterId, "Encounter id");
  const groupKeys = stringList(value.groupKeys, "groupKeys");
  for (const groupKey of groupKeys) {
    kebabCase(groupKey, "Finding section group groupKey");
  }
  return { encounterId: value.encounterId, groupKeys };
}

function assertBasicCode(resource: Basic, code: string): void {
  const matches = resource.code?.coding?.some(
    (coding) =>
      coding.system === FINDING_SECTION_GROUP_CODE_SYSTEM &&
      coding.code === code,
  );
  if (!matches) throw new Error(`Basic resource is not ${code}.`);
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Finding section group ${field} must be a list.`);
  const values = value.map((item) => {
    requiredId(item, `Finding section group ${field} entry`);
    return item.trim();
  });
  if (new Set(values).size !== values.length) {
    throw new Error(`Finding section group ${field} entries must be unique.`);
  }
  return values;
}

function kebabCase(value: unknown, field: string): asserts value is string {
  requiredId(value, field);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`${field} "${value}" must be immutable kebab-case.`);
  }
}

function requiredId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} JSON is malformed and cannot be parsed.`);
  }
}

function resolveDuplicates<T extends { resource: Basic }>(
  rows: T[],
  key: (row: T) => string,
  label: string,
): T[] {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const group = grouped.get(key(row)) ?? [];
    group.push(row);
    grouped.set(key(row), group);
  }
  return [...grouped.values()].map((group) => {
    const winner = group.reduce((current, candidate) =>
      compareResources(candidate.resource, current.resource) > 0 ? candidate : current
    );
    for (const loser of group) {
      if (loser !== winner) {
        console.error(
          `Duplicate ${label} ${key(winner)}: Basic/${loser.resource.id ?? "unknown"} skipped.`,
        );
      }
    }
    return winner;
  });
}

function compareResources(left: Basic, right: Basic): number {
  const lastUpdated = (left.meta?.lastUpdated ?? "").localeCompare(right.meta?.lastUpdated ?? "");
  return lastUpdated || (left.id ?? "").localeCompare(right.id ?? "");
}

function guardedWriteHeaders(resource: Basic): Record<string, string> {
  if (!resource.meta?.versionId) {
    throw new Error(`Cannot update Basic/${resource.id ?? "unknown"} without a FHIR version.`);
  }
  return {
    ...FINDING_SECTION_GROUP_WRITE_HEADERS,
    "If-Match": `W/"${resource.meta.versionId}"`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
