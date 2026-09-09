import assert from "node:assert/strict";
import { test } from "node:test";
import type { Appointment, Encounter, Resource } from "@medplum/fhirtypes";
import { resolveVisitTypeCategoryForEncounter } from "../src/clinic/clinic-summary.js";
import { buildExamOverviewProjection } from "../src/clinical-graph/exam-overview-projection.js";
import { buildVisitType, ODOS_VISIT_TYPE_SYSTEM } from "../src/fhir/schedulingVisitType.js";

const encounter: Encounter = {
  resourceType: "Encounter", id: "visit", status: "in-progress", class: { code: "AMB" },
  subject: { reference: "Patient/synthetic" },
};
const noFhir = {
  async read<T extends Resource>(): Promise<T> { throw new Error("Unexpected FHIR read"); },
  async search(): Promise<never> { throw new Error("Unexpected FHIR search"); },
};
function project(visitTypeCategoryId: string | undefined) {
  return buildExamOverviewProjection({
    encounterReference: "Encounter/visit", patientReference: "Patient/synthetic",
    visitTypeCategoryId, definitions: [], currentObservations: [],
    priorObservationCandidates: [], assessmentRows: [],
  });
}

test("VISITTYPE-1 walk-in resolves six required sections without an Appointment", async () => {
  const category = await resolveVisitTypeCategoryForEncounter({
    ...encounter, type: [{ coding: [{ system: ODOS_VISIT_TYPE_SYSTEM, code: "exams" }] }],
  }, undefined, noFhir);
  assert.equal(category, "exams");
  const projection = project(category);
  assert.equal(projection.completeness.requiredSectionCount, 6);
  assert.deepEqual(projection.sections.map((section) => section.sectionKey),
    ["history", "entrance", "refraction", "pretest", "ocular-health", "assessment"]);
});

test("VISITTYPE-1 scheduled visit without Encounter.type resolves through Appointment", async () => {
  const appointment: Appointment = {
    resourceType: "Appointment", id: "scheduled", status: "arrived", participant: [],
    serviceType: [{ coding: [{ system: ODOS_VISIT_TYPE_SYSTEM, code: "routine-exam-new" }] }],
  };
  const service = buildVisitType({ code: "routine-exam-new", name: "Routine exam",
    discipline: "eyecare", durationMinutes: 30, categoryCode: "exams", categoryLabel: "Exams" });
  const fhir = {
    async read<T extends Resource>(resourceType: string, id: string): Promise<T> {
      assert.equal(resourceType, "Appointment"); assert.equal(id, "scheduled");
      return appointment as T;
    },
    async search<T extends Resource>() {
      return { resourceType: "Bundle" as const, type: "searchset" as const,
        entry: [{ resource: service as T }] };
    },
  };
  for (const type of [undefined, [{ coding: [{ system: ODOS_VISIT_TYPE_SYSTEM, code: "routine-exam-new" }] }]]) {
    const category = await resolveVisitTypeCategoryForEncounter({
      ...encounter, type, appointment: [{ reference: "Appointment/scheduled" }],
    }, undefined, fhir);
    assert.equal(category, "exams");
    assert.equal(project(category).completeness.requiredSectionCount, 6);
  }
});

test("VISITTYPE-1 unknown visit remains gated and unconfigured", async () => {
  const category = await resolveVisitTypeCategoryForEncounter(encounter, undefined, noFhir);
  assert.equal(category, undefined);
  const projection = project(category);
  assert.equal(projection.completeness.status, "unconfigured");
  assert.equal(projection.completeness.requiredSectionCount, 0);
  assert.deepEqual(projection.sections, []);
});


test("VISITTYPE-1 explicit categories take precedence over Appointment without guessing", async () => {
  for (const code of ["exams", "medical", "contact-lens"]) {
    assert.equal(await resolveVisitTypeCategoryForEncounter({
      ...encounter, appointment: [{ reference: "Appointment/not-needed" }],
      type: [{ coding: [{ system: ODOS_VISIT_TYPE_SYSTEM, code }] }],
    }, undefined, noFhir), code);
  }
});

test("VISITTYPE-1 unrelated, empty and non-category codings cannot open the gate", async () => {
  for (const coding of [
    { code: "exams" }, { system: "urn:unrelated", code: "exams" },
    { system: ODOS_VISIT_TYPE_SYSTEM }, { system: ODOS_VISIT_TYPE_SYSTEM, code: "" },
    { system: ODOS_VISIT_TYPE_SYSTEM, code: "unknown" },
    { system: ODOS_VISIT_TYPE_SYSTEM, code: "routine-exam-new" },
  ]) {
    const category = await resolveVisitTypeCategoryForEncounter({
      ...encounter, type: [{ text: "Exams", coding: [coding] }],
    }, undefined, noFhir);
    assert.equal(category, undefined);
    assert.equal(project(category).completeness.status, "unconfigured");
  }
});

test("VISITTYPE-1 category search considers every concept and coding", async () => {
  assert.equal(await resolveVisitTypeCategoryForEncounter({
    ...encounter, type: [
      { coding: [{ system: "urn:unrelated", code: "exams" }] },
      { coding: [{ system: ODOS_VISIT_TYPE_SYSTEM, code: "routine-exam-new" },
        { system: ODOS_VISIT_TYPE_SYSTEM, code: "exams" }] },
    ],
  }, undefined, noFhir), "exams");
});
