import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Condition, Encounter, Observation, Provenance } from "@medplum/fhirtypes";
import { verificationStatusConcept } from "../src/fhir/condition.js";
import { handleEncounterVoidRequest } from "../src/clinical-graph/encounter-void-endpoint.js";
import { ENCOUNTER_COMPLAINT_CODE, parseEncounterComplaintResource } from "../src/clinical-graph/encounter-complaint-store.js";
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
  type VoidBody,
} from "./encounterVoidFixture.js";

// ---------------------------------------------------------------------------
// Mandate 17 guard 1 — the sign gate
// ---------------------------------------------------------------------------

test("guard 1: void against a finished encounter returns 409 and writes nothing", async () => {
  const { deps, fhir } = fixture({ encounterStatus: "finished" });
  fhir.add(cvf("o1", "OD"));

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "encounter" },
  });

  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.match((result.body as VoidBody).error ?? "", /signed|closed/i);
  assert.equal(fhir.transactions.length, 0);
  assert.equal(fhir.get<Observation>("Observation", "o1").status, "final");
});

test("guard 1: cancelled and entered-in-error encounters are gated the same way", async () => {
  for (const encounterStatus of ["cancelled", "entered-in-error"] as const) {
    const { deps, fhir } = fixture({ encounterStatus });
    fhir.add(cvf("o1", "OD"));
    const result = await handleEncounterVoidRequest(deps, {
      authHeader: AUTH,
      params: { encounterId: "e1" },
      body: { scope: "observation", observationReference: "Observation/o1" },
    });
    assert.equal(result.status, 409, `${encounterStatus}: ${JSON.stringify(result.body)}`);
    assert.equal(fhir.transactions.length, 0);
  }
});

// ---------------------------------------------------------------------------
// Mandate 17 guard 5 — encounter scope respects the carried-forward boundary
// ---------------------------------------------------------------------------

test("guard 5: encounter scope voids this-encounter Observations and leaves the prior-encounter one alone", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("today", "OD"));
  fhir.add(cvf("prior", "OD", { encounter: { reference: "Encounter/e0" }, effectiveDateTime: "2025-01-01T00:00:00.000Z" }));

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "encounter" },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as VoidBody;
  // The fake's search returned BOTH rows (it ignores `encounter`); only the endpoint's own
  // boundary can keep the prior visit's entry out of the voided set.
  assert.deepEqual(body.voided, ["Observation/today"]);
  assert.equal(body.count, 1);
  assert.equal(fhir.get<Observation>("Observation", "today").status, "entered-in-error");
  assert.equal(fhir.get<Observation>("Observation", "prior").status, "final", "a prior encounter's entry belongs to a signed chart and must never be touched");
  // Defence in depth: the endpoint must also ASK the server for this encounter only, so a real
  // FHIR server never even returns another visit's rows to it.
  const observationSearch = fhir.searches.find((search) => search.resourceType === "Observation");
  assert.equal(observationSearch?.params.encounter, ENCOUNTER, "the Observation search must be scoped to this encounter");
});

// ---------------------------------------------------------------------------
// Mandate 17 guard 6 — finding scope voids the whole set, not the latest
// ---------------------------------------------------------------------------

test("guard 6: finding scope voids every Observation for (findingKey, laterality), not just the latest", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("od-1", "OD", { effectiveDateTime: "2026-09-01T10:00:00.000Z" }));
  fhir.add(cvf("od-2", "OD", { effectiveDateTime: "2026-09-01T11:00:00.000Z" }));
  fhir.add(cvf("od-3", "OD", { effectiveDateTime: "2026-09-01T12:00:00.000Z" }));
  fhir.add(cvf("os-1", "OS"));

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "finding", findingKey: "entrance:cvf", laterality: "OD" },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as VoidBody;
  assert.deepEqual([...body.voided].sort(), ["Observation/od-1", "Observation/od-2", "Observation/od-3"]);
  assert.equal(body.count, 3);
  for (const id of ["od-1", "od-2", "od-3"]) {
    assert.equal(fhir.get<Observation>("Observation", id).status, "entered-in-error", id);
  }
  assert.equal(fhir.get<Observation>("Observation", "os-1").status, "final");
});

// ---------------------------------------------------------------------------
// Observation scope + Provenance shape
// ---------------------------------------------------------------------------

