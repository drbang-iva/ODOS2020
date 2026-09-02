import type {
  Basic,
  Bundle,
  Condition,
  Encounter,
  MedicationAdministration,
  Observation,
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
import { isFhirConflict } from "./fhir-conflict.js";
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

export interface EncounterVoidResponse {
  voided: string[];
  count: number;
  sections: VoidSectionSummary[];
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
  if (isClosedEncounter(encounter)) {
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
  const complaints: ComplaintRow[] = includeComplaints ? await activeComplaints(staff.fhir, encounterId) : [];
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
  const ledgerRow = await new FhirEncounterUndoLedgerStore(staff.fhir).readRow(encounterId);
  const currentLedger = ledgerRow?.ledger ?? emptyEncounterUndoLedger(encounterId);
  const preview = request.preview === true;
  if (preview || voided.length === 0) {
    const response: EncounterVoidResponse = { voided, count: voided.length, sections, preview, ledger: currentLedger };
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
  const response: EncounterVoidResponse = { voided, count: voided.length, sections, preview, ledger: nextLedger };

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
  const entries: NonNullable<Bundle["entry"]> = [];
  for (const { observation } of targetObservations) {
    entries.push(putEntry(`Observation/${observation.id}`, { ...observation, status: "entered-in-error" }, observation.meta?.versionId));
    entries.push({ resource: provenanceFor(`Observation/${observation.id}`), request: { method: "POST", url: "Provenance" } });
  }
  for (const administration of administrations) {
    entries.push(putEntry(
      `MedicationAdministration/${administration.id}`,
      { ...administration, status: "entered-in-error" },
      administration.meta?.versionId,
    ));
    entries.push({
      resource: provenanceFor(`MedicationAdministration/${administration.id}`),
      request: { method: "POST", url: "Provenance" },
    });
  }
  for (const condition of conditions) {
    const { clinicalStatus: _clinicalStatus, ...withoutClinicalStatus } = condition;
    entries.push(putEntry(
      `Condition/${condition.id}`,
      { ...withoutClinicalStatus, verificationStatus: verificationStatusConcept("entered-in-error") },
      condition.meta?.versionId,
    ));
    entries.push({ resource: provenanceFor(`Condition/${condition.id}`), request: { method: "POST", url: "Provenance" } });
  }
  for (const { resource, complaint } of complaints) {
    entries.push(putEntry(
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
  if (complaints.length) nextEncounter = stampPrimaryComplaint(nextEncounter, [], []);
  if (conditions.length) {
    const diagnosis = (nextEncounter.diagnosis ?? []).filter((row) => !retracted.has(row.condition.reference ?? ""));
    nextEncounter = diagnosis.length ? { ...nextEncounter, diagnosis } : stripDiagnosis(nextEncounter);
  }
  entries.push(putEntry(encounterReference, nextEncounter, encounter.meta?.versionId));
  // The ledger is written by the void, in the void's transaction: a void without its Undo
  // slot, or a slot without its void, cannot exist.
  entries.push(ledgerEntry(nextLedger, ledgerRow?.resource));
  const transaction: Bundle = { resourceType: "Bundle", type: "transaction", entry: entries };
  try {
    const result = await staff.fhir.executeTransaction(transaction, VOID_WRITE_HEADERS);
    assertSuccessfulTransaction(transaction, result);
  } catch (error) {
    if (isFhirConflict(error)) {
      return { status: 409, body: { error: CONCURRENT_EDIT_MESSAGE, code: "concurrent-edit" } };
    }
    throw error;
  }
  return { status: 200, body: response };
}

// ---------------------------------------------------------------------------------------

function identify(
  observation: Observation & { id: string },
  definitions: readonly ClinicalFindingDefinition[],
): IdentifiedObservation {
  const laterality = observationLaterality(observation);
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

export function assertSuccessfulTransaction(request: Bundle, response: Bundle): void {
  const entries = response.entry;
  if (response.type !== "transaction-response" || !entries || entries.length !== request.entry?.length) {
    throw new Error("Void did not return a complete transaction response.");
  }
  for (const entry of entries) {
    const status = Number.parseInt(entry.response?.status ?? "", 10);
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      throw new Error(`Void transaction failed with ${entry.response?.status ?? "no status"}.`);
    }
  }
}

export function readId(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as Record<string, unknown>)[field];
  return typeof id === "string" && /^[A-Za-z0-9.-]+$/.test(id) ? id : undefined;
}
