import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import {
  EncounterFindingOverlay,
  findingRowsForSection,
} from "../src/components/charting/EncounterFindingOverlay";
import type { DiagnosisFindingsPayload } from "../src/lib/diagnosis-findings";

test("by-structure projection filters one section and preserves both finding origins", () => {
  const payload = groupingPayload();

  assert.deepEqual(
    findingRowsForSection(payload, "lens").map((row) => [row.display, row.source]),
    [
      ["Nuclear sclerosis", "atomic"],
      ["Cortical change", "section"],
    ],
  );
  assert.deepEqual(findingRowsForSection(payload, "cornea").map((row) => row.display), [
    "Corneal scar",
  ]);
});

test("structure overlay renders sign grade and laterality and refreshes after diagnosis-side changes", async () => {
  const events = new EventTarget();
  let payload = groupingPayload();
  let loads = 0;
  const renderer = create(
    <EncounterFindingOverlay
      encounterReference="Encounter/e1"
      sectionKey="lens"
      loadPayload={async () => {
        loads += 1;
        return payload;
      }}
      eventTarget={events}
    />,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const initial = JSON.stringify(renderer.toJSON());
  assert.match(initial, /Nuclear sclerosis/);
  assert.match(initial, /Present · 2\+ · OD/);
  assert.match(initial, /Cortical change/);
  assert.match(initial, /Charted in section/);
  assert.doesNotMatch(initial, /Corneal scar/);

  payload = {
    ...payload,
    bySection: {
      ...payload.bySection,
      lens: payload.bySection.lens!.map((row) => row.atomicFindingId.endsWith("nuclear")
        ? { ...row, presence: "absent", grade: undefined }
        : row),
    },
  };
  const changed = new Event("odos:encounter-findings-changed") as Event & {
    detail: { encounterReference: string };
  };
  Object.defineProperty(changed, "detail", { value: { encounterReference: "Encounter/e1" } });
  await act(async () => {
    events.dispatchEvent(changed);
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(loads, 2);
  assert.match(JSON.stringify(renderer.toJSON()), /Absent · OD/);
});

function groupingPayload(): DiagnosisFindingsPayload {
  const base = {
    findingDefinitionId: "definition-lens",
    findingDefinitionKey: "ocular-health:anterior:lens",
    fieldCode: "CUSTOM_ABNORMAL",
    sectionKey: "lens",
    gradeScale: [] as string[],
    diagnosisKeys: ["cataract"],
    origin: "shipped" as const,
    laterality: "OD" as const,
    lateralitySource: "inherited" as const,
    presence: "present" as const,
    conditionReference: "Condition/cataract",
  };
  const nuclear = {
    ...base,
    atomicFindingId: "lens::field::nuclear",
    optionCode: "nuclear",
    display: "Nuclear sclerosis",
    gradeScale: ["1+", "2+"],
    grade: "2+",
    source: "atomic" as const,
    observationReference: "Observation/nuclear",
  };
  const cortical = {
    ...base,
    atomicFindingId: "lens::field::cortical",
    optionCode: "cortical",
    display: "Cortical change",
    source: "section" as const,
    observationReference: "Observation/lens-section",
  };
  const cornea = {
    ...base,
    findingDefinitionId: "definition-cornea",
    findingDefinitionKey: "ocular-health:anterior:cornea",
    atomicFindingId: "cornea::field::scar",
    optionCode: "scar",
    display: "Corneal scar",
    sectionKey: "cornea",
    source: "atomic" as const,
    observationReference: "Observation/scar",
  };
  return {
    canWrite: true,
    findings: [nuclear],
    catalog: [],
    unassigned: [],
    bySection: { lens: [nuclear, cortical], cornea: [cornea] },
    visitDiagnoses: [],
  };
}
