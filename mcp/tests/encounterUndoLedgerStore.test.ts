import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import {
  ENCOUNTER_UNDO_LEDGER_CODE,
  ENCOUNTER_UNDO_LEDGER_CODE_SYSTEM,
  ENCOUNTER_UNDO_LEDGER_EXTENSION_URL,
  FhirEncounterUndoLedgerStore,
  buildEncounterUndoLedgerResource,
  emptyEncounterUndoLedger,
  parseEncounterUndoLedgerResource,
  type EncounterUndoLedger,
} from "../src/clinical-graph/encounter-undo-ledger-store.js";

const LEDGER: EncounterUndoLedger = {
  encounterId: "e1",
  encounter: {
    voided: [
      { ref: "Observation/o1", priorStatus: "preliminary" },
      { ref: "Condition/c1", priorStatus: "confirmed", clinicalStatus: "active", diagnosis: { condition: { reference: "Condition/c1" }, rank: 1 } },
      { ref: "Basic/basic-cx", priorStatus: "active" },
    ],
    label: "everything charted",
    count: 3,
    at: "2026-09-01T15:00:00.000Z",
    sectionKeys: [],
  },
  sections: {
    "entrance:pupils": {
      voided: [{ ref: "Observation/p1", priorStatus: "final" }],
      label: "Pupils",
      count: 1,
      at: "2026-09-01T14:00:00.000Z",
      sectionKeys: ["entrance:pupils"],
    },
  },
};

test("the ledger Basic round-trips every slot, entry, and prior status through its JSON extension", () => {
  const resource = buildEncounterUndoLedgerResource(LEDGER);
  assert.equal(resource.resourceType, "Basic");
  assert.equal(resource.subject?.reference, "Encounter/e1");
  assert.deepEqual(resource.code?.coding?.[0], {
    system: ENCOUNTER_UNDO_LEDGER_CODE_SYSTEM,
    code: ENCOUNTER_UNDO_LEDGER_CODE,
    display: "ODOS encounter undo ledger",
  });
  assert.ok(resource.extension?.some((extension) => extension.url === ENCOUNTER_UNDO_LEDGER_EXTENSION_URL));
  assert.deepEqual(parseEncounterUndoLedgerResource(resource), LEDGER);
});

test("rebuilding onto an existing Basic keeps its id and meta so the update is version-guarded", () => {
  const existing: Basic = { ...buildEncounterUndoLedgerResource(LEDGER), id: "ledger-1", meta: { versionId: "4" } };
  const rebuilt = buildEncounterUndoLedgerResource({ ...LEDGER, encounter: null }, existing);
  assert.equal(rebuilt.id, "ledger-1");
  assert.equal(rebuilt.meta?.versionId, "4");
  assert.equal(parseEncounterUndoLedgerResource(rebuilt).encounter, null);
});

test("parse refuses a Basic that is not an undo ledger or whose subject is not an Encounter", () => {
  assert.throws(() => parseEncounterUndoLedgerResource({ resourceType: "Basic", code: { coding: [{ system: "x", code: "y" }] } }), /not odos-encounter-undo-ledger/);
  const noSubject = { ...buildEncounterUndoLedgerResource(LEDGER), subject: { reference: "Patient/p1" } };
  assert.throws(() => parseEncounterUndoLedgerResource(noSubject), /Encounter subject/);
});

test("get returns the empty ledger when the encounter has no Basic yet, and the stored one when it does", async () => {
  const fhir = new MemoryFhir();
  const store = new FhirEncounterUndoLedgerStore(fhir);
  assert.deepEqual(await store.get("e1"), emptyEncounterUndoLedger("e1"));
  assert.deepEqual(emptyEncounterUndoLedger("e1"), { encounterId: "e1", encounter: null, sections: {} });

  fhir.resources.push({ ...buildEncounterUndoLedgerResource(LEDGER), id: "ledger-1", meta: { versionId: "1" } });
  // Another encounter's ledger is never this encounter's, even if the search were to return it.
  fhir.resources.push({ ...buildEncounterUndoLedgerResource({ ...LEDGER, encounterId: "e2" }), id: "ledger-2", meta: { versionId: "1" } });
  assert.deepEqual(await store.get("e1"), LEDGER);
  const search = fhir.searches[fhir.searches.length - 1]!;
  assert.equal(search.params.code, `${ENCOUNTER_UNDO_LEDGER_CODE_SYSTEM}|${ENCOUNTER_UNDO_LEDGER_CODE}`);
  assert.equal(search.params.subject, "Encounter/e1");
});

test("readRow hands back the stored Basic alongside the ledger so a writer can PUT it version-guarded", async () => {
  const fhir = new MemoryFhir();
  const store = new FhirEncounterUndoLedgerStore(fhir);
  assert.equal(await store.readRow("e1"), undefined);
  fhir.resources.push({ ...buildEncounterUndoLedgerResource(LEDGER), id: "ledger-1", meta: { versionId: "7" } });
  const row = await store.readRow("e1");
  assert.equal(row?.resource.id, "ledger-1");
  assert.equal(row?.resource.meta?.versionId, "7");
  assert.deepEqual(row?.ledger, LEDGER);
});

class MemoryFhir {
  readonly resources: Resource[] = [];
  readonly searches: Array<{ resourceType: string; params: Record<string, string> }> = [];

  async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    this.searches.push({ resourceType, params: { ...params } });
    // Permissive on purpose: returns every Basic of the type regardless of subject, so the
    // store's own encounterId check is what keeps another encounter's ledger out.
    const rows = this.resources.filter((resource) => resource.resourceType === resourceType);
    return { resourceType: "Bundle", type: "searchset", entry: rows.map((resource) => ({ resource: structuredClone(resource) as T })) };
  }
}
