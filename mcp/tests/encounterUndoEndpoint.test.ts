import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Condition, Encounter, Observation, Provenance } from "@medplum/fhirtypes";
import { parseEncounterComplaintResource } from "../src/clinical-graph/encounter-complaint-store.js";
import {
  RESTORE_PROVENANCE_NOTE,
  handleEncounterUndoLedgerRequest,
  handleEncounterUndoRequest,
} from "../src/clinical-graph/encounter-undo-endpoint.js";
import {
  ENCOUNTER_UNDO_LEDGER_CODE,
  ENCOUNTER_UNDO_LEDGER_CODE_SYSTEM,
  FhirEncounterUndoLedgerStore,
  type EncounterUndoLedger,
} from "../src/clinical-graph/encounter-undo-ledger-store.js";
import { handleEncounterVoidRequest } from "../src/clinical-graph/encounter-void-endpoint.js";
import { clinicalStatusConcept, verificationStatusConcept } from "../src/fhir/condition.js";
import {
  AUTH,
  ENCOUNTER,
  NOW,
  PATIENT,
  administration,
  complaintResource,
  condition,
  cvf,
  fixture,
  observation,
  type MemoryFhir,
  type VoidBody,
} from "./encounterVoidFixture.js";

type UndoBody = {
  restored: string[];
  count: number;
  ledger: EncounterUndoLedger;
  error?: string;
  code?: string;
};

type LedgerBody = { ledger: EncounterUndoLedger; error?: string };

const PARAMS = { encounterId: "e1" };

async function voidEntries(deps: Parameters<typeof handleEncounterVoidRequest>[0], body: unknown) {
  const result = await handleEncounterVoidRequest(deps, { authHeader: AUTH, params: PARAMS, body });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body as VoidBody & { ledger: EncounterUndoLedger };
}

async function undo(deps: Parameters<typeof handleEncounterUndoRequest>[0], body: unknown) {
  return handleEncounterUndoRequest(deps, { authHeader: AUTH, params: PARAMS, body });
}

function ledgerEntries(fhir: MemoryFhir): Basic[] {
  return fhir.all<Basic>("Basic").filter((row) =>
    row.code?.coding?.some((coding) => coding.system === ENCOUNTER_UNDO_LEDGER_CODE_SYSTEM && coding.code === ENCOUNTER_UNDO_LEDGER_CODE)
  );
}

/** Six Pupils values (three per eye) plus twenty-five across four other sections. */
function seedPupilsAndTwentyFive(fhir: MemoryFhir): { pupils: string[]; others: string[] } {
  const pupils: string[] = [];
  const others: string[] = [];
  for (let index = 1; index <= 3; index += 1) {
    for (const eye of ["OD", "OS"] as const) {
      const id = `pupil-${eye}-${index}`;
      fhir.add(observation(id, "entrance:pupils", eye));
      pupils.push(`Observation/${id}`);
    }
  }
  for (let index = 1; index <= 10; index += 1) { fhir.add(cvf(`cvf-${index}`, index % 2 ? "OD" : "OS")); others.push(`Observation/cvf-${index}`); }
  for (let index = 1; index <= 5; index += 1) { fhir.add(observation(`iop-${index}`, "intraocular_pressure", "OD", { status: "preliminary" })); others.push(`Observation/iop-${index}`); }
  for (let index = 1; index <= 5; index += 1) { fhir.add(observation(`cornea-${index}`, "ocular-health:anterior:cornea", "OS")); others.push(`Observation/cornea-${index}`); }
  for (let index = 1; index <= 5; index += 1) { fhir.add(observation(`dfe-${index}`, "entrance:dilation", "UNKNOWN")); others.push(`Observation/dfe-${index}`); }
  return { pupils, others };
}

// ---------------------------------------------------------------------------
// Mandate 17 guard 9 — the ledger is written by the void, in the void's transaction
// ---------------------------------------------------------------------------

