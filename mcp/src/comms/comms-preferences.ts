import type { Bundle, Patient } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../authz/roles.js";
import type { MedplumClient } from "../fhir-client.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { replaceCommsPreferenceCells, type CommsPreferenceInput, type CommsPreferenceSurface } from "./suppression-gate.js";

export interface CommsPreferenceActor {
  actorReference: string;
  actorRole: PracticeRoleId;
  policyUrl?: string;
  recordedAt: string;
  surface: CommsPreferenceSurface;
}

export async function writeCommsPreferences(
  fhir: Pick<MedplumClient, "read" | "executeTransactionAsActor">,
  patientReference: string,
  cells: CommsPreferenceInput[],
  actor: CommsPreferenceActor,
): Promise<Patient> {
  const patient = await fhir.read<Patient>("Patient", patientReference.slice("Patient/".length));
  if (!patient.id || !patient.meta?.versionId) throw new Error("Preference write requires a Patient id and version.");
  const updated = replaceCommsPreferenceCells(patient, cells, {
    recordedAt: actor.recordedAt, setBy: { reference: actor.actorReference }, surface: actor.surface,
  });
  const transaction: Bundle = {
    resourceType: "Bundle", type: "transaction", entry: [
      { resource: updated, request: { method: "PUT", url: patientReference, ifMatch: `W/"${patient.meta.versionId}"` } },
      { resource: buildProvenance({
        targetReferences: [patientReference], recorded: actor.recordedAt,
        activityCode: "UPDATE", activityDisplay: "Set communication preferences",
        agents: [{ whoReference: actor.actorReference, typeCode: "author" }],
        entityValues: cells.map(cell => ({ role: "source", display: `${cell.purpose}/${cell.channel}: ${cell.allowed}` })),
      }), request: { method: "POST", url: "Provenance" } },
    ],
  };
  await fhir.executeTransactionAsActor(transaction, {
    actorReference: actor.actorReference, actorRole: actor.actorRole, policyUrl: actor.policyUrl,
    actionReason: "communications.preferences.manage set",
  }, { "X-ODOS-Source": "mcp/comms-preferences-write" }, {
    validateResponse: response => assertPreferenceTransaction(response, transaction.entry!.length),
  });
  return fhir.read<Patient>("Patient", patient.id);
}

export function assertPreferenceTransaction(response: Bundle, expectedEntries: number): void {
  if (response.type !== "transaction-response" || response.entry?.length !== expectedEntries) {
    throw new Error("Preference write returned an incomplete transaction response.");
  }
  const failed = response.entry.find(entry => !/^2\d\d/.test(entry.response?.status ?? ""));
  if (failed) throw Object.assign(new Error(`Preference write failed with status ${failed.response?.status ?? "unknown"}.`), {
    status: Number.parseInt(failed.response?.status ?? "", 10),
  });
}
