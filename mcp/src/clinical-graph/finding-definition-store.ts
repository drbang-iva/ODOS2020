import type { Basic, Bundle } from "@medplum/fhirtypes";
import {
  buildGlaucomaFindingDefinitionStubs,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
} from "./glaucoma-suspect.js";
import { buildGonioscopyFindingDefinitions } from "./gonioscopy.js";
import { buildRefractionFindingDefinitionStub } from "./refraction-suspect.js";
import {
  buildSoftContactLensFindingDefinitionStub,
  buildSpecialtyContactLensFindingDefinitionStub,
} from "./contact-lens-definition.js";
import { buildPretestFindingDefinitionStubs } from "./pretest-endpoint.js";
import {
  buildAnteriorOcularHealthDefinitions,
  buildPosteriorOcularHealthDefinitions,
} from "./ocular-health-definition.js";
import { buildHpiFindingDefinition } from "./hpi-definition.js";
import { buildEntranceFindingDefinitions, PACHYMETRY_KEY } from "./entrance-definition.js";
import { buildMyopiaFindingDefinitions } from "./myopia-finding-definition.js";
import { buildDryEyeFindingDefinitions } from "./dry-eye-finding-definition.js";

export const FINDING_DEFINITION_CODE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/odos-finding-definition";
export const FINDING_DEFINITION_CODE = "odos-finding-definition";
export const FINDING_DEFINITION_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/finding-definition-stable-key";
export const FINDING_DEFINITION_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-finding-definition-json";
export const FINDING_DEFINITION_WRITE_HEADERS = {
  "X-ODOS-Source": "finding-definitions",
} as const;

export interface FindingDefinitionFhirClient {
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

export class FhirFindingDefinitionStore {
  constructor(
    private readonly fhir: FindingDefinitionFhirClient,
    private readonly seeds: readonly ClinicalFindingDefinition[] = buildFindingDefinitionSeeds(),
  ) {
    assertUniqueStableKeys(seeds, "compiled finding-definition seeds");
  }

  async list(): Promise<ClinicalFindingDefinition[]> {
    const stored = await this.readStoredRows();
    const storedByStableKey = new Map(stored.map((row) => [row.definition.stableKey, row.definition]));
    const merged = this.seeds.map((seed) => storedByStableKey.get(seed.stableKey) ?? seed);
    const seedKeys = new Set(this.seeds.map((seed) => seed.stableKey));
    const localOnly = stored
      .map((row) => row.definition)
      .filter((definition) => !seedKeys.has(definition.stableKey))
      .sort((left, right) => left.stableKey.localeCompare(right.stableKey));
    return [...merged, ...localOnly];
  }

  async save(
    definition: ClinicalFindingDefinition,
    provenance: ClinicalGraphProvenance = definition.provenance,
  ): Promise<ClinicalFindingDefinition> {
    const stored = await this.readStoredRows();
    let existing = stored.find((row) => row.definition.stableKey === definition.stableKey)?.resource;
    const localDefinition = assertClinicalFindingDefinition({
      ...definition,
      sourceStatus: "local-practice",
      provenance,
    });
    if (!existing?.id) {
      const refreshed = await this.readStoredRows();
      existing = refreshed.find((row) => row.definition.stableKey === definition.stableKey)?.resource;
    }
    // A competing row can still appear after the second search and before create; conditional
    // create can close that residual race when the FHIR client exposes response status semantics.
    const resource = buildFindingDefinitionResource(localDefinition, existing);
    const persisted = existing?.id
      ? await this.fhir.update("Basic", existing.id, resource, FINDING_DEFINITION_WRITE_HEADERS)
      : await this.fhir.create(resource, FINDING_DEFINITION_WRITE_HEADERS);
    return parseFindingDefinitionResource(persisted);
  }

  async deactivate(
    stableKey: string,
    provenance: ClinicalGraphProvenance,
  ): Promise<ClinicalFindingDefinition> {
    const definition = (await this.list()).find((candidate) => candidate.stableKey === stableKey);
    if (!definition) {
      throw new Error(`Finding definition ${stableKey} does not exist.`);
    }
    return this.save({ ...definition, active: false }, provenance);
  }

