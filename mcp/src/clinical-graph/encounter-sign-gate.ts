import type { Encounter } from "@medplum/fhirtypes";

/**
 * The pre-sign edit gate.
 *
 * An encounter that is finished (signed), cancelled, or entered-in-error is closed to
 * clinical edits: nothing charted under it may be added, changed, or voided; the path
 * forward after sign is an amendment. Every clinical-graph writer that mutates
 * encounter-scoped chart content checks this one predicate rather than carrying its
 * own copy of the status list.
 */
export const CLOSED_ENCOUNTER_STATUSES: ReadonlySet<NonNullable<Encounter["status"]>> = new Set([
  "finished",
  "cancelled",
  "entered-in-error",
]);

export const CLOSED_ENCOUNTER_EDIT_ERROR = "Signed or closed encounters cannot be edited.";

export function isClosedEncounter(encounter: Pick<Encounter, "status">): boolean {
  return encounter.status !== undefined && CLOSED_ENCOUNTER_STATUSES.has(encounter.status);
}
