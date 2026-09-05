import { createContext, useContext, useSyncExternalStore } from "react";
import type { Encounter } from "@medplum/fhirtypes";
import { isClosedEncounterStatus, type EncounterVoidRequest, type EncounterVoidResult } from "../../lib/encounter-void";

export interface EncounterClearedDetail {
  scope: EncounterVoidRequest["scope"];
  result: EncounterVoidResult;
}

/** A void the server refused (or never answered). The surface has already rendered `error`. */
export interface EncounterClearFailedDetail {
  scope: EncounterVoidRequest["scope"];
  error: unknown;
}

/**
 * What a charting surface needs to know about the encounter it is editing in order to offer
 * the pre-finalization delete controls: whether the encounter is still open, whom to tell
 * when something was voided so the Overview and section statuses refresh, and whom to tell
 * when a void FAILED so the chart is re-read alongside the error. The panel the clinician is
 * reading may already show content an earlier void removed; an error must never sit beside a
 * stale overview (2026-09-02 walkthrough).
 */
export interface EncounterEditContextValue {
  encounterStatus?: Encounter["status"];
  onCleared?: (detail: EncounterClearedDetail) => void;
  onClearFailed?: (detail: EncounterClearFailedDetail) => void;
}

export const EncounterEditContext = createContext<EncounterEditContextValue>({});

export function useEncounterEdit(): EncounterEditContextValue {
  return useContext(EncounterEditContext);
}

export function useEncounterClosed(): boolean {
  return isClosedEncounterStatus(useContext(EncounterEditContext).encounterStatus);
}

const sectionWrites = new Set<{ encounter: string; sections?: string[] }>();
const writeListeners = new Set<() => void>();
const subscribeWrites = (listener: () => void) => {
  writeListeners.add(listener);
  return () => { writeListeners.delete(listener); };
};

export function isSectionWriteBusy(encounter: string, sections?: string[]): boolean {
  return [...sectionWrites].some(write => write.encounter === encounter && (!sections || !write.sections ||
    sections.some(key => write.sections!.some(other => key === other || key.startsWith(`${other}:`) || other.startsWith(`${key}:`)))));
}

export function useSectionWriteBusy(encounter: string, sections?: string[]): boolean {
  return useSyncExternalStore(subscribeWrites, () => isSectionWriteBusy(encounter, sections), () => false);
}

export function acquireSectionWrite(encounter: string, sections?: string[]): (() => void) | undefined {
  if (isSectionWriteBusy(encounter, sections)) return undefined;
  const write = { encounter, sections };
  sectionWrites.add(write);
  writeListeners.forEach(listener => listener());
  // Keep the lease until the request settles, even if its component unmounts.
  return () => {
    sectionWrites.delete(write);
    writeListeners.forEach(listener => listener());
  };
}
