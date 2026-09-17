import { isClosedEncounter } from "./encounter-sign-gate.js";
import { diagnosisDefinitionViews } from "./diagnosis-candidates-endpoint.js";
import { currentFindingKeySchema, currentFindingIdentifier, ownsFact } from "./current-finding-identity.js";
import { customFieldEntries } from "./custom-fields.js";
import { loadDiagnosisFindingContext, findingTargetReadOnlyReason } from "./diagnosis-findings-endpoint.js";
import { randomUUID } from "node:crypto";
import type { Basic, Bundle, ChargeItem, CodeableConcept, Condition, Encounter, Money, Observation, Provenance, Resource } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import {
  buildEncounterDiagnosisComponent,
  buildEncounterDiagnosisCondition,
  isConfirmedEncounterDiagnosis,
  verificationStatusConcept,
  type ConditionVerificationStatusCode,
} from "../fhir/condition.js";
import { ODOS_EXTENSION_URLS } from "../fhir/ophthalmology/extensions.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { isRelativeFhirReference } from "../fhir/reference.js";
import { collectAllFhirSearchPages, searchAll, type FhirSearchClient } from "../fhir-search.js";
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

type PickResource = Basic | ChargeItem | Condition | Encounter | Observation | Provenance;
type LateralityBucket = "right" | "left" | "bilateral" | "unspecified" | "none";

interface StrandedCharge {
  reference: string;
  display: string;
  amount: Money | null;
}

interface DiagnosisDemotionImpact {
  strandedCharges: StrandedCharge[];
  unaffectedChargeCount: number;
  strandedChargesComputed: boolean;
}

export interface DiagnosisPickFhirClient extends FhirSearchClient {
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  create<T extends PickResource>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends PickResource>(resourceType: T["resourceType"], id: string, resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  executeTransaction(
    bundle: Bundle,
    extraHeaders?: Record<string, string>,
    options?: { autoRollbackCreatedEntries?: boolean },
  ): Promise<Bundle>;
}

const supportSchema = z.object({
  key: currentFindingKeySchema,
  baseline: z.object({ kind: z.literal("canonical"), reference: z.string().regex(/^Observation\/[A-Za-z0-9.-]+$/), versionId: z.string().min(1) }).strict(),
}).strict();
const pickSchema = z.object({
  commandId: z.string().uuid().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).optional(),
  supportingFacts: z.array(supportSchema).min(1).optional(),
  findingInstanceId: z.string().trim().min(1).optional(),
  diagnosisKey: z.string().trim().min(1),
  action: z.enum(["possible", "confirm", "discard"]),
  laterality: z.enum(["OD", "OS", "OU", "right", "left", "bilateral"]).optional(),
  source: z.enum(["rule", "mapping", "catalog-search"]).optional(),
  status: z.enum(DIAGNOSIS_VISIT_STATUSES).optional(),
  stageDeferred: z.boolean().optional(),
}).strict();

