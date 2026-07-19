import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type {
  Bundle,
  Condition,
  DocumentReference,
  Encounter,
  MedicationRequest,
  MedicationStatement,
  Observation,
  Patient,
  Procedure,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import express from "express";
import { registerClinicRoutes } from "../src/clinic/clinic-routes.js";
import {
  loadPatientOverview,
  loadPatientStickyNoteHistory,
  savePatientStickyNote,
} from "../src/clinic/patient-overview.js";
import { FhirSearchLimitError } from "../src/fhir-search.js";
import { clinicalStatusConcept, conditionCategoryConcept, verificationStatusConcept } from "../src/fhir/condition.js";
import { ODOS_VISIT_TYPE_SYSTEM } from "../src/fhir/schedulingVisitType.js";

test("patient overview projects real snapshot resources and newest-first encounter diagnoses", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(condition("problem-eye", "Ocular condition", { category: "problem-list-item", bodySite: "Both eyes" }));
  fake.add(condition("problem-medical", "Medical condition", { category: "problem-list-item" }));
  fake.add({ resourceType: "Procedure", id: "procedure-1", status: "completed", subject: { reference: "Patient/p1" }, code: { text: "Ocular surgery" }, bodySite: [{ text: "Left eye" }] } satisfies Procedure);
  fake.add({ resourceType: "MedicationStatement", id: "ophthalmic-med", status: "active", medicationCodeableConcept: { text: "Ophthalmic medication" }, subject: { reference: "Patient/p1" }, dosage: [{ route: { text: "Ophthalmic" }, text: "One drop nightly" }] } satisfies MedicationStatement);
  fake.add({ resourceType: "MedicationRequest", id: "systemic-med", status: "active", intent: "order", medicationCodeableConcept: { text: "Systemic medication" }, subject: { reference: "Patient/p1" }, dosageInstruction: [{ text: "Daily" }] } satisfies MedicationRequest);
  fake.add({ resourceType: "Observation", id: "smoking", status: "final", code: { text: "Tobacco smoking status" }, subject: { reference: "Patient/p1" }, valueCodeableConcept: { text: "Former smoker" } } satisfies Observation);
  fake.add(encounter("older", "2025-06-01T14:00:00Z"));
  fake.add(encounter("newer", "2026-06-01T14:00:00Z"));
  fake.add({ resourceType: "Provenance", id: "signed-newer", target: [{ reference: "Encounter/newer" }, { reference: "Patient/p1" }], recorded: "2026-06-01T14:00:00Z", agent: [{ who: { display: "Dr. Clinician" } }] } satisfies Provenance);
  fake.add(condition("dx-old", "Older diagnosis", { category: "encounter-diagnosis", encounterId: "older", code: "DX-OLD" }));
  fake.add(condition("dx-new", "Newer diagnosis", { category: "encounter-diagnosis", encounterId: "newer", code: "DX-NEW" }));
  const resolved = condition("dx-resolved", "Resolved historical diagnosis", { category: "encounter-diagnosis", encounterId: "older", code: "DX-RESOLVED" });
  resolved.clinicalStatus = clinicalStatusConcept("resolved");
  fake.add(resolved);

  const overview = await loadPatientOverview(fake as never, "p1");

  assert.deepEqual(overview.snapshot.ocularHistory.map((row) => row.name), ["Ocular condition"]);
  assert.deepEqual(overview.snapshot.medicalConditions.map((row) => row.name), ["Medical condition"]);
  assert.deepEqual(overview.snapshot.ocularSurgicalHistory.map((row) => row.name), ["Ocular surgery"]);
  assert.deepEqual(overview.snapshot.ophthalmicMedications.map((row) => [row.name, row.sig]), [["Ophthalmic medication", "One drop nightly"]]);
  assert.deepEqual(overview.snapshot.systemicMedications.map((row) => [row.name, row.sig]), [["Systemic medication", "Daily"]]);
  assert.deepEqual(overview.snapshot.socialHistory, ["Former smoker"]);
  assert.deepEqual(overview.visits.map((visit) => visit.encounterId), ["newer", "older"]);
  assert.deepEqual(overview.visits.map((visit) => visit.diagnoses[0]?.code), ["DX-NEW", "DX-OLD"]);
  assert.deepEqual(overview.visits[1]?.diagnoses.map((diagnosis) => diagnosis.code), ["DX-OLD", "DX-RESOLVED"]);
  assert.deepEqual(overview.visits.map((visit) => visit.status), ["Final", "Preliminary"]);
  const provenanceSearch = fake.searches.find((row) => row.resourceType === "Provenance");
  assert.equal(provenanceSearch?.params.target, undefined);
  assert.equal(provenanceSearch?.params.patient, "Patient/p1");
  assert.equal(provenanceSearch?.params.recorded, undefined);
  assert.equal(provenanceSearch?.params._sort, "recorded");
});