test("observation scope flips one Observation to entered-in-error and writes a VOID Provenance for it", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("o1", "OD", { status: "preliminary" }));
  fhir.add(cvf("o2", "OS"));

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "observation", observationReference: "Observation/o1" },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as VoidBody;
  assert.deepEqual(body.voided, ["Observation/o1"]);
  assert.equal(body.count, 1);
  assert.equal(body.preview, false);
  assert.equal(fhir.get<Observation>("Observation", "o1").status, "entered-in-error");
  assert.equal(fhir.get<Observation>("Observation", "o2").status, "final");
  // component[] is never touched
  assert.deepEqual(fhir.get<Observation>("Observation", "o1").component, cvf("o1", "OD").component);

  const provenances = fhir.all<Provenance>("Provenance");
  assert.equal(provenances.length, 1);
  const provenance = provenances[0]!;
  assert.ok(provenance.target.some((target) => target.reference === "Observation/o1"));
  assert.ok(provenance.target.some((target) => target.reference === PATIENT));
  assert.equal(provenance.activity?.coding?.[0]?.code, "VOID");
  assert.equal(provenance.recorded, NOW);
  assert.equal(provenance.agent[0]?.who.reference, "Practitioner/doc1");
  // one transaction, not N round trips
  assert.equal(fhir.transactions.length, 1);
});

test("observation scope refuses an Observation that belongs to a different encounter", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("elsewhere", "OD", { encounter: { reference: "Encounter/e0" } }));

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "observation", observationReference: "Observation/elsewhere" },
  });

  assert.equal(result.status, 404, JSON.stringify(result.body));
  assert.equal(fhir.get<Observation>("Observation", "elsewhere").status, "final");
});

test("already-voided Observations are not re-voided and are not counted", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("live", "OD"));
  fhir.add(cvf("gone", "OS", { status: "entered-in-error" }));

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "section", sectionKey: "entrance:cvf" },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual((result.body as VoidBody).voided, ["Observation/live"]);
});

// ---------------------------------------------------------------------------
// Section scope — Observations, complaints (shape C), Conditions (shape D)
// ---------------------------------------------------------------------------

test("section scope matches the section key exactly or as a prefix, and reports per-section labels", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("cvf-od", "OD"));
  fhir.add(observation("pupils-od", "entrance:pupils", "OD"));
  fhir.add(observation("cornea-od", "ocular-health:anterior:cornea", "OD"));
  fhir.add(observation("lens-os", "ocular-health:anterior:lens", "OS"));

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "section", sectionKey: "ocular-health" },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as VoidBody;
  assert.deepEqual([...body.voided].sort(), ["Observation/cornea-od", "Observation/lens-os"]);
  assert.deepEqual(body.sections.map((section) => [section.sectionKey, section.label, section.count]).sort(), [
    ["ocular-health:anterior:cornea", "Cornea", 1],
    ["ocular-health:anterior:lens", "Lens", 1],
  ]);
  assert.equal(fhir.get<Observation>("Observation", "cvf-od").status, "final");
  assert.equal(fhir.get<Observation>("Observation", "pupils-od").status, "final");
});

test("section scope accepts several keys at once so a sheet that owns two definitions clears in one call", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("cvf-od", "OD"));
  fhir.add(observation("defect", "entrance:visual-field-defect", "UNKNOWN"));
  fhir.add(observation("pupils-od", "entrance:pupils", "OD"));

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "section", sectionKey: ["entrance:cvf", "entrance:visual-field-defect"] },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual([...(result.body as VoidBody).voided].sort(), ["Observation/cvf-od", "Observation/defect"]);
  assert.equal(fhir.get<Observation>("Observation", "pupils-od").status, "final");
});

