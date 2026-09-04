import type {
  Basic,
  Bundle,
  Condition,
  Encounter,
  MedicationAdministration,
  Observation,
  OperationOutcome,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import { z } from "zod";
import { staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import { verificationStatusConcept } from "../fhir/condition.js";
import { ODOS_EXTENSION_URLS, odosConcept, reference } from "../fhir/ophthalmology/extensions.js";
import { searchAll } from "../fhir-search.js";
import { stampPrimaryComplaint } from "./complaint-endpoint.js";
import type { EncounterComplaint } from "./complaint-model.js";
import { buildComplaintDefinitionSeeds } from "./complaint-model.js";
import {
  HISTORY_REVIEW_ATTESTATION_CODE,
  HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM,
  HISTORY_REVIEW_SECTION_EXTENSION_URL,
  isHistoryAnswerObservation,
  parseHistoryAnswerObservation,
} from "./history-answer-observation.js";
import {
  ENCOUNTER_COMPLAINT_CODE,
  ENCOUNTER_COMPLAINT_CODE_SYSTEM,
  buildEncounterComplaintResource,
  parseEncounterComplaintResource,
} from "./encounter-complaint-store.js";
import { CLOSED_ENCOUNTER_EDIT_ERROR, isClosedEncounter } from "./encounter-sign-gate.js";
import {
  FhirEncounterUndoLedgerStore,
  buildEncounterUndoLedgerResource,
  emptyEncounterUndoLedger,
  type EncounterUndoLedger,
  type UndoLedgerEntry,
  type UndoLedgerSlot,
} from "./encounter-undo-ledger-store.js";
import { findingDefinitionForObservation } from "./finding-observation-match.js";
import type { ClinicalFindingDefinition, ClinicalGraphProvenance } from "./glaucoma-suspect.js";
import { isLiveObservation } from "./observation-liveness.js";

/**
 * POST /clinical-graph/encounters/:encounterId/void
 *
 * The one pre-finalization delete primitive. Nothing is ever hard-deleted: an Observation
 * flips to `entered-in-error`, a Condition's verificationStatus flips to `entered-in-error`
 * (and it leaves `Encounter.diagnosis`), a presenting complaint flips to `removed`. Every
 * flipped Observation/Condition gets one VOID Provenance. All writes for one request go in
 * one FHIR transaction, so a conflict leaves the chart untouched.
 *
 * Four scopes, one sign gate:
 *   observation — one Observation by reference (tier 1, shape A)
 *   finding     — every Observation for (findingKey, laterality?) in the encounter (tier 1/2)
 *   section     — every entry whose section key matches (exact or `key:` prefix) (tier 2)
 *   encounter   — everything recorded under this encounter (tier 3)
 *
 * The encounter boundary is the one line this primitive draws itself: only resources whose
 * `encounter` is this encounter are candidates. Values carried forward from a prior visit
 * belong to that visit's (signed) record and are never touched.
 *
 * `preview: true` resolves the same candidate set and returns the counts without writing.
 *
 * Every real void also writes the encounter's Undo ledger (§4b.4) IN THE SAME TRANSACTION:
 * the slot for the action's scope — the visit slot for `encounter`, the section's slot for
 * everything else — is overwritten with exactly the set this action voided and each
 * resource's prior status. A visit clear empties every section slot (§4b.2 rule 3).
 */

export const VOID_WRITE_HEADERS = { "X-ODOS-Source": "mcp/void_encounter_entries" } as const;
export const VOID_PROVENANCE_NOTE = "Voided by clinician before sign.";
export const ENCOUNTER_UNDO_LABEL = "everything charted";
export const CONCURRENT_EDIT_MESSAGE =
  "This record was changed by someone else since you opened it. Reload and reapply your change.";

/** Pseudo section keys for the two non-Observation shapes. */
export const COMPLAINTS_SECTION_KEY = "complaints";
export const ASSESSMENT_SECTION_KEY = "assessment";
export const HISTORY_SECTION_KEY = "hpi";
const OTHER_SECTION_KEY = "other";

const SECTION_LABELS: Record<string, string> = {
  [HISTORY_SECTION_KEY]: "History",
  "ocular-history": "Ocular History",
  "medical-history": "Medical History",
  "social-history": "Social History",
  [COMPLAINTS_SECTION_KEY]: "Complaints",
  [ASSESSMENT_SECTION_KEY]: "Assessment",
  tonometry: "IOP",
  refraction: "Refraction",
  "auto-refraction": "Auto-refraction / Auto-K",
  va: "Visual acuity",
  "optic-nerve": "Cup/Disc",
  gonioscopy: "Gonioscopy",
  wearing: "Wearing Rx",
  "myopia-progression": "Eye growth",
  oct: "OCT",
  [OTHER_SECTION_KEY]: "Other",
};

export interface EncounterVoidFhirClient {
  readonly baseUrl: string;
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
  executeTransaction(bundle: Bundle, extraHeaders?: Record<string, string>): Promise<Bundle>;
}

export interface EncounterVoidEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: EncounterVoidFhirClient;
  } | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
}

export type VoidLaterality = "OD" | "OS" | "OU" | "UNKNOWN";

export interface VoidSectionSummary {
  sectionKey: string;
  label: string;
  count: number;
}

/** One live Observation the request would void, identified so a reopened sheet can rehydrate its per-item controls. */
export interface VoidCandidateEntry {
  reference: string;
  sectionKey: string;
  findingKey: string;
  laterality: VoidLaterality;
}

export interface EncounterVoidResponse {
  voided: string[];
  count: number;
  sections: VoidSectionSummary[];
  /** Every Observation in `voided`, with its section, finding key, and laterality. */
  entries: VoidCandidateEntry[];
  preview: boolean;
  /** The encounter's Undo ledger after this request — what the client renders its strips from. */
  ledger: EncounterUndoLedger;
}

const sectionKeySchema = z.string().trim().min(1).max(200);
const sectionKeysSchema = z.union([sectionKeySchema, z.array(sectionKeySchema).min(1).max(50)]);
const previewSchema = z.object({
  preview: z.boolean().optional(),
  /** What the Undo strip should say was cleared ("Reactivity · OD"); the server derives one when absent. */
  label: z.string().trim().min(1).max(120).optional(),
});
const observationReferenceSchema = z.string().regex(/^Observation\/[A-Za-z0-9.-]+$/);
const requestSchema = z.discriminatedUnion("scope", [
  previewSchema.extend({
    scope: z.literal("observation"),
    observationReference: z.union([
      observationReferenceSchema,
      z.array(observationReferenceSchema).min(1).max(50),
    ]),
    /** The sheet's own section key(s), so a two-definition sheet keeps one Undo slot. */
    sectionKey: sectionKeysSchema.optional(),
  }).strict(),
  previewSchema.extend({
    scope: z.literal("finding"),
    findingKey: z.string().trim().min(1).max(200),
    laterality: z.enum(["OD", "OS", "OU", "UNKNOWN"]).optional(),
    sectionKey: sectionKeysSchema.optional(),
  }).strict(),
  previewSchema.extend({
    scope: z.literal("section"),
    sectionKey: sectionKeysSchema,
  }).strict(),
  previewSchema.extend({ scope: z.literal("encounter") }).strict(),
]);

