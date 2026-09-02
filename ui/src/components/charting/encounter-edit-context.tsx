import { createContext, useContext } from "react";
import type { Encounter } from "@medplum/fhirtypes";
import { isClosedEncounterStatus, type EncounterVoidRequest, type EncounterVoidResult } from "../../lib/encounter-void";

export interface EncounterClearedDetail {
  scope: EncounterVoidRequest["scope"];
  result: EncounterVoidResult;
}

/**
 * What a charting surface needs to know about the encounter it is editing in order to offer
 * the pre-finalization delete controls: whether the encounter is still open, and whom to tell
 * when something was voided so the Overview and section statuses refresh.
 */
export interface EncounterEditContextValue {
  encounterStatus?: Encounter["status"];
  onCleared?: (detail: EncounterClearedDetail) => void;
}

export const EncounterEditContext = createContext<EncounterEditContextValue>({});

export function useEncounterEdit(): EncounterEditContextValue {
  return useContext(EncounterEditContext);
}

export function useEncounterClosed(): boolean {
  return isClosedEncounterStatus(useContext(EncounterEditContext).encounterStatus);
}