test("clearing the History section voids the History Observation, removes every active complaint, and clears the primary complaint stamp", async () => {
  const { deps, fhir } = fixture({ reasonText: "Dry eyes" });
  fhir.add(observation("history", "hpi_ros", "UNKNOWN"));
  fhir.add(complaintResource("complaint-1", 1));
  fhir.add(complaintResource("complaint-2", 2));
  fhir.add(complaintResource("complaint-old", 3, "removed"));
  fhir.add(cvf("cvf-od", "OD"));

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "section", sectionKey: "hpi" },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as VoidBody;
  assert.equal(body.count, 3);
  assert.ok(body.voided.includes("Observation/history"));
  assert.equal(fhir.get<Observation>("Observation", "history").status, "entered-in-error");
  // The undo ledger is a Basic too; only the complaint rows are complaints.
  const complaints = fhir.all<Basic>("Basic")
    .filter((row) => row.code?.coding?.some((coding) => coding.code === ENCOUNTER_COMPLAINT_CODE))
    .map(parseEncounterComplaintResource);
  assert.deepEqual(
    complaints.map((complaint) => [complaint.id, complaint.status]).sort(),
    [["complaint-1", "removed"], ["complaint-2", "removed"], ["complaint-old", "removed"]],
  );
  const removed = complaints.find((complaint) => complaint.id === "complaint-1")!;
  assert.equal(removed.provenanceHistory.length, 1);
  assert.equal(removed.provenance.actorReference, "Practitioner/doc1");
  assert.equal(removed.provenance.recordedAt, NOW);
  const encounter = fhir.get<Encounter>("Encounter", "e1");
  assert.equal(encounter.reasonCode?.some((reason) => reason.text === "Dry eyes"), false);
  assert.equal(fhir.get<Observation>("Observation", "cvf-od").status, "final");
  assert.deepEqual(body.sections.map((section) => section.sectionKey).sort(), ["complaints", "hpi"]);
});

test("clearing the Assessment section marks each visit Condition entered-in-error and retracts it from the Encounter", async () => {
  const { deps, fhir } = fixture({ diagnoses: ["Condition/c1", "Condition/c2"] });
  fhir.add(condition("c1"));
  fhir.add(condition("c2"));
  fhir.add(condition("c-prior", { encounter: { reference: "Encounter/e0" } }));
  fhir.add(condition("c-refuted", { verificationStatus: verificationStatusConcept("refuted") }));
  fhir.add(cvf("cvf-od", "OD"));

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "section", sectionKey: "assessment" },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as VoidBody;
  assert.deepEqual([...body.voided].sort(), ["Condition/c1", "Condition/c2"]);
  for (const id of ["c1", "c2"]) {
    const voided = fhir.get<Condition>("Condition", id);
    assert.equal(voided.verificationStatus?.coding?.[0]?.code, "entered-in-error", id);
    assert.equal(voided.clinicalStatus, undefined, id);
  }
  assert.equal(fhir.get<Condition>("Condition", "c-prior").verificationStatus?.coding?.[0]?.code, "confirmed");
  assert.equal(fhir.get<Condition>("Condition", "c-refuted").verificationStatus?.coding?.[0]?.code, "refuted");
  assert.deepEqual(fhir.get<Encounter>("Encounter", "e1").diagnosis ?? [], []);
  assert.equal(fhir.get<Observation>("Observation", "cvf-od").status, "final");
  assert.equal(fhir.all<Provenance>("Provenance").length, 2);
});

// ---------------------------------------------------------------------------
// Encounter scope — everything charted this visit, across all four shapes
// ---------------------------------------------------------------------------

test("encounter scope clears Observations, History, complaints, and Conditions in one transaction and names every section", async () => {
  const { deps, fhir } = fixture({ diagnoses: ["Condition/c1"], reasonText: "Blur" });
  fhir.add(cvf("cvf-od", "OD"));
  fhir.add(cvf("cvf-os", "OS"));
  fhir.add(observation("pupils-od", "entrance:pupils", "OD"));
  fhir.add(observation("iop-od", "intraocular_pressure", "OD", { status: "preliminary" }));
  fhir.add(observation("history", "hpi_ros", "UNKNOWN"));
  fhir.add(complaintResource("complaint-1", 1));
  fhir.add(condition("c1"));
  fhir.add(cvf("prior", "OD", { encounter: { reference: "Encounter/e0" } }));

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "encounter" },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as VoidBody;
  assert.equal(body.count, 7);
  assert.deepEqual(body.sections.map((section) => [section.sectionKey, section.count]).sort(), [
    ["assessment", 1],
    ["complaints", 1],
    ["entrance:cvf", 2],
    ["entrance:pupils", 1],
    ["hpi", 1],
    ["tonometry", 1],
  ]);
  assert.equal(fhir.transactions.length, 1);
  assert.equal(fhir.get<Observation>("Observation", "prior").status, "final");
  assert.equal(fhir.get<Observation>("Observation", "iop-od").status, "entered-in-error");
  assert.equal(fhir.get<Condition>("Condition", "c1").verificationStatus?.coding?.[0]?.code, "entered-in-error");
  assert.equal(parseEncounterComplaintResource(fhir.get<Basic>("Basic", "basic-complaint-1")).status, "removed");
});

