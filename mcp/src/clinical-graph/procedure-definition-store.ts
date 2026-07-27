import { randomUUID } from "node:crypto";
import type { Basic, Bundle, CodeableConcept, Procedure } from "@medplum/fhirtypes";
import {
  assertDiscipline,
  type SchedulingDiscipline,
} from "../scheduling/clinic-mode.js";
import {
  buildProcedure,
  type ProcedureCodeInput,
  type ProcedureStatusCode,
} from "../fhir/procedure.js";
import { SERIES_PROCEDURE_TYPE_SYSTEM } from "../series-tracker/protocol-definition-store.js";
import type { ClinicalGraphProvenance } from "./glaucoma-suspect.js";

export const PROCEDURE_DEFINITION_CODE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/odos-procedure-definition";
export const PROCEDURE_DEFINITION_CODE = "odos-procedure-definition";
export const PROCEDURE_DEFINITION_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/procedure-definition-stable-key";
export const PROCEDURE_DEFINITION_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-procedure-definition-json";
export const AESTHETICS_PROCEDURE_TYPE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/aesthetics-procedure-type";
export const DRY_EYE_PROCEDURE_STABLE_KEYS = {
  ipl: "procedure:dry-eye:ipl",
  rf: "procedure:dry-eye:rf",
  lllt: "procedure:dry-eye:lllt",
  blephex: "procedure:dry-eye:blephex",
  glandExpression: "procedure:dry-eye:gland-expression",
  maskinProbing: "procedure:dry-eye:maskin-probing",
  punctalOcclusion: "procedure:dry-eye:punctal-occlusion",
} as const;
export const PROCEDURE_DEFINITION_WRITE_HEADERS = {
  "X-ODOS-Source": "procedure-definitions",
} as const;

export interface ClinicalProcedureDefinition {
  id: string;
  stableKey: string;
  display: string;
  sectionKey: string;
  discipline: SchedulingDiscipline;
  sourceStatus: "verified-seed" | "unseeded-needs-operator-input" | "local-practice";
  fhirProcedureCode: ProcedureCodeInput | CodeableConcept;
  valueSchema: Record<string, unknown>;
  photo_posture: "timeline" | "compare";
  defaultStatus: ProcedureStatusCode;
  notBillReady: boolean;
  active: boolean;
  provenance: ClinicalGraphProvenance;
}

export interface ProcedureDefinitionFhirClient {
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

export class FhirProcedureDefinitionStore {
  constructor(
    private readonly fhir: ProcedureDefinitionFhirClient,
    private readonly seeds: readonly ClinicalProcedureDefinition[] = buildProcedureDefinitionSeeds(),
  ) {
    assertUniqueStableKeys(seeds, "compiled procedure-definition seeds");
  }

  async list(): Promise<ClinicalProcedureDefinition[]> {
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
    definition: ClinicalProcedureDefinition,
    provenance: ClinicalGraphProvenance = definition.provenance,
  ): Promise<ClinicalProcedureDefinition> {
    const stored = await this.readStoredRows();
    let existing = stored.find((row) => row.definition.stableKey === definition.stableKey)?.resource;
    const localDefinition = assertClinicalProcedureDefinition({
      ...definition,
      sourceStatus: "local-practice",
      provenance,
    });
    if (!existing?.id) {
      const refreshed = await this.readStoredRows();
      existing = refreshed.find((row) => row.definition.stableKey === definition.stableKey)?.resource;
    }
    const resource = buildProcedureDefinitionResource(localDefinition, existing);
    const persisted = existing?.id
      ? await this.fhir.update("Basic", existing.id, resource, PROCEDURE_DEFINITION_WRITE_HEADERS)
      : await this.fhir.create(resource, PROCEDURE_DEFINITION_WRITE_HEADERS);
    return parseProcedureDefinitionResource(persisted);
  }