async function performDiagnosisPickRequest(
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
  if (!staffHasBusinessAction(staff, "chart.diagnosis.write")) return { status: 403, body: { error: "chart.diagnosis.write role required" } };
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

  let encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
  if (isClosedEncounter(encounter)) return { status: 409, body: { result: "invalid", reason: "encounter-closed", error: "Signed or closed encounters cannot be edited." } };
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
  let supportLaterality: "right" | "left" | "bilateral" | undefined;
  const supports = parsed.data.supportingFacts;
  if (supports || parsed.data.findingInstanceId) {
    const definitions = await new FhirFindingDefinitionStore(staff.fhir).list();
    const context = await loadDiagnosisFindingContext(staff.fhir, encounterId, definitions);
    if (context.incomplete) return { status: context.kind === "refused" ? 403 : context.kind === "missing" ? 404 : 502,
      body: { result: "unavailable", kind: context.kind, error: context.reason } };
    const definitionViews = diagnosisDefinitionViews(context.projection, definitions);
    if (supports) {
      if (!parsed.data.commandId) return { status: 400, body: { result: "invalid", reason: "command-id-required", error: "Supported picks require a UUIDv4 commandId." } };
      if (context.projection.preRebuild) return { status: 409, body: { result: "invalid", reason: "pre-rebuild-test-encounter", error: "Test data from before the rebuild is read-only." } };
      const seen = new Set<string>();
      for (const [targetIndex, support] of supports.entries()) {
        const identity = currentFindingIdentifier(support.key).value!;
        const fact = context.projection.currentFacts.find(f => currentFindingIdentifier(f.key).value === identity);
        const reason = findingTargetReadOnlyReason(context, support.key);
        if (seen.has(identity) || !fact || fact.status !== "live" || fact.presence !== "present" || fact.baseline?.kind !== "canonical" ||
          fact.baseline.reference !== support.baseline.reference || fact.baseline.versionId !== support.baseline.versionId || reason ||
          support.key.stableKey !== supports[0].key.stableKey) {
          return { status: reason === "signed-or-cancelled" ? 422 : 400, body: { result: "invalid", reason: reason ?? "invalid-support", targetIndex, error: "Each support must be a unique, current, editable present fact in this view." } };
        }
        seen.add(identity);
      }
      const eyes = new Set(supports.map(s => s.key.eye));
      supportLaterality = eyes.size === 2 ? "bilateral" : eyes.has("OD") ? "right" : "left";
      if (parsed.data.laterality && normalizeLaterality(parsed.data.laterality) !== supportLaterality) return { status: 400, body: { result: "invalid", reason: "support-laterality", error: "Laterality must equal the supporting eyes." } };
      findingDefinitionStableKey = supports[0].key.stableKey;
      const views = definitionViews.filter(v => findingDefinitionForObservation(v, definitions)?.stableKey === findingDefinitionStableKey &&
        eyes.has(observationLaterality(v) as "OD" | "OS"));
      if (views.length !== eyes.size || parsed.data.findingInstanceId && !views.some(v => (v.id ?? v.projectionKey) === stripReference(parsed.data.findingInstanceId!, "Observation"))) {
        return { status: 400, body: { result: "invalid", reason: "support-view", error: "Supports must belong to the selected finding view." } };
      }
      observation = views[0];
    } else {
      const findingId = stripReference(parsed.data.findingInstanceId!, "Observation");
      observation = definitionViews.find(v => (v.id ?? v.projectionKey) === findingId);
      const raw = context.state.observations.find(o => o.id === findingId);
      const rawDefinition = raw && findingDefinitionForObservation(raw, definitions);
      if (rawDefinition && customFieldEntries(rawDefinition, true).some(f => ownsFact(rawDefinition, f)) && context.projection.preRebuild) {
        return { status: 409, body: { result: "invalid", reason: "pre-rebuild-test-encounter", error: "Test data from before the rebuild is read-only." } };
      }
      if (!observation) return { status: 404, body: { error: `Finding ${findingId} does not exist in the current projection.` } };
      findingDefinitionStableKey = findingDefinitionForObservation(observation, definitions)?.stableKey;
      if (!findingDefinitionStableKey) return { status: 422, body: { error: "The finding does not resolve to an active finding definition." } };
    }
  }

  const laterality = supportLaterality ?? normalizeLaterality(observationLaterality(observation) ?? parsed.data.laterality);
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

  let patientReference = observation?.subject?.reference;
  if (!patientReference) {
    encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
    patientReference = encounter.subject?.reference;
  }
  if ((parsed.data.status || parsed.data.action === "confirm" || parsed.data.action === "discard") && !encounter) {
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
  const evidenceReference = !supports && observation?.id ? `Observation/${observation.id}` : undefined;
  const conditionDraft = existing
    ? updatedCondition(
        existing,
        diagnosis,
        compositeIdentifierValue,
        pendingFamilyIdentifierValues,
        codes,
        verificationStatus,
        evidenceReference,
      )
    : buildEncounterDiagnosisCondition({
        patientReference,
        encounterReference,
        code: conditionCodeForResolution(diagnosis, codes),
        verificationStatus,
        recordedDate: recordedAt,
        identifiers: [{ system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM, value: compositeIdentifierValue }],
        ...(evidenceReference ? { evidenceObservationReferences: [evidenceReference] } : {}),
      });
  const conditionFullUrl = existing ? `Condition/${existing.id}` : `urn:uuid:${randomUUID()}`;
  const provenanceFullUrl = `urn:uuid:${randomUUID()}`;
  let condition: Condition | undefined;
  let linkedEncounter: Encounter | undefined;
  let provenance: Provenance | undefined;
  let encounterSnapshot = encounter;
  const failedStep = (status: number, error: string) => ({ status, body: { result: "pick", ...(parsed.data.commandId ? { commandId: parsed.data.commandId } : {}),
    conditionStep: "failed", link: supports && parsed.data.action !== "discard" ? "pending" : "not-applicable", error } });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const encounterChange = parsed.data.action === "confirm"
      ? linkEncounterDiagnosis(encounterSnapshot!, conditionFullUrl)
      : parsed.data.action === "discard"
        ? unlinkEncounterDiagnosis(encounterSnapshot!, conditionFullUrl)
        : undefined;
    const provenanceDraft = buildProvenance({
      targetReferences: [conditionFullUrl, ...(encounterChange?.changed ? [encounterReference] : [])],
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
    }) as Provenance;
    const transactionBundle: Bundle = {
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        existing
          ? {
              fullUrl: conditionFullUrl,
              resource: conditionDraft,
              request: {
                method: "PUT",
                url: conditionFullUrl,
                ...(existing.meta?.versionId ? { ifMatch: `W/\"${existing.meta.versionId}\"` } : {}),
              },
            }
          : {
              fullUrl: conditionFullUrl,
              resource: conditionDraft,
              request: {
                method: "POST",
                url: "Condition",
                ifNoneExist: `identifier=${DIAGNOSIS_KEY_IDENTIFIER_SYSTEM}|${compositeIdentifierValue}`,
              },
            },
        ...(encounterChange?.changed ? [{
          fullUrl: encounterReference,
          resource: encounterChange.encounter,
          request: {
            method: "PUT" as const,
            url: encounterReference,
            ...(encounterSnapshot?.meta?.versionId ? { ifMatch: `W/\"${encounterSnapshot.meta.versionId}\"` } : {}),
          },
        }] : []),
        {
          fullUrl: provenanceFullUrl,
          resource: provenanceDraft,
          request: { method: "POST", url: "Provenance" },
        },
      ],
    };

    try {
      const response = await staff.fhir.executeTransaction(transactionBundle, {
        ...DIAGNOSIS_PICK_WRITE_HEADERS,
        Prefer: "return=representation",
      }, { autoRollbackCreatedEntries: false });
      const persisted = diagnosisPickTransactionResources(transactionBundle, response, encounterChange?.changed === true);
      condition = persisted.condition;
      linkedEncounter = encounterChange ? persisted.encounter ?? encounterChange.encounter : undefined;
      provenance = persisted.provenance;
      break;
    } catch (error) {
      if (!isConflict(error)) {
        const cause = (error as { status?: number })?.status;
        const failed = cause !== undefined && cause >= 400 && cause < 500;
        return { status: failed ? cause : 502, body: { result: "pick", ...(parsed.data.commandId ? { commandId: parsed.data.commandId } : {}),
          conditionStep: failed ? "failed" : "unconfirmed", link: supports && parsed.data.action !== "discard" ? "pending" : "not-applicable", error: errorMessage(error) } };
      }
      if (existing?.id) {
        const currentCondition = await staff.fhir.read<Condition>("Condition", existing.id);
        if (currentCondition.meta?.versionId !== existing.meta?.versionId) {
          return failedStep(409, "This diagnosis was modified concurrently — reload and retry.");
        }
      }
      if (encounterChange?.changed && attempt === 0) {
        encounterSnapshot = await staff.fhir.read<Encounter>("Encounter", encounterId);
        continue;
      }
      return failedStep(409, encounterChange?.changed
        ? "The encounter diagnoses changed concurrently — reload and retry."
        : "This diagnosis was modified concurrently — reload and retry.");
    }
  }
  if (!condition || !provenance) throw new Error("Diagnosis pick transaction exhausted its retry budget.");

  const conditionReference = `Condition/${condition.id}`;
  let demotionImpact: DiagnosisDemotionImpact = {
    strandedCharges: [],
    unaffectedChargeCount: 0,
    strandedChargesComputed: true,
  };
  if (existing && isConfirmedEncounterDiagnosis(existing) && !isConfirmedEncounterDiagnosis(condition)) {
    try {
      demotionImpact = await diagnosisDemotionImpact(staff.fhir, encounterReference, conditionReference);
    } catch (error) {
      demotionImpact = {
        strandedCharges: [],
        unaffectedChargeCount: 0,
        strandedChargesComputed: false,
      };
      console.error(`Diagnosis demotion charge impact failed after ${conditionReference}: ${errorMessage(error)}`);
    }
  }

  let diagnosisVisitStatus: Awaited<ReturnType<DiagnosisVisitStatusStore["upsert"]>> | undefined;
  let visitStatusError: string | undefined;
  if (parsed.data.status) {
    try {
      diagnosisVisitStatus = await deps.diagnosisVisitStatusStore.upsert({ conditionReference, encounterId,
        status: parsed.data.status, setBy: staff.staffReference, at: recordedAt });
    } catch {
      visitStatusError = "Diagnosis applied, but its visit status could not be saved.";
    }
  }

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

  const after = await staff.fhir.read<Encounter>("Encounter", encounterId);
  return {
    status: 200,
    body: {
      ...(isClosedEncounter(after) ? { encounterClosedDuringCommand: true } : {}),
      result: "pick",
      ...(parsed.data.commandId ? { commandId: parsed.data.commandId } : {}),
      conditionStep: "applied",
      link: supports && parsed.data.action !== "discard" ? "pending" : "not-applicable",
      condition,
      ...(linkedEncounter ? { encounter: linkedEncounter } : {}),
      provenanceReference: provenance.id ? `Provenance/${provenance.id}` : undefined,
      action: parsed.data.action,
      ...demotionImpact,
      ...(diagnosisVisitStatus ? { diagnosisVisitStatus } : {}),
      ...(visitStatusError ? { error: visitStatusError } : {}),
    },
  };
}

