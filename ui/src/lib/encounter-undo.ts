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

/**
 * "Removed Reactivity · OD" · "Cleared Pupils · 6 values" · "Cleared everything charted · 31 values".
 *
 * The exact count is spoken only for a slot this page saw CONFIRMED — returned by a successful
 * void's own response, which proves every row in it applied. A slot read back from the server
 * (on load, or after a refused clear) was written from intent: on this non-atomic stack a
 * refused clear can still write its slot naming every row it MEANT to void, so its count is
 * an upper bound and the copy says so. Undo itself restores only what was actually voided.
 */
export function undoStripCopy(slot: UndoLedgerSlot, options: { confirmed?: boolean } = {}): string {
  const verb = slot.scope === "observation" || slot.scope === "finding" ? "Removed" : "Cleared";
  const noun = slot.count === 1 ? "value" : "values";
  if (!options.confirmed) return `${verb} ${slot.label} · up to ${slot.count} ${noun}`;
  if (verb === "Removed" && slot.count === 1) return `${verb} ${slot.label}`;
  return `${verb} ${slot.label} · ${slot.count} ${noun}`;
}

/** The Undo button's title, with the same confirmed / upper-bound split as the strip copy. */
export function undoButtonTitle(slot: UndoLedgerSlot, confirmed: boolean): string {
  const noun = slot.count === 1 ? "value" : "values";
  return confirmed
    ? `Restore the ${slot.count === 1 ? noun : `${slot.count} ${noun}`} this action removed`
    : `Restore whatever this action actually removed, up to ${slot.count} ${noun}`;
}

/** Identity of a slot for confirmation bookkeeping: its placement plus the action's timestamp. */
export function undoSlotKey(placement: "encounter" | string, slot: UndoLedgerSlot): string {
  return `${placement}|${slot.at}`;
}

/**
 * The slot(s) a successful void's response ledger vouches for: those stamped with the newest
 * `at` — the action that just ran and applied in full. Every other slot in that ledger was
 * carried over from storage and stays intent-derived.
 */
export function confirmedSlotKeys(ledger: EncounterUndoLedger): string[] {
  const rows = [
    ...(ledger.encounter ? [{ placement: "encounter", slot: ledger.encounter }] : []),
    ...Object.entries(ledger.sections).map(([placement, slot]) => ({ placement, slot })),
  ];
  const newest = rows.reduce<string | undefined>((max, row) => max === undefined || row.slot.at.localeCompare(max) > 0 ? row.slot.at : max, undefined);
  return rows.filter((row) => row.slot.at === newest).map((row) => undoSlotKey(row.placement, row.slot));
}
