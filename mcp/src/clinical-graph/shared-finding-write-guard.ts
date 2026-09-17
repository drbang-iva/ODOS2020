import { randomUUID } from "node:crypto";
import type { Encounter, Observation } from "@medplum/fhirtypes";
import { classifyFindingObservation } from "./current-finding-identity.js";
import { loadEncounterFindingState, projectCurrentFindings } from "./current-finding-reader.js";
import { repairPendingAudits, type FindingCommandDeps } from "./current-finding-writer.js";
import { materializeAtomicFindingCatalog } from "./diagnosis-findings-endpoint.js";
import { buildFindingReadAliases } from "./finding-read-aliases.js";
import type { ClinicalFindingDefinition } from "./glaucoma-suspect.js";

function classification(observation: Observation, definitions: readonly ClinicalFindingDefinition[]) {
  const catalog = materializeAtomicFindingCatalog(definitions);
  return classifyFindingObservation(observation, definitions, catalog, buildFindingReadAliases(definitions, catalog));
}

export function assertNotSharedFindingWrite(observation: Observation, definitions: readonly ClinicalFindingDefinition[]): void {
  if (classification(observation, definitions).kind !== "unrelated") {
    throw new Error("Shared findings are charted in the finding doors");
  }
}

export async function prepareSharedFindingLifecycle(observation: Observation, deps: Omit<FindingCommandDeps, "catalog">): Promise<void> {
  const identity = classification(observation, deps.definitions);
  if (identity.kind === "unrelated") return;
  if (identity.kind !== "canonical-fact" && identity.kind !== "panel-context") {
    throw new Error("Shared findings are charted in the finding doors; legacy targets are read-only");
  }
  const patientReference = observation.subject?.reference;
  const encounterReference = observation.encounter?.reference;
  if (!patientReference?.startsWith("Patient/") || !encounterReference?.startsWith("Encounter/") || !observation.id) {
    throw new Error("Shared finding lifecycle requires its patient and encounter");
  }
  const encounter = await deps.fhir.read<Encounter>("Encounter", encounterReference.slice("Encounter/".length));
  if (encounter.subject?.reference !== patientReference) throw new Error("Shared finding lifecycle patient does not match encounter");
  const catalog = materializeAtomicFindingCatalog(deps.definitions);
  const state = await loadEncounterFindingState(deps.fhir, {patientReference, encounterReference, definitions: deps.definitions, catalog});
  if (state.incomplete) throw new Error(`Shared finding lifecycle unavailable: ${state.reason}`);
  if (projectCurrentFindings(state).preRebuild) throw new Error("pre-rebuild-test-encounter: Shared findings are read-only");
  const repaired = await repairPendingAudits({...deps, catalog}, {commandId: randomUUID(), patientReference, encounterReference}, {targets: [`Observation/${observation.id}`]});
  if (!repaired.complete) throw new Error("Shared finding audit repair failed; lifecycle write refused");
}
