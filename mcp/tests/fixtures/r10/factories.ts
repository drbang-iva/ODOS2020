import type { Observation, ObservationComponent } from "@medplum/fhirtypes";
import { buildAnteriorOcularHealthDefinitions, buildPosteriorOcularHealthDefinitions } from "../../../src/clinical-graph/ocular-health-definition.js";
import { materializeAtomicFindingCatalog } from "../../../src/clinical-graph/diagnosis-findings-endpoint.js";
import { customFieldEntries } from "../../../src/clinical-graph/custom-fields.js";
import { ODOS_EXTENSION_URLS, odosConcept, lateralityConcept } from "../../../src/fhir/ophthalmology/extensions.js";

export const provenance = { source: "manual" as const, recordedAt: "2026-09-15T12:00:00.000Z", actorReference: "Practitioner/synthetic" };
export const definitions = [...buildAnteriorOcularHealthDefinitions(provenance), ...buildPosteriorOcularHealthDefinitions(provenance)]
  .map((d, i) => ({ ...d, id: `definition-${i}` }));
export const catalog = materializeAtomicFindingCatalog(definitions);
export const lens = definitions.find(d => d.stableKey.endsWith(":lens"))!;
export const lensField = customFieldEntries(lens)[0].localCode;
export const nuclear = catalog.find(r => r.findingDefinitionKey === lens.stableKey && r.optionCode === "nuclear-sclerosis")!;
export const comp = (code: string, value: unknown): ObservationComponent => ({ code: odosConcept(code),
  ...(typeof value === "boolean" ? { valueBoolean: value } : typeof value === "number" ? { valueQuantity: { value } } : { valueString: typeof value === "string" ? value : JSON.stringify(value) }) });
export function atomic(id = "atomic", eye = "OD", presence = true, row = nuclear): Observation {
  return { resourceType: "Observation", id, meta: { versionId: "v1" }, status: "preliminary", code: odosConcept(row.atomicFindingId),
    subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" }, effectiveDateTime: provenance.recordedAt,
    extension: [{ url: ODOS_EXTENSION_URLS.eyeLaterality, valueCodeableConcept: lateralityConcept(eye as "OD") }], valueBoolean: presence };
}
export function snapshot(id = "snapshot", options: string[] = ["nuclear-sclerosis"], eye = "OD"): Observation {
  return { ...atomic(id, eye), code: odosConcept(lens.stableKey), valueBoolean: undefined,
    component: options.map(o => comp(`${eye}_${lensField}::${o}`, true)) };
}
export function negative(): Observation {
  const act = { id: "00000000-0000-4000-8000-000000000001", definitionStableKey: lens.stableKey, eye: "OD", optionCodes: ["nuclear-sclerosis"],
    exclusions: [], assertedAt: "2026-09-15T13:00:00.000Z", actorReference: provenance.actorReference };
  return { ...snapshot("negative", []), effectiveDateTime: act.assertedAt, identifier: [{ system: "urn:odos:negative-act", value: "scope" }],
    component: [comp("NEGATIVE_ACT", JSON.stringify(act)), comp("NEGATIVE_CAPTURE_INPUT", "frozen-input"), comp("NEGATIVE_OPTION::nuclear-sclerosis", false), comp("EXAM_STATE", "normal")] };
}
export function state(observations: Observation[], extra = {}) {
  return { incomplete: false as const, patientReference: "Patient/p1", encounterReference: "Encounter/e1", observations, conditions: [], definitions, catalog, ...extra };
}