test("guard 9: a section void writes the ledger slot in the SAME transaction, and a GET of the ledger shows it with its count", async () => {
  const { deps, fhir } = fixture();
  fhir.add(observation("pupil-od", "entrance:pupils", "OD"));
  fhir.add(observation("pupil-os", "entrance:pupils", "OS", { status: "preliminary" }));

  const body = await voidEntries(deps, { scope: "section", sectionKey: "entrance:pupils" });

  assert.equal(fhir.transactions.length, 1, "the void and its ledger are one transaction, not two round trips");
  const ledgerEntry = fhir.transactions[0]!.entry!.find((entry) =>
    entry.resource?.resourceType === "Basic" &&
    (entry.resource as Basic).code?.coding?.some((coding) => coding.code === ENCOUNTER_UNDO_LEDGER_CODE)
  );
  assert.ok(ledgerEntry, "the ledger Basic rides in the void transaction");
  assert.equal(ledgerEntry.request?.method, "POST");

  const stored = await new FhirEncounterUndoLedgerStore(fhir).get("e1");
  const slot = stored.sections["entrance:pupils"];
  assert.ok(slot, "one slot per section");
  assert.equal(slot.count, 2);
  assert.equal(slot.label, "Pupils");
  assert.equal(slot.at, NOW);
  assert.deepEqual(slot.sectionKeys, ["entrance:pupils"]);
  assert.deepEqual(
    [...slot.voided].sort((left, right) => left.ref.localeCompare(right.ref)),
    [{ ref: "Observation/pupil-od", priorStatus: "final" }, { ref: "Observation/pupil-os", priorStatus: "preliminary" }],
    "priorStatus is recorded per resource, not assumed",
  );
  assert.equal(stored.encounter, null);
  assert.deepEqual(body.ledger, stored, "the void response carries the ledger the client renders from");

  const read = await handleEncounterUndoLedgerRequest(deps, { authHeader: AUTH, params: PARAMS });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual((read.body as LedgerBody).ledger, stored);
});

test("a second void updates the one existing ledger Basic version-guarded instead of creating another", async () => {
  const { deps, fhir } = fixture();
  fhir.add(observation("pupil-od", "entrance:pupils", "OD"));
  fhir.add(cvf("cvf-od", "OD"));
  await voidEntries(deps, { scope: "section", sectionKey: "entrance:pupils" });
  await voidEntries(deps, { scope: "section", sectionKey: "entrance:cvf" });

  assert.equal(ledgerEntries(fhir).length, 1, "one ledger per encounter");
  const second = fhir.transactions[1]!.entry!.find((entry) => entry.request?.url?.startsWith("Basic/"));
  assert.equal(second?.request?.method, "PUT");
  assert.equal(second?.request?.ifMatch, 'W/"1"');
});

test("preview and empty voids never write a ledger", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("cvf-od", "OD"));
  const preview = await voidEntries(deps, { scope: "section", sectionKey: "entrance:cvf", preview: true });
  assert.equal(preview.count, 1);
  const empty = await voidEntries(deps, { scope: "section", sectionKey: "entrance:pupils" });
  assert.equal(empty.count, 0);
  assert.equal(fhir.transactions.length, 0);
  assert.equal(ledgerEntries(fhir).length, 0);
  assert.equal(empty.ledger.encounter, null);
  assert.deepEqual(empty.ledger.sections, {});
});

// ---------------------------------------------------------------------------
// §4b.2 supersession — one slot for the visit, one per section, tier 3 absorbs
// ---------------------------------------------------------------------------

test("rule 1: a second visit clear replaces the first's Undo — the visit slot holds only the latest action", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("first", "OD"));
  await voidEntries(deps, { scope: "encounter" });
  fhir.add(cvf("second", "OS"));
  const body = await voidEntries(deps, { scope: "encounter" });

  assert.deepEqual(body.ledger.encounter?.voided, [{ ref: "Observation/second", priorStatus: "final" }]);
  assert.equal(body.ledger.encounter?.count, 1);
  assert.equal(body.ledger.encounter?.label, "everything charted");
});

