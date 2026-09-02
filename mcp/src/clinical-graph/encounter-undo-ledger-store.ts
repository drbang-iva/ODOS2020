import type { Basic, Bundle, EncounterDiagnosis, Resource } from "@medplum/fhirtypes";

/**
 * The per-encounter Undo ledger — one `Basic` per encounter, cloned from the
 * `odos-encounter-section-override` pattern in finding-section-group-store.ts.
 *
 * It records, per undo slot, exactly which resources the last clear action voided and what
 * status each one had before, so Undo restores *that* (a `preliminary` IOP stays
 * `preliminary`; a custom-section Observation with no status gets none back) instead of a
 * constant. One slot for the visit (tier 3) and one per section (tiers 1–2). It is not an
 * audit log: a slot holds one action, the most recent, and Undo clears it.
 */

const BASE = "https://odos2020.com/fhir";
export const ENCOUNTER_UNDO_LEDGER_CODE = "odos-encounter-undo-ledger";
export const ENCOUNTER_UNDO_LEDGER_CODE_SYSTEM = `${BASE}/CodeSystem/${ENCOUNTER_UNDO_LEDGER_CODE}`;
export const ENCOUNTER_UNDO_LEDGER_EXTENSION_URL = `${BASE}/StructureDefinition/${ENCOUNTER_UNDO_LEDGER_CODE}-json`;

export interface UndoLedgerEntry {
  /** `ResourceType/id` of the voided resource. */
  ref: string;
  /**
   * The status the resource carried before the void: Observation.status,
   * MedicationAdministration.status, Condition.verificationStatus code, or the complaint's
   * `active`. Custom-section Observations save with no status at all; that is recorded as "".
   */
  priorStatus: string;
  /** Conditions only — the clinicalStatus code the void stripped. */
  clinicalStatus?: string;
  /** Conditions only — the Encounter.diagnosis row the void retracted, restored verbatim. */
  diagnosis?: EncounterDiagnosis;
}

export interface UndoLedgerSlot {
  voided: UndoLedgerEntry[];
  /** What the strip says was cleared: "Pupils", "Reactivity · OD", "everything charted". */
  label: string;
  count: number;
  at: string;
  /** The section keys the action was scoped to (empty for the visit slot). */
  sectionKeys: string[];
  /** Which tier made the clear — "observation" | "finding" (tier 1), "section" (tier 2), "encounter" (tier 3). */
  scope?: string;
}

export interface EncounterUndoLedger {
  encounterId: string;
  encounter: UndoLedgerSlot | null;
  sections: Record<string, UndoLedgerSlot>;
}

export function emptyEncounterUndoLedger(encounterId: string): EncounterUndoLedger {
  return { encounterId, encounter: null, sections: {} };
}

export interface EncounterUndoLedgerFhirClient {
  search<T extends Resource>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
}

export class FhirEncounterUndoLedgerStore {
  constructor(private readonly fhir: EncounterUndoLedgerFhirClient) {}

  async get(encounterId: string): Promise<EncounterUndoLedger> {
    return (await this.readRow(encounterId))?.ledger ?? emptyEncounterUndoLedger(encounterId);
  }

  /** The stored Basic with its ledger, or undefined when the encounter has none yet. */
  async readRow(encounterId: string): Promise<{ resource: Basic; ledger: EncounterUndoLedger } | undefined> {
    requiredId(encounterId, "Encounter id");
    const bundle = await this.fhir.search<Basic>("Basic", {
      code: `${ENCOUNTER_UNDO_LEDGER_CODE_SYSTEM}|${ENCOUNTER_UNDO_LEDGER_CODE}`,
      subject: `Encounter/${encounterId}`,
      _count: "10",
    });
    const rows = (bundle.entry ?? []).flatMap((entry) => {
      if (!entry.resource) return [];
      try {
        const ledger = parseEncounterUndoLedgerResource(entry.resource);
        return ledger.encounterId === encounterId ? [{ resource: entry.resource, ledger }] : [];
      } catch (error) {
        console.error(`Encounter-undo-ledger Basic/${entry.resource.id ?? "unknown"} skipped: ${errorMessage(error)}`);
        return [];
      }
    });
    // Newest Basic wins if a duplicate ever appears; the loser is logged, never silently merged.
    let winner: { resource: Basic; ledger: EncounterUndoLedger } | undefined;
    for (const row of rows) {
      if (!winner || compareResources(row.resource, winner.resource) > 0) winner = row;
    }
    for (const row of rows) {
      if (row !== winner) console.error(`Duplicate encounter undo ledger for ${encounterId}: Basic/${row.resource.id ?? "unknown"} skipped.`);
    }
    return winner;
  }
}

