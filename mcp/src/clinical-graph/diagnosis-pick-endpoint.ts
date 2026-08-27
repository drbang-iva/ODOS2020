import type { Basic, Bundle, CodeableConcept, Condition, Encounter, Observation, Provenance } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import {
  buildEncounterDiagnosisComponent,
  buildEncounterDiagnosisCondition,
  verificationStatusConcept,
  type ConditionVerificationStatusCode,
} from "../fhir/condition.js";
import { ODOS_EXTENSION_URLS } from "../fhir/ophthalmology/extensions.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { isRelativeFhirReference } from "../fhir/reference.js";
import { FhirDiagnosisCatalogStore } from "./diagnosis-catalog-store.js";
import { FhirDiagnosisPickTallyStore } from "./diagnosis-pick-tally-store.js";
import { FhirFindingDefinitionStore } from "./finding-definition-store.js";
import { findingDefinitionForObservation } from "./finding-observation-match.js";
import type { DiagnosisCatalogRow } from "./glaucoma-suspect.js";
import { ICD10_CM_CODE_SYSTEM } from "./glaucoma-suspect.js";
import { resolveConditionCodes } from "./diagnosis-code-resolution.js";
export { resolveConditionCodes } from "./diagnosis-code-resolution.js";
import { FAMILY_RESOLUTION_MODES } from "./diagnosis-catalog-seeds.js";
import {
  visualFieldDescriptorResolutionFromObservation,
  type VisualFieldDescriptorResolution,
} from "./entrance-definition.js";
import {
  DIAGNOSIS_VISIT_STATUSES,
  type DiagnosisVisitStatusStore,
} from "./diagnosis-visit-status-store.js";

export const DIAGNOSIS_KEY_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key";
export const DIAGNOSIS_CATALOG_CODE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/diagnosis-catalog";
export const DIAGNOSIS_PICK_WRITE_HEADERS = { "X-ODOS-Source": "diagnosis-pick" } as const;

type PickResource = Basic | Condition | Encounter | Observation | Provenance;
type LateralityBucket = "right" | "left" | "bilateral" | "unspecified" | "none";

export interface DiagnosisPickFhirClient {
  read<T extends PickResource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends PickResource>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
  create<T extends PickResource>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends PickResource>(resourceType: T["resourceType"], id: string, resource: T, extraHeaders?: Record<string, string>): Promise<T>;
}

const pickSchema = z.object({
  findingInstanceId: z.string().trim().min(1).optional(),
  diagnosisKey: z.string().trim().min(1),
  action: z.enum(["possible", "confirm", "discard"]),
  laterality: z.enum(["OD", "OS", "OU", "right", "left", "bilateral"]).optional(),
  source: z.enum(["rule", "mapping", "catalog-search"]).optional(),
  status: z.enum(DIAGNOSIS_VISIT_STATUSES).optional(),
  stageDeferred: z.boolean().optional(),
}).strict();