  private async readStoredRows(): Promise<Array<{
    resource: Basic;
    definition: ClinicalProcedureDefinition;
  }>> {
    const bundle = await this.fhir.search<Basic>("Basic", {
      code: `${PROCEDURE_DEFINITION_CODE_SYSTEM}|${PROCEDURE_DEFINITION_CODE}`,
      _count: "200",
    });
    const rows = (bundle.entry ?? []).flatMap((entry) => {
      const resource = entry.resource;
      if (!resource) return [];
      try {
        return [{ resource, definition: parseProcedureDefinitionResource(resource) }];
      } catch (error) {
        console.error(`${basicReference(resource)} skipped: ${errorMessage(error)}`);
        return [];
      }
    });
    return resolveStoredDuplicates(rows);
  }
}

export function buildProcedureDefinitionSeeds(): ClinicalProcedureDefinition[] {
  const aestheticsProvenance: ClinicalGraphProvenance = {
    source: "manual",
    recordedAt: new Date(0).toISOString(),
    actorReference: "Practitioner/odos-system",
    note: "ODOS local aesthetics procedure definition seed.",
  };
  const dryEyeProvenance: ClinicalGraphProvenance = {
    source: "manual",
    recordedAt: new Date(0).toISOString(),
    actorReference: "Practitioner/odos-system",
    note: "ODOS dry-eye procedure seed; external CPT mappings are intentionally omitted pending Mandate 14 verification.",
  };
  return [
    procedureSeed(
      "procedure:aesthetics:neurotoxin-glabella",
      "neurotoxin-injection-glabella",
      "Neurotoxin injection — glabella",
      aestheticsProvenance,
    ),
    procedureSeed(
      "procedure:aesthetics:dermal-filler-nasolabial-fold",
      "dermal-filler-nasolabial-fold",
      "Dermal filler — nasolabial fold",
      aestheticsProvenance,
    ),
    procedureSeed(
      "procedure:aesthetics:chemical-peel-full-face",
      "chemical-peel-full-face",
      "Chemical peel — full face",
      aestheticsProvenance,
    ),
    // Package eligibility is separate from billing readiness; dry-eye rows stay notBillReady until external codes are verified.
    procedureSeed(
      DRY_EYE_PROCEDURE_STABLE_KEYS.ipl,
      DRY_EYE_PROCEDURE_STABLE_KEYS.ipl,
      "IPL (OptiLight-class)",
      dryEyeProvenance,
      { discipline: "eyecare", codeSystem: SERIES_PROCEDURE_TYPE_SYSTEM, photoPosture: "compare" },
    ),
    procedureSeed(
      DRY_EYE_PROCEDURE_STABLE_KEYS.rf,
      DRY_EYE_PROCEDURE_STABLE_KEYS.rf,
      "RF (Opus-class)",
      dryEyeProvenance,
      { discipline: "eyecare", codeSystem: SERIES_PROCEDURE_TYPE_SYSTEM, photoPosture: "compare" },
    ),
    procedureSeed(
      DRY_EYE_PROCEDURE_STABLE_KEYS.lllt,
      DRY_EYE_PROCEDURE_STABLE_KEYS.lllt,
      "LLLT (Equinox-class)",
      dryEyeProvenance,
      { discipline: "eyecare", codeSystem: SERIES_PROCEDURE_TYPE_SYSTEM, photoPosture: "timeline" },
    ),
    procedureSeed(
      DRY_EYE_PROCEDURE_STABLE_KEYS.blephex,
      DRY_EYE_PROCEDURE_STABLE_KEYS.blephex,
      "BlephEx / microblepharoexfoliation",
      dryEyeProvenance,
      { discipline: "eyecare", codeSystem: SERIES_PROCEDURE_TYPE_SYSTEM, photoPosture: "timeline" },
    ),
    procedureSeed(
      DRY_EYE_PROCEDURE_STABLE_KEYS.glandExpression,
      DRY_EYE_PROCEDURE_STABLE_KEYS.glandExpression,
      "Meibomian gland expression",
      dryEyeProvenance,
      { discipline: "eyecare", codeSystem: SERIES_PROCEDURE_TYPE_SYSTEM, photoPosture: "timeline" },
    ),
    procedureSeed(
      DRY_EYE_PROCEDURE_STABLE_KEYS.maskinProbing,
      DRY_EYE_PROCEDURE_STABLE_KEYS.maskinProbing,
      "Maskin probing",
      dryEyeProvenance,
      { discipline: "eyecare", codeSystem: SERIES_PROCEDURE_TYPE_SYSTEM, photoPosture: "timeline" },
    ),
    procedureSeed(
      DRY_EYE_PROCEDURE_STABLE_KEYS.punctalOcclusion,
      DRY_EYE_PROCEDURE_STABLE_KEYS.punctalOcclusion,
      "Punctal occlusion (plugs)",
      dryEyeProvenance,
      { discipline: "eyecare", codeSystem: SERIES_PROCEDURE_TYPE_SYSTEM, photoPosture: "timeline", notBillReady: true },
    ),
  ];
}

export function buildProcedureFromDefinition(
  definition: ClinicalProcedureDefinition,
  input: {
    patientReference: string;
    encounterReference?: string;
    performedDateTime?: string;
    status?: ProcedureStatusCode;
  },
): Procedure {
  return buildProcedure({
    patientReference: input.patientReference,
    encounterReference: input.encounterReference,
    performedDateTime: input.performedDateTime,
    status: input.status ?? definition.defaultStatus,
    code: definition.fhirProcedureCode,
  });
}

export function buildProcedureDefinitionResource(
  definition: ClinicalProcedureDefinition,
  existing?: Basic,
): Basic {
  const validated = assertClinicalProcedureDefinition(definition);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{
      system: PROCEDURE_DEFINITION_IDENTIFIER_SYSTEM,
      value: validated.stableKey,
    }],
    code: {
      coding: [{
        system: PROCEDURE_DEFINITION_CODE_SYSTEM,
        code: PROCEDURE_DEFINITION_CODE,
        display: "ODOS procedure definition",
      }],
      text: validated.display,
    },
    extension: [{
      url: PROCEDURE_DEFINITION_EXTENSION_URL,
      valueString: JSON.stringify(validated),
    }],
  };
}