test("rule 2: sections own independent slots — clearing CVF leaves Pupils' Undo alone, and a tier-1 remove inside Pupils replaces only Pupils'", async () => {
  const { deps, fhir } = fixture();
  fhir.add(observation("pupil-od", "entrance:pupils", "OD"));
  fhir.add(observation("pupil-os", "entrance:pupils", "OS"));
  fhir.add(cvf("cvf-od", "OD"));
  await voidEntries(deps, { scope: "section", sectionKey: "entrance:pupils" });
  let body = await voidEntries(deps, { scope: "section", sectionKey: "entrance:cvf" });
  assert.deepEqual(Object.keys(body.ledger.sections).sort(), ["entrance:cvf", "entrance:pupils"]);
  assert.equal(body.ledger.sections["entrance:pupils"]?.count, 2);

  fhir.add(observation("pupil-again", "entrance:pupils", "OD", { status: "preliminary" }));
  body = await voidEntries(deps, { scope: "observation", observationReference: "Observation/pupil-again", label: "Reactivity · OD" });
  assert.deepEqual(body.ledger.sections["entrance:pupils"], {
    voided: [{ ref: "Observation/pupil-again", priorStatus: "preliminary" }],
    label: "Reactivity · OD",
    count: 1,
    at: NOW,
    sectionKeys: ["entrance:pupils"],
    scope: "observation",
  }, "a tier-1 remove is slotted under its section and replaces that section's previous clear");
  assert.equal(body.ledger.sections["entrance:cvf"]?.count, 1, "the other section's slot is untouched");
});

test("a tier-1 remove may name the sheet's section keys so a two-definition sheet keeps one slot, replacing any slot under either key", async () => {
  const { deps, fhir } = fixture();
  fhir.add(observation("vfd-od", "entrance:visual-field-defect", "OD"));
  fhir.add(cvf("cvf-od", "OD"));
  await voidEntries(deps, {
    scope: "observation",
    observationReference: "Observation/vfd-od",
    sectionKey: ["entrance:cvf", "entrance:visual-field-defect"],
    label: "Field defect · OD",
  });
  let stored = await new FhirEncounterUndoLedgerStore(fhir).get("e1");
  assert.deepEqual(Object.keys(stored.sections), ["entrance:cvf"], "slotted under the first key the sheet names");
  assert.deepEqual(stored.sections["entrance:cvf"]?.sectionKeys, ["entrance:cvf", "entrance:visual-field-defect"]);

  await voidEntries(deps, {
    scope: "observation",
    observationReference: "Observation/cvf-od",
    sectionKey: ["entrance:cvf", "entrance:visual-field-defect"],
    label: "Superior temporal · OD",
  });
  stored = await new FhirEncounterUndoLedgerStore(fhir).get("e1");
  assert.deepEqual(Object.keys(stored.sections), ["entrance:cvf"]);
  assert.deepEqual(stored.sections["entrance:cvf"]?.voided, [{ ref: "Observation/cvf-od", priorStatus: "final" }]);
});

test("rule 3: a visit clear absorbs every pending section Undo — only the visit slot remains", async () => {
  const { deps, fhir } = fixture();
  fhir.add(observation("pupil-od", "entrance:pupils", "OD"));
  fhir.add(cvf("cvf-od", "OD"));
  await voidEntries(deps, { scope: "section", sectionKey: "entrance:pupils" });
  const body = await voidEntries(deps, { scope: "encounter" });
  assert.deepEqual(body.ledger.sections, {});
  assert.deepEqual(body.ledger.encounter?.voided, [{ ref: "Observation/cvf-od", priorStatus: "final" }]);
});

// ---------------------------------------------------------------------------
// Mandate 17 guard 7 — Undo restores exactly the set that action voided
// ---------------------------------------------------------------------------

test("guard 7: clear Pupils (6), clear everything (25 more), undo everything → 25 restored and Pupils' 6 still entered-in-error", async () => {
  const { deps, fhir } = fixture();
  const { pupils, others } = seedPupilsAndTwentyFive(fhir);

  const pupilsVoid = await voidEntries(deps, { scope: "section", sectionKey: "entrance:pupils" });
  assert.equal(pupilsVoid.count, 6);
  const everything = await voidEntries(deps, { scope: "encounter" });
  assert.equal(everything.count, 25, "Pupils' 6 were already entered-in-error and are not re-voided");
  assert.equal(everything.ledger.encounter?.count, 25);
  assert.deepEqual(everything.ledger.sections, {}, "rule 3: the Pupils Undo was absorbed");

  const result = await undo(deps, { scope: "encounter" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as UndoBody;
  assert.equal(body.count, 25);
  assert.deepEqual([...body.restored].sort(), [...others].sort());
  for (const reference of others) {
    assert.notEqual(fhir.get<Observation>("Observation", reference.slice("Observation/".length)).status, "entered-in-error", `${reference} restored`);
  }
  for (const reference of pupils) {
    assert.equal(fhir.get<Observation>("Observation", reference.slice("Observation/".length)).status, "entered-in-error", `${reference} stays voided: that Undo was absorbed and is gone`);
  }
  assert.equal(body.ledger.encounter, null, "the slot is cleared by the Undo");
  assert.deepEqual(body.ledger.sections, {});
});

// ---------------------------------------------------------------------------
// Mandate 17 guard 8 — Undo is gated by sign
// ---------------------------------------------------------------------------

test("guard 8: undo against a finished encounter returns 409 and restores nothing", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("cvf-od", "OD"));
  await voidEntries(deps, { scope: "encounter" });
  fhir.replace({ ...fhir.get<Encounter>("Encounter", "e1"), status: "finished" });

  const result = await undo(deps, { scope: "encounter" });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal((result.body as UndoBody).code, "encounter-closed");
  assert.match((result.body as UndoBody).error ?? "", /signed|closed/i);
  assert.equal(fhir.transactions.length, 1, "only the void wrote; the undo wrote nothing");
  assert.equal(fhir.get<Observation>("Observation", "cvf-od").status, "entered-in-error");
});

