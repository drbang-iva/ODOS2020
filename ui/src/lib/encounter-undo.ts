import type { EncounterDiagnosis } from "@medplum/fhirtypes";
import {
  authHeaders,
  clinicalGraphApiBase,
  clinicalGraphResponseError,
  type ClinicalGraphErrorBody,
} from "./clinical-graph-client";

/**
 * Client for the per-encounter Undo ledger (§4b.4) and the one reversal it supports:
 *
 *   GET  /clinical-graph/encounters/:encounterId/void/ledger   → { ledger }
 *   POST /clinical-graph/encounters/:encounterId/void/undo     { scope, sectionKey? }
 *
 * The ledger holds one slot for the visit (tier 3) and one per section (tiers 1–2), each the
 * most recent clear at that scope. Undo restores exactly that slot's set and clears it. There
 * is no history to browse and Undo is not itself undoable.
 */

export interface UndoLedgerEntry {
  ref: string;
  priorStatus: string;
  clinicalStatus?: string;
  diagnosis?: EncounterDiagnosis;
}

export interface UndoLedgerSlot {
  voided: UndoLedgerEntry[];
  label: string;
  count: number;
  at: string;
  sectionKeys: string[];
  /** "observation" | "finding" for a tier-1 remove, "section" for a clear, "encounter" for the visit. */
  scope?: string;
}

export interface EncounterUndoLedger {
  encounterId: string;
  encounter: UndoLedgerSlot | null;
  sections: Record<string, UndoLedgerSlot>;
}

export type EncounterUndoRequest =
  | { scope: "encounter" }
  | { scope: "section"; sectionKey: string };

export interface EncounterUndoResult {
  restored: string[];
  count: number;
  skipped: string[];
  ledger: EncounterUndoLedger;
}

export function emptyUndoLedger(encounterReferenceOrId: string): EncounterUndoLedger {
  return { encounterId: encounterId(encounterReferenceOrId), encounter: null, sections: {} };
}

function encounterId(reference: string): string {
  return reference.replace(/^Encounter\//, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSlot(value: unknown): value is UndoLedgerSlot {
  return isRecord(value) &&
    Array.isArray(value.voided) &&
    typeof value.label === "string" &&
    typeof value.count === "number" &&
    typeof value.at === "string";
}

/** Tolerant: anything that is not a ledger for this encounter reads as "nothing to undo". */
export function parseUndoLedger(value: unknown, encounterReferenceOrId: string): EncounterUndoLedger {
  const id = encounterId(encounterReferenceOrId);
  const candidate = isRecord(value) && isRecord(value.ledger) ? value.ledger : undefined;
  if (!candidate || candidate.encounterId !== id) return emptyUndoLedger(id);
  const encounter = isSlot(candidate.encounter) ? candidate.encounter : null;
  const sections: Record<string, UndoLedgerSlot> = {};
  if (isRecord(candidate.sections)) {
    for (const [key, slot] of Object.entries(candidate.sections)) {
      if (isSlot(slot)) sections[key] = slot;
    }
  }
  return { encounterId: id, encounter, sections };
}

/** Never throws: Undo is a convenience, and a chart must open even when the ledger cannot be read. */
export async function readEncounterUndoLedger(
  encounterReference: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EncounterUndoLedger> {
  const id = encounterId(encounterReference);
  try {
    const response = await fetchImpl(
      `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(id)}/void/ledger`,
      { headers: authHeaders() },
    );
    if (!response.ok) return emptyUndoLedger(id);
    return parseUndoLedger(await response.json(), id);
  } catch {
    return emptyUndoLedger(id);
  }
}

export async function undoEncounterVoid(
  encounterReference: string,
  request: EncounterUndoRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<EncounterUndoResult> {
  const id = encounterId(encounterReference);
  const response = await fetchImpl(
    `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(id)}/void/undo`,
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  const body = await response.json().catch(() => ({})) as Partial<EncounterUndoResult> & ClinicalGraphErrorBody;
  if (!response.ok) {
    throw clinicalGraphResponseError(response, body, `Undo failed (${response.status}).`);
  }
  return {
    restored: body.restored ?? [],
    count: body.count ?? 0,
    skipped: body.skipped ?? [],
    ledger: parseUndoLedger({ ledger: body.ledger }, id),
  };
}

/**
 * The slot a sheet renders: the most recent slot filed under any of the sheet's own keys,
 * where a key matches exactly or as a `key:` prefix in either direction — so a sheet that
 * names ["entrance:cvf", "entrance:visual-field-defect"] finds a slot filed under either,
 * and "ocular-health" sees every slot beneath it.
 */
export function undoSlotForSection(
  ledger: EncounterUndoLedger,
  sectionKeys: readonly string[],
): { sectionKey: string; slot: UndoLedgerSlot } | undefined {
  const related = (left: string, right: string) => left === right || left.startsWith(`${right}:`) || right.startsWith(`${left}:`);
  let best: { sectionKey: string; slot: UndoLedgerSlot } | undefined;
  for (const [sectionKey, slot] of Object.entries(ledger.sections)) {
    const matches = sectionKeys.some((key) => related(sectionKey, key)) ||
      slot.sectionKeys.some((slotKey) => sectionKeys.some((key) => related(slotKey, key)));
    if (!matches) continue;
    if (!best || slot.at.localeCompare(best.slot.at) > 0) best = { sectionKey, slot };
  }
  return best;
}

/** "Removed Reactivity · OD" · "Cleared Pupils · 6 values" · "Cleared everything charted · 31 values". */
export function undoStripCopy(slot: UndoLedgerSlot): string {
  const verb = slot.scope === "observation" || slot.scope === "finding" ? "Removed" : "Cleared";
  const count = `${slot.count} ${slot.count === 1 ? "value" : "values"}`;
  if (verb === "Removed" && slot.count === 1) return `${verb} ${slot.label}`;
  return `${verb} ${slot.label} · ${count}`;
}