export function parseProcedureDefinitionResource(resource: Basic): ClinicalProcedureDefinition {
  const coding = resource.code?.coding?.find((candidate) =>
    candidate.system === PROCEDURE_DEFINITION_CODE_SYSTEM &&
    candidate.code === PROCEDURE_DEFINITION_CODE
  );
  if (!coding) throw new Error("Basic resource is not an ODOS procedure definition.");
  const raw = resource.extension?.find((extension) =>
    extension.url === PROCEDURE_DEFINITION_EXTENSION_URL
  )?.valueString;
  if (!raw) throw new Error("Procedure-definition Basic is missing its JSON extension.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Procedure-definition JSON is malformed and cannot be parsed.");
  }
  const normalized = isRecord(parsed) && parsed.photo_posture === undefined
    ? { ...parsed, photo_posture: parsed.discipline === "aesthetics" ? "compare" : "timeline" }
    : parsed;
  const definition = assertClinicalProcedureDefinition(normalized);
  const identifier = resource.identifier?.find((candidate) =>
    candidate.system === PROCEDURE_DEFINITION_IDENTIFIER_SYSTEM
  )?.value;
  if (identifier !== definition.stableKey) {
    throw new Error("Procedure-definition identifier does not match its stableKey.");
  }
  if (definition.sourceStatus !== "local-practice") {
    throw new Error("Persisted procedure definitions must have sourceStatus local-practice.");
  }
  return definition;
}

function procedureSeed(
  stableKey: string,
  code: string,
  display: string,
  provenance: ClinicalGraphProvenance,
  options: {
    discipline?: SchedulingDiscipline;
    codeSystem?: string;
    photoPosture?: ClinicalProcedureDefinition["photo_posture"];
    notBillReady?: boolean;
  } = {},
): ClinicalProcedureDefinition {
  return {
    id: randomUUID(),
    stableKey,
    display,
    sectionKey: stableKey,
    discipline: options.discipline ?? "aesthetics",
    sourceStatus: "verified-seed",
    fhirProcedureCode: {
      system: options.codeSystem ?? AESTHETICS_PROCEDURE_TYPE_SYSTEM,
      code,
      display,
    },
    valueSchema: {
      type: "procedure",
      perEye: false,
      fields: {},
    },
    photo_posture: options.photoPosture ?? "compare",
    defaultStatus: "completed",
    notBillReady: options.notBillReady ?? true,
    active: true,
    provenance,
  };
}