test("guard 8: cancelled and entered-in-error encounters gate undo the same way", async () => {
  for (const status of ["cancelled", "entered-in-error"] as const) {
    const { deps, fhir } = fixture();
    fhir.add(cvf("cvf-od", "OD"));
    await voidEntries(deps, { scope: "section", sectionKey: "entrance:cvf" });
    fhir.replace({ ...fhir.get<Encounter>("Encounter", "e1"), status });
    const result = await undo(deps, { scope: "section", sectionKey: "entrance:cvf" });
    assert.equal(result.status, 409, `${status}: ${JSON.stringify(result.body)}`);
    assert.equal(fhir.transactions.length, 1);
  }
});

// ---------------------------------------------------------------------------
// Mandate 17 guard 10 — Undo restores the prior status, not a constant
// ---------------------------------------------------------------------------

test("guard 10: void a preliminary IOP Observation, undo → it is preliminary again", async () => {
  const { deps, fhir } = fixture();
  fhir.add(observation("iop-od", "intraocular_pressure", "OD", { status: "preliminary" }));
  await voidEntries(deps, { scope: "section", sectionKey: "tonometry" });
  assert.equal(fhir.get<Observation>("Observation", "iop-od").status, "entered-in-error");

  const result = await undo(deps, { scope: "section", sectionKey: "tonometry" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(fhir.get<Observation>("Observation", "iop-od").status, "preliminary", "what the record asserted about attestation is unchanged by the round trip");
});

test("guard 10: a final Observation comes back final, and a status-less custom Observation comes back with no status", async () => {
  const { deps, fhir } = fixture();
  fhir.add(observation("cvf-final", "entrance:cvf", "OD"));
  const statusless = observation("pupil-none", "entrance:pupils", "OD");
  delete (statusless as { status?: unknown }).status;
  fhir.add(statusless);
  await voidEntries(deps, { scope: "encounter" });
  assert.equal(fhir.get<Observation>("Observation", "pupil-none").status, "entered-in-error");

  const result = await undo(deps, { scope: "encounter" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(fhir.get<Observation>("Observation", "cvf-final").status, "final");
  assert.equal("status" in fhir.get<Observation>("Observation", "pupil-none"), false, "no status before means no status after — nothing is stamped final");
});

// ---------------------------------------------------------------------------
// Undo mechanics — Provenance, transaction, slot cleared, every shape restored
// ---------------------------------------------------------------------------

test("undo writes one RESTORE Provenance per resource, in one version-guarded transaction that carries the Encounter and clears the slot", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("cvf-od", "OD"));
  fhir.add(cvf("cvf-os", "OS"));
  await voidEntries(deps, { scope: "section", sectionKey: "entrance:cvf" });
  const voidProvenances = fhir.all<Provenance>("Provenance").length;

  const result = await undo(deps, { scope: "section", sectionKey: "entrance:cvf" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(fhir.transactions.length, 2, "one transaction for the undo");
  const transaction = fhir.transactions[1]!;
  const encounterEntry = transaction.entry!.find((entry) => entry.request?.url === "Encounter/e1");
  assert.equal(encounterEntry?.request?.method, "PUT");
  assert.equal(encounterEntry?.request?.ifMatch, 'W/"2"', "the Encounter rides in the undo transaction version-guarded, so a concurrent sign fails it closed");
  const ledgerEntry = transaction.entry!.find((entry) => entry.request?.url?.startsWith("Basic/"));
  assert.equal(ledgerEntry?.request?.method, "PUT");
  assert.ok(ledgerEntry?.request?.ifMatch, "the ledger update is version-guarded too");
  for (const id of ["cvf-od", "cvf-os"]) {
    const entry = transaction.entry!.find((row) => row.request?.url === `Observation/${id}`);
    assert.ok(entry?.request?.ifMatch, `${id} is restored with If-Match`);
  }

  const restores = fhir.all<Provenance>("Provenance").slice(voidProvenances);
  assert.equal(restores.length, 2, "one Provenance per restored resource");
  for (const provenance of restores) {
    assert.equal(provenance.activity?.coding?.[0]?.code, "RESTORE");
    assert.equal(provenance.activity?.text, RESTORE_PROVENANCE_NOTE);
    assert.equal(RESTORE_PROVENANCE_NOTE, "Restored by clinician before sign.");
    assert.equal(provenance.recorded, NOW);
    assert.equal(provenance.agent[0]?.who.reference, "Practitioner/doc1");
    assert.ok(provenance.target.some((target) => target.reference === ENCOUNTER));
    assert.ok(provenance.target.some((target) => target.reference === PATIENT));
  }
  assert.ok(restores.some((provenance) => provenance.target.some((target) => target.reference === "Observation/cvf-od")));
  assert.ok(restores.some((provenance) => provenance.target.some((target) => target.reference === "Observation/cvf-os")));

  const stored = await new FhirEncounterUndoLedgerStore(fhir).get("e1");
  assert.deepEqual(stored.sections, {}, "the slot is cleared");
  assert.deepEqual((result.body as UndoBody).ledger, stored);
});

test("undo of a History clear restores the complaint to active, re-stamps the primary complaint, and restores the History Observation", async () => {
  const { deps, fhir } = fixture({ reasonText: "Dry eyes" });
  fhir.add(observation("history", "hpi_ros", "UNKNOWN"));
  fhir.add(complaintResource("complaint-1", 1));
  fhir.add(complaintResource("complaint-old", 2, "removed"));
  await voidEntries(deps, { scope: "section", sectionKey: "hpi" });
  assert.equal(parseEncounterComplaintResource(fhir.get<Basic>("Basic", "basic-complaint-1")).status, "removed");

  const result = await undo(deps, { scope: "section", sectionKey: "hpi" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as UndoBody;
  assert.deepEqual([...body.restored].sort(), ["Basic/basic-complaint-1", "Observation/history"]);
  const complaint = parseEncounterComplaintResource(fhir.get<Basic>("Basic", "basic-complaint-1"));
  assert.equal(complaint.status, "active");
  assert.equal(complaint.provenance.note, RESTORE_PROVENANCE_NOTE);
  assert.equal(complaint.provenanceHistory.length, 2, "the void and the restore both stay in the complaint's history");
  assert.equal(parseEncounterComplaintResource(fhir.get<Basic>("Basic", "basic-complaint-old")).status, "removed", "a complaint that was already removed before the clear is not this action's to restore");
  assert.equal(fhir.get<Observation>("Observation", "history").status, "final");
  const encounter = fhir.get<Encounter>("Encounter", "e1");
  assert.equal(encounter.reasonCode?.some((reason) => reason.text === "Presenting concern, both eyes"), true, "the primary complaint stamp is back on the Encounter");
});

test("undo of an Assessment clear restores each Condition's verificationStatus and clinicalStatus and puts it back on Encounter.diagnosis", async () => {
  const { deps, fhir } = fixture({ diagnoses: ["Condition/c1", "Condition/c2"] });
  fhir.add(condition("c1", { verificationStatus: verificationStatusConcept("provisional"), clinicalStatus: clinicalStatusConcept("recurrence") }));
  fhir.add(condition("c2"));
  const before = fhir.get<Encounter>("Encounter", "e1").diagnosis;
  await voidEntries(deps, { scope: "section", sectionKey: "assessment" });
  assert.equal(fhir.get<Encounter>("Encounter", "e1").diagnosis, undefined);

  const result = await undo(deps, { scope: "section", sectionKey: "assessment" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const c1 = fhir.get<Condition>("Condition", "c1");
  assert.equal(c1.verificationStatus?.coding?.[0]?.code, "provisional", "the prior verificationStatus, not 'confirmed'");
  assert.equal(c1.clinicalStatus?.coding?.[0]?.code, "recurrence", "the prior clinicalStatus, not 'active'");
  const c2 = fhir.get<Condition>("Condition", "c2");
  assert.equal(c2.verificationStatus?.coding?.[0]?.code, "confirmed");
  assert.equal(c2.clinicalStatus?.coding?.[0]?.code, "active");
  assert.deepEqual(fhir.get<Encounter>("Encounter", "e1").diagnosis, before, "the diagnosis rows are back on the Encounter in their original shape");
});

test("undo of a Dilation clear restores the linked MedicationAdministration to its prior status", async () => {
  const { deps, fhir } = fixture();
  fhir.add(administration("ma1"));
  fhir.add(observation("dfe", "entrance:dilation", "UNKNOWN", { partOf: [{ reference: "MedicationAdministration/ma1" }] }));
  await voidEntries(deps, { scope: "section", sectionKey: "entrance:dilation" });
  assert.equal(fhir.get<ReturnType<typeof administration>>("MedicationAdministration", "ma1").status, "entered-in-error");

  const result = await undo(deps, { scope: "section", sectionKey: "entrance:dilation" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual([...(result.body as UndoBody).restored].sort(), ["MedicationAdministration/ma1", "Observation/dfe"]);
  assert.equal(fhir.get<ReturnType<typeof administration>>("MedicationAdministration", "ma1").status, "completed");
  assert.equal(fhir.get<Observation>("Observation", "dfe").status, "final");
});

test("undo is not itself undoable: once a slot is undone there is nothing to undo, and no 'restored' slot is written", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("cvf-od", "OD"));
  await voidEntries(deps, { scope: "section", sectionKey: "entrance:cvf" });
  const first = await undo(deps, { scope: "section", sectionKey: "entrance:cvf" });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const second = await undo(deps, { scope: "section", sectionKey: "entrance:cvf" });
  assert.equal(second.status, 404, JSON.stringify(second.body));
  assert.match((second.body as UndoBody).error ?? "", /nothing to undo/i);
  assert.equal(fhir.transactions.length, 2, "the second undo wrote nothing");
  const stored = await new FhirEncounterUndoLedgerStore(fhir).get("e1");
  assert.deepEqual(stored, { encounterId: "e1", encounter: null, sections: {} });
});

test("undo with an empty visit slot or an unknown section returns 404 and writes nothing", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("cvf-od", "OD"));
  await voidEntries(deps, { scope: "section", sectionKey: "entrance:cvf" });
  const visit = await undo(deps, { scope: "encounter" });
  assert.equal(visit.status, 404, JSON.stringify(visit.body));
  const other = await undo(deps, { scope: "section", sectionKey: "entrance:pupils" });
  assert.equal(other.status, 404, JSON.stringify(other.body));
  assert.equal(fhir.transactions.length, 1);
});

test("a concurrent edit during the undo surfaces as a 409 concurrent-edit, not a partial restore", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("cvf-od", "OD"));
  fhir.add(cvf("cvf-os", "OS"));
  await voidEntries(deps, { scope: "section", sectionKey: "entrance:cvf" });
  fhir.beforeTransaction = () => {
    const current = fhir.get<Encounter>("Encounter", "e1");
    fhir.replace({ ...current, status: "finished", meta: { versionId: "9" } });
  };

  const result = await undo(deps, { scope: "section", sectionKey: "entrance:cvf" });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal((result.body as UndoBody).code, "concurrent-edit");
  assert.equal(fhir.get<Observation>("Observation", "cvf-od").status, "entered-in-error", "the sign won; nothing was restored");
  assert.equal(fhir.get<Observation>("Observation", "cvf-os").status, "entered-in-error");
});

test("an entry that cannot be read fails the undo closed — nothing is restored and the reference is named", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("cvf-od", "OD"));
  fhir.add(cvf("cvf-os", "OS"));
  await voidEntries(deps, { scope: "section", sectionKey: "entrance:cvf" });
  fhir.failedReads.set("Observation/cvf-os", 503);

  const result = await undo(deps, { scope: "section", sectionKey: "entrance:cvf" });
  assert.equal(result.status, 503, JSON.stringify(result.body));
  assert.match((result.body as UndoBody).error ?? "", /Observation\/cvf-os/);
  assert.equal(fhir.transactions.length, 1, "the undo wrote nothing");
  assert.equal(fhir.get<Observation>("Observation", "cvf-od").status, "entered-in-error");
});

test("undo requires authentication, chart.write, a valid encounter id, and a known scope", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("cvf-od", "OD"));
  await voidEntries(deps, { scope: "encounter" });
  assert.equal((await handleEncounterUndoRequest(deps, { authHeader: undefined, params: PARAMS, body: { scope: "encounter" } })).status, 401);
  assert.equal((await handleEncounterUndoRequest(fixture({ role: "admin" }).deps, { authHeader: AUTH, params: PARAMS, body: { scope: "encounter" } })).status, 403);
  assert.equal((await handleEncounterUndoRequest(deps, { authHeader: AUTH, params: { encounterId: "../x" }, body: { scope: "encounter" } })).status, 400);
  assert.equal((await undo(deps, { scope: "nope" })).status, 400);
  assert.equal((await undo(deps, { scope: "section" })).status, 400, "section scope needs a sectionKey");
  assert.equal((await undo(deps, { scope: "encounter", sectionKey: "x" })).status, 400, "the visit scope takes no section key");
  assert.equal((await handleEncounterUndoRequest(deps, { authHeader: AUTH, params: { encounterId: "missing" }, body: { scope: "encounter" } })).status, 404);
  assert.equal(fhir.transactions.length, 1);
});