  private async readStoredRows(): Promise<Array<{
    resource: Basic;
    definition: ClinicalFindingDefinition;
  }>> {
    const bundle = await this.fhir.search<Basic>("Basic", {
      code: `${FINDING_DEFINITION_CODE_SYSTEM}|${FINDING_DEFINITION_CODE}`,
      _count: "200",
    });
    const rows = (bundle.entry ?? []).flatMap((entry) => {
      const resource = entry.resource;
      if (!resource) return [];
      try {
        return [{ resource, definition: parseFindingDefinitionResource(resource) }];
      } catch (error) {
        console.error(`${basicReference(resource)} skipped: ${errorMessage(error)}`);
        return [];
      }
    });
    return resolveStoredDuplicates(rows);
  }
}

export function buildFindingDefinitionSeeds(): ClinicalFindingDefinition[] {
  const provenance: ClinicalGraphProvenance = {
    source: "manual",
    recordedAt: new Date(0).toISOString(),
    actorReference: "Practitioner/odos-system",
  };
  return [
    buildHpiFindingDefinition(provenance),
    ...buildGlaucomaFindingDefinitionStubs({ provenance }).filter((definition) => definition.stableKey !== PACHYMETRY_KEY),
    ...buildGonioscopyFindingDefinitions(provenance),
    buildRefractionFindingDefinitionStub(provenance),
    buildSoftContactLensFindingDefinitionStub(provenance),
    buildSpecialtyContactLensFindingDefinitionStub(provenance),
    ...buildPretestFindingDefinitionStubs(provenance),
    ...buildEntranceFindingDefinitions(provenance),
    ...buildMyopiaFindingDefinitions(provenance),
    ...buildDryEyeFindingDefinitions(provenance),
    ...buildAnteriorOcularHealthDefinitions(provenance),
    ...buildPosteriorOcularHealthDefinitions(provenance),
  ];
}

export function buildFindingDefinitionResource(
  definition: ClinicalFindingDefinition,
  existing?: Basic,
): Basic {
  const validated = assertClinicalFindingDefinition(definition);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{ system: FINDING_DEFINITION_IDENTIFIER_SYSTEM, value: validated.stableKey }],
    code: {
      coding: [{
        system: FINDING_DEFINITION_CODE_SYSTEM,
        code: FINDING_DEFINITION_CODE,
        display: "ODOS finding definition",
      }],
      text: validated.display,
    },
    extension: [{
      url: FINDING_DEFINITION_EXTENSION_URL,
      valueString: JSON.stringify(validated),
    }],
  };
}

export function parseFindingDefinitionResource(resource: Basic): ClinicalFindingDefinition {
  const coding = resource.code?.coding?.find((candidate) =>
    candidate.system === FINDING_DEFINITION_CODE_SYSTEM &&
    candidate.code === FINDING_DEFINITION_CODE,
  );
  if (!coding) {
    throw new Error("Basic resource is not an ODOS finding definition.");
  }
  const raw = resource.extension?.find((extension) =>
    extension.url === FINDING_DEFINITION_EXTENSION_URL
  )?.valueString;
  if (!raw) {
    throw new Error("Finding-definition Basic is missing its JSON extension.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Finding-definition JSON is malformed and cannot be parsed.");
  }
  const definition = assertClinicalFindingDefinition(parsed);
  const identifier = resource.identifier?.find((candidate) =>
    candidate.system === FINDING_DEFINITION_IDENTIFIER_SYSTEM
  )?.value;
  if (identifier !== definition.stableKey) {
    throw new Error("Finding-definition identifier does not match its stableKey.");
  }
  if (definition.sourceStatus !== "local-practice") {
    throw new Error("Persisted finding definitions must have sourceStatus local-practice.");
  }
  return definition;
}

