import type {
  Address,
  ContactPoint,
  HumanName,
  Patient,
} from "@medplum/fhirtypes";
import { z } from "zod";
import type { MedplumClient } from "../fhir-client.js";
import { searchAll } from "../fhir-search.js";
import {
  MIGRATION_TAG_CODE,
  MIGRATION_TAG_SYSTEM,
} from "./access-policy.js";
import type { ImportLedger } from "./import-ledger.js";

export const EPM_PATIENT_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/eyefinity-epm-patient-id";
export const EHR_PATIENT_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/eyefinity-ehr-patient-id";
export const FORBIDDEN_M2A_EPM_SOURCE_KEY = "6499570";
export const FORBIDDEN_M2A_EHR_SOURCE_KEY = "969";

const sourcePersonSchema = z.object({
  sourceKey: z.string().trim().min(1),
  firstName: z.string().trim().min(1),
  middleName: z.string().trim().optional(),
  lastName: z.string().trim().min(1),
  suffix: z.string().trim().optional(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const epmPatientSchema = sourcePersonSchema.extend({
  active: z.boolean().optional(),
  gender: z.enum(["male", "female", "other", "unknown"]).optional(),
  telecom: z.array(z.object({
    system: z.enum(["phone", "fax", "email", "pager", "url", "sms", "other"]),
    value: z.string().trim().min(1),
    use: z.enum(["home", "work", "temp", "old", "mobile"]).optional(),
  })).optional(),
  address: z.array(z.object({
    use: z.enum(["home", "work", "temp", "old", "billing"]).optional(),
    line: z.array(z.string().trim().min(1)).optional(),
    city: z.string().trim().optional(),
    state: z.string().trim().optional(),
    postalCode: z.string().trim().optional(),
    country: z.string().trim().optional(),
  })).optional(),
});

const junkRowSchema = sourcePersonSchema.extend({
  sourceSystem: z.enum(["epm", "ehr"]),
});

export const patientImportManifestSchema = z.object({
  epm: epmPatientSchema,
  ehr: sourcePersonSchema,
  junkRows: z.array(junkRowSchema).min(1),
});

export type PatientImportManifest = z.infer<typeof patientImportManifestSchema>;
export type SourcePerson = z.infer<typeof sourcePersonSchema>;

export interface PatientImportResult {
  readonly runId: string;
  readonly sourceKey: string;
  readonly patientReference?: string;
  readonly action: "created" | "updated" | "skipped" | "conflict";
  readonly junkRejections: number;
}

export async function importLegacyPatient(input: {
  readonly fhir: Pick<MedplumClient, "search" | "searchUrl" | "create" | "update">;
  readonly ledger: ImportLedger;
  readonly runId: string;
  readonly projectId: string;
  readonly manifest: PatientImportManifest;
  readonly allowOperatorTestDataChart?: boolean;
}): Promise<PatientImportResult> {
  const manifest = patientImportManifestSchema.parse(input.manifest);
  assertSourcePairIsNotJunk(manifest);
  assertOperatorChartAcknowledged(
    manifest,
    input.allowOperatorTestDataChart === true,
  );
  assertIdentityJoin(manifest.epm, manifest.ehr);

  let junkRejections = 0;
  for (const row of manifest.junkRows) {
    const reasons = junkRowReasons(row);
    if (reasons.length === 0) {
      throw new Error(
        `Source row ${row.sourceKey} was supplied as junk but matched no approved junk rule.`,
      );
    }
    for (const reason of reasons) {
      input.ledger.recordJunkRejection({
        runId: input.runId,
        sourceSystem: row.sourceSystem,
        sourceKey: row.sourceKey,
        reason,
      });
      junkRejections += 1;
    }
  }

  const identifiers = [
    { system: EPM_PATIENT_IDENTIFIER_SYSTEM, value: manifest.epm.sourceKey },
    { system: EHR_PATIENT_IDENTIFIER_SYSTEM, value: manifest.ehr.sourceKey },
  ];
  const identified = await findByMigrationIdentifiers(input.fhir, identifiers);
  if (identified.kind === "conflict") {
    input.ledger.recordAmbiguity({
      sourceKind: "patient",
      sourceKey: manifest.epm.sourceKey,
      ambiguityType: "migration-identifier",
      details: { reason: identified.reason },
    });
    input.ledger.recordResourceAction({
      runId: input.runId,
      sourceKey: manifest.epm.sourceKey,
      resourceType: "Patient",
      action: "conflict",
      reason: identified.reason,
    });
    return {
      runId: input.runId,
      sourceKey: manifest.epm.sourceKey,
      action: "conflict",
      junkRejections,
    };
  }

  let existing = identified.patient;
  let reason = "matched-migration-identifier";
  if (!existing) {
    const nativeMatches = await findNativeIdentityMatches(input.fhir, manifest.epm);
    if (nativeMatches.length > 1) {
      const conflictReason = `native-identity-multi-match:${nativeMatches.length}`;
      input.ledger.recordAmbiguity({
        sourceKind: "patient",
        sourceKey: manifest.epm.sourceKey,
        ambiguityType: "native-identity",
        details: { matchCount: nativeMatches.length },
      });
      input.ledger.recordResourceAction({
        runId: input.runId,
        sourceKey: manifest.epm.sourceKey,
        resourceType: "Patient",
        action: "conflict",
        reason: conflictReason,
      });
      return {
        runId: input.runId,
        sourceKey: manifest.epm.sourceKey,
        action: "conflict",
        junkRejections,
      };
    }
    existing = nativeMatches[0];
    reason = existing ? "adopted-native-name-dob-match" : "no-existing-match";
  }

  if (!existing) {
    const created = await input.fhir.create<Patient>(
      buildPatient(manifest, input.projectId, identifiers),
      { "X-ODOS-Source": "scripts/import-legacy-patient-m2a" },
    );
    if (!created.id) throw new Error("Patient create returned no id.");
    const patientReference = `Patient/${created.id}`;
    input.ledger.recordResourceAction({
      runId: input.runId,
      sourceKey: manifest.epm.sourceKey,
      resourceType: "Patient",
      resourceReference: patientReference,
      action: "created",
      reason,
    });
    return {
      runId: input.runId,
      sourceKey: manifest.epm.sourceKey,
      patientReference,
      action: "created",
      junkRejections,
    };
  }

  if (!existing.id || !existing.meta?.versionId) {
    throw new Error("Matched Patient lacks id/meta.versionId for a version-aware update.");
  }
  const desired = mergePatient(existing, manifest, identifiers);
  const patientReference = `Patient/${existing.id}`;
  if (sameManagedPatientState(existing, desired)) {
    input.ledger.recordResourceAction({
      runId: input.runId,
      sourceKey: manifest.epm.sourceKey,
      resourceType: "Patient",
      resourceReference: patientReference,
      action: "skipped",
      reason: "already-converged",
    });
    return {
      runId: input.runId,
      sourceKey: manifest.epm.sourceKey,
      patientReference,
      action: "skipped",
      junkRejections,
    };
  }

  await input.fhir.update<Patient>(
    "Patient",
    existing.id,
    desired,
    {
      "If-Match": `W/"${existing.meta.versionId}"`,
      "X-ODOS-Source": "scripts/import-legacy-patient-m2a",
    },
  );
  input.ledger.recordResourceAction({
    runId: input.runId,
    sourceKey: manifest.epm.sourceKey,
    resourceType: "Patient",
    resourceReference: patientReference,
    action: "updated",
    reason,
  });
  return {
    runId: input.runId,
    sourceKey: manifest.epm.sourceKey,
    patientReference,
    action: "updated",
    junkRejections,
  };
}

export function assertIdentityJoin(epm: SourcePerson, ehr: SourcePerson): void {
  const epmIdentity = identityTuple(epm);
  const ehrIdentity = identityTuple(ehr);
  if (epmIdentity !== ehrIdentity) {
    throw new Error(
      `EPM source ${epm.sourceKey} and EHR source ${ehr.sourceKey} do not match on firstName+lastName+birthDate.`,
    );
  }
}

export function junkRowReasons(row: SourcePerson): string[] {
  const reasons: string[] = [];
  if (row.birthDate === "9999-12-31" || row.birthDate === "1899-12-31") {
    reasons.push("sentinel-birth-date");
  }
  const names = [row.firstName, row.middleName, row.lastName].filter(
    (value): value is string => Boolean(value),
  );
  if (names.some((value) => /,\s*(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/.test(value))) {
    reasons.push("comma-date-in-name");
  }
  if (names.some((value) => isGuid(value))) {
    reasons.push("guid-name");
  }
  return reasons;
}

function assertSourcePairIsNotJunk(manifest: PatientImportManifest): void {
  const selectedReasons = [
    ...junkRowReasons(manifest.epm),
    ...junkRowReasons(manifest.ehr),
  ];
  if (selectedReasons.length > 0) {
    throw new Error(
      `Selected source pair is a junk-row candidate (${[...new Set(selectedReasons)].join(",")}).`,
    );
  }
}

function assertOperatorChartAcknowledged(
  manifest: PatientImportManifest,
  acknowledged: boolean,
): void {
  // Chart 969 must never calibrate junk rules, but that process rule is distinct
  // from importing it for explicit per-Encounter adjudication downstream.
  if (
    !acknowledged
    && (
      manifest.epm.sourceKey === FORBIDDEN_M2A_EPM_SOURCE_KEY
      || manifest.ehr.sourceKey === FORBIDDEN_M2A_EHR_SOURCE_KEY
    )
  ) {
    throw new Error("M2a refuses the operator test-data chart; select one typical chart.");
  }
}

async function findByMigrationIdentifiers(
  fhir: Pick<MedplumClient, "search" | "searchUrl">,
  identifiers: readonly { system: string; value: string }[],
): Promise<{ kind: "ok"; patient?: Patient } | { kind: "conflict"; reason: string }> {
  const matches = await Promise.all(identifiers.map((identifier) =>
    searchAll<Patient>(fhir, "Patient", {
      identifier: `${identifier.system}|${identifier.value}`,
    })
  ));
  if (matches.some((rows) => rows.length > 1)) {
    return { kind: "conflict", reason: "migration-identifier-multi-match" };
  }
  const byReference = new Map<string, Patient>();
  for (const patient of matches.flat()) {
    if (!patient.id) return { kind: "conflict", reason: "migration-identifier-match-missing-id" };
    byReference.set(patient.id, patient);
  }
  if (byReference.size > 1) {
    return { kind: "conflict", reason: "migration-identifiers-resolve-to-different-patients" };
  }
  return { kind: "ok", patient: [...byReference.values()][0] };
}

async function findNativeIdentityMatches(
  fhir: Pick<MedplumClient, "search" | "searchUrl">,
  source: SourcePerson,
): Promise<Patient[]> {
  const candidates = await searchAll<Patient>(fhir, "Patient", {
    family: source.lastName,
    birthdate: source.birthDate,
  });
  return candidates.filter((patient) =>
    patient.birthDate === source.birthDate
    && patient.name?.some((name) =>
      normalize(name.family) === normalize(source.lastName)
      && name.given?.some((given) => normalize(given) === normalize(source.firstName))
    )
  );
}

function buildPatient(
  manifest: PatientImportManifest,
  projectId: string,
  identifiers: readonly { system: string; value: string }[],
): Patient {
  return {
    resourceType: "Patient",
    meta: {
      project: projectId,
      tag: [{ system: MIGRATION_TAG_SYSTEM, code: MIGRATION_TAG_CODE }],
    },
    identifier: [...identifiers],
    active: manifest.epm.active ?? true,
    name: [sourceName(manifest.epm)],
    gender: manifest.epm.gender ?? "unknown",
    birthDate: manifest.epm.birthDate,
    ...(manifest.epm.telecom ? { telecom: manifest.epm.telecom as ContactPoint[] } : {}),
    ...(manifest.epm.address ? { address: manifest.epm.address as Address[] } : {}),
  };
}

function mergePatient(
  existing: Patient,
  manifest: PatientImportManifest,
  identifiers: readonly { system: string; value: string }[],
): Patient {
  const migrationSystems = new Set(identifiers.map((identifier) => identifier.system));
  const existingTags = existing.meta?.tag ?? [];
  const importedName = sourceName(manifest.epm);
  return {
    ...existing,
    meta: {
      ...existing.meta,
      tag: [
        ...existingTags.filter((tag) =>
          tag.system !== MIGRATION_TAG_SYSTEM || tag.code !== MIGRATION_TAG_CODE
        ),
        { system: MIGRATION_TAG_SYSTEM, code: MIGRATION_TAG_CODE },
      ],
    },
    identifier: [
      ...(existing.identifier ?? []).filter((identifier) =>
        !identifier.system || !migrationSystems.has(identifier.system)
      ),
      ...identifiers,
    ],
    active: manifest.epm.active ?? existing.active ?? true,
    name: upsertName(existing.name ?? [], importedName),
    gender: manifest.epm.gender ?? existing.gender ?? "unknown",
    birthDate: manifest.epm.birthDate,
    ...(manifest.epm.telecom ? { telecom: manifest.epm.telecom as ContactPoint[] } : {}),
    ...(manifest.epm.address ? { address: manifest.epm.address as Address[] } : {}),
  };
}

function upsertName(existing: readonly HumanName[], imported: HumanName): HumanName[] {
  const importedKey = nameKey(imported);
  const matchIndex = existing.findIndex((name) => nameKey(name) === importedKey);
  if (matchIndex === -1) return [...existing, imported];
  return existing.map((name, index) => index === matchIndex ? imported : name);
}

function nameKey(name: HumanName): string {
  return [
    normalize(name.use),
    normalize(name.family),
    (name.given ?? []).map(normalize).join("\u001e"),
  ].join("\u001f");
}

function sourceName(source: z.infer<typeof epmPatientSchema>): HumanName {
  return {
    family: source.lastName,
    given: [source.firstName, source.middleName].filter(
      (value): value is string => Boolean(value),
    ),
    ...(source.suffix ? { suffix: [source.suffix] } : {}),
  };
}

function sameManagedPatientState(left: Patient, right: Patient): boolean {
  return JSON.stringify(managedPatientState(left)) === JSON.stringify(managedPatientState(right));
}

function managedPatientState(patient: Patient): unknown {
  return {
    tag: canonicalCollection(patient.meta?.tag ?? []),
    identifier: canonicalCollection(patient.identifier ?? []),
    active: patient.active,
    name: canonicalCollection(patient.name ?? []),
    gender: patient.gender,
    birthDate: patient.birthDate,
    telecom: canonicalCollection(patient.telecom ?? []),
    address: canonicalCollection(patient.address ?? []),
  };
}

function canonicalCollection<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) =>
    stableKey(left).localeCompare(stableKey(right))
  );
}

function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableKey(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function identityTuple(source: SourcePerson): string {
  return [
    normalize(source.firstName),
    normalize(source.lastName),
    source.birthDate,
  ].join("\u001f");
}

function normalize(value: string | undefined): string {
  return value?.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US") ?? "";
}

function isGuid(value: string): boolean {
  return /^[{(]?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}[)}]?$/i.test(
    value.trim(),
  );
}