test("the ledger read requires authentication and chart.read, and 404s for an unknown encounter", async () => {
  const { deps } = fixture();
  assert.equal((await handleEncounterUndoLedgerRequest(deps, { authHeader: undefined, params: PARAMS })).status, 401);
  assert.equal((await handleEncounterUndoLedgerRequest(deps, { authHeader: AUTH, params: { encounterId: "missing" } })).status, 404);
  const empty = await handleEncounterUndoLedgerRequest(deps, { authHeader: AUTH, params: PARAMS });
  assert.equal(empty.status, 200);
  assert.deepEqual((empty.body as LedgerBody).ledger, { encounterId: "e1", encounter: null, sections: {} });
});

// ---------------------------------------------------------------------------
// Fixback after evaluation of 02c8155c — P2 #2: per-item controls must survive reopen
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Non-atomic stack (no `transaction-bundles`): a partial void must not produce a wrong undo
// ---------------------------------------------------------------------------

test("partial void: the slot over-names the refused row, but undo restores only the rows that were actually voided and leaves the refused one untouched", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("o1", "OD"));
  fhir.add(cvf("o2", "OS"));
  fhir.add(cvf("o3", "OD"));
  // Medplum applies every other entry — including the Undo ledger slot that names all three.
  fhir.refuse = (entry) => entry.request?.url === "Observation/o2" ? { status: "412 Precondition Failed" } : undefined;
  const failure = await handleEncounterVoidRequest(deps, { authHeader: AUTH, params: PARAMS, body: { scope: "encounter" } }).then(
    (result) => new Error(`expected the void to throw, got ${JSON.stringify(result)}`),
    (error: unknown) => error,
  );
  assert.equal((failure as { name?: string }).name, "VoidTransactionError", String(failure));
  assert.equal(fhir.get<Observation>("Observation", "o1").status, "entered-in-error");
  assert.equal(fhir.get<Observation>("Observation", "o2").status, "final", "the refused row was never voided");
  assert.equal(fhir.get<Observation>("Observation", "o3").status, "entered-in-error");
  const written = await new FhirEncounterUndoLedgerStore(fhir).get("e1");
  assert.deepEqual(written.encounter?.voided.map((row) => row.ref), ["Observation/o1", "Observation/o2", "Observation/o3"], "the slot was built from intent, so it over-names o2");
  const o2Version = fhir.get<Observation>("Observation", "o2").meta?.versionId;
  const provenancesOnO2 = () => fhir.all<Provenance>("Provenance").filter((row) => row.target?.some((target) => target.reference === "Observation/o2")).length;
  const provenancesBefore = provenancesOnO2();

  fhir.refuse = undefined;
  const undone = await undo(deps, { scope: "encounter" });

  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  const body = undone.body as UndoBody & { skipped: string[] };
  assert.deepEqual(body.restored, ["Observation/o1", "Observation/o3"], "only what was actually voided is restored");
  assert.deepEqual(body.skipped, ["Observation/o2"], "the refused row is named as skipped, not restored");
  assert.equal(body.count, 2);
  assert.equal(fhir.get<Observation>("Observation", "o1").status, "final");
  assert.equal(fhir.get<Observation>("Observation", "o3").status, "final");
  assert.equal(fhir.get<Observation>("Observation", "o2").status, "final");
  assert.equal(fhir.get<Observation>("Observation", "o2").meta?.versionId, o2Version, "the refused row was not written by the undo");
  assert.equal(provenancesOnO2(), provenancesBefore, "no RESTORE Provenance is written for a row that was never voided");
  assert.equal(body.ledger.encounter, null, "the slot is cleared: nothing more to undo");
});

