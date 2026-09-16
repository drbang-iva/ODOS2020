import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import {
  EncounterFindingOverlay,
  findingRowsForSection,
} from "../src/components/charting/EncounterFindingOverlay";
import type { DiagnosisFindingsPayload } from "../src/lib/diagnosis-findings";

test("by-structure projection filters one section and preserves independent finding rows", () => {
  const payload = groupingPayload();

  assert.deepEqual(
    findingRowsForSection(payload, "lens").map((row) => [row.display, row.rowKey]),
    [
      ["Nuclear sclerosis", "nuclear:OD"],
      ["Cortical change", "cortical:OD"],
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
  assert.match(initial, /Shared finding/);
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
    eye: "OD" as const, kind: "fact" as const, status: "live" as const, editable: true,
    qualifiers: {}, homes: ["Condition/cataract"], homeSources: [], contributors: [],
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
    rowKey: "nuclear:OD",
  };
  const cortical = {
    ...base,
    atomicFindingId: "lens::field::cortical",
    optionCode: "cortical",
    display: "Cortical change",
    rowKey: "cortical:OD",
  };
  const cornea = {
    ...base,
    findingDefinitionId: "definition-cornea",
    findingDefinitionKey: "ocular-health:anterior:cornea",
    atomicFindingId: "cornea::field::scar",
    optionCode: "scar",
    display: "Corneal scar",
    sectionKey: "cornea",
    rowKey: "scar:OD",
  };
  return {
    encounterEditable: true, canWrite: true, canWriteDiagnosis: true, searchIndex: [nuclear, cortical, cornea], auditDebt: [],
    findings: [nuclear],
    catalog: [],
    unassigned: [],
    bySection: { lens: [nuclear, cortical], cornea: [cornea] },
    visitDiagnoses: [],
  };
}
