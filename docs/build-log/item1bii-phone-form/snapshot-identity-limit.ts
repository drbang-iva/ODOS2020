import assert from "node:assert/strict";
import { createPatientDemographicsActions, patientDemographicsFromPatient, patientTelecomSnapshot } from "../../../ui/src/lib/patient-registration";
import { NUMBERS, TELECOM_NOW, telecomFixture } from "../../../ui/tests/fixtures/patient-telecom";

async function main() {
  const original = telecomFixture("IMPORTED3");
  const phone = original.telecom![3];
  original.telecom = [
    { ...phone, id: "duplicate-A", rank: 1 },
    { ...phone, id: "duplicate-B", rank: 2 },
  ];
  const draft = patientDemographicsFromPatient(original, TELECOM_NOW);
  const snapshot = patientTelecomSnapshot(original, TELECOM_NOW);
  const held = structuredClone(original);
  held.telecom!.reverse();
  held.meta!.versionId = "4";
  draft.phones[0].value = NUMBERS.changed;
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.method, "PUT");
    bodies.push(String(init.body));
    return Response.json({ ...JSON.parse(String(init.body)), meta: { versionId: "5" } });
  };
  try {
    await createPatientDemographicsActions(held).save(draft, snapshot);
    assert.equal(bodies.length, 1);
    const written = JSON.parse(bodies[0]);
    const editedId = written.telecom.find((point: { value?: string }) => point.value === NUMBERS.changed)?.id;
    assert.equal(editedId, "duplicate-B");
    process.stdout.write(JSON.stringify({
      finding: "Identical system/value/use triples hide a permutation during preference refresh",
      outcome: "LIMITATION REPRODUCED; not an acceptance test or an independent verdict",
      originalIds: original.telecom.map(point => point.id),
      heldIds: held.telecom!.map(point => point.id),
      snapshot,
      originallySelectedId: "duplicate-A",
      editedId,
      writeCount: bodies.length,
      serializedPut: written,
    }, null, 2) + "\n");
  } finally { globalThis.fetch = originalFetch; }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