test("fixback P2#2: preview lists every candidate with its section, finding key, and laterality so a reopened sheet can rehydrate its per-item controls", async () => {
  const { deps, fhir } = fixture();
  fhir.add(observation("iop-od", "intraocular_pressure", "OD", { status: "preliminary" }));
  fhir.add(observation("iop-os", "intraocular_pressure", "OS", { status: "preliminary" }));
  fhir.add(cvf("cvf-od", "OD"));
  fhir.add(cvf("gone", "OS", { status: "entered-in-error" }));

  const result = await handleEncounterVoidRequest(deps, { authHeader: AUTH, params: PARAMS, body: { scope: "section", sectionKey: "tonometry", preview: true } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as VoidBody & { entries?: Array<{ reference: string; sectionKey: string; findingKey: string; laterality: string }> };
  assert.deepEqual(
    [...(body.entries ?? [])].sort((left, right) => left.reference.localeCompare(right.reference)),
    [
      { reference: "Observation/iop-od", sectionKey: "tonometry", findingKey: "intraocular_pressure", laterality: "OD" },
      { reference: "Observation/iop-os", sectionKey: "tonometry", findingKey: "intraocular_pressure", laterality: "OS" },
    ],
    "entries name each live candidate of the requested section, never another section's and never a voided one",
  );
  assert.equal(fhir.transactions.length, 0, "a preview writes nothing");

  const everything = await handleEncounterVoidRequest(deps, { authHeader: AUTH, params: PARAMS, body: { scope: "encounter", preview: true } });
  const all = (everything.body as { entries?: Array<{ reference: string }> }).entries ?? [];
  assert.deepEqual([...all.map((entry) => entry.reference)].sort(), ["Observation/cvf-od", "Observation/iop-od", "Observation/iop-os"]);
});

// ---------------------------------------------------------------------------
// Fixback after evaluation of 56ff8d36 — P2: signed charts still show what was recorded
// ---------------------------------------------------------------------------

test("fixback 56ff8d36 P2#A: a preview on a signed encounter still resolves its candidates read-only, while the void itself stays 409", async () => {
  const { deps, fhir } = fixture({ encounterStatus: "finished" });
  fhir.add(observation("iop-od", "intraocular_pressure", "OD", { status: "preliminary" }));
  fhir.add(cvf("cvf-od", "OD"));

  const preview = await handleEncounterVoidRequest(deps, { authHeader: AUTH, params: PARAMS, body: { scope: "section", sectionKey: "tonometry", preview: true } });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const body = preview.body as VoidBody & { entries?: Array<{ reference: string; laterality: string }> };
  assert.deepEqual(body.entries, [{ reference: "Observation/iop-od", sectionKey: "tonometry", findingKey: "intraocular_pressure", laterality: "OD" }]);
  assert.equal(body.count, 1);
  assert.equal(fhir.transactions.length, 0, "a preview never writes, signed or not");

  for (const request of [
    { scope: "section", sectionKey: "tonometry" },
    { scope: "observation", observationReference: "Observation/iop-od" },
    { scope: "encounter" },
  ]) {
    const result = await handleEncounterVoidRequest(deps, { authHeader: AUTH, params: PARAMS, body: request });
    assert.equal(result.status, 409, `${request.scope}: ${JSON.stringify(result.body)}`);
  }
  assert.equal(fhir.transactions.length, 0);
  assert.equal(fhir.get<Observation>("Observation", "iop-od").status, "preliminary");
});
