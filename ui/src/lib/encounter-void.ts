import type { Encounter } from "@medplum/fhirtypes";
import {
  authHeaders,
  clinicalGraphApiBase,
  clinicalGraphResponseError,
  type ClinicalGraphErrorBody,
} from "./clinical-graph-client";

/**
 * Client for the one pre-finalization delete primitive:
 * POST /clinical-graph/encounters/:encounterId/void
 *
 * Nothing is deleted. The server flips the matched entries to entered-in-error (Observations,
 * Conditions) or removed (complaints) and writes a VOID Provenance per resource; every reader
 * already ignores those statuses, so the entries disappear from every screen while staying in
 * the record. The server refuses (409) once the encounter is signed.
 */

export type EncounterVoidLaterality = "OD" | "OS" | "OU" | "UNKNOWN";

export type EncounterVoidRequest =
  | { scope: "observation"; observationReference: string | string[] }
  | { scope: "finding"; findingKey: string; laterality?: EncounterVoidLaterality }
  | { scope: "section"; sectionKey: string | string[] }
  | { scope: "encounter" };

export interface EncounterVoidSection {
  sectionKey: string;
  label: string;
  count: number;
}

export interface EncounterVoidResult {
  voided: string[];
  count: number;
  sections: EncounterVoidSection[];
  preview: boolean;
}

export const SIGNED_ENCOUNTER_TOOLTIP = "Signed — use an amendment.";

const CLOSED_ENCOUNTER_STATUSES: ReadonlySet<string> = new Set(["finished", "cancelled", "entered-in-error"]);

/** Mirrors the server's sign gate: finished, cancelled, and entered-in-error encounters take no edits. */
export function isClosedEncounterStatus(status: Encounter["status"] | string | undefined): boolean {
  return status !== undefined && CLOSED_ENCOUNTER_STATUSES.has(status);
}

export async function voidEncounterEntries(
  encounterReference: string,
  request: EncounterVoidRequest,
  options: { preview?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<EncounterVoidResult> {
  const encounterId = encounterReference.replace(/^Encounter\//, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/void`,
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(options.preview ? { ...request, preview: true } : request),
    },
  );
  const body = await response.json().catch(() => ({})) as Partial<EncounterVoidResult> & ClinicalGraphErrorBody;
  if (!response.ok) {
    throw clinicalGraphResponseError(response, body, `Void failed (${response.status}).`);
  }
  return {
    voided: body.voided ?? [],
    count: body.count ?? 0,
    sections: body.sections ?? [],
    preview: body.preview === true,
  };
}

/** Same candidate resolution as a void, nothing written — the confirm dialog's numbers come from here. */
export function previewEncounterVoid(
  encounterReference: string,
  request: EncounterVoidRequest,
  fetchImpl?: typeof fetch,
): Promise<EncounterVoidResult> {
  return voidEncounterEntries(encounterReference, request, { preview: true, fetchImpl });
}

export function clearSectionConfirmMessage(label: string, count: number): string {
  return `Clear ${label} — voids ${count} recorded ${count === 1 ? "value" : "values"} from this visit. They remain in the record as entered-in-error. Continue?`;
}

export function clearEncounterConfirmMessage(sections: readonly EncounterVoidSection[], count: number): string {
  const named = sections.map((section) => `${section.label} (${section.count})`).join(", ");
  return `Clear everything charted for this visit — ${named}: ${count} recorded ${count === 1 ? "value" : "values"}. They remain in the record as entered-in-error. Continue?`;
}

/** A destructive action without a confirm surface is refused, never assumed. */
export function confirmDestructive(message: string): boolean {
  return typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(message) : false;
}