export type EncounterVoidRequest = z.infer<typeof requestSchema>;

interface IdentifiedObservation {
  observation: Observation & { id: string };
  findingKey: string;
  sectionKey: string;
  laterality: VoidLaterality;
}

export interface ComplaintRow {
  resource: Basic & { id: string };
  complaint: EncounterComplaint;
}

export async function handleEncounterVoidRequest(
  deps: EncounterVoidEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to void encounter entries." } };
  if (!staffHasBusinessAction(staff, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const encounterId = readId(input.params, "encounterId");
  if (!encounterId) return { status: 400, body: { error: "A valid encounter id is required." } };
  const parsed = requestSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid void request." } };
  }

  let encounter: Encounter;
  try {
    encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
  } catch {
    return { status: 404, body: { error: "Encounter not found." } };
  }
  // The sign gate closes every write. A preview writes nothing and is allowed after sign: a signed
  // chart still shows what it recorded, with its controls present-but-disabled (§3, §4b.5), so
  // the sheet must still be able to learn what it holds.
  if (isClosedEncounter(encounter) && parsed.data.preview !== true) {
    return { status: 409, body: { error: CLOSED_ENCOUNTER_EDIT_ERROR, code: "encounter-closed" } };
  }
  const patientReference = encounter.subject?.reference;
  if (!patientReference || !/^Patient\/[A-Za-z0-9.-]+$/.test(patientReference)) {
    return { status: 400, body: { error: "Encounter must reference a Patient subject." } };
  }
  const encounterReference = `Encounter/${encounterId}`;
  const definitions = (deps.findingDefinitions?.() ?? []).filter((definition) => definition.active);
  const request = parsed.data;

  // --- Candidate resolution -------------------------------------------------------------
  // The encounter boundary: only this encounter's resources are ever candidates.
  const observations = (await searchAll<Observation>(staff.fhir, "Observation", { encounter: encounterReference }))
    .filter((observation): observation is Observation & { id: string } =>
      typeof observation.id === "string" &&
      observation.encounter?.reference === encounterReference &&
      observation.subject?.reference === patientReference &&
      isLiveObservation(observation)
    )
    .map((observation) => identify(observation, definitions));

  let targetObservations: IdentifiedObservation[] = [];
  let includeComplaints = false;
  let targetComplaintIds: Set<string> | undefined;
  let includeConditions = false;
  if (request.scope === "observation") {
    // All-or-nothing: a caller that names N references means all N. Voiding the valid subset
    // would leave a refraction block half-gone — the UI drops it while one eye stays live.
    const wanted = Array.isArray(request.observationReference) ? request.observationReference : [request.observationReference];
    const live = new Map(observations.map((row) => [`Observation/${row.observation.id}`, row]));
    const missing = wanted.filter((reference) => !live.has(reference));
    if (missing.length > 0) {
      return {
        status: 404,
        body: {
          error: `Not a live entry of this encounter: ${missing.join(", ")}. Nothing was voided.`,
          missing,
        },
      };
    }
    targetObservations = [...new Set(wanted)].map((reference) => live.get(reference)!);
  } else if (request.scope === "finding") {
    targetObservations = observations.filter((row) =>
      row.findingKey === request.findingKey &&
      (request.laterality === undefined || row.laterality === request.laterality)
    );
    if (request.findingKey.startsWith("hpi-complaint:")) {
      includeComplaints = true;
      targetComplaintIds = new Set([request.findingKey.slice("hpi-complaint:".length)]);
    }
  } else if (request.scope === "section") {
    const keys = Array.isArray(request.sectionKey) ? request.sectionKey : [request.sectionKey];
    const matches = (sectionKey: string) => keys.some((key) => sectionKey === key || sectionKey.startsWith(`${key}:`));
    targetObservations = observations.filter((row) => matches(row.sectionKey));
    includeComplaints = matches(HISTORY_SECTION_KEY) || matches(COMPLAINTS_SECTION_KEY);
    includeConditions = matches(ASSESSMENT_SECTION_KEY);
  } else {
    targetObservations = observations;
    includeComplaints = true;
    includeConditions = true;
  }

  const conditions: Array<Condition & { id: string }> = includeConditions
    ? (await searchAll<Condition>(staff.fhir, "Condition", { encounter: encounterReference }))
        .filter((condition): condition is Condition & { id: string } =>
          typeof condition.id === "string" &&
          condition.encounter?.reference === encounterReference &&
          condition.subject?.reference === patientReference &&
          isLiveCondition(condition)
        )
    : [];
  const activeComplaintRows: ComplaintRow[] = includeComplaints ? await activeComplaints(staff.fhir, encounterId) : [];
  const complaints = targetComplaintIds
    ? activeComplaintRows.filter((row) => targetComplaintIds.has(row.complaint.id))
    : activeComplaintRows;
  // Dilation records the drops as MedicationAdministration and links them from the DFE
  // Observation. Voiding only the Observation hides them while they stay clinically active,
  // so every administration a voided Observation is partOf is retired with it.
  let administrations: Array<MedicationAdministration & { id: string }>;
  try {
    administrations = await linkedAdministrations(staff.fhir, targetObservations, encounterReference, patientReference);
  } catch (error) {
    if (error instanceof LinkedAdministrationReadError) {
      // Fail closed: if a linked administration cannot be verified, the Observation must not
      // disappear while the medication might stay clinically active.
      return { status: 503, body: { error: error.message, code: "linked-administration-unavailable" } };
    }
    if (error instanceof LinkedAdministrationBoundaryError) {
      return { status: 422, body: { error: error.message, code: "linked-administration-foreign" } };
    }
    throw error;
  }

  // --- Summary --------------------------------------------------------------------------
  // Every voided resource is counted under a section BEFORE the summary is built, so the
  // confirm dialog's subtotals always sum to its total.
  const sectionCounts = new Map<string, number>();
  for (const row of targetObservations) sectionCounts.set(row.sectionKey, (sectionCounts.get(row.sectionKey) ?? 0) + 1);
  for (const administration of administrations) {
    const sectionKey = administrationSectionKey(administration, targetObservations);
    sectionCounts.set(sectionKey, (sectionCounts.get(sectionKey) ?? 0) + 1);
  }
  if (conditions.length) sectionCounts.set(ASSESSMENT_SECTION_KEY, conditions.length);
  if (complaints.length) sectionCounts.set(COMPLAINTS_SECTION_KEY, complaints.length);
  const sections: VoidSectionSummary[] = [...sectionCounts.entries()].map(([sectionKey, count]) => ({
    sectionKey,
    label: sectionLabel(sectionKey, definitions),
    count,
  }));
  const voided = [
    ...targetObservations.map((row) => `Observation/${row.observation.id}`),
    ...administrations.map((administration) => `MedicationAdministration/${administration.id}`),
    ...conditions.map((condition) => `Condition/${condition.id}`),
    ...complaints.map((row) => `Basic/${row.resource.id}`),
  ];
  const entries: VoidCandidateEntry[] = targetObservations.map((row) => ({
    reference: `Observation/${row.observation.id}`,
    sectionKey: row.sectionKey,
    findingKey: row.findingKey,
    laterality: row.laterality,
  }));
  const ledgerRow = await new FhirEncounterUndoLedgerStore(staff.fhir).readRow(encounterId);
  const currentLedger = ledgerRow?.ledger ?? emptyEncounterUndoLedger(encounterId);
  const preview = request.preview === true;
  if (preview || voided.length === 0) {
    const response: EncounterVoidResponse = { voided, count: voided.length, sections, entries, preview, ledger: currentLedger };
    return { status: 200, body: response };
  }

  // --- The Undo ledger slot for this action (§4b.4) -------------------------------------
  // priorStatus is recorded per resource so Undo restores what was there, not a constant.
  const now = deps.now?.() ?? new Date().toISOString();
  const diagnosisRows = new Map((encounter.diagnosis ?? []).map((row) => [row.condition.reference ?? "", row]));
  const ledgerEntries: UndoLedgerEntry[] = [
    ...targetObservations.map(({ observation }): UndoLedgerEntry => ({
      ref: `Observation/${observation.id}`,
      priorStatus: observation.status ?? "",
    })),
    ...administrations.map((administration): UndoLedgerEntry => ({
      ref: `MedicationAdministration/${administration.id}`,
      priorStatus: administration.status ?? "",
    })),
    ...conditions.map((condition): UndoLedgerEntry => {
      const ref = `Condition/${condition.id}`;
      const clinicalStatus = codeOf(condition.clinicalStatus);
      const diagnosis = diagnosisRows.get(ref);
      return {
        ref,
        priorStatus: codeOf(condition.verificationStatus) ?? "",
        ...(clinicalStatus ? { clinicalStatus } : {}),
        ...(diagnosis ? { diagnosis } : {}),
      };
    }),
    ...complaints.map((row): UndoLedgerEntry => ({ ref: `Basic/${row.resource.id}`, priorStatus: row.complaint.status })),
  ];
  const slotKeys = request.scope === "encounter"
    ? []
    : request.scope === "section"
      ? asList(request.sectionKey)
      : request.sectionKey !== undefined
        ? asList(request.sectionKey)
        : [...new Set(targetObservations.map((row) => row.sectionKey))];
  const slot: UndoLedgerSlot = {
    voided: ledgerEntries,
    label: request.label ?? (request.scope === "encounter"
      ? ENCOUNTER_UNDO_LABEL
      : request.scope === "section"
        ? sectionLabel(slotKeys[0]!, definitions)
        : tierOneLabel(targetObservations, definitions)),
    count: voided.length,
    at: now,
    sectionKeys: slotKeys,
    scope: request.scope,
  };
  const nextLedger: EncounterUndoLedger = request.scope === "encounter"
    // Rule 1: one visit slot, the latest wins. Rule 3: a visit clear absorbs every section Undo.
    ? { encounterId, encounter: slot, sections: {} }
    // Rule 2: one slot per section. Every slot this action's keys cover (exactly or as a
    // `key:` prefix, matching section-scope resolution) is replaced by this one.
    : {
        ...currentLedger,
        sections: {
          ...Object.fromEntries(Object.entries(currentLedger.sections).filter(([key]) =>
            !slotKeys.some((slotKey) => key === slotKey || key.startsWith(`${slotKey}:`))
          )),
          [slotKeys[0] ?? OTHER_SECTION_KEY]: slot,
        },
      };
  const response: EncounterVoidResponse = { voided, count: voided.length, sections, entries, preview, ledger: nextLedger };

  // --- One transaction ------------------------------------------------------------------
  const complaintProvenance: ClinicalGraphProvenance = {
    source: "manual",
    recordedAt: now,
    actorReference: staff.staffReference,
    note: VOID_PROVENANCE_NOTE,
  };
  const provenanceFor = (target: string): Provenance => chartProvenance({
    target,
    encounterReference,
    patientReference,
    staffReference: staff.staffReference,
    now,
    activity: { code: "VOID", display: "Void before sign", note: VOID_PROVENANCE_NOTE },
  });
  const transactionEntries: NonNullable<Bundle["entry"]> = [];
  for (const { observation } of targetObservations) {
    transactionEntries.push(putEntry(`Observation/${observation.id}`, { ...observation, status: "entered-in-error" }, observation.meta?.versionId));
    transactionEntries.push({ resource: provenanceFor(`Observation/${observation.id}`), request: { method: "POST", url: "Provenance" } });
  }
  for (const administration of administrations) {
    transactionEntries.push(putEntry(
      `MedicationAdministration/${administration.id}`,
      { ...administration, status: "entered-in-error" },
      administration.meta?.versionId,
    ));
    transactionEntries.push({
      resource: provenanceFor(`MedicationAdministration/${administration.id}`),
      request: { method: "POST", url: "Provenance" },
    });
  }
  for (const condition of conditions) {
    const { clinicalStatus: _clinicalStatus, ...withoutClinicalStatus } = condition;
    transactionEntries.push(putEntry(
      `Condition/${condition.id}`,
      { ...withoutClinicalStatus, verificationStatus: verificationStatusConcept("entered-in-error") },
      condition.meta?.versionId,
    ));
    transactionEntries.push({ resource: provenanceFor(`Condition/${condition.id}`), request: { method: "POST", url: "Provenance" } });
  }
  for (const { resource, complaint } of complaints) {
    transactionEntries.push(putEntry(
      `Basic/${resource.id}`,
      buildEncounterComplaintResource({
        ...complaint,
        status: "removed",
        provenance: complaintProvenance,
        provenanceHistory: [...complaint.provenanceHistory, complaintProvenance],
      }, resource),
      resource.meta?.versionId,
    ));
  }
  // The Encounter goes in EVERY void transaction, version-guarded, even when its body is
  // unchanged. The status read above is a snapshot; without this entry a concurrent sign can
  // finish the encounter while the void still commits. With it, the sign bumps the version and
  // the whole transaction fails closed as a concurrent edit.
  const retracted = new Set(conditions.map((condition) => `Condition/${condition.id}`));
  let nextEncounter: Encounter = encounter;
  if (complaints.length) {
    const removedComplaintIds = new Set(complaints.map((row) => row.complaint.id));
    nextEncounter = stampPrimaryComplaint(
      nextEncounter,
      activeComplaintRows.filter((row) => !removedComplaintIds.has(row.complaint.id)).map((row) => row.complaint),
      buildComplaintDefinitionSeeds(),
    );
  }
  if (conditions.length) {
    const diagnosis = (nextEncounter.diagnosis ?? []).filter((row) => !retracted.has(row.condition.reference ?? ""));
    nextEncounter = diagnosis.length ? { ...nextEncounter, diagnosis } : stripDiagnosis(nextEncounter);
  }
  transactionEntries.push(putEntry(encounterReference, nextEncounter, encounter.meta?.versionId));
  // The ledger is written by the void, in the void's transaction: a void without its Undo
  // slot, or a slot without its void, cannot exist.
  transactionEntries.push(ledgerEntry(nextLedger, ledgerRow?.resource));
  const transaction: Bundle = { resourceType: "Bundle", type: "transaction", entry: transactionEntries };
  try {
    const result = await staff.fhir.executeTransaction(transaction, VOID_WRITE_HEADERS);
    assertSuccessfulTransaction(transaction, result);
  } catch (error) {
    // A refused ENTRY already carries its outcome and its detail; on this non-atomic stack a
    // per-entry 412 can sit beside forty applied writes, so it is never folded into anything.
    if (error instanceof VoidTransactionError) throw error;
    // No shortcut for a whole-request 409/412 either. The rollback that a "reload and reapply"
    // answer would promise has not been verified on this stack (no transaction-bundles
    // feature), and a status class is not proof of behaviour. classifyVoidTransactionFailure
    // names the one whole-request rejection that IS verified; everything else is indeterminate.
    throw classifyVoidTransactionFailure(transaction, error);
  }
  return { status: 200, body: response };
}

// ---------------------------------------------------------------------------------------

function identify(
  observation: Observation & { id: string },
  definitions: readonly ClinicalFindingDefinition[],
): IdentifiedObservation {
  const laterality = observationLaterality(observation);
  if (isHistoryAnswerObservation(observation)) {
    const answer = parseHistoryAnswerObservation(observation);
    if (answer.complaintId) {
      return { observation, findingKey: `hpi-complaint:${answer.complaintId}`, sectionKey: HISTORY_SECTION_KEY, laterality };
    }
    return {
      observation,
      findingKey: `history-subject:${answer.templateKey}:${answer.sectionId}:${answer.optionCode ?? "value"}`,
      sectionKey: answer.templateKey,
      laterality: answer.eye ?? laterality,
    };
  }
  if (observation.code.coding?.some((coding) =>
    coding.system === HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM && coding.code === HISTORY_REVIEW_ATTESTATION_CODE
  )) {
    const sectionKey = observation.extension?.find((extension) => extension.url === HISTORY_REVIEW_SECTION_EXTENSION_URL)?.valueCode ?? OTHER_SECTION_KEY;
    return { observation, findingKey: `history-review:${sectionKey}`, sectionKey, laterality };
  }
  const definition = findingDefinitionForObservation(observation, definitions);
  if (definition) {
    return { observation, findingKey: definition.stableKey, sectionKey: definition.sectionKey ?? definition.stableKey, laterality };
  }
  const code = observation.code.coding?.find((coding) => coding.code)?.code;
  if (code === "VISUAL_ACUITY" || code === "VISUAL_ACUITY_PANEL") {
    return { observation, findingKey: code, sectionKey: "va", laterality };
  }
  return { observation, findingKey: code ?? OTHER_SECTION_KEY, sectionKey: OTHER_SECTION_KEY, laterality };
}

function observationLaterality(observation: Observation): VoidLaterality {
  const code = observation.extension?.find((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality)
    ?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code ??
    observation.bodySite?.coding?.find((coding) => coding.code)?.code;
  if (code === "OD" || code === "right") return "OD";
  if (code === "OS" || code === "left") return "OS";
  if (code === "OU" || code === "bilateral") return "OU";
  return "UNKNOWN";
}

function isLiveCondition(condition: Condition): boolean {
  const code = condition.verificationStatus?.coding?.find((coding) => coding.code)?.code;
  return code !== "entered-in-error" && code !== "refuted";
}

function codeOf(concept: { coding?: Array<{ code?: string }> } | undefined): string | undefined {
  return concept?.coding?.find((coding) => coding.code)?.code;
}

function asList(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

/** "Pupils · OD" for a single-eye tier-1 remove; the section's display otherwise. */
function tierOneLabel(targets: readonly IdentifiedObservation[], definitions: readonly ClinicalFindingDefinition[]): string {
  const sectionKey = targets[0]?.sectionKey ?? OTHER_SECTION_KEY;
  const label = sectionLabel(sectionKey, definitions);
  const lateralities = new Set(targets.map((row) => row.laterality));
  const laterality = lateralities.size === 1 ? [...lateralities][0] : undefined;
  return laterality && laterality !== "UNKNOWN" ? `${label} · ${laterality}` : label;
}

/** The ledger Basic as a transaction entry: PUT version-guarded when it exists, POST otherwise. */
export function ledgerEntry(ledger: EncounterUndoLedger, existing: Basic | undefined): NonNullable<Bundle["entry"]>[number] {
  const resource = buildEncounterUndoLedgerResource(ledger, existing);
  if (existing?.id) return putEntry(`Basic/${existing.id}`, resource, existing.meta?.versionId);
  return { resource, request: { method: "POST", url: "Basic" } };
}

/** The one Provenance shape every pre-sign void and restore writes. */
export function chartProvenance(input: {
  target: string;
  encounterReference: string;
  patientReference: string;
  staffReference: string;
  now: string;
  activity: { code: string; display: string; note: string };
}): Provenance {
  return {
    resourceType: "Provenance",
    target: [reference(input.target), reference(input.encounterReference), reference(input.patientReference)],
    recorded: input.now,
    occurredDateTime: input.now,
    activity: { ...odosConcept(input.activity.code, input.activity.display), text: input.activity.note },
    agent: [{
      type: {
        coding: [{
          system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
          code: "author",
          display: "Author",
        }],
      },
      who: reference(input.staffReference),
    }],
  };
}

export async function activeComplaints(fhir: EncounterVoidFhirClient, encounterId: string): Promise<ComplaintRow[]> {
  const resources = await searchAll<Basic>(fhir, "Basic", {
    code: `${ENCOUNTER_COMPLAINT_CODE_SYSTEM}|${ENCOUNTER_COMPLAINT_CODE}`,
  });
  const rows = resources.flatMap((resource): ComplaintRow[] => {
    if (typeof resource.id !== "string") return [];
    try {
      const complaint = parseEncounterComplaintResource(resource);
      return complaint.encounterId === encounterId && complaint.status === "active"
        ? [{ resource: resource as Basic & { id: string }, complaint }]
        : [];
    } catch {
      return [];
    }
  });
  // Mirror the store's duplicate resolution: newest Basic per complaint id wins.
  const byId = new Map<string, ComplaintRow>();
  for (const row of rows) {
    const current = byId.get(row.complaint.id);
    if (!current || compareResources(row.resource, current.resource) > 0) byId.set(row.complaint.id, row);
  }
  return [...byId.values()];
}

async function linkedAdministrations(
  fhir: EncounterVoidFhirClient,
  targets: readonly IdentifiedObservation[],
  encounterReference: string,
  patientReference: string,
): Promise<Array<MedicationAdministration & { id: string }>> {
  const references = [...new Set(targets.flatMap((row) =>
    (row.observation.partOf ?? []).flatMap((source) =>
      source.reference?.startsWith("MedicationAdministration/") ? [source.reference] : []
    )
  ))];
  const rows = await Promise.all(references.map(async (reference) => {
    try {
      return await fhir.read<MedicationAdministration>("MedicationAdministration", reference.slice("MedicationAdministration/".length));
    } catch (error) {
      // A 404 is a dangling partOf link: there is nothing left active to retire. Anything else
      // (outage, denial, timeout) means we cannot prove the medication is retired, so the caller
      // fails the whole void closed rather than hiding the Observation over a live administration.
      if (isNotFound(error)) return undefined;
      throw new LinkedAdministrationReadError(reference, error);
    }
  }));
  const linked: Array<MedicationAdministration & { id: string }> = [];
  for (const [index, administration] of rows.entries()) {
    if (!administration) continue; // dangling link — nothing active remains
    if (administration.status === "entered-in-error") continue; // already retired — nothing active remains
    // A live administration that is NOT this encounter's / this patient's is a boundary violation,
    // not something to leave out quietly: omitting it would void the Observation while the drops
    // stay clinically active under another chart. Refuse the whole void.
    if (
      typeof administration.id !== "string" ||
      administration.context?.reference !== encounterReference ||
      administration.subject?.reference !== patientReference
    ) {
      throw new LinkedAdministrationBoundaryError(references[index]!, encounterReference);
    }
    linked.push(administration as MedicationAdministration & { id: string });
  }
  return linked;
}

class LinkedAdministrationBoundaryError extends Error {
  override readonly name = "LinkedAdministrationBoundaryError";
  constructor(reference: string, encounterReference: string) {
    super(`Linked ${reference} is active but does not belong to ${encounterReference}; nothing was voided.`);
  }
}

class LinkedAdministrationReadError extends Error {
  override readonly name = "LinkedAdministrationReadError";
  constructor(reference: string, cause: unknown) {
    super(`Linked ${reference} could not be read (${errorMessage(cause)}); nothing was voided.`, { cause });
  }
}

function isNotFound(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: unknown }).status
    : undefined;
  return status === 404 || /FHIR 404\b/.test(error instanceof Error ? error.message : String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function administrationSectionKey(
  administration: MedicationAdministration & { id: string },
  targets: readonly IdentifiedObservation[],
): string {
  const reference = `MedicationAdministration/${administration.id}`;
  return targets.find((row) =>
    (row.observation.partOf ?? []).some((source) => source.reference === reference)
  )?.sectionKey ?? OTHER_SECTION_KEY;
}

function compareResources(left: Basic, right: Basic): number {
  return (left.meta?.lastUpdated ?? "").localeCompare(right.meta?.lastUpdated ?? "") ||
    (left.id ?? "").localeCompare(right.id ?? "");
}

function sectionLabel(sectionKey: string, definitions: readonly ClinicalFindingDefinition[]): string {
  return definitions.find((definition) => definition.sectionKey === sectionKey && definition.stableKey === sectionKey)?.display ??
    SECTION_LABELS[sectionKey] ??
    definitions.find((definition) => (definition.sectionKey ?? definition.stableKey) === sectionKey)?.display ??
    sectionKey;
}

export function putEntry(url: string, resource: Resource, versionId: string | undefined): NonNullable<Bundle["entry"]>[number] {
  return {
    resource,
    request: {
      method: "PUT",
      url,
      ...(versionId ? { ifMatch: `W/"${versionId}"` } : {}),
    },
  };
}

export function stripDiagnosis(encounter: Encounter): Encounter {
  const { diagnosis: _diagnosis, ...rest } = encounter;
  return rest;
}

// ---------------------------------------------------------------------------------------
// When the FHIR server refuses a void, the error carries its own evidence — and claims only
// what it can know.
//
// Medplum answers a transaction one of two ways. Without the `transaction-bundles` project
// feature (ODOS does not set it; the live Project carries no features at all) a refused entry
// comes back INSIDE a 200 transaction-response while every other entry is still applied (the
// fhir-client then deletes what the response says it created, i.e. the Provenances). With the
// feature on, the whole request is refused with one HTTP status and no entry identity. So a
// void that did not succeed has three outcomes, not one:
//
//   applied-none     POSITIVE evidence that nothing durable was written: every entry answered
//                    with an entry-level 4xx — the server's own final statement that it did not
//                    fulfil that entry — and no durable write was accepted; or the whole request
//                    was refused by a rejection VERIFIED to run before any entry
//                    (see VERIFIED_APPLIED_NONE_REJECTIONS)
//   applied-partial  refused, and at least one durable write (a PUT) WAS accepted
//   indeterminate    everything else — transport loss, parse failure, an incomplete bundle, an
//                    unverified whole-request status (409/412 and every 5xx included), or ANY
//                    entry whose answer is not a final verdict on that entry: no status, a
//                    string that is not a status, a 1xx (interim, RFC 9110), a 5xx (the server
//                    failed WHILE processing — the write may have landed), a 3xx, or a 2xx other
//                    than 200/201/204 (202 is "accepted for processing", not "done"). Absent or
//                    non-final evidence of a write is not evidence of its absence.
//
// A status is not an outcome. Per entry, only two statuses are read as verdicts: a final
// success (200/201/204, and where the server names the written resource it must be the one
// requested) and an entry-level 4xx. Everything else is "the server did not say".
//
// The rule that keeps this honest: a status class is not proof of behaviour; only the path
// actually exercised on this stack is.
//
// PHI boundary: `diagnostics` and `message` are for the server log only; they carry resource
// ids and outcome text, which may describe clinical content. `clientBody` is what the HTTP
// response may carry: the outcome, the entry index, the resource TYPE, the status code,
// counts, and a stable code. Never ids, never outcome text. encounterVoidRoutes.test.ts
// asserts this on the bytes Express actually sends.
// ---------------------------------------------------------------------------------------

export type VoidOutcome = "applied-none" | "applied-partial" | "indeterminate";

export interface VoidEntrySummary {
  index: number;
  method: string;
  url: string;
}

export interface VoidEntryFailure extends VoidEntrySummary {
  status: number | undefined;
  /** The entry's OperationOutcome, flattened: `details.text: diagnostics (code) [expression]` per issue. */
  outcome: string;
}

export type VoidTransactionDiagnostics =
  | {
      kind: "entry-failed";
      outcome: VoidOutcome;
      entryCount: number;
      /** Durable writes in the request: every entry that is not a POST. */
      changeCount: number;
      /** Durable writes the server positively accepted (a real 2xx status). */
      appliedCount: number;
      /** Accepted POSTs (the Provenances); the fhir-client deletes these again, best-effort. */
      acceptedCreates: number;
      /** Entries positively refused (a real non-2xx status). */
      failedCount: number;
      /** Entries whose answer carried no usable HTTP status: neither confirmed nor refused. */
      unknownCount: number;
      /** The first refused entry, or the first unknown one when nothing was positively refused. */
      firstFailure: VoidEntryFailure;
      failures: VoidEntryFailure[];
      unknown: VoidEntryFailure[];
      accepted: VoidEntrySummary[];
    }
  | {
      kind: "incomplete-response";
      outcome: "indeterminate";
      entryCount: number;
      returnedEntries: number;
      /** `Bundle/<type>` for a Bundle, otherwise the resourceType (or JS type) of what came back. */
      responseType: string;
    }
  | {
      kind: "http-rejected";
      outcome: "applied-none" | "indeterminate";
      status: number;
      /** The upstream error text as the fhir-client phrased it: method, path, HTTP status, and the outcome it parsed. */
      detail: string;
      entryCount: number;
      entries: VoidEntrySummary[];
      /** Present only when the answer matched a rejection verified to run before any entry — the sole basis for applied-none here. */
      verifiedRejection?: string;
    }
  | {
      kind: "no-response";
      outcome: "indeterminate";
      /** The transport or parse error text. */
      detail: string;
      entryCount: number;
      entries: VoidEntrySummary[];
    };

export type VoidTransactionClientBody =
  | {
      error: string;
      code: "void-transaction-failed";
      outcome: VoidOutcome;
      failedEntryIndex: number;
      failedResourceType: string;
      failedStatus: number | undefined;
      failedCount: number;
      unknownCount: number;
      appliedCount: number;
      changeCount: number;
      entryCount: number;
    }
  | { error: string; code: "void-transaction-incomplete"; outcome: "indeterminate"; entryCount: number; returnedEntries: number }
  | { error: string; code: "void-transaction-rejected"; outcome: "applied-none" | "indeterminate"; httpStatus: number; entryCount: number }
  | { error: string; code: "void-transaction-unanswered"; outcome: "indeterminate"; entryCount: number };

export class VoidTransactionError extends Error {
  override readonly name = "VoidTransactionError";
  readonly outcome: VoidOutcome;
  /** Server log only. */
  readonly diagnostics: VoidTransactionDiagnostics;
  /** HTTP response body. */
  readonly clientBody: VoidTransactionClientBody;

  // Deliberately no `status` field: `isFhirConflict` must never see a per-entry 409/412 here.
  constructor(diagnostics: VoidTransactionDiagnostics, options?: { cause?: unknown }) {
    super(voidTransactionMessage(diagnostics), options);
    this.diagnostics = diagnostics;
    this.outcome = diagnostics.outcome;
    this.clientBody = voidTransactionClientBody(diagnostics);
  }
}

export function assertSuccessfulTransaction(request: Bundle, response: Bundle): void {
  const sent = request.entry ?? [];
  const returned = Array.isArray(response?.entry) ? response.entry : [];
  if (response?.resourceType !== "Bundle" || response.type !== "transaction-response" || returned.length !== sent.length) {
    throw new VoidTransactionError({
      kind: "incomplete-response",
      outcome: "indeterminate",
      entryCount: sent.length,
      returnedEntries: returned.length,
      responseType: responseTypeName(response),
    });
  }
  const failures: VoidEntryFailure[] = [];
  const unknown: VoidEntryFailure[] = [];
  const accepted: VoidEntrySummary[] = [];
  returned.forEach((entry, index) => {
    const summary = entrySummary(sent[index], index);
    const status = parseEntryStatus(entry.response?.status);
    const verdict = entryVerdict(status, summary, entry.response?.location);
    if (verdict === "accepted") accepted.push(summary);
    else if (verdict === "refused") failures.push({ ...summary, status, outcome: describeOutcome(entry.response?.outcome) });
    else unknown.push({ ...summary, status, outcome: describeOutcome(entry.response?.outcome) });
  });
  if (failures.length === 0 && unknown.length === 0) return;
  // What counts as "applied" is a durable write the server accepted. Accepted creates (the
  // Provenances) are deleted again by the fhir-client's rollback, so they do not make a
  // refused void partial on their own.
  const changeCount = [...accepted, ...failures, ...unknown].filter(isDurableWrite).length;
  const appliedCount = accepted.filter(isDurableWrite).length;
  // applied-none rests on POSITIVE evidence: every entry answered with an entry-level 4xx and
  // none of the durable writes was accepted. One entry whose answer is not a final verdict —
  // no status, an interim 1xx, a 5xx, anything the server "did not say" — is an entry it may
  // have applied without saying so: indeterminate, whatever the others say. (The 2026-09-02
  // probes returned exactly those shapes AFTER the write had committed.)
  const outcome: VoidOutcome = unknown.length > 0 ? "indeterminate" : appliedCount > 0 ? "applied-partial" : "applied-none";
  throw new VoidTransactionError({
    kind: "entry-failed",
    outcome,
    entryCount: sent.length,
    changeCount,
    appliedCount,
    acceptedCreates: accepted.length - appliedCount,
    failedCount: failures.length,
    unknownCount: unknown.length,
    firstFailure: failures[0] ?? unknown[0]!,
    failures,
    unknown,
    accepted,
  });
}

/**
 * Whole-request answers PROVEN to leave nothing applied.
 *
 * Verified empirically against Medplum 5.1.30-9b1bd92 on 2026-09-02 (PR #505 round-2
 * evaluation, disposable synthetic patients, before/after version reads): two whole-request
 * HTTP 400 "Not a bundle" answers left the target's version unchanged, while a [200, 412]
 * control on the same stack partially applied. The router raises "Not a bundle" in its batch
 * handler before `processBatch` runs (medplum/packages/fhir-router/src/fhirrouter.ts).
 *
 * Nothing else in the 4xx class has been exercised — not other 400s, not 401/403/404, not
 * 409/412, not 422 — so nothing else may claim applied-none. RE-VERIFY ON ANY MEDPLUM UPGRADE:
 * this list is evidence about one path on one version, not a rule about a status class.
 */
const VERIFIED_APPLIED_NONE_REJECTIONS: ReadonlyArray<{ status: number; pattern: RegExp; note: string }> = [
  {
    status: 400,
    pattern: /: Not a bundle\s*$/,
    note: "HTTP 400 'Not a bundle': Medplum 5.1.30-9b1bd92 batch handler rejects before processBatch; verified empirically 2026-09-02",
  },
];

/**
 * The transaction produced no per-entry answer. No HTTP status at all — transport loss, a
 * parse failure — is indeterminate: the request may have been applied before the connection
 * broke. An HTTP status means the server answered for the whole request; that is applied-none
 * ONLY when the answer matches a rejection verified to run before any entry
 * (VERIFIED_APPLIED_NONE_REJECTIONS), and indeterminate for every other status, 4xx or 5xx.
 */
export function classifyVoidTransactionFailure(request: Bundle, cause: unknown): VoidTransactionError {
  // `detail` is the fhir-client's message, `FHIR POST <path> [Bundle] <status> <text>: <outcome>`;
  // the verified pattern anchors on the outcome text at its end, so a different 400 that merely
  // mentions the words elsewhere cannot borrow the verified path's certainty.
  const entries = (request.entry ?? []).map((entry, index) => entrySummary(entry, index));
  const status = typeof cause === "object" && cause !== null && "status" in cause && typeof (cause as { status?: unknown }).status === "number"
    ? (cause as { status: number }).status
    : undefined;
  const detail = errorMessage(cause);
  if (status === undefined) {
    return new VoidTransactionError({ kind: "no-response", outcome: "indeterminate", detail, entryCount: entries.length, entries }, { cause });
  }
  const verified = VERIFIED_APPLIED_NONE_REJECTIONS.find((row) => row.status === status && row.pattern.test(detail));
  return new VoidTransactionError(
    {
      kind: "http-rejected",
      outcome: verified ? "applied-none" : "indeterminate",
      status,
      detail,
      entryCount: entries.length,
      entries,
      ...(verified ? { verifiedRejection: verified.note } : {}),
    },
    { cause },
  );
}

function voidTransactionMessage(diagnostics: VoidTransactionDiagnostics): string {
  switch (diagnostics.kind) {
    case "entry-failed": {
      const first = diagnostics.firstFailure;
      return `Void transaction ${diagnostics.outcome}: entry ${first.index} of ${diagnostics.entryCount} ` +
        `(${first.method} ${first.url}) answered HTTP ${first.status ?? "no status"}; ` +
        `${diagnostics.failedCount} of ${diagnostics.entryCount} entries refused, ` +
        `${diagnostics.unknownCount} without a usable status, ` +
        `${diagnostics.appliedCount} of ${diagnostics.changeCount} changes applied, ` +
        `${diagnostics.acceptedCreates} creates accepted (rolled back by the client). First outcome: ${first.outcome}`;
    }
    case "incomplete-response":
      return `Void transaction indeterminate: the FHIR server's answer was not a usable transaction response ` +
        `(sent ${diagnostics.entryCount} entries, received ${diagnostics.returnedEntries}, ${diagnostics.responseType}).`;
    case "http-rejected":
      return `Void transaction ${diagnostics.outcome}: the FHIR server answered HTTP ${diagnostics.status} for the whole request` +
        `${diagnostics.verifiedRejection ? ` (${diagnostics.verifiedRejection})` : " (not a rejection verified to run before any entry)"}; ` +
        `${diagnostics.entryCount} entries were sent. ${diagnostics.detail}`;
    case "no-response":
      return `Void transaction indeterminate: the FHIR server did not answer usably; ` +
        `${diagnostics.entryCount} entries were sent. ${diagnostics.detail}`;
  }
}

/**
 * What the clinician reads. Each outcome gets the advice that is safe FOR THAT OUTCOME and no
 * other: "reload and try again" only when nothing applied; "review the chart" when something
 * did or when nobody knows; never a cheerful summary of a state the server did not confirm.
 */
function voidTransactionClientBody(diagnostics: VoidTransactionDiagnostics): VoidTransactionClientBody {
  switch (diagnostics.kind) {
    case "entry-failed": {
      const first = diagnostics.firstFailure;
      const resourceType = resourceTypeOfUrl(first.url);
      const where = `entry ${first.index} of ${diagnostics.entryCount} (${first.method} ${resourceType}, HTTP ${first.status ?? "no status"})`;
      const refused = `${diagnostics.failedCount} of ${diagnostics.entryCount} entries refused`;
      const error = diagnostics.outcome === "indeterminate"
        ? `Could not confirm what this clear saved: the record server's answer carried no status for ` +
          `${diagnostics.unknownCount} of ${diagnostics.entryCount} entries (${diagnostics.failedCount} refused; ` +
          `${diagnostics.appliedCount > 0 ? `at least ${diagnostics.appliedCount} of ${diagnostics.changeCount} changes were saved` : "no change confirmed saved"}). ` +
          `Some or all of it may have been applied. Review the chart before continuing; do not repeat the clear blindly.`
        : diagnostics.outcome === "applied-partial"
          ? `This clear only partly applied: ${diagnostics.appliedCount} of ${diagnostics.changeCount} changes were saved ` +
            `before the record server refused ${where}; ${refused}. Review the chart before continuing. ` +
            `Undo, where offered, restores only what was actually cleared.`
          : `Nothing was cleared: the record server refused this clear at ${where}; ${refused} and none of the ` +
            `${diagnostics.changeCount} changes were saved. Reload and try again.`;
      return {
        error,
        code: "void-transaction-failed",
        outcome: diagnostics.outcome,
        failedEntryIndex: first.index,
        failedResourceType: resourceType,
        failedStatus: first.status,
        failedCount: diagnostics.failedCount,
        unknownCount: diagnostics.unknownCount,
        appliedCount: diagnostics.appliedCount,
        changeCount: diagnostics.changeCount,
        entryCount: diagnostics.entryCount,
      };
    }
    case "incomplete-response":
      return {
        error: `Could not confirm what this clear saved: the record server's answer was not a usable transaction response ` +
          `(sent ${diagnostics.entryCount} entries, received ${diagnostics.returnedEntries}, ${diagnostics.responseType}). ` +
          `Some or all of it may have been applied. Review the chart before continuing; do not repeat the clear blindly.`,
        code: "void-transaction-incomplete",
        outcome: "indeterminate",
        entryCount: diagnostics.entryCount,
        returnedEntries: diagnostics.returnedEntries,
      };
    case "http-rejected":
      return {
        error: diagnostics.outcome === "applied-none"
          ? `Nothing was cleared: the record server rejected this clear (HTTP ${diagnostics.status}) before processing it; ` +
            `${diagnostics.entryCount} entries were sent. Reload and try again.`
          : diagnostics.status >= 500
            ? `Could not confirm what this clear saved: the record server failed while handling it (HTTP ${diagnostics.status}); ` +
              `${diagnostics.entryCount} entries were sent and some or all may have been applied. ` +
              `Review the chart before continuing; do not repeat the clear blindly.`
            : `Could not confirm what this clear saved: the record server refused the whole request (HTTP ${diagnostics.status}) ` +
              `without confirming what had already been saved; ${diagnostics.entryCount} entries were sent and some or all may have been applied. ` +
              `Review the chart before continuing; do not repeat the clear blindly.`,
        code: "void-transaction-rejected",
        outcome: diagnostics.outcome,
        httpStatus: diagnostics.status,
        entryCount: diagnostics.entryCount,
      };
    case "no-response":
      return {
        error: `Could not confirm what this clear saved: the record server did not answer (${diagnostics.entryCount} entries were sent). ` +
          `Some or all of it may have been applied. Review the chart before continuing; do not repeat the clear blindly.`,
        code: "void-transaction-unanswered",
        outcome: "indeterminate",
        entryCount: diagnostics.entryCount,
      };
  }
}

function isDurableWrite(row: VoidEntrySummary): boolean {
  return row.method.toUpperCase() !== "POST";
}

function entrySummary(entry: NonNullable<Bundle["entry"]>[number] | undefined, index: number): VoidEntrySummary {
  return { index, method: entry?.request?.method ?? "?", url: entry?.request?.url ?? "?" };
}

function resourceTypeOfUrl(url: string): string {
  return url.split(/[/?]/, 1)[0] || "?";
}

/** A real HTTP status leads the string — "200", "200 OK", "412 Precondition Failed". Anything else is unknown, never a refusal. */
function parseEntryStatus(status: unknown): number | undefined {
  if (typeof status !== "string") return undefined;
  const match = /^\s*([1-5]\d\d)(?:\s|$)/.exec(status);
  return match ? Number(match[1]) : undefined;
}

/** The only entry statuses that are final successes for the writes the void sends (PUT → 200, POST → 201; 204 is a final success too). */
const FINAL_SUCCESS_STATUSES: ReadonlySet<number> = new Set([200, 201, 204]);

/**
 * What one entry's answer proves about that entry. Only two answers are verdicts:
 *
 *   accepted — a final success status, and where the server named the resource it wrote
 *              (`response.location`) it names the one this entry asked for; a success that
 *              names some other resource proves nothing about this one
 *   refused  — an entry-level 4xx: the server's final statement that it did not fulfil the entry
 *
 * Everything else — no status, 1xx (interim, RFC 9110 §15.2), 3xx, 2xx other than 200/201/204
 * (202 is accepted-for-processing, not done), 5xx (failed WHILE processing; the write may have
 * landed) — is `unknown`: the server did not say, and the entry may have been applied.
 */
function entryVerdict(status: number | undefined, requested: VoidEntrySummary, location: unknown): "accepted" | "refused" | "unknown" {
  if (status === undefined) return "unknown";
  if (status >= 400 && status < 500) return "refused";
  if (!FINAL_SUCCESS_STATUSES.has(status)) return "unknown";
  return locationNamesRequestedResource(requested, location) ? "accepted" : "unknown";
}

/**
 * When the server says which resource it wrote, it must be the one the entry asked for:
 * `ResourceType/id` for a PUT, the resource type for a POST. Relative and absolute locations
 * both count; a missing location is not a contradiction (the status is then the evidence).
 */
function locationNamesRequestedResource(requested: VoidEntrySummary, location: unknown): boolean {
  if (typeof location !== "string" || location.length === 0) return true;
  const path = location.replace(/[?#].*$/, "");
  const target = requested.method.toUpperCase() === "POST" ? `${resourceTypeOfUrl(requested.url)}/` : requested.url.split("?", 1)[0]!;
  const at = path.indexOf(target);
  if (at < 0) return false;
  const boundaryBefore = at === 0 || path[at - 1] === "/";
  const after = path.slice(at + target.length);
  const boundaryAfter = requested.method.toUpperCase() === "POST" || after === "" || after.startsWith("/");
  return boundaryBefore && boundaryAfter;
}

function responseTypeName(response: unknown): string {
  if (!response || typeof response !== "object") return typeof response;
  const { resourceType, type } = response as { resourceType?: unknown; type?: unknown };
  if (resourceType === "Bundle") return `Bundle/${typeof type === "string" ? type : "no type"}`;
  return typeof resourceType === "string" ? resourceType : "unknown";
}

function describeOutcome(outcome: unknown): string {
  const issues = (outcome as OperationOutcome | undefined)?.issue;
  if (!Array.isArray(issues) || issues.length === 0) return "no OperationOutcome";
  return issues.map((issue) => {
    const parts = [issue.details?.text, issue.diagnostics].filter((part): part is string => typeof part === "string" && part.length > 0);
    const expression = issue.expression?.length ? ` [${issue.expression.join(", ")}]` : "";
    return `${parts.length ? parts.join(": ") : "no detail"} (${issue.code ?? "no code"})${expression}`;
  }).join("; ");
}

export function readId(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as Record<string, unknown>)[field];
  return typeof id === "string" && /^[A-Za-z0-9.-]+$/.test(id) ? id : undefined;
}