export type DiagnosisPickResponse = ({ result: "pick"; commandId?: string; link: "pending" | "not-applicable" } & (
  ({ conditionStep: "applied"; condition: Condition; encounter?: Encounter; provenanceReference?: string; error?: string; action: string;
    diagnosisVisitStatus?: Awaited<ReturnType<DiagnosisVisitStatusStore["upsert"]>> } & DiagnosisDemotionImpact) |
  { conditionStep: "unconfirmed" | "failed"; error: string }
)) |
  { result: "unavailable"; kind: "refused" | "missing" | "upstream" | "foreign-or-unscoped"; error: string } |
  { result: "invalid"; error: string; reason: string; targetIndex?: number } |
  { result: "unauthenticated" | "forbidden"; error: string };
export async function handleDiagnosisPickRequest(...args: Parameters<typeof performDiagnosisPickRequest>): Promise<{ status: number; body: DiagnosisPickResponse }> {
  try {
    const response = await performDiagnosisPickRequest(...args);
    const body = response.body as Record<string, unknown>;
    if (body.result) return response as { status: number; body: DiagnosisPickResponse };
    const result = response.status === 401 ? "unauthenticated" : response.status === 403 ? "forbidden" : "invalid";
    return { status: response.status, body: { ...body, result, ...(result === "invalid" ? { reason: "invalid-pick" } : {}) } as DiagnosisPickResponse };
  } catch (error) {
    const status = (error as { status?: number })?.status;
    const kind = status === 401 || status === 403 ? "refused" : status === 404 || status === 410 ? "missing" : "upstream";
    return { status: kind === "refused" ? 403 : kind === "missing" ? 404 : 502, body: { result: "unavailable", kind, error: "Diagnosis pick context could not be loaded." } };
  }
}