function assertClinicalProcedureDefinition(value: unknown): ClinicalProcedureDefinition {
  if (!isRecord(value)) throw new Error("Procedure definition must be an object.");
  requiredString(value.id, "id");
  requiredString(value.stableKey, "stableKey");
  requiredString(value.display, "display");
  requiredString(value.sectionKey, "sectionKey");
  requiredString(value.discipline, "discipline");
  assertDiscipline(value.discipline);
  if (![
    "verified-seed",
    "unseeded-needs-operator-input",
    "local-practice",
  ].includes(String(value.sourceStatus))) {
    throw new Error("Procedure definition sourceStatus is invalid.");
  }
  if (!isRecord(value.fhirProcedureCode)) {
    throw new Error("Procedure definition fhirProcedureCode must be an object.");
  }
  const searchableCode = "coding" in value.fhirProcedureCode
    ? Array.isArray(value.fhirProcedureCode.coding) &&
      value.fhirProcedureCode.coding.some((coding) =>
        isRecord(coding) && requiredCodingPair(coding.system, coding.code)
      )
    : requiredCodingPair(
        value.fhirProcedureCode.system,
        value.fhirProcedureCode.code,
      );
  if (!searchableCode) {
    throw new Error("Procedure definition requires a searchable FHIR coding.");
  }
  if (!isRecord(value.valueSchema)) {
    throw new Error("Procedure definition valueSchema must be an object.");
  }
  if (value.photo_posture !== "timeline" && value.photo_posture !== "compare") {
    throw new Error("Procedure definition photo_posture must be timeline or compare.");
  }
  if (![
    "preparation",
    "in-progress",
    "not-done",
    "on-hold",
    "stopped",
    "completed",
    "entered-in-error",
    "unknown",
  ].includes(String(value.defaultStatus))) {
    throw new Error("Procedure definition defaultStatus is invalid.");
  }
  if (typeof value.notBillReady !== "boolean") {
    throw new Error("Procedure definition notBillReady must be boolean.");
  }
  if (typeof value.active !== "boolean") {
    throw new Error("Procedure definition active must be boolean.");
  }
  if (!isRecord(value.provenance)) {
    throw new Error("Procedure definition provenance must be an object.");
  }
  requiredString(value.provenance.recordedAt, "provenance.recordedAt");
  return value as unknown as ClinicalProcedureDefinition;
}

function assertUniqueStableKeys(
  definitions: readonly ClinicalProcedureDefinition[],
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
  rows: Array<{ resource: Basic; definition: ClinicalProcedureDefinition }>,
): Array<{ resource: Basic; definition: ClinicalProcedureDefinition }> {
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = grouped.get(row.definition.stableKey) ?? [];
    group.push(row);
    grouped.set(row.definition.stableKey, group);
  }
  return [...grouped.values()].map((group) => group.reduce((current, candidate) => {
    const updated = (candidate.resource.meta?.lastUpdated ?? "")
      .localeCompare(current.resource.meta?.lastUpdated ?? "");
    return updated > 0 || (updated === 0 &&
        (candidate.resource.id ?? "").localeCompare(current.resource.id ?? "") > 0)
      ? candidate
      : current;
  }));
}

function basicReference(resource: Basic): string {
  return `Procedure-definition Basic/${resource.id ?? "unknown"}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Procedure definition ${field} must be a non-empty string.`);
  }
}

function requiredCodingPair(system: unknown, code: unknown): boolean {
  return typeof system === "string" && system.trim().length > 0 &&
    typeof code === "string" && code.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
