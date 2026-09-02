import type { Observation } from "@medplum/fhirtypes";

/**
 * A voided Observation (`entered-in-error`) or a cancelled one is not part of the chart a
 * clinician reads. Every reader that lists or projects Observations for a screen filters
 * with this predicate so a void made anywhere disappears everywhere.
 */
export function isLiveObservation(observation: Pick<Observation, "status">): boolean {
  return observation.status !== "entered-in-error" && observation.status !== "cancelled";
}