test("encounter scope on an empty encounter returns 200 with count 0 and writes nothing", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("prior", "OD", { encounter: { reference: "Encounter/e0" } }));

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "encounter" },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((result.body as VoidBody).count, 0);
  assert.equal(fhir.transactions.length, 0);
});

// ---------------------------------------------------------------------------
// Preview — the confirm dialog's numbers come from here, nothing is written
// ---------------------------------------------------------------------------

test("preview reports what a void would touch without writing anything", async () => {
  const { deps, fhir } = fixture({ diagnoses: ["Condition/c1"] });
  fhir.add(cvf("cvf-od", "OD"));
  fhir.add(observation("history", "hpi_ros", "UNKNOWN"));
  fhir.add(complaintResource("complaint-1", 1));
  fhir.add(condition("c1"));

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "encounter", preview: true },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as VoidBody;
  assert.equal(body.preview, true);
  assert.equal(body.count, 4);
  assert.equal(fhir.transactions.length, 0);
  assert.equal(fhir.get<Observation>("Observation", "cvf-od").status, "final");
  assert.equal(fhir.all<Provenance>("Provenance").length, 0);
});

// ---------------------------------------------------------------------------
// Authentication, authorization, validation
// ---------------------------------------------------------------------------

test("void requires authentication, chart.write, a valid encounter id, and a known scope", async () => {
  const { deps } = fixture();
  assert.equal((await handleEncounterVoidRequest(deps, { authHeader: undefined, params: { encounterId: "e1" }, body: { scope: "encounter" } })).status, 401);
  const admin = fixture({ role: "admin" });
  assert.equal((await handleEncounterVoidRequest(admin.deps, { authHeader: AUTH, params: { encounterId: "e1" }, body: { scope: "encounter" } })).status, 403);
  assert.equal((await handleEncounterVoidRequest(deps, { authHeader: AUTH, params: {}, body: { scope: "encounter" } })).status, 400);
  assert.equal((await handleEncounterVoidRequest(deps, { authHeader: AUTH, params: { encounterId: "e1" }, body: { scope: "everything" } })).status, 400);
  assert.equal((await handleEncounterVoidRequest(deps, { authHeader: AUTH, params: { encounterId: "e1" }, body: { scope: "observation" } })).status, 400);
  assert.equal((await handleEncounterVoidRequest(deps, { authHeader: AUTH, params: { encounterId: "missing" }, body: { scope: "encounter" } })).status, 404);
});

test("a concurrent edit during the void surfaces as a 409 concurrent-edit, not a partial write", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("o1", "OD", { meta: { versionId: "1" } }));
  fhir.beforeTransaction = () => {
    const current = fhir.get<Observation>("Observation", "o1");
    fhir.replace({ ...current, meta: { versionId: "2" } });
  };

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "observation", observationReference: "Observation/o1" },
  });

  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal((result.body as { code?: string }).code, "concurrent-edit");
  assert.equal(fhir.get<Observation>("Observation", "o1").status, "final");
});

test("observation scope accepts several references so a two-eye refraction block voids in one transaction", async () => {
  const { deps, fhir } = fixture();
  fhir.add(observation("block-od", "refraction", "OD"));
  fhir.add(observation("block-os", "refraction", "OS"));
  fhir.add(observation("other-od", "refraction", "OD"));

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "observation", observationReference: ["Observation/block-od", "Observation/block-os"] },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual([...(result.body as VoidBody).voided].sort(), ["Observation/block-od", "Observation/block-os"]);
  assert.equal(fhir.transactions.length, 1);
  assert.equal(fhir.get<Observation>("Observation", "block-od").status, "entered-in-error");
  assert.equal(fhir.get<Observation>("Observation", "block-os").status, "entered-in-error");
  assert.equal(fhir.get<Observation>("Observation", "other-od").status, "final");

  const none = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "observation", observationReference: ["Observation/block-od"] },
  });
  assert.equal(none.status, 404, "an already-voided reference is not a live entry");
});

// ---------------------------------------------------------------------------
// Fixback after evaluation of 91411903
// ---------------------------------------------------------------------------

