import assert from "node:assert/strict";
import { test } from "node:test";
import type { Condition, Encounter } from "@medplum/fhirtypes";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  ReorderImpressionsModal,
  buildReorderImpressionRows,
  type ReorderImpressionRow,
} from "../src/components/charting/ReorderImpressionsModal";
import { updateDiagnosisOrder } from "../src/lib/clinical-graph-client";
import { fhir } from "../src/lib/fhir";

const ROWS: ReorderImpressionRow[] = [
  {
    conditionReference: "Condition/a",
    diagnosisDisplay: "Confirmed diagnosis A",
    provisional: false,
    procedureDisplays: ["Procedure A1", "Procedure A2"],
  },
  {
    conditionReference: "Condition/b",
    diagnosisDisplay: "Confirmed diagnosis B",
    provisional: false,
    procedureDisplays: ["Procedure B"],
  },
  {
    conditionReference: "Condition/c",
    diagnosisDisplay: "Possible diagnosis C",
    provisional: true,
    procedureDisplays: [],
  },
];

test("diagnosis-order client sends one authenticated complete PUT and returns the updated Encounter", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const updated: Encounter = {
    resourceType: "Encounter",
    id: "enc-1",
    status: "in-progress",
    class: {},
    diagnosis: [
      { condition: { reference: "Condition/a" }, rank: 2 },
      { condition: { reference: "Condition/b" }, rank: 1 },
    ],
  };
  const originalAuthHeader = fhir.authHeader;
  fhir.authHeader = () => "Bearer synthetic-order-token";
  try {
    const result = await updateDiagnosisOrder(
      "enc-1",
      ["Condition/b", "Condition/a"],
      async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json({ encounter: updated });
      },
    );
    assert.deepEqual(result, updated);
  } finally {
    fhir.authHeader = originalAuthHeader;
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "/clinical-graph/encounters/enc-1/diagnosis-order");
  assert.deepEqual(requests[0]?.init, {
    method: "PUT",
    headers: {
      Authorization: "Bearer synthetic-order-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ conditionReferences: ["Condition/b", "Condition/a"] }),
  });
});

test("keyboard reordering saves the complete order once", async () => {
  const saved: string[][] = [];
  const renderer = renderModal(async (references) => { saved.push(references); });

  act(() => renderer.root.findByProps({ "aria-label": "Move Confirmed diagnosis B up" }).props.onClick());
  await act(async () => {
    await renderer.root.findByProps({ children: "Save" }).props.onClick();
  });

  assert.deepEqual(saved, [["Condition/b", "Condition/a", "Condition/c"]]);
  act(() => renderer.unmount());
});

test("opening, reordering, and cancelling performs zero writes", () => {
  let saves = 0;
  const renderer = renderModal(async () => { saves += 1; });

  act(() => renderer.root.findByProps({ "aria-label": "Move Confirmed diagnosis B up" }).props.onClick());
  act(() => renderer.root.findByProps({ children: "Cancel" }).props.onClick());

  assert.equal(saves, 0);
  act(() => renderer.unmount());
});

test("dragging uses the same local ordering without writing until Save", async () => {
  const saved: string[][] = [];
  const renderer = renderModal(async (references) => { saved.push(references); });
  const transfer = { effectAllowed: "", setData() {}, getData() { return ""; } };

  act(() => renderer.root.findByProps({ "aria-label": "Drag Confirmed diagnosis B" }).props.onDragStart({
    dataTransfer: transfer,
  }));
  act(() => renderer.root.findByProps({ "data-condition-reference": "Condition/a" }).props.onDrop({
    preventDefault() {},
  }));
  assert.equal(saved.length, 0);
  await act(async () => {
    await renderer.root.findByProps({ children: "Save" }).props.onClick();
  });

  assert.deepEqual(saved, [["Condition/b", "Condition/a", "Condition/c"]]);
  act(() => renderer.unmount());
});

test("provisional diagnoses are visible but keyboard controls cannot move them into rank one", () => {
  const renderer = renderModal(async () => undefined);

  act(() => renderer.root.findByProps({ "aria-label": "Move Possible diagnosis C up" }).props.onClick());
  assert.equal(
    renderer.root.findByProps({ "aria-label": "Move Possible diagnosis C up" }).props.disabled,
    true,
  );
  assert.match(JSON.stringify(renderer.toJSON()), /Possible diagnosis C/);
  assert.match(JSON.stringify(renderer.toJSON()), /Provisional/);
  act(() => renderer.unmount());
});