test("patient overview route stays available with more than 1000 other-patient Provenance rows", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(encounter("signed-visit", "2026-06-01T14:00:00Z"));
  fake.add({
    resourceType: "Provenance",
    id: "signed-visit-proof",
    target: [{ reference: "Encounter/signed-visit" }, { reference: "Patient/p1" }],
    recorded: "2026-06-01T14:00:00Z",
    agent: [{ who: { display: "Dr. Clinician" } }],
  } satisfies Provenance);
  for (let index = 0; index < 1_001; index += 1) {
    fake.add({
      resourceType: "Provenance",
      id: `other-patient-${index}`,
      target: [{ reference: `Observation/other-${index}` }, { reference: `Patient/other-${index}` }],
      recorded: "2026-06-01T14:30:00Z",
      agent: [{ who: { reference: "Practitioner/other" } }],
    } satisfies Provenance);
  }

  const app = express();
  registerClinicRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async (header) => header === "Bearer good"
      ? { staffReference: "Practitioner/staff-1", actorRole: "clinician", fhir: fake as never }
      : null,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/clinic/patients/p1/overview`, {
      headers: { Authorization: "Bearer good" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { visits: Array<{ encounterId: string; status: string }> };
    assert.deepEqual(body.visits, [{
      encounterId: "signed-visit",
      date: "2026-06-01T14:00:00Z",
      provider: "Dr. Clinician",
      facility: "Practice location",
      visitType: "Comprehensive exam",
      status: "Final",
      diagnoses: [],
    }]);
    assert.equal(
      fake.searches.find((row) => row.resourceType === "Provenance")?.params.patient,
      "Patient/p1",
    );
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

test("empty snapshot stays honestly empty and visit filters issue distinct FHIR searches", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(encounter("eye-visit", "2026-06-01T14:00:00Z", "routine-exam-new"));
  fake.add(encounter("office-visit", "2026-05-01T14:00:00Z", "office-visit"));

  const eye = await loadPatientOverview(fake as never, "p1", { filter: "eye-exams" });
  assert.deepEqual(eye.snapshot, {
    ocularHistory: [], ocularSurgicalHistory: [], medicalConditions: [], socialHistory: [], ophthalmicMedications: [], systemicMedications: [],
  });
  assert.deepEqual(eye.visits.map((visit) => visit.encounterId), ["eye-visit"]);
  assert.match(fake.searches.find((row) => row.resourceType === "Encounter")?.params.type ?? "", /routine-exam-new/);

  fake.searches.length = 0;
  const office = await loadPatientOverview(fake as never, "p1", { filter: "office-visits" });
  assert.deepEqual(office.visits.map((visit) => visit.encounterId), ["office-visit"]);
  assert.match(fake.searches.find((row) => row.resourceType === "Encounter")?.params.type ?? "", /office-visit/);
});

test("overview stays usable and reports honest wiring when role-scoped optional reads are unavailable", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.deniedTypes.add("Coverage");
  fake.deniedTypes.add("MedicationRequest");

  const overview = await loadPatientOverview(fake as never, "p1");

  assert.deepEqual(overview.insurance, []);
  assert.deepEqual(overview.snapshot.systemicMedications, []);
  assert.deepEqual(overview.unavailable, {
    insurance: "Insurance unavailable from this session",
    medicationOrders: "Medication orders unavailable from this session",
  });
});

test("overview does not disguise unexpected optional-source failures as unavailable wiring", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.failedTypes.set("Coverage", 500);

  await assert.rejects(loadPatientOverview(fake as never, "p1"), /Coverage unavailable/);
});

test("diagnosis filtering searches Condition by code then searches only matching Encounter ids", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(encounter("match", "2026-06-01T14:00:00Z"));
  fake.add(encounter("other", "2025-06-01T14:00:00Z"));
  fake.add(condition("dx-match", "Selected diagnosis", { category: "encounter-diagnosis", encounterId: "match", code: "DX-SELECTED" }));

  await loadPatientOverview(fake as never, "p1", {
    filter: "eye-exams",
    diagnosisSystem: "https://example.test/diagnosis",
    diagnosisCode: "DX-SELECTED",
  });

  assert.equal(fake.searches.find((row) => row.resourceType === "Condition" && row.params.category === "encounter-diagnosis")?.params.code, "https://example.test/diagnosis|DX-SELECTED");
  assert.equal(fake.searches.find((row) => row.resourceType === "Encounter")?.params._id, "match");
  assert.equal(fake.searches.find((row) => row.resourceType === "Encounter")?.params.type, undefined);
});

test("sticky note create and second edit persist prior text in native DocumentReference history", async () => {
  const fake = new FakeFhir();
  const first = await savePatientStickyNote(fake as never, {
    patientId: "p1",
    text: "First chart-front note",
    authorReference: "Practitioner/one",
    now: "2026-07-11T14:00:00Z",
  });
  const second = await savePatientStickyNote(fake as never, {
    patientId: "p1",
    text: "Second chart-front note",
    authorReference: "Practitioner/two",
    now: "2026-07-11T15:00:00Z",
  });
  const history = await loadPatientStickyNoteHistory(fake as never, "p1");

  assert.equal(first.text, "First chart-front note");
  assert.equal(second.text, "Second chart-front note");
  assert.deepEqual(history.map((entry) => entry.text), ["Second chart-front note", "First chart-front note"]);
  assert.deepEqual(history.map((entry) => entry.editedBy), ["Practitioner/two", "Practitioner/one"]);
});

test("sticky-note conditional-create races update the winning resource with this edit", async () => {
  const fake = new FakeFhir();
  fake.conditionalCreateResponse = {
    resourceType: "DocumentReference",
    id: "sticky-1",
    meta: { versionId: "1" },
    status: "current",
    identifier: [{ system: "https://odos2020.com/fhir/identifier/patient-sticky-note", value: "p1" }],
    subject: { reference: "Patient/p1" },
    content: [{ attachment: { data: Buffer.from("Concurrent edit", "utf8").toString("base64") } }],
  };

  const saved = await savePatientStickyNote(fake as never, {
    patientId: "p1",
    text: "This caller's edit",
    authorReference: "Practitioner/one",
    now: "2026-07-11T14:00:00Z",
  });

  assert.equal(saved.text, "This caller's edit");
  assert.equal(fake.updateCalls, 1);
});

class FakeFhir {
  resources: Resource[] = [];
  searches: Array<{ resourceType: string; params: Record<string, string> }> = [];
  documentHistory: DocumentReference[] = [];
  deniedTypes = new Set<string>();
  failedTypes = new Map<string, number>();
  conditionalCreateResponse?: DocumentReference;
  updateCalls = 0;

  add(resource: Resource) { this.resources.push(resource); }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find((candidate) => candidate.resourceType === resourceType && candidate.id === id);
    if (!resource) throw new Error(`${resourceType}/${id} not found`);
    return resource as T;
  }

  async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    this.searches.push({ resourceType, params: { ...params } });
    const failureStatus = this.failedTypes.get(resourceType);
    if (failureStatus) {
      const error = new Error(`${resourceType} unavailable`) as Error & { status?: number };
      error.status = failureStatus;
      throw error;
    }
    if (this.deniedTypes.has(resourceType)) {
      const error = new Error(`${resourceType} unavailable`) as Error & { status?: number };
      error.status = 403;
      throw error;
    }
    let rows = this.resources.filter((resource) => resource.resourceType === resourceType) as T[];
    if (resourceType === "DocumentReference" && params.identifier) {
      rows = rows.filter((resource) => (resource as DocumentReference).identifier?.some((identifier) => `${identifier.system}|${identifier.value}` === params.identifier));
    }
    if (resourceType === "Condition" && params.category === "encounter-diagnosis") {
      rows = rows.filter((resource) => (resource as Condition).category?.some((category) => category.coding?.some((coding) => coding.code === "encounter-diagnosis")));
      if (params.code) rows = rows.filter((resource) => (resource as Condition).code?.coding?.some((coding) => `${coding.system}|${coding.code}` === params.code));
    }
    if (resourceType === "Condition" && params.category === "problem-list-item") {
      rows = rows.filter((resource) => (resource as Condition).category?.some((category) => category.coding?.some((coding) => coding.code === "problem-list-item")));
    }
    if (resourceType === "Encounter" && params._id) rows = rows.filter((resource) => params._id.split(",").includes(resource.id ?? ""));
    if (resourceType === "Encounter" && params.type) {
      const requestedTypes = params.type.split(",");
      rows = rows.filter((resource) => (resource as Encounter).type?.some((concept) =>
        concept.coding?.some((coding) => requestedTypes.includes(`${coding.system}|${coding.code}`)),
      ));
    }
    if (resourceType === "Provenance" && params.patient) {
      rows = rows.filter((resource) => (resource as Provenance).target.some(
        (target) => target.reference === params.patient,
      ));
    }
    if (resourceType === "Provenance" && !params.patient && rows.length > 1_000) {
      throw new FhirSearchLimitError("Provenance", 1_000);
    }
    return bundle(rows);
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    if (this.conditionalCreateResponse) {
      const winner = structuredClone(this.conditionalCreateResponse);
      this.resources.push(winner);
      this.documentHistory.unshift(winner);
      return winner as T;
    }
    const version = { ...resource, id: "sticky-1", meta: { ...resource.meta, versionId: "1", lastUpdated: "2026-07-11T14:00:00Z" } } as T;
    this.resources.push(version);
    this.documentHistory.unshift(structuredClone(version as DocumentReference));
    return version;
  }

  async update<T extends Resource>(_resourceType: T["resourceType"], id: string, resource: T): Promise<T> {
    this.updateCalls += 1;
    const versionId = String(this.documentHistory.length + 1);
    const updated = { ...resource, id, meta: { ...resource.meta, versionId, lastUpdated: "2026-07-11T15:00:00Z" } } as T;
    this.resources = this.resources.map((candidate) => candidate.resourceType === resource.resourceType && candidate.id === id ? updated : candidate);
    this.documentHistory.unshift(structuredClone(updated as DocumentReference));
    return updated;
  }

  async history<T extends Resource>(): Promise<Bundle<T>> {
    return bundle(this.documentHistory as T[]);
  }
}

function patient(): Patient {
  return { resourceType: "Patient", id: "p1", name: [{ given: ["Alex"], family: "Patient" }], birthDate: "1980-01-01", gender: "female" };
}

function encounter(id: string, start: string, visitCode?: string): Encounter {
  return {
    resourceType: "Encounter",
    id,
    status: "finished",
    class: { code: "AMB" },
    subject: { reference: "Patient/p1" },
    period: { start, end: start },
    type: [{ text: "Comprehensive exam", ...(visitCode ? { coding: [{ system: ODOS_VISIT_TYPE_SYSTEM, code: visitCode }] } : {}) }],
    participant: [{ individual: { display: "Dr. Clinician" } }],
    serviceProvider: { display: "Practice location" },
  };
}

function condition(id: string, name: string, options: { category: "problem-list-item" | "encounter-diagnosis"; bodySite?: string; encounterId?: string; code?: string }): Condition {
  return {
    resourceType: "Condition",
    id,
    subject: { reference: "Patient/p1" },
    category: [conditionCategoryConcept(options.category)],
    clinicalStatus: clinicalStatusConcept("active"),
    verificationStatus: verificationStatusConcept("confirmed"),
    code: { text: name, ...(options.code ? { coding: [{ system: "https://example.test/diagnosis", code: options.code, display: name }] } : {}) },
    ...(options.bodySite ? { bodySite: [{ text: options.bodySite }] } : {}),
    ...(options.encounterId ? { encounter: { reference: `Encounter/${options.encounterId}` } } : {}),
  };
}

function bundle<T extends Resource>(resources: T[]): Bundle<T> {
  return { resourceType: "Bundle", type: "searchset", entry: resources.map((resource) => ({ resource })) };
}
