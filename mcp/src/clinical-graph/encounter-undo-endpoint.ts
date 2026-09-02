import type {
  Basic,
  Bundle,
  Condition,
  Encounter,
  EncounterDiagnosis,
  MedicationAdministration,
  Observation,
  Provenance,
} from "@medplum/fhirtypes";
import { z } from "zod";
import { staffHasBusinessAction } from "../authz/roles.js";
import { clinicalStatusConcept, verificationStatusConcept } from "../fhir/condition.js";
import { stampPrimaryComplaint } from "./complaint-endpoint.js";
import type { EncounterComplaint } from "./complaint-model.js";
import { buildEncounterComplaintResource, parseEncounterComplaintResource } from "./encounter-complaint-store.js";
import { CLOSED_ENCOUNTER_EDIT_ERROR, isClosedEncounter } from "./encounter-sign-gate.js";
import {
  FhirEncounterUndoLedgerStore,
  type EncounterUndoLedger,
  type UndoLedgerEntry,
  type UndoLedgerSlot,
} from "./encounter-undo-ledger-store.js";
import {
  CONCURRENT_EDIT_MESSAGE,
  activeComplaints,
  assertSuccessfulTransaction,
  chartProvenance,
  ledgerEntry,
  putEntry,
  readId,
  type EncounterVoidEndpointDeps,
  type EncounterVoidFhirClient,
} from "./encounter-void-endpoint.js";
import { isFhirConflict } from "./fhir-conflict.js";
import type { ClinicalGraphProvenance } from "./glaucoma-suspect.js";

/**
 * POST /clinical-graph/encounters/:encounterId/void/undo   { scope: "encounter" | "section", sectionKey? }
 * GET  /clinical-graph/encounters/:encounterId/void/ledger
 *
 * Undo reverses exactly one clear action — the one recorded in the ledger slot for that scope
 * (§4b.4). It reads the slot, restores each listed resource to the status the ledger recorded
 * for it (never a constant), writes one RESTORE Provenance per resource, puts the Encounter's
 * diagnosis rows and primary-complaint stamp back, and clears the slot — all in one
 * version-guarded transaction under the same sign gate as the void. It never searches for
 * "everything entered-in-error": a set that action did not void is not this Undo's to restore.
 * Undo is not itself undoable: after it, the slot is gone and there is nothing to browse.
 */

export const UNDO_WRITE_HEADERS = { "X-ODOS-Source": "mcp/undo_encounter_void" } as const;
export const RESTORE_PROVENANCE_NOTE = "Restored by clinician before sign.";
export const NOTHING_TO_UNDO_ERROR = "Nothing to undo.";

const requestSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("encounter") }).strict(),
  z.object({ scope: z.literal("section"), sectionKey: z.string().trim().min(1).max(200) }).strict(),
]);

export type EncounterUndoRequest = z.infer<typeof requestSchema>;

export interface EncounterUndoResponse {
  restored: string[];
  count: number;
  /** Entries the slot named that were no longer voided when Undo ran; left as they are. */
  skipped: string[];
  scope: EncounterUndoRequest["scope"];
  sectionKey?: string;
  ledger: EncounterUndoLedger;
}