test("fixback 1: an Observation-only void carries the Encounter version, so a concurrent sign makes it fail closed", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("o1", "OD"));
  fhir.beforeTransaction = () => {
    const current = fhir.get<Encounter>("Encounter", "e1");
    fhir.replace({ ...current, status: "finished", meta: { versionId: "2" } });
  };

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "observation", observationReference: "Observation/o1" },
  });

  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal((result.body as { code?: string }).code, "concurrent-edit");
  assert.equal(fhir.get<Observation>("Observation", "o1").status, "final", "the sign won; nothing was voided");
  assert.equal(fhir.all<Provenance>("Provenance").length, 0);
});

test("fixback 1: every successful void transaction includes the Encounter with its If-Match, even when the Encounter body is unchanged", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("o1", "OD"));
  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "observation", observationReference: "Observation/o1" },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const encounterEntry = fhir.transactions[0]!.entry!.find((entry) => entry.request?.url === "Encounter/e1");
  assert.ok(encounterEntry, "the Encounter must be part of the transaction");
  assert.equal(encounterEntry.request?.method, "PUT");
  assert.equal(encounterEntry.request?.ifMatch, 'W/"1"');
});

test("fixback 2: a multi-reference void is all-or-nothing — one stale, voided, or foreign reference fails the whole request", async () => {
  const { deps, fhir } = fixture();
  fhir.add(observation("block-od", "refraction", "OD"));
  fhir.add(observation("block-os", "refraction", "OS", { status: "entered-in-error" }));
  fhir.add(observation("foreign", "refraction", "OD", { encounter: { reference: "Encounter/e0" } }));

  for (const references of [
    ["Observation/block-od", "Observation/block-os"],
    ["Observation/block-od", "Observation/foreign"],
    ["Observation/block-od", "Observation/missing"],
  ]) {
    const result = await handleEncounterVoidRequest(deps, {
      authHeader: AUTH,
      params: { encounterId: "e1" },
      body: { scope: "observation", observationReference: references },
    });
    assert.equal(result.status, 404, `${references.join(",")}: ${JSON.stringify(result.body)}`);
    assert.match((result.body as { error: string }).error, new RegExp(references[1]!.replace("/", "\\/")));
    assert.equal(fhir.get<Observation>("Observation", "block-od").status, "final", "the valid subset must not be voided");
    assert.equal(fhir.transactions.length, 0);
  }
});

test("fixback 3: voiding a dilation Observation also retires the MedicationAdministration rows it is partOf", async () => {
  const { deps, fhir } = fixture();
  fhir.add({
    resourceType: "MedicationAdministration",
    id: "ma1",
    status: "completed",
    subject: { reference: PATIENT },
    context: { reference: ENCOUNTER },
    medicationCodeableConcept: { text: "Tropicamide 1%" },
    effectiveDateTime: "2026-09-01T12:00:00.000Z",
    meta: { versionId: "3" },
  });
  fhir.add({
    resourceType: "MedicationAdministration",
    id: "ma-other",
    status: "completed",
    subject: { reference: PATIENT },
    context: { reference: ENCOUNTER },
    medicationCodeableConcept: { text: "Phenylephrine 2.5%" },
    effectiveDateTime: "2026-09-01T12:00:00.000Z",
  });
  fhir.add(observation("dfe", "entrance:dilation", "UNKNOWN", {
    partOf: [{ reference: "MedicationAdministration/ma1" }],
  }));

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "section", sectionKey: "entrance:dilation" },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as VoidBody;
  assert.deepEqual([...body.voided].sort(), ["MedicationAdministration/ma1", "Observation/dfe"]);
  assert.equal(body.count, 2);
  assert.equal(fhir.get<{ resourceType: "MedicationAdministration"; id: string; status: string }>("MedicationAdministration", "ma1").status, "entered-in-error");
  assert.equal(fhir.get<{ resourceType: "MedicationAdministration"; id: string; status: string }>("MedicationAdministration", "ma-other").status, "completed", "an unlinked administration is not touched");
  const entry = fhir.transactions[0]!.entry!.find((row) => row.request?.url === "MedicationAdministration/ma1");
  assert.equal(entry?.request?.ifMatch, 'W/"3"');
  assert.ok(fhir.all<Provenance>("Provenance").some((provenance) => provenance.target.some((target) => target.reference === "MedicationAdministration/ma1")));
  assert.equal(fhir.transactions.length, 1);
});

// ---------------------------------------------------------------------------
// Fixback 2 after evaluation of 3192a0ba
// ---------------------------------------------------------------------------