test("each row renders its diagnosis and existing dxPointer-linked procedure subtitles", () => {
  const renderer = renderModal(async () => undefined);
  const html = JSON.stringify(renderer.toJSON());

  assert.match(html, /Reorder Impressions/);
  assert.match(html, /Drag impression to desired position\./);
  assert.match(html, /Confirmed diagnosis A/);
  assert.match(html, /Procedure A1/);
  assert.match(html, /Procedure A2/);
  assert.match(html, /Confirmed diagnosis B/);
  assert.match(html, /Procedure B/);
  act(() => renderer.unmount());
});

test("the modal discloses when attached procedures could not be loaded", () => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ReorderImpressionsModal
        rows={ROWS}
        busy={false}
        attachmentError="Attached procedures could not be loaded."
        onCancel={() => undefined}
        onSave={async () => undefined}
      />,
    );
  });

  assert.match(JSON.stringify(renderer.toJSON()), /Attached procedures could not be loaded\./);
  act(() => renderer.unmount());
});

test("row builder sorts by Encounter rank and groups procedure displays from existing diagnosis references", () => {
  const encounter: Encounter = {
    resourceType: "Encounter",
    id: "enc-1",
    status: "in-progress",
    class: {},
    diagnosis: [
      { condition: { reference: "Condition/a" }, rank: 2 },
      { condition: { reference: "Condition/b" }, rank: 1 },
      { condition: { reference: "Condition/c" }, rank: 3 },
    ],
  };
  const conditions = [
    condition("a", "Diagnosis A", "confirmed"),
    condition("b", "Diagnosis B", "confirmed"),
    condition("c", "Diagnosis C", "provisional"),
  ];

  const rows = buildReorderImpressionRows(encounter, conditions, [
    {
      proposalId: "proposal-a",
      procedureConceptKey: "procedure-a",
      display: "Procedure A",
      diagnosisReferences: ["Condition/a"],
    },
    {
      proposalId: "proposal-both",
      procedureConceptKey: "procedure-both",
      display: "Procedure shared",
      diagnosisReferences: ["Condition/a", "Condition/b"],
    },
  ]);

  assert.deepEqual(rows, [
    {
      conditionReference: "Condition/b",
      diagnosisDisplay: "Diagnosis B",
      provisional: false,
      procedureDisplays: ["Procedure shared"],
    },
    {
      conditionReference: "Condition/a",
      diagnosisDisplay: "Diagnosis A",
      provisional: false,
      procedureDisplays: ["Procedure A", "Procedure shared"],
    },
    {
      conditionReference: "Condition/c",
      diagnosisDisplay: "Diagnosis C",
      provisional: true,
      procedureDisplays: [],
    },
  ]);
});

test("row builder excludes Encounter diagnosis references that do not resolve to a Condition", () => {
  const rows = buildReorderImpressionRows({
    resourceType: "Encounter",
    id: "enc-stale",
    status: "in-progress",
    class: {},
    diagnosis: [
      { condition: { reference: "Condition/a" }, rank: 1 },
      { condition: { reference: "Condition/refuted" }, rank: 2 },
      { condition: { reference: "Condition/b" }, rank: 3 },
    ],
  }, [
    condition("a", "Diagnosis A", "confirmed"),
    condition("b", "Diagnosis B", "confirmed"),
  ], []);

  assert.deepEqual(rows.map((row) => row.conditionReference), ["Condition/a", "Condition/b"]);
  assert.equal(rows.some((row) => row.diagnosisDisplay === "Condition/refuted"), false);
});

function renderModal(onSave: (references: string[]) => Promise<void>): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ReorderImpressionsModal
        rows={ROWS}
        busy={false}
        onCancel={() => undefined}
        onSave={onSave}
      />,
    );
  });
  return renderer;
}

function condition(
  id: string,
  display: string,
  verification: "confirmed" | "provisional",
): Condition {
  return {
    resourceType: "Condition",
    id,
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/enc-1" },
    code: { text: display },
    verificationStatus: { coding: [{
      system: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
      code: verification,
    }] },
  };
}
