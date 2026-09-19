import type { DocumentReference, Encounter, QuestionnaireResponse } from "@medplum/fhirtypes";
import { collectAllFhirSearchPages, type FhirSearchClient } from "../fhir-search.js";
import { OBSERVATION_MEIBOMIAN_GLAND_SCORE_PROFILE_URL } from "../fhir/contactLens.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import { loadEncounterFindingState, projectCurrentFindings } from "./current-finding-reader.js";
import { classifyFindingObservation } from "./current-finding-identity.js";
import { materializeAtomicFindingCatalog } from "./diagnosis-findings-endpoint.js";
import { DRY_EYE_QUESTIONNAIRE_INSTRUMENTS, dryEyeQuestionnaireSummaryConcept, questionnaireReferenceForInstrument } from "../fhir/dryEyeTerminology.js";
import { DRY_EYE_GLAND_STRUCTURE_KEY, DRY_EYE_SYMPTOMS_KEY } from "./dry-eye-finding-definition.js";
import { buildFindingReadAliases } from "./finding-read-aliases.js";
import type { ClinicalFindingDefinition } from "./glaucoma-suspect.js";

export async function encounterContentSectionKeys(
  fhir: FhirSearchClient,
  encounter: Encounter,
  definitions: readonly ClinicalFindingDefinition[],
): Promise<string[]> {
  const encounterReference = `Encounter/${encounter.id}`;
  const patientReference = encounter.subject?.reference;
  if (!patientReference?.startsWith("Patient/")) throw new Error("Encounter content requires a scoped patient.");
  const catalog = materializeAtomicFindingCatalog([...definitions]);
  const state = await loadEncounterFindingState(fhir, { encounterReference, patientReference, definitions, catalog });
  if (state.incomplete) throw new Error(state.reason);
  const content = new Set<string>();
  const add = (definition: ClinicalFindingDefinition | undefined) => {
    if (definition?.sectionKey) content.add(definition.sectionKey);
  };
  const projection = projectCurrentFindings(state);
  for (const fact of [...projection.currentFacts, ...projection.conflicts]) {
    if (fact.status === "live") add(definitions.find(d => d.stableKey === fact.key.stableKey));
  }
  const aliases = buildFindingReadAliases(definitions, catalog);
  const questionnaireCodes = DRY_EYE_QUESTIONNAIRE_INSTRUMENTS.flatMap(instrument => dryEyeQuestionnaireSummaryConcept(instrument).coding ?? []);
  for (const observation of state.observations) {
    if (observation.status === "entered-in-error") continue;
    const classification = classifyFindingObservation(observation, definitions, catalog, aliases);
    if (classification.kind !== "canonical-fact" && classification.kind !== "legacy-atomic") add(classification.definition);
    if (observation.code.coding?.some(code => questionnaireCodes.some(expected => code.system === expected.system && code.code === expected.code))) {
      add(definitions.find(d => d.stableKey === DRY_EYE_SYMPTOMS_KEY));
    }
    if (observation.meta?.profile?.includes(OBSERVATION_MEIBOMIAN_GLAND_SCORE_PROFILE_URL)) {
      add(definitions.find(d => d.stableKey === DRY_EYE_GLAND_STRUCTURE_KEY));
    }
  }
  // The image is saved before its score; a failed second write must still keep its section visible.
  const page = await fhir.search<DocumentReference>("DocumentReference", { encounter: encounterReference, _count: "200" });
  const documents = await collectAllFhirSearchPages(fhir, "DocumentReference", page, fhir.baseUrl);
  for (const document of documents) {
    if (document.resourceType !== "DocumentReference" || document.subject?.reference !== patientReference ||
      !document.context?.encounter?.some(r => r.reference === encounterReference)) throw new Error("Document search returned content outside this encounter.");
    if (document.status !== "entered-in-error" && document.type?.coding?.some(c =>
      c.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && c.code === "MEIBOGRAPHY_IMAGE")) {
      add(definitions.find(d => d.stableKey === DRY_EYE_GLAND_STRUCTURE_KEY));
    }
  }
  const responsePage = await fhir.search<QuestionnaireResponse>("QuestionnaireResponse", { encounter: encounterReference, _count: "200" });
  const responses = await collectAllFhirSearchPages(fhir, "QuestionnaireResponse", responsePage, fhir.baseUrl);
  const questionnaires = new Set(DRY_EYE_QUESTIONNAIRE_INSTRUMENTS.map(questionnaireReferenceForInstrument));
  for (const response of responses) {
    if (response.resourceType !== "QuestionnaireResponse" || response.subject?.reference !== patientReference ||
      response.encounter?.reference !== encounterReference) throw new Error("Questionnaire search returned content outside this encounter.");
    if (response.status !== "entered-in-error" && response.questionnaire && questionnaires.has(response.questionnaire)) {
      add(definitions.find(d => d.stableKey === DRY_EYE_SYMPTOMS_KEY));
    }
  }
  return [...content].sort();
}