export async function handleDiagnosisPickRequest(
  deps: {
    authenticate(authHeader: string | undefined): Promise<{
      staffReference: string;
      actorRole: PracticeRoleId;
      fhir: DiagnosisPickFhirClient;
    } | null>;
    diagnosisVisitStatusStore: DiagnosisVisitStatusStore;
    now?: () => string;
  },
  input: { authHeader: string | undefined; params: unknown; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to pick a diagnosis." } };
  if (!staffMay(staff.actorRole, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const encounterId = readEncounterId(input.params);
  if (!encounterId) return { status: 400, body: { error: "A valid encounter id is required." } };
  const parsed = pickSchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid diagnosis pick." } };
  if (parsed.data.status && parsed.data.action !== "confirm") {
    return { status: 400, body: { error: "Diagnosis visit status is only accepted when confirming a diagnosis." } };
  }
  if (parsed.data.stageDeferred && parsed.data.action !== "confirm") {
    return { status: 400, body: { error: "Stage can only be deferred when confirming a diagnosis." } };
  }

  const encounterReference = `Encounter/${encounterId}`;
  const catalog = await new FhirDiagnosisCatalogStore(staff.fhir).list();
  const familyMode = FAMILY_RESOLUTION_MODES[parsed.data.diagnosisKey];
  if (parsed.data.stageDeferred && familyMode?.mode !== "staged") {
    return { status: 400, body: { error: `${parsed.data.diagnosisKey} is not a staged diagnosis family.` } };
  }
  const diagnosis = parsed.data.stageDeferred && familyMode?.mode === "staged"
    ? pendingStageDiagnosis(catalog, parsed.data.diagnosisKey, familyMode.members.map((member) => member.stableKey))
    : catalog.find((row) => row.stableKey === parsed.data.diagnosisKey);
  if (!diagnosis) return { status: 404, body: { error: `Diagnosis ${parsed.data.diagnosisKey} does not exist.` } };
  if (!diagnosis.active) return { status: 409, body: { error: `Diagnosis ${parsed.data.diagnosisKey} is inactive.` } };

  let observation: Observation | undefined;
  let findingDefinitionStableKey: string | undefined;
  if (parsed.data.findingInstanceId) {
    try {
      observation = await staff.fhir.read<Observation>("Observation", stripReference(parsed.data.findingInstanceId, "Observation"));
    } catch {
      return { status: 404, body: { error: `Finding ${parsed.data.findingInstanceId} does not exist.` } };
    }
    if (observation.encounter?.reference !== encounterReference) {
      return { status: 409, body: { error: "The finding does not belong to this encounter." } };
    }
    const definitions = await new FhirFindingDefinitionStore(staff.fhir).list();
    findingDefinitionStableKey = findingDefinitionForObservation(observation, definitions)?.stableKey;
    if (!findingDefinitionStableKey) return { status: 422, body: { error: "The finding does not resolve to an active finding definition." } };
  }

  const laterality = normalizeLaterality(observationLaterality(observation) ?? parsed.data.laterality);
  const visualFieldDescriptor = visualFieldDescriptorResolutionFromObservation(
    findingDefinitionStableKey,
    observation,
  );
  const codes = resolveConditionCodes(diagnosis, laterality, visualFieldDescriptor);
  const descriptorEyeLaterality = visualFieldDescriptor?.codeSelection?.kind === "eye";
  if (diagnosis.lateralityRequired && (
    (!parsed.data.stageDeferred && codes.length === 0) ||
    (!laterality && !descriptorEyeLaterality)
  )) {
    return { status: 422, body: { error: "This diagnosis requires laterality. Supply laterality explicitly." } };
  }
  const lateralityBucket = parsed.data.stageDeferred
    ? laterality!
    : diagnosisLateralityBucket(diagnosis, laterality, visualFieldDescriptor);
  const legacyIdentifierValue = `${diagnosis.stableKey}::${lateralityBucket}`;
  const compositeIdentifierValue = `${encounterId}::${legacyIdentifierValue}`;
  const stagedFamily = stagedFamilyForMember(diagnosis.stableKey);
  const pendingFamilyIdentifierValues = stagedFamily && parsed.data.action === "confirm"
    ? [`${encounterId}::${stagedFamily}::${lateralityBucket}`, `${stagedFamily}::${lateralityBucket}`]
    : [];
  const stagedMemberIdentifierValues = parsed.data.stageDeferred && familyMode?.mode === "staged"
    ? familyMode.members.flatMap((member) => [
        `${encounterId}::${member.stableKey}::${lateralityBucket}`,
        `${member.stableKey}::${lateralityBucket}`,
      ])
    : [];
  const diagnosisMatch = await findEncounterDiagnosis(
    staff.fhir,
    encounterReference,
    compositeIdentifierValue,
    legacyIdentifierValue,
    pendingFamilyIdentifierValues,
    stagedMemberIdentifierValues,
  );
  if (diagnosisMatch.conflictingStagedMember) {
    return {
      status: 409,
      body: {
        error: `A staged diagnosis already exists for ${diagnosis.stableKey} ${lateralityBucket}. Re-stage the existing diagnosis instead.`,
      },
    };
  }
  const existing = diagnosisMatch.existing;
  if (parsed.data.action === "discard" && !existing) {
    return { status: 404, body: { error: `No existing Condition for ${diagnosis.stableKey} can be discarded.` } };
  }

  let encounter: Encounter | undefined;
  let patientReference = observation?.subject?.reference;
  if (!patientReference) {
    encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
    patientReference = encounter.subject?.reference;
  }
  if ((parsed.data.status || parsed.data.action === "discard") && !encounter) {
    encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
  }
  if ((parsed.data.status || parsed.data.action === "discard") && encounter?.status === "finished") {
    return { status: 409, body: { error: "Diagnosis visit status cannot change after the encounter is signed." } };
  }
  if (!isRelativeFhirReference(patientReference, "Patient")) {
    return { status: 422, body: { error: "The encounter does not resolve to a Patient reference." } };
  }

  const verificationStatus: ConditionVerificationStatusCode = parsed.data.action === "discard"
    ? "refuted"
    : parsed.data.action === "possible" ? "provisional" : "confirmed";
  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const evidenceReference = observation?.id ? `Observation/${observation.id}` : undefined;
  let condition: Condition;
  if (existing) {
    try {
      condition = await updateCondition(
        staff.fhir,
        existing,
        diagnosis,
        compositeIdentifierValue,
        pendingFamilyIdentifierValues,
        codes,
        verificationStatus,
        evidenceReference,
      );
    } catch (error) {
      if (isConflict(error)) {
        return { status: 409, body: { error: "This diagnosis was modified concurrently — reload and retry." } };
      }
      throw error;
    }
  } else {
    condition = await staff.fhir.create<Condition>(
      buildEncounterDiagnosisCondition({
        patientReference,
        encounterReference,
        code: conditionCodeForResolution(diagnosis, codes),
        verificationStatus,
        recordedDate: recordedAt,
        identifiers: [{ system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM, value: compositeIdentifierValue }],
        ...(evidenceReference ? { evidenceObservationReferences: [evidenceReference] } : {}),
      }),
      {
        ...DIAGNOSIS_PICK_WRITE_HEADERS,
        "If-None-Exist": `identifier=${DIAGNOSIS_KEY_IDENTIFIER_SYSTEM}|${compositeIdentifierValue}`,
      },
    );
  }

  const conditionReference = `Condition/${condition.id}`;
  let linkedEncounter: Encounter | undefined;
  let encounterChanged = false;
  if (parsed.data.action === "confirm") {
    try {
      const linked = await ensureEncounterDiagnosisLinked(staff.fhir, encounterId, conditionReference, encounter);
      linkedEncounter = linked.encounter;
      encounterChanged = linked.changed;
    } catch (error) {
      if (isConflict(error)) {
        return { status: 409, body: { error: "The encounter diagnoses changed concurrently — reload and retry." } };
      }
      throw error;
    }
  } else if (parsed.data.action === "discard") {
    try {
      const unlinked = await ensureEncounterDiagnosisUnlinked(staff.fhir, encounterId, conditionReference, encounter);
      linkedEncounter = unlinked.encounter;
      encounterChanged = unlinked.changed;
    } catch (error) {
      if (isConflict(error)) {
        return { status: 409, body: { error: "The encounter diagnoses changed concurrently — reload and retry." } };
      }
      throw error;
    }
  }
  const provenance = await staff.fhir.create<Provenance>(buildProvenance({
    targetReferences: [conditionReference, ...(encounterChanged ? [encounterReference] : [])],
    patientReference,
    occurredDateTime: recordedAt,
    recorded: recordedAt,
    activityCode: existing ? "UPDATE" : "CREATE",
    activityDisplay: `${parsed.data.action} encounter diagnosis`,
    agents: [{ typeCode: "author", typeDisplay: "Author", whoReference: staff.staffReference }],
    ...(evidenceReference ? { entityReferences: [evidenceReference] } : {}),
    entityValues: [{
      role: "source",
      display: parsed.data.source
        ? `Explicit ${parsed.data.source} diagnosis pick: ${diagnosis.stableKey}`
        : `Explicit diagnosis pick: ${diagnosis.stableKey}`,
    }],
  }), DIAGNOSIS_PICK_WRITE_HEADERS);

  const diagnosisVisitStatus = parsed.data.status
    ? await deps.diagnosisVisitStatusStore.upsert({
        conditionReference,
        encounterId,
        status: parsed.data.status,
        setBy: staff.staffReference,
        at: recordedAt,
      })
    : undefined;

  if (parsed.data.action !== "discard" && findingDefinitionStableKey) {
    try {
      await new FhirDiagnosisPickTallyStore(staff.fhir).increment(
        staff.staffReference,
        findingDefinitionStableKey,
        diagnosis.stableKey,
        recordedAt,
      );
    } catch (error) {
      console.error(`Diagnosis pick tally increment failed after ${conditionReference}: ${errorMessage(error)}`);
    }
  }

  return {
    status: existing ? 200 : 201,
    body: {
      condition,
      ...(linkedEncounter ? { encounter: linkedEncounter } : {}),
      provenanceReference: provenance.id ? `Provenance/${provenance.id}` : undefined,
      action: parsed.data.action,
      ...(diagnosisVisitStatus ? { diagnosisVisitStatus } : {}),
    },
  };
}

function pendingStageDiagnosis(
  catalog: readonly DiagnosisCatalogRow[],
  clinicalFamily: string,
  memberKeys: readonly string[],
): DiagnosisCatalogRow | undefined {
  const representative = memberKeys.flatMap((stableKey) => {
    const row = catalog.find((candidate) => candidate.stableKey === stableKey && candidate.active);
    return row ? [row] : [];
  })[0];
  if (!representative) return undefined;
  return {
    ...representative,
    stableKey: clinicalFamily,
    display: representative.display.replace(/,\s.*$/, ""),
    icd10Family: undefined,
    icd10Code: undefined,
    icd10Display: undefined,
    icd10: undefined,
  };
}

function stagedFamilyForMember(stableKey: string): string | undefined {
  return Object.entries(FAMILY_RESOLUTION_MODES).find(([, mode]) =>
    mode.mode === "staged" && mode.members.some((member) => member.stableKey === stableKey)
  )?.[0];
}

async function ensureEncounterDiagnosisLinked(
  fhir: DiagnosisPickFhirClient,
  encounterId: string,
  conditionReference: string,
  initialEncounter: Encounter | undefined,
): Promise<{ encounter: Encounter; changed: boolean }> {
  let encounter = initialEncounter;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    encounter ??= await fhir.read<Encounter>("Encounter", encounterId);
    if (encounter.diagnosis?.some((diagnosis) => diagnosis.condition.reference === conditionReference)) {
      return { encounter, changed: false };
    }
    const nextRank = Math.max(0, ...(encounter.diagnosis ?? []).map((diagnosis) =>
      Number.isInteger(diagnosis.rank) && (diagnosis.rank ?? 0) > 0 ? diagnosis.rank! : 0
    )) + 1;
    try {
      const updated = await fhir.update<Encounter>("Encounter", encounterId, {
        ...encounter,
        diagnosis: [
          ...(encounter.diagnosis ?? []),
          buildEncounterDiagnosisComponent(conditionReference, nextRank),
        ],
      }, {
        ...DIAGNOSIS_PICK_WRITE_HEADERS,
        ...(encounter.meta?.versionId ? { "If-Match": `W/\"${encounter.meta.versionId}\"` } : {}),
      });
      return { encounter: updated, changed: true };
    } catch (error) {
      if (!isConflict(error) || attempt === 1) throw error;
      encounter = await fhir.read<Encounter>("Encounter", encounterId);
    }
  }
  throw new Error("Encounter diagnosis linking exhausted its retry budget.");
}

async function ensureEncounterDiagnosisUnlinked(
  fhir: DiagnosisPickFhirClient,
  encounterId: string,
  conditionReference: string,
  initialEncounter: Encounter | undefined,
): Promise<{ encounter: Encounter; changed: boolean }> {
  let encounter = initialEncounter;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    encounter ??= await fhir.read<Encounter>("Encounter", encounterId);
    if (!encounter.diagnosis?.some((diagnosis) => diagnosis.condition.reference === conditionReference)) {
      return { encounter, changed: false };
    }
    try {
      const updated = await fhir.update<Encounter>("Encounter", encounterId, {
        ...encounter,
        diagnosis: encounter.diagnosis.filter((diagnosis) => diagnosis.condition.reference !== conditionReference),
      }, {
        ...DIAGNOSIS_PICK_WRITE_HEADERS,
        ...(encounter.meta?.versionId ? { "If-Match": `W/\"${encounter.meta.versionId}\"` } : {}),
      });
      return { encounter: updated, changed: true };
    } catch (error) {
      if (!isConflict(error) || attempt === 1) throw error;
      encounter = await fhir.read<Encounter>("Encounter", encounterId);
    }
  }
  throw new Error("Encounter diagnosis unlinking exhausted its retry budget.");
}

async function findEncounterDiagnosis(
  fhir: DiagnosisPickFhirClient,
  encounterReference: string,
  compositeIdentifierValue: string,
  legacyIdentifierValue: string,
  pendingFamilyIdentifierValues: readonly string[],
  stagedMemberIdentifierValues: readonly string[],
): Promise<{ existing?: Condition; conflictingStagedMember?: Condition }> {
  const bundle = await fhir.search<Condition>("Condition", { encounter: encounterReference, _count: "200" });
  const conditions = (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
  const exact = conditions.find((condition) =>
    condition.identifier?.some((identifier) => identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM &&
      (identifier.value === compositeIdentifierValue || identifier.value === legacyIdentifierValue))
  );
  const pendingFamily = conditions.find((condition) =>
    !condition.code?.coding?.some((coding) => coding.system === ICD10_CM_CODE_SYSTEM && coding.code) &&
    condition.identifier?.some((identifier) => identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM &&
      identifier.value !== undefined && pendingFamilyIdentifierValues.includes(identifier.value))
  );
  const conflictingStagedMember = conditions.find((condition) =>
    condition.clinicalStatus?.coding?.some((coding) => coding.code === "active") === true &&
    condition.verificationStatus?.coding?.some((coding) => coding.code === "refuted" || coding.code === "entered-in-error") !== true &&
    condition.identifier?.some((identifier) => identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM &&
      identifier.value !== undefined && stagedMemberIdentifierValues.includes(identifier.value))
  );
  return { existing: exact ?? pendingFamily, conflictingStagedMember };
}

async function updateCondition(
  fhir: DiagnosisPickFhirClient,
  existing: Condition,
  diagnosis: DiagnosisCatalogRow,
  compositeIdentifierValue: string,
  replacedIdentifierValues: readonly string[],
  codes: readonly string[],
  verificationStatus: ConditionVerificationStatusCode,
  evidenceReference: string | undefined,
): Promise<Condition> {
  if (!existing.id) throw new Error("Existing diagnosis Condition has no id.");
  const evidence = [...(existing.evidence ?? [])];
  if (evidenceReference && !evidence.flatMap((row) => row.detail ?? []).some((row) => row.reference === evidenceReference)) {
    evidence.push({ detail: [{ reference: evidenceReference }] });
  }
  const identifiers = (existing.identifier ?? []).map((identifier) =>
    identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM &&
      identifier.value !== undefined && replacedIdentifierValues.includes(identifier.value)
      ? { ...identifier, value: compositeIdentifierValue }
      : identifier
  );
  if (!identifiers.some((identifier) => identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM && identifier.value === compositeIdentifierValue)) {
    identifiers.push({ system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM, value: compositeIdentifierValue });
  }
  const uniqueIdentifiers = identifiers.filter((identifier, index) => identifiers.findIndex((candidate) =>
    candidate.system === identifier.system && candidate.value === identifier.value
  ) === index);
  const next: Condition = {
    ...existing,
    identifier: uniqueIdentifiers,
    verificationStatus: verificationStatusConcept(verificationStatus),
    ...(verificationStatus === "refuted" ? {} : {
      code: conditionCodeForResolution(diagnosis, codes),
    }),
    ...(evidence.length ? { evidence } : {}),
  };
  return fhir.update("Condition", existing.id, next, {
    ...DIAGNOSIS_PICK_WRITE_HEADERS,
    ...(existing.meta?.versionId ? { "If-Match": `W/\"${existing.meta.versionId}\"` } : {}),
  });
}

function conditionCodeForResolution(row: DiagnosisCatalogRow, codes: readonly string[]): CodeableConcept {
  if (codes.length === 1) {
    return {
      coding: [{ system: ICD10_CM_CODE_SYSTEM, code: codes[0], display: row.display }],
      text: row.display,
    };
  }
  if (codes.length > 1) {
    return {
      coding: [{ system: DIAGNOSIS_CATALOG_CODE_SYSTEM, code: row.stableKey, display: row.display }],
      text: row.display,
    };
  }
  return { text: row.display };
}

function diagnosisLateralityBucket(
  row: DiagnosisCatalogRow,
  laterality: "right" | "left" | "bilateral" | undefined,
  visualFieldDescriptor?: VisualFieldDescriptorResolution,
): LateralityBucket | "field-right" | "field-left" {
  if (!row.icd10 || "code" in row.icd10) return "none";
  if (
    visualFieldDescriptor?.codeSelection?.kind === "field" &&
    row.stableKey === "vf_homonymous_bilateral"
  ) return `field-${visualFieldDescriptor.codeSelection.slot}`;
  if (
    visualFieldDescriptor?.codeSelection?.kind === "eye" &&
    row.clinicalFamily === "visual-field-defect" &&
    row.lateralityRequired
  ) return visualFieldDescriptor.codeSelection.slot;
  if (!row.lateralityRequired) return "none";
  return laterality ?? "unspecified";
}

function observationLaterality(observation: Observation | undefined): string | undefined {
  return observation?.extension?.find((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality)
    ?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code ??
    observation?.bodySite?.coding?.find((coding) => coding.code)?.code;
}

function normalizeLaterality(value: string | undefined): "right" | "left" | "bilateral" | undefined {
  if (value === "OD" || value === "right") return "right";
  if (value === "OS" || value === "left") return "left";
  if (value === "OU" || value === "bilateral") return "bilateral";
  return undefined;
}

function stripReference(value: string, resourceType: string): string {
  return value.replace(new RegExp(`^${resourceType}/`), "");
}

function readEncounterId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.encounterId;
  return typeof id === "string" && /^[A-Za-z0-9.-]+$/.test(id) ? id : undefined;
}

function staffMay(role: PracticeRoleId, action: "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConflict(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return status === 409 || status === 412 || /FHIR (409|412)\b/.test(errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
