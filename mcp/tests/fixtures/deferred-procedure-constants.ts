export const DEFERRED_PROCEDURE_CONCEPT_SYSTEM =
  "https://osod.dev/fhir/CodeSystem/deferred-procedure-concepts";
export const CPT_CODE_SYSTEM = "urn:ama:cpt";
export const SCODI_OPTIC_NERVE = {
  conceptKey: "scodi-optic-nerve",
  cptBinding: {
    status: "deferred-to-licensed-adapter",
    system: CPT_CODE_SYSTEM,
  },
} as const;

export function deferredProcedureCode(concept = SCODI_OPTIC_NERVE) {
  return {
    system: DEFERRED_PROCEDURE_CONCEPT_SYSTEM,
    code: concept.conceptKey,
    text: concept.conceptKey,
  };
}