function assertClinicalFindingDefinition(value: unknown): ClinicalFindingDefinition {
  if (!isRecord(value)) throw new Error("Finding definition must be an object.");
  requiredString(value.id, "id");
  requiredString(value.stableKey, "stableKey");
  requiredString(value.display, "display");
  if (value.sectionKey !== undefined) requiredString(value.sectionKey, "sectionKey");
  if (
    value.anatomyTarget !== undefined &&
    !["eye", "optic-nerve", "cornea", "retina", "other"].includes(String(value.anatomyTarget))
  ) {
    throw new Error("Finding definition anatomyTarget is invalid.");
  }
  if (!isRecord(value.valueSchema)) throw new Error("Finding definition valueSchema must be an object.");
  if (value.normalSemantics !== undefined && !isRecord(value.normalSemantics)) {
    throw new Error("Finding definition normalSemantics must be an object.");
  }
  if (![
    "verified-seed",
    "unseeded-needs-operator-input",
    "local-practice",
  ].includes(String(value.sourceStatus))) {
    throw new Error("Finding definition sourceStatus is invalid.");
  }
  if (value.fhirObservationCode !== undefined && !isRecord(value.fhirObservationCode)) {
    throw new Error("Finding definition fhirObservationCode must be an object.");
  }
  if (value.allowDiagnosisMapping !== undefined && typeof value.allowDiagnosisMapping !== "boolean") {
    throw new Error("Finding definition allowDiagnosisMapping must be boolean.");
  }
  if (value.diagnosisCandidates !== undefined) {
    if (!Array.isArray(value.diagnosisCandidates)) {
      throw new Error("Finding definition diagnosisCandidates must be an array.");
    }
    const ids = new Set<string>();
    for (const candidate of value.diagnosisCandidates) {
      if (!isRecord(candidate)) throw new Error("Diagnosis mapping entries must be objects.");
      requiredString(candidate.id, "diagnosisCandidates.id");
      requiredString(candidate.diagnosisKey, "diagnosisCandidates.diagnosisKey");
      if (!isRecord(candidate.trigger)) throw new Error("Diagnosis mapping trigger must be an object.");
      if (!["seed", "practice"].includes(String(candidate.origin)) || typeof candidate.active !== "boolean") {
        throw new Error("Diagnosis mapping origin or active state is invalid.");
      }
      if (ids.has(candidate.id)) throw new Error(`Duplicate diagnosis mapping id ${candidate.id}.`);
      ids.add(candidate.id);
    }
  }
  if (value.documentationElements !== undefined) {
    if (!Array.isArray(value.documentationElements)) {
      throw new Error("Finding definition documentationElements must be an array.");
    }
    const codes = new Set<string>();
    for (const element of value.documentationElements) {
      if (!isRecord(element)) throw new Error("Documentation element entries must be objects.");
      requiredString(element.code, "documentationElements.code");
      const code = element.code;
      if (!code.startsWith("entrance.")) throw new Error("Documentation element codes must use the entrance. prefix.");
      if (!['seed', 'practice'].includes(String(element.origin)) || typeof element.active !== "boolean") {
        throw new Error("Documentation element origin or active state is invalid.");
      }
      if (codes.has(code)) throw new Error(`Duplicate documentation element code ${code}.`);
      codes.add(code);
    }
  }
  if (typeof value.notBillReady !== "boolean") {
    throw new Error("Finding definition notBillReady must be boolean.");
  }
  if (typeof value.active !== "boolean") {
    throw new Error("Finding definition active must be boolean.");
  }
  if (!isRecord(value.provenance)) throw new Error("Finding definition provenance must be an object.");
  if (!["manual", "device", "parser", "agent", "protocol", "rule"].includes(String(value.provenance.source))) {
    throw new Error("Finding definition provenance source is invalid.");
  }
  requiredString(value.provenance.recordedAt, "provenance.recordedAt");
  return value as unknown as ClinicalFindingDefinition;
}

function assertUniqueStableKeys(
  definitions: readonly ClinicalFindingDefinition[],
  source: string,
): void {
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.stableKey)) {
      throw new Error(`Duplicate stableKey ${definition.stableKey} in ${source}.`);
    }
    seen.add(definition.stableKey);
  }
}

function resolveStoredDuplicates(
  rows: Array<{ resource: Basic; definition: ClinicalFindingDefinition }>,
): Array<{ resource: Basic; definition: ClinicalFindingDefinition }> {
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = grouped.get(row.definition.stableKey) ?? [];
    group.push(row);
    grouped.set(row.definition.stableKey, group);
  }
  return [...grouped.values()].map((group) => {
    const winner = group.reduce((current, candidate) =>
      compareStoredRows(candidate, current) > 0 ? candidate : current
    );
    for (const loser of group) {
      if (loser === winner) continue;
      console.error(
        `Duplicate finding-definition stableKey ${winner.definition.stableKey}: ` +
        `${basicReference(loser.resource)} skipped in favor of ${basicReference(winner.resource)}.`,
      );
    }
    return winner;
  });
}

function compareStoredRows(
  left: { resource: Basic },
  right: { resource: Basic },
): number {
  const lastUpdated = (left.resource.meta?.lastUpdated ?? "")
    .localeCompare(right.resource.meta?.lastUpdated ?? "");
  return lastUpdated || (left.resource.id ?? "").localeCompare(right.resource.id ?? "");
}

function basicReference(resource: Basic): string {
  return `Finding-definition Basic/${resource.id ?? "unknown"}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Finding definition ${field} must be a non-empty string.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
