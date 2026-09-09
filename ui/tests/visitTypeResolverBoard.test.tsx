import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { create } from "react-test-renderer";
import { resolveVisitTypeCategoryForEncounter } from "../../mcp/src/clinic/clinic-summary";
import { buildExamOverviewProjection } from "../../mcp/src/clinical-graph/exam-overview-projection";
import { ODOS_VISIT_TYPE_SYSTEM } from "../src/lib/scheduling";
import { ExamOverviewBoard } from "../src/components/charting/ExamOverviewBoard";

test("VISITTYPE-1 fresh walk-in board renders configured sections including Ocular Health", async () => {
  const visitTypeCategoryId = await resolveVisitTypeCategoryForEncounter({
    resourceType: "Encounter", id: "walk-in", status: "in-progress", class: { code: "AMB" },
    subject: { reference: "Patient/synthetic" },
    type: [{ coding: [{ system: ODOS_VISIT_TYPE_SYSTEM, code: "exams" }] }],
  }, undefined, {
    async read(): Promise<never> { throw new Error("Unexpected FHIR read"); },
    async search(): Promise<never> { throw new Error("Unexpected FHIR search"); },
  });
  const projection = buildExamOverviewProjection({
    encounterReference: "Encounter/walk-in", patientReference: "Patient/synthetic",
    visitTypeCategoryId, definitions: [], currentObservations: [],
    priorObservationCandidates: [], assessmentRows: [],
  });
  const renderer = create(<ExamOverviewBoard projection={projection} editorEntries={[]}
    refreshing={false} onOpenEditor={() => undefined} onRefresh={() => undefined} />);
  try {
    for (const section of ["history", "pretest", "refraction", "ocular-health", "assessment"]) {
      assert.equal(renderer.root.findAllByProps({ "data-section-key": section }).length, 1,
        `Missing configured section: ${section}`);
    }
    assert.match(JSON.stringify(renderer.toJSON()), /Ocular Health/);
    assert.equal(renderer.root.findAllByProps({ "data-testid": "exam-finding-row" }).length, 0);
  } finally { renderer.unmount(); }
});