export async function handleEncounterUndoLedgerRequest(
  deps: EncounterVoidEndpointDeps,
  input: { authHeader: string | undefined; params: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read the encounter undo ledger." } };
  if (!staffHasBusinessAction(staff, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const encounterId = readId(input.params, "encounterId");
  if (!encounterId) return { status: 400, body: { error: "A valid encounter id is required." } };
  try {
    await staff.fhir.read<Encounter>("Encounter", encounterId);
  } catch {
    return { status: 404, body: { error: "Encounter not found." } };
  }
  const ledger = await new FhirEncounterUndoLedgerStore(staff.fhir).get(encounterId);
  return { status: 200, body: { ledger } };
}

export async function handleEncounterUndoRequest(
  deps: EncounterVoidEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to undo a void." } };
  if (!staffHasBusinessAction(staff, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const encounterId = readId(input.params, "encounterId");
  if (!encounterId) return { status: 400, body: { error: "A valid encounter id is required." } };
  const parsed = requestSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid undo request." } };
  }
  const request = parsed.data;

  let encounter: Encounter;
  try {
    encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
  } catch {
    return { status: 404, body: { error: "Encounter not found." } };
  }
  // The same gate as the void: signing closes the Undo window (§4b.5).
  if (isClosedEncounter(encounter)) {
    return { status: 409, body: { error: CLOSED_ENCOUNTER_EDIT_ERROR, code: "encounter-closed" } };
  }
  const patientReference = encounter.subject?.reference;
  if (!patientReference || !/^Patient\/[A-Za-z0-9.-]+$/.test(patientReference)) {
    return { status: 400, body: { error: "Encounter must reference a Patient subject." } };
  }
  const encounterReference = `Encounter/${encounterId}`;

  // --- The slot: one action, the most recent, nothing else -------------------------------
  const ledgerRow = await new FhirEncounterUndoLedgerStore(staff.fhir).readRow(encounterId);
  const slot: UndoLedgerSlot | undefined = request.scope === "encounter"
    ? ledgerRow?.ledger.encounter ?? undefined
    : ledgerRow?.ledger.sections[request.sectionKey];
  if (!ledgerRow || !slot || slot.voided.length === 0) {
    return { status: 404, body: { error: NOTHING_TO_UNDO_ERROR, code: "nothing-to-undo" } };
  }

  // --- Read every listed resource; fail closed if any cannot be read --------------------
  let targets: RestoreTarget[];
  try {
    targets = await Promise.all(slot.voided.map((entry) => readTarget(staff.fhir, entry)));
  } catch (error) {
    if (error instanceof UndoEntryReadError) {
      return { status: 503, body: { error: error.message, code: "undo-entry-unavailable" } };
    }
    throw error;
  }

  // --- Build the restore ---------------------------------------------------------------
  const now = deps.now?.() ?? new Date().toISOString();
  const provenanceFor = (target: string): Provenance => chartProvenance({
    target,
    encounterReference,
    patientReference,
    staffReference: staff.staffReference,
    now,
    activity: { code: "RESTORE", display: "Restore before sign", note: RESTORE_PROVENANCE_NOTE },
  });
  const complaintProvenance: ClinicalGraphProvenance = {
    source: "manual",
    recordedAt: now,
    actorReference: staff.staffReference,
    note: RESTORE_PROVENANCE_NOTE,
  };
  const entries: NonNullable<Bundle["entry"]> = [];
  const restored: string[] = [];
  const skipped: string[] = [];
  const diagnosisRows: EncounterDiagnosis[] = [];
  const restoredComplaints: EncounterComplaint[] = [];
  for (const target of targets) {
    if (!target.voided) {
      skipped.push(target.entry.ref);
      continue;
    }
    restored.push(target.entry.ref);
    entries.push(putEntry(target.entry.ref, target.restored, target.versionId));
    entries.push({ resource: provenanceFor(target.entry.ref), request: { method: "POST", url: "Provenance" } });
    if (target.entry.diagnosis) diagnosisRows.push(target.entry.diagnosis);
    if (target.complaint) restoredComplaints.push(target.complaint);
  }
  for (const target of targets) {
    if (target.complaint) {
      // Every restored complaint carries the restore in its own provenance history.
      const index = entries.findIndex((entry) => entry.request?.url === target.entry.ref);
      if (index >= 0) {
        entries[index] = putEntry(
          target.entry.ref,
          buildEncounterComplaintResource({
            ...target.complaint,
            provenance: complaintProvenance,
            provenanceHistory: [...target.complaint.provenanceHistory, complaintProvenance],
          }, target.resource as Basic),
          target.versionId,
        );
      }
    }
  }

  // The Encounter rides in every undo transaction version-guarded (same invariant as the void):
  // a concurrent sign bumps its version and the whole restore fails closed.
  let nextEncounter: Encounter = encounter;
  if (diagnosisRows.length) {
    const present = new Set((encounter.diagnosis ?? []).map((row) => row.condition.reference ?? ""));
    const added = diagnosisRows.filter((row) => !present.has(row.condition.reference ?? ""));
    nextEncounter = { ...nextEncounter, diagnosis: [...(encounter.diagnosis ?? []), ...added] };
  }
  if (restoredComplaints.length) {
    const stillActive = (await activeComplaints(staff.fhir, encounterId)).map((row) => row.complaint);
    nextEncounter = stampPrimaryComplaint(nextEncounter, [...stillActive, ...restoredComplaints], []);
  }
  entries.push(putEntry(encounterReference, nextEncounter, encounter.meta?.versionId));

  // Clear the slot. Undo is not itself undoable: nothing about the restore is recorded here.
  const nextLedger: EncounterUndoLedger = request.scope === "encounter"
    ? { ...ledgerRow.ledger, encounter: null }
    : {
        ...ledgerRow.ledger,
        sections: Object.fromEntries(Object.entries(ledgerRow.ledger.sections).filter(([key]) => key !== request.sectionKey)),
      };
  entries.push(ledgerEntry(nextLedger, ledgerRow.resource));

  const transaction: Bundle = { resourceType: "Bundle", type: "transaction", entry: entries };
  try {
    const result = await staff.fhir.executeTransaction(transaction, UNDO_WRITE_HEADERS);
    assertSuccessfulTransaction(transaction, result);
  } catch (error) {
    if (isFhirConflict(error)) {
      return { status: 409, body: { error: CONCURRENT_EDIT_MESSAGE, code: "concurrent-edit" } };
    }
    throw error;
  }
  const response: EncounterUndoResponse = {
    restored,
    count: restored.length,
    skipped,
    scope: request.scope,
    ...(request.scope === "section" ? { sectionKey: request.sectionKey } : {}),
    ledger: nextLedger,
  };
  return { status: 200, body: response };
}

// ---------------------------------------------------------------------------------------

interface RestoreTarget {
  entry: UndoLedgerEntry;
  resource: Observation | MedicationAdministration | Condition | Basic;
  /** Whether the resource still carries the voided status — only then is it this Undo's to restore. */
  voided: boolean;
  restored: Observation | MedicationAdministration | Condition | Basic;
  versionId: string | undefined;
  complaint?: EncounterComplaint;
}

class UndoEntryReadError extends Error {
  override readonly name = "UndoEntryReadError";
  constructor(reference: string, cause: unknown) {
    super(`${reference} could not be read (${cause instanceof Error ? cause.message : String(cause)}); nothing was restored.`, { cause });
  }
}

async function readTarget(fhir: EncounterVoidFhirClient, entry: UndoLedgerEntry): Promise<RestoreTarget> {
  const [resourceType, id] = entry.ref.split("/") as [string, string];
  let resource: Observation | MedicationAdministration | Condition | Basic;
  try {
    switch (resourceType) {
      case "Observation":
        resource = await fhir.read<Observation>("Observation", id);
        break;
      case "MedicationAdministration":
        resource = await fhir.read<MedicationAdministration>("MedicationAdministration", id);
        break;
      case "Condition":
        resource = await fhir.read<Condition>("Condition", id);
        break;
      case "Basic":
        resource = await fhir.read<Basic>("Basic", id);
        break;
      default:
        throw new Error(`unsupported resource type ${resourceType}`);
    }
  } catch (error) {
    throw new UndoEntryReadError(entry.ref, error);
  }
  const versionId = resource.meta?.versionId;
  switch (resource.resourceType) {
    case "Observation": {
      const restored = withStatus(resource, entry.priorStatus) as Observation;
      return { entry, resource, voided: resource.status === "entered-in-error", restored, versionId };
    }
    case "MedicationAdministration": {
      const restored = withStatus(resource, entry.priorStatus) as MedicationAdministration;
      return { entry, resource, voided: resource.status === "entered-in-error", restored, versionId };
    }
    case "Condition": {
      const { verificationStatus: _verification, ...rest } = resource;
      const restored: Condition = {
        ...rest,
        ...(entry.priorStatus ? { verificationStatus: verificationStatusConcept(entry.priorStatus as Parameters<typeof verificationStatusConcept>[0]) } : {}),
        ...(entry.clinicalStatus ? { clinicalStatus: clinicalStatusConcept(entry.clinicalStatus as Parameters<typeof clinicalStatusConcept>[0]) } : {}),
      };
      const voided = resource.verificationStatus?.coding?.some((coding) => coding.code === "entered-in-error") === true;
      return { entry, resource, voided, restored, versionId };
    }
    default: {
      const complaint = parseEncounterComplaintResource(resource);
      const active: EncounterComplaint = { ...complaint, status: "active" };
      return {
        entry,
        resource,
        voided: complaint.status === "removed",
        restored: buildEncounterComplaintResource(active, resource),
        versionId,
        complaint: active,
      };
    }
  }
}

/** priorStatus "" means the resource saved with no status at all — restore it that way. */
function withStatus<T extends { status?: string }>(resource: T, priorStatus: string): T {
  if (!priorStatus) {
    const { status: _status, ...rest } = resource;
    return rest as T;
  }
  return { ...resource, status: priorStatus };
}