test("fixback 6: a linked administration that cannot be read fails the void closed — nothing is voided, nothing left active behind a hidden Observation", async () => {
  const { deps, fhir } = fixture();
  fhir.add(administration("ma1"));
  fhir.add(observation("dfe", "entrance:dilation", "UNKNOWN", { partOf: [{ reference: "MedicationAdministration/ma1" }] }));
  fhir.failedReads.set("MedicationAdministration/ma1", 503);

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "section", sectionKey: "entrance:dilation" },
  });

  assert.equal(result.status, 503, JSON.stringify(result.body));
  assert.match((result.body as { error: string }).error, /MedicationAdministration\/ma1/);
  assert.equal(fhir.transactions.length, 0);
  assert.equal(fhir.get<Observation>("Observation", "dfe").status, "final");
  assert.equal(fhir.get<ReturnType<typeof administration>>("MedicationAdministration", "ma1").status, "completed");
});

test("fixback 6: a dangling partOf reference (404) is not an outage — the Observation voids and the missing link is simply absent", async () => {
  const { deps, fhir } = fixture();
  fhir.add(observation("dfe", "entrance:dilation", "UNKNOWN", { partOf: [{ reference: "MedicationAdministration/gone" }] }));

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "section", sectionKey: "entrance:dilation" },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual((result.body as VoidBody).voided, ["Observation/dfe"]);
  assert.equal(fhir.get<Observation>("Observation", "dfe").status, "entered-in-error");
});

test("fixback 7: section subtotals include linked administrations, so they always sum to the overall count", async () => {
  const { deps, fhir } = fixture();
  fhir.add(administration("ma1"));
  fhir.add(administration("ma2"));
  fhir.add(observation("dfe", "entrance:dilation", "UNKNOWN", {
    partOf: [{ reference: "MedicationAdministration/ma1" }, { reference: "MedicationAdministration/ma2" }],
  }));
  fhir.add(cvf("cvf-od", "OD"));

  for (const body of [
    { scope: "encounter", preview: true },
    { scope: "section", sectionKey: "entrance:dilation" },
  ]) {
    const result = await handleEncounterVoidRequest(deps, { authHeader: AUTH, params: { encounterId: "e1" }, body });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const response = result.body as VoidBody;
    const subtotal = response.sections.reduce((sum, section) => sum + section.count, 0);
    assert.equal(subtotal, response.count, `${body.scope}: subtotals ${subtotal} must equal count ${response.count}`);
    assert.equal(response.sections.find((section) => section.sectionKey === "entrance:dilation")?.count, 3, `${body.scope}: dilation subtotal counts the DFE plus two administrations`);
  }
});

test("fixback 8: a linked administration that belongs to another encounter or patient rejects the void before any write", async () => {
  for (const foreign of [
    { ...administration("ma-foreign"), context: { reference: "Encounter/e0" } },
    { ...administration("ma-foreign"), subject: { reference: "Patient/p9" } },
  ]) {
    const { deps, fhir } = fixture();
    fhir.add(foreign);
    fhir.add(observation("dfe", "entrance:dilation", "UNKNOWN", { partOf: [{ reference: "MedicationAdministration/ma-foreign" }] }));

    const result = await handleEncounterVoidRequest(deps, {
      authHeader: AUTH,
      params: { encounterId: "e1" },
      body: { scope: "section", sectionKey: "entrance:dilation" },
    });

    assert.equal(result.status, 422, JSON.stringify(result.body));
    assert.match((result.body as { error: string }).error, /MedicationAdministration\/ma-foreign/);
    assert.equal(fhir.transactions.length, 0, "nothing may be written");
    assert.equal(fhir.get<Observation>("Observation", "dfe").status, "final", "the Observation must not disappear over a live administration");
    assert.equal(fhir.get<ReturnType<typeof administration>>("MedicationAdministration", "ma-foreign").status, "completed");
  }
});

test("fixback 8: a linked administration already entered-in-error is not a boundary violation — nothing active remains, the Observation voids", async () => {
  const { deps, fhir } = fixture();
  fhir.add(administration("ma-retired", "entered-in-error"));
  fhir.add(observation("dfe", "entrance:dilation", "UNKNOWN", { partOf: [{ reference: "MedicationAdministration/ma-retired" }] }));
  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "section", sectionKey: "entrance:dilation" },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual((result.body as VoidBody).voided, ["Observation/dfe"]);
});
