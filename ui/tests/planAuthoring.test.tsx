import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { ProtocolStagingList } from "../src/components/charting/ProtocolStagingList";
import { FollowUpConfirmation } from "../src/components/charting/ProtocolApplicationStatus";

test("staging shows authored titles and hides unavailable items", () => {
  const tree = create(<ProtocolStagingList selections={{}} items={[
    { itemKey: "photo", itemType: "order", title: "Optic nerve photos", defaultSelected: true, lateralityMode: "OU-always", payload: { orderableKey: "fundus-photography", performContext: "in-office-today" }, offered: true },
    { itemKey: "series-ipl", itemType: "series-prescription", title: "IPL treatment", defaultSelected: true, lateralityMode: "OU-always", payload: {}, offered: false },
  ]} />);
  assert.match(JSON.stringify(tree.toJSON()), /Optic nerve photos/);
  assert.match(JSON.stringify(tree.toJSON()), /In Office Today/);
  assert.doesNotMatch(JSON.stringify(tree.toJSON()), /IPL treatment|series-ipl/);
  assert.equal(tree.root.findAllByType("input").length, 1);
});

test("follow-up with missing interval and unit can be confirmed before editing", async () => {
  const saves: unknown[] = [];
  const tree = create(<FollowUpConfirmation action={{ id: "follow", payload: { needsConfirmation: true } }} protocolTitles={{}} onSave={async change => { saves.push(change); }} />);
  const confirm = tree.root.findAllByType("button").find(button => button.props.children === "Confirm follow-up")!;
  assert.equal(confirm.props.disabled, false);
  await act(async () => { await confirm.props.onClick(); });
  assert.deepEqual(saves, [{}]);
});

import { AssessmentSection } from "../src/components/charting/AssessmentSection";
import { RoleProvider } from "../src/lib/role-context";
import { fhir } from "../src/lib/fhir";

test("Assessment shows each offer's added count once and keeps the nonselected count", async () => {
  const savedFetch = globalThis.fetch, savedWindow = globalThis.window, read = fhir.read, search = fhir.search;
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  fhir.read = (async () => ({ resourceType: "Encounter", id: "e1", status: "in-progress", class: {}, subject: { reference: "Patient/p1" } })) as typeof fhir.read;
  fhir.search = (async () => ({ resourceType: "Bundle", type: "searchset", entry: [{ resource: {
    resourceType: "Condition", id: "c1", subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" },
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "encounter-diagnosis" }] }],
    verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }] },
    code: { coding: [{ code: "synthetic-diagnosis" }] },
  } }] })) as typeof fhir.search;
  const item = { itemKey: "photo", itemType: "order", title: "Optic nerve photos", defaultSelected: true, lateralityMode: "OU-always", payload: {}, offered: true };
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes("/protocols/applications")) return Response.json({ applications: ["A", "B"].map(id => ({ id: `app-${id}`, protocolId: id, scope: "item", confirmed: true, undoState: "active", itemKeys: ["photo"] })) });
    if (url.endsWith("/protocols/offers")) return Response.json({ protocols: ["A", "B"].map(id => ({ id, title: `Plan ${id}`, version: 1, trigger: { kind: "diagnosis", dxKeys: ["synthetic-diagnosis"] }, statusScope: [], items: [item] })) });
    if (url.includes("/diagnosis-statuses")) return Response.json({ statuses: [] });
    if (url.includes("/procedure-charges")) return Response.json({ options: [], diagnoses: [], proposals: [], attachedProcedures: [] });
    return Response.json({ diagnoses: [], rows: [] });
  };
  let tree: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      tree = create(<RoleProvider initialRole="provider"><AssessmentSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => {}} /></RoleProvider>);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.equal((JSON.stringify(tree!.toJSON()).match(/item added/g) ?? []).length, 2);
    const radios = tree!.root.findAllByType("input").filter(input => input.props.name === "protocol-offer");
    assert.equal(radios.length, 2);
    await act(async () => { radios[1].props.onChange(); });
    assert.equal((JSON.stringify(tree!.toJSON()).match(/item added/g) ?? []).length, 2);
  } finally {
    await act(async () => { tree?.unmount(); }); globalThis.fetch = savedFetch; fhir.read = read; fhir.search = search;
    Object.defineProperty(globalThis, "window", { configurable: true, value: savedWindow });
  }
});
