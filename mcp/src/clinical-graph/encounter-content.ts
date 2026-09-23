import type { Resource } from "@medplum/fhirtypes";
import { searchAll, type FhirSearchClient } from "../fhir-search.js";
import { ProtocolBasicStore, PROTOCOL_BASIC_CODES, type ProtocolFhirClient } from "./protocol-store.js";
import type { ChargeProposal, PlanActionInstance } from "./protocol-types.js";

export const ENCOUNTER_CONTENT_QUERIES: ReadonlyArray<readonly [Resource["resourceType"], string]> = [
  ["Observation", "encounter"], ["Condition", "encounter"], ["Procedure", "encounter"],
  ["DiagnosticReport", "encounter"], ["DocumentReference", "encounter"], ["Media", "encounter"],
  ["QuestionnaireResponse", "encounter"], ["ServiceRequest", "encounter"], ["MedicationRequest", "encounter"],
  ["MedicationStatement", "context"], ["MedicationAdministration", "context"], ["DeviceRequest", "encounter"],
  ["CarePlan", "encounter"], ["ChargeItem", "context"],
];
export function isLiveEncounterContent(resource: Resource): boolean {
  if (resource.resourceType === "Condition") return !resource.verificationStatus?.coding?.some(c => c.code === "entered-in-error");
  return !["entered-in-error", "cancelled", "revoked"].includes((resource as { status?: string }).status ?? "");
}
export type EncounterContentCount = { kind: string; count: number };
export async function readEncounterProtocolContent(fhir: ProtocolFhirClient) {
  const proposals = await new ProtocolBasicStore<ChargeProposal>(fhir, PROTOCOL_BASIC_CODES.chargeProposal).list();
  const actions = await new ProtocolBasicStore<PlanActionInstance>(fhir, PROTOCOL_BASIC_CODES.planActionInstance).list();
  return { proposals, actions };
}
export async function encounterContentByEncounter(fhir: FhirSearchClient & ProtocolFhirClient, encounterIds: readonly string[], loadProtocol = () => readEncounterProtocolContent(fhir)) {
  const ids = [...new Set(encounterIds)];
  const contentByEncounter = new Map(ids.map(id => [id, [] as EncounterContentCount[]]));
  const resources = new Map<Resource["resourceType"], Resource[]>();
  const count = (id: string, kind: string, amount: number) => { if (amount) contentByEncounter.get(id)!.push({ kind, count: amount }); };
  for (const [kind, parameter] of ENCOUNTER_CONTENT_QUERIES) {
    const collected: Resource[] = [];
    for (let offset = 0; offset < ids.length; offset += 25) {
      const chunk = ids.slice(offset, offset + 25);
      const rows = await searchAll(fhir, kind, { [parameter]: chunk.map(id => `Encounter/${id}`).join(","), _sort: "-_lastUpdated" });
      collected.push(...rows);
      for (const id of chunk) {
        const matching = chunk.length === 1 ? rows : rows.filter(resource => {
          const references = resource.resourceType === "DocumentReference" ? resource.context?.encounter : (resource as unknown as Record<string, unknown>)[parameter];
          return (Array.isArray(references) ? references : [references]).some(reference => (reference as { reference?: string } | undefined)?.reference === `Encounter/${id}`);
        });
        count(id, kind, matching.filter(isLiveEncounterContent).length);
      }
    }
    resources.set(kind, collected);
  }
  const { proposals, actions } = await loadProtocol();
  for (const id of ids) {
    count(id, "ChargeProposal", proposals.filter(row => row.encounterId === id && ["staged", "accepted", "overridden", "finalized"].includes(row.state)).length);
    count(id, "PlanActionInstance", actions.filter(row => row.encounterId === id && !["removed", "cancelled"].includes(row.state)).length);
  }
  return { contentByEncounter, resources, proposals, actions };
}