async function diagnosisDemotionImpact(
  fhir: DiagnosisPickFhirClient,
  encounterReference: string,
  changedConditionReference: string,
): Promise<DiagnosisDemotionImpact> {
  const [conditions, charges] = await Promise.all([
    searchAll<Condition>(fhir, "Condition", { encounter: encounterReference, _count: "200" }),
    searchAll<ChargeItem>(fhir, "ChargeItem", { context: encounterReference, _count: "100" }),
  ]);
  const confirmedConditionReferences = new Set(
    conditions.flatMap((condition) => {
      return condition.id && isConfirmedEncounterDiagnosis(condition)
        ? [`Condition/${condition.id}`]
        : [];
    }),
  );
  const touchingCharges = charges.flatMap((charge) => {
    return charge.supportingInformation?.some((reference) => reference.reference === changedConditionReference)
      ? [charge]
      : [];
  });
  let unaffectedChargeCount = 0;
  const strandedCharges: StrandedCharge[] = [];
  for (const charge of touchingCharges) {
    const retainsConfirmedDiagnosis = charge.supportingInformation?.some((reference) =>
      reference.reference !== undefined &&
      confirmedConditionReferences.has(reference.reference)
    );
    if (retainsConfirmedDiagnosis) {
      unaffectedChargeCount += 1;
      continue;
    }
    if (!charge.id) continue;
    const reference = `ChargeItem/${charge.id}`;
    strandedCharges.push({
      reference,
      display: charge.code.text ?? charge.code.coding?.find((coding) => coding.display)?.display ?? reference,
      amount: charge.priceOverride ?? null,
    });
  }
  return { strandedCharges, unaffectedChargeCount, strandedChargesComputed: true };
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

function linkEncounterDiagnosis(
  encounter: Encounter,
  conditionReference: string,
): { encounter: Encounter; changed: boolean } {
  if (encounter.diagnosis?.some((diagnosis) => diagnosis.condition.reference === conditionReference)) {
    return { encounter, changed: false };
  }
  const nextRank = Math.max(0, ...(encounter.diagnosis ?? []).map((diagnosis) =>
    Number.isInteger(diagnosis.rank) && (diagnosis.rank ?? 0) > 0 ? diagnosis.rank! : 0
  )) + 1;
  return {
    encounter: {
      ...encounter,
      diagnosis: [
        ...(encounter.diagnosis ?? []),
        buildEncounterDiagnosisComponent(conditionReference, nextRank),
      ],
    },
    changed: true,
  };
}

function unlinkEncounterDiagnosis(
  encounter: Encounter,
  conditionReference: string,
): { encounter: Encounter; changed: boolean } {
  if (!encounter.diagnosis?.some((diagnosis) => diagnosis.condition.reference === conditionReference)) {
    return { encounter, changed: false };
  }
  return {
    encounter: {
      ...encounter,
      diagnosis: encounter.diagnosis.filter((diagnosis) => diagnosis.condition.reference !== conditionReference),
    },
    changed: true,
  };
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
  const conditions = await collectAllFhirSearchPages<Condition>(fhir, "Condition", bundle, fhir.baseUrl);
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

function updatedCondition(
  existing: Condition,
  diagnosis: DiagnosisCatalogRow,
  compositeIdentifierValue: string,
  replacedIdentifierValues: readonly string[],
  codes: readonly string[],
  verificationStatus: ConditionVerificationStatusCode,
  evidenceReference: string | undefined,
): Condition {
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
  return {
    ...existing,
    identifier: uniqueIdentifiers,
    verificationStatus: verificationStatusConcept(verificationStatus),
    ...(verificationStatus === "refuted" ? {} : {
      code: conditionCodeForResolution(diagnosis, codes),
    }),
    ...(evidence.length ? { evidence } : {}),
  };
}

function diagnosisPickTransactionResources(
  request: Bundle,
  response: Bundle,
  encounterChanged: boolean,
): { condition: Condition; encounter?: Encounter; provenance: Provenance } {
  if (response.resourceType !== "Bundle" || response.type !== "transaction-response") {
    throw new Error("Diagnosis pick FHIR transaction did not return a transaction-response Bundle.");
  }
  const responseEntries = response.entry;
  if (!responseEntries || responseEntries.length !== request.entry?.length) {
    throw new Error("Diagnosis pick FHIR transaction returned an incomplete response.");
  }
  for (const entry of responseEntries) {
    const status = Number.parseInt(entry.response?.status ?? "", 10);
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      throw Object.assign(new Error(`Diagnosis pick FHIR transaction failed with ${entry.response?.status ?? "no status"}.`), {
        ...(Number.isInteger(status) ? { status } : {}),
      });
    }
  }
  const condition = responseEntries[0]?.resource;
  const encounter = encounterChanged ? responseEntries[1]?.resource : undefined;
  const provenance = responseEntries.at(-1)?.resource;
  if (condition?.resourceType !== "Condition" || !condition.id) {
    throw new Error("Diagnosis pick FHIR transaction did not return the persisted Condition.");
  }
  if (encounterChanged && (encounter?.resourceType !== "Encounter" || !encounter.id)) {
    throw new Error("Diagnosis pick FHIR transaction did not return the persisted Encounter.");
  }
  if (provenance?.resourceType !== "Provenance" || !provenance.id) {
    throw new Error("Diagnosis pick FHIR transaction did not return the persisted Provenance.");
  }
  return {
    condition,
    ...(encounter?.resourceType === "Encounter" ? { encounter } : {}),
    provenance,
  };
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

function staffMay(role: PracticeRoleId, action: "chart.diagnosis.write"): boolean {
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