export function buildEncounterUndoLedgerResource(ledger: EncounterUndoLedger, existing?: Basic): Basic {
  const validated = assertEncounterUndoLedger(ledger);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    subject: { reference: `Encounter/${validated.encounterId}` },
    code: {
      coding: [{
        system: ENCOUNTER_UNDO_LEDGER_CODE_SYSTEM,
        code: ENCOUNTER_UNDO_LEDGER_CODE,
        display: "ODOS encounter undo ledger",
      }],
      text: "Encounter undo ledger",
    },
    extension: [{
      url: ENCOUNTER_UNDO_LEDGER_EXTENSION_URL,
      valueString: JSON.stringify({ encounter: validated.encounter, sections: validated.sections }),
    }],
  };
}

export function parseEncounterUndoLedgerResource(resource: Basic): EncounterUndoLedger {
  const matches = resource.code?.coding?.some((coding) =>
    coding.system === ENCOUNTER_UNDO_LEDGER_CODE_SYSTEM && coding.code === ENCOUNTER_UNDO_LEDGER_CODE
  );
  if (!matches) throw new Error(`Basic resource is not ${ENCOUNTER_UNDO_LEDGER_CODE}.`);
  const encounterId = resource.subject?.reference?.match(/^Encounter\/([^/]+)$/)?.[1];
  if (!encounterId) throw new Error("Encounter-undo-ledger Basic must reference an Encounter subject.");
  const raw = resource.extension?.find((extension) => extension.url === ENCOUNTER_UNDO_LEDGER_EXTENSION_URL)?.valueString;
  if (!raw) throw new Error("Encounter-undo-ledger Basic is missing its JSON extension.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Encounter-undo-ledger JSON is malformed and cannot be parsed.");
  }
  if (!isRecord(parsed)) throw new Error("Encounter undo ledger must be an object.");
  return assertEncounterUndoLedger({ encounterId, encounter: parsed.encounter ?? null, sections: parsed.sections ?? {} });
}

export function assertEncounterUndoLedger(value: unknown): EncounterUndoLedger {
  if (!isRecord(value)) throw new Error("Encounter undo ledger must be an object.");
  requiredId(value.encounterId, "Encounter id");
  const encounter = value.encounter === null || value.encounter === undefined ? null : assertSlot(value.encounter, "encounter");
  if (!isRecord(value.sections ?? {})) throw new Error("Encounter undo ledger sections must be an object.");
  const sections: Record<string, UndoLedgerSlot> = {};
  for (const [key, slot] of Object.entries((value.sections ?? {}) as Record<string, unknown>)) {
    requiredId(key, "Undo ledger section key");
    sections[key] = assertSlot(slot, key);
  }
  return { encounterId: value.encounterId, encounter, sections };
}

function assertSlot(value: unknown, label: string): UndoLedgerSlot {
  if (!isRecord(value)) throw new Error(`Undo ledger slot ${label} must be an object.`);
  if (!Array.isArray(value.voided)) throw new Error(`Undo ledger slot ${label} must list voided entries.`);
  const voided = value.voided.map((entry) => assertEntry(entry, label));
  if (typeof value.label !== "string") throw new Error(`Undo ledger slot ${label} must carry a label.`);
  if (typeof value.count !== "number" || !Number.isInteger(value.count) || value.count < 0) {
    throw new Error(`Undo ledger slot ${label} must carry an integer count.`);
  }
  requiredId(value.at, `Undo ledger slot ${label} timestamp`);
  const sectionKeys = Array.isArray(value.sectionKeys) ? value.sectionKeys : [];
  for (const key of sectionKeys) requiredId(key, `Undo ledger slot ${label} section key`);
  return {
    voided,
    label: value.label,
    count: value.count,
    at: value.at,
    sectionKeys: sectionKeys as string[],
    ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
  };
}

function assertEntry(value: unknown, label: string): UndoLedgerEntry {
  if (!isRecord(value)) throw new Error(`Undo ledger slot ${label} entry must be an object.`);
  if (typeof value.ref !== "string" || !/^[A-Za-z]+\/[A-Za-z0-9.-]+$/.test(value.ref)) {
    throw new Error(`Undo ledger slot ${label} entry must reference a resource.`);
  }
  if (typeof value.priorStatus !== "string") throw new Error(`Undo ledger entry ${value.ref} must record priorStatus.`);
  const entry: UndoLedgerEntry = { ref: value.ref, priorStatus: value.priorStatus };
  if (typeof value.clinicalStatus === "string") entry.clinicalStatus = value.clinicalStatus;
  if (isRecord(value.diagnosis)) {
    const condition = value.diagnosis.condition;
    if (!isRecord(condition) || typeof condition.reference !== "string") {
      throw new Error(`Undo ledger entry ${value.ref} diagnosis must reference a Condition.`);
    }
    entry.diagnosis = value.diagnosis as unknown as EncounterDiagnosis;
  }
  return entry;
}

function requiredId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareResources(left: Basic, right: Basic): number {
  return (left.meta?.lastUpdated ?? "").localeCompare(right.meta?.lastUpdated ?? "") ||
    (left.id ?? "").localeCompare(right.id ?? "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
