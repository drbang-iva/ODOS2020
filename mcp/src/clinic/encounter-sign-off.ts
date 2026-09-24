import type { Encounter, Provenance } from "@medplum/fhirtypes";

export function signedEncounterIds(encounters: readonly Encounter[], provenances: readonly Provenance[]): Set<string> {
  const checkoutTimes = new Map(encounters.flatMap(encounter => encounter.id && encounter.status === "finished" && encounter.period?.end ? [[encounter.id, encounter.period.end] as const] : []));
  // EncounterHeader passes one instant to both Encounter.period.end and the transaction's
  // Provenance.recorded. Exact equality is the persisted sign-off contract; a nearby audit
  // event must not silently sign a chart.
  return new Set(provenances.flatMap(provenance => (provenance.target ?? []).flatMap(target => {
    const id = target.reference?.match(/^Encounter\/([^/]+)$/)?.[1];
    const end = id ? checkoutTimes.get(id) : undefined;
    const recorded = Date.parse(provenance.recorded ?? "");
    return id && end && Number.isFinite(recorded) && recorded === Date.parse(end) ? [id] : [];
  })));
}
