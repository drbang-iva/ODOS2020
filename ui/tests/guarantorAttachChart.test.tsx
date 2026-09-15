import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { ResponsiblePartiesControl } from "../src/components/patient/ResponsiblePartiesControl";
import { GuarantorLinkScreens } from "../src/components/patient/GuarantorLinkScreens";

const related = { resourceType: "RelatedPerson", id: "r", meta: { versionId: "1" }, patient: { reference: "Patient/p" }, name: [{ given: ["Existing"], family: "Guardian" }] };
const destination = { resourceType: "Person", id: "D", meta: { versionId: "4" }, active: true, name: [{ given: ["Existing"], family: "Guardian" }], telecom: [{ system: "phone", value: "864-555-0199" }], address: [{ city: "Greenville" }] };
const card = { personId: "D", versionId: "4", name: "Existing Guardian", phones: ["864-555-0199"], city: "Greenville", postalCode: "29601" };

function text(renderer: ReactTestRenderer): string { return JSON.stringify(renderer.toJSON()); }
function findButton(renderer: ReactTestRenderer, label: string): ReactTestInstance | undefined { return renderer.root.findAllByType("button").find(node => node.children.join("") === label); }
function button(renderer: ReactTestRenderer, label: string): ReactTestInstance { const found = findButton(renderer, label); assert.ok(found, `button ${label}`); return found; }
async function field(renderer: ReactTestRenderer, label: string, value: string) {
  const row = renderer.root.findAllByType("label").find(node => node.children[0] === label); assert.ok(row, label);
  await act(async () => row.findByType("input").props.onChange({ target: { value } }));
}

test("A14/B4: only missing ownership offers Attach and a failed attach is explained", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; body?: any }> = [];
  let renderer!: ReactTestRenderer;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://synthetic.test");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, ...(body ? { body } : {}) });
    if (url.pathname.endsWith("/fhir/R4/RelatedPerson")) return Response.json({ resourceType: "Bundle", entry: [{ resource: related }] });
    if (url.pathname.endsWith("/fhir/R4/Person")) return Response.json({ resourceType: "Bundle", entry: [] });
    if (url.pathname === "/guarantors/link-operations" && !body) return Response.json([{ kind: "attach", task: { resourceType: "Task", id: "failed-attach", status: "failed" }, active: false, phase: "claim-conflict", destinationPersonId: "D", relatedPersonIds: ["r"], patients: [] }]);
    if (url.pathname === "/guarantors/search") return Response.json([card]);
    if (url.pathname.endsWith("/draft")) return Response.json({ expected: { "Person/D": "4", "RelatedPerson/r": "1" }, relatedPersonIds: ["r"], patients: [{ relatedPersonId: "r", patientId: "p", name: [{ given: ["Synthetic"], family: "Child" }], current: related, resulting: destination }] });
    if (url.pathname === "/guarantors/link-operations" && body) return Response.json({ kind: "attach", task: { resourceType: "Task", id: "attach-complete", status: "completed" }, active: false, phase: "linked", destinationPersonId: "D", relatedPersonIds: ["r"], patients: [] });
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  try {
    await act(async () => { renderer = create(<ResponsiblePartiesControl patientId="p" />); });
    assert.match(text(renderer), /No linked guarantor record\./);
    assert.match(text(renderer), /The guarantor attach did not finish\./);
    assert.ok(button(renderer, "Attach a guarantor"));
    assert.equal(findButton(renderer, "Move to another guarantor"), undefined);
    assert.equal(findButton(renderer, "Join duplicate guarantor records"), undefined);

    await act(async () => button(renderer, "Attach a guarantor").props.onClick());
    await field(renderer, "Search last name", "Guardian");
    await field(renderer, "Search first name", "Existing");
    await act(async () => button(renderer, "Search guarantors").props.onClick());
    await act(async () => button(renderer, "Select Existing Guardian").props.onClick());
    await field(renderer, "Reason for guarantor change", "Registration attach repair");
    await act(async () => button(renderer, "Confirm guarantor change").props.onClick());
    const draft = calls.find(call => call.path.endsWith("/draft"))!.body;
    const createBody = calls.filter(call => call.path === "/guarantors/link-operations" && call.body).at(-1)!.body;
    assert.deepEqual(draft, { kind: "attach", destinationPersonId: "D", relatedPersonIds: ["r"] });
    assert.equal(Object.hasOwn(createBody, "sourcePersonId"), false);
    assert.equal(createBody.kind, "attach");
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    globalThis.fetch = original;
  }
});

test("A14: ambiguous ownership never offers Attach", async () => {
  const original = globalThis.fetch;
  let renderer!: ReactTestRenderer;
  let attachOffered = false;
  globalThis.fetch = async input => {
    const url = new URL(String(input), "http://synthetic.test");
    if (url.pathname.endsWith("/RelatedPerson")) return Response.json({ resourceType: "Bundle", entry: [{ resource: related }] });
    if (url.pathname.endsWith("/Person")) return Response.json({ resourceType: "Bundle", entry: [{ resource: { ...destination, id: "D1", link: [{ target: { reference: "RelatedPerson/r" } }] } }, { resource: { ...destination, id: "D2", link: [{ target: { reference: "RelatedPerson/r" } }] } }] });
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  try {
    await act(async () => { renderer = create(<ResponsiblePartiesControl patientId="p" />); });
    assert.match(text(renderer), /Ambiguous guarantor/);
    attachOffered = Boolean(findButton(renderer, "Attach a guarantor"));
  } finally { if (renderer) await act(async () => renderer.unmount()); globalThis.fetch = original; }
  assert.equal(attachOffered, false);
});

test("B4: a successful later attach clears an older failed-attach explanation", async () => {
  const original = globalThis.fetch;
  let renderer!: ReactTestRenderer;
  globalThis.fetch = async input => {
    const url = new URL(String(input), "http://synthetic.test");
    if (url.pathname.endsWith("/RelatedPerson")) return Response.json({ resourceType: "Bundle", entry: [{ resource: related }] });
    if (url.pathname.endsWith("/Person")) return Response.json({ resourceType: "Bundle", entry: [] });
    if (url.pathname === "/guarantors/link-operations") return Response.json([
      { kind: "attach", task: { resourceType: "Task", id: "attach-later", status: "completed" }, active: false, phase: "linked", destinationPersonId: "D", relatedPersonIds: ["r"], patients: [] },
      { kind: "attach", task: { resourceType: "Task", id: "attach-older", status: "failed" }, active: false, phase: "claim-conflict", destinationPersonId: "D", relatedPersonIds: ["r"], patients: [] },
    ]);
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  try {
    await act(async () => { renderer = create(<ResponsiblePartiesControl patientId="p" />); });
    assert.match(text(renderer), /No linked guarantor record\./);
    assert.doesNotMatch(text(renderer), /The guarantor attach did not finish\./);
  } finally { if (renderer) await act(async () => renderer.unmount()); globalThis.fetch = original; }
});

test("A3: an attach-pending child renders pending without a source Person", async () => {
  const original = globalThis.fetch;
  let renderer!: ReactTestRenderer;
  globalThis.fetch = async input => {
    const url = new URL(String(input), "http://synthetic.test");
    if (url.pathname.endsWith("/RelatedPerson")) return Response.json({ resourceType: "Bundle", entry: [{ resource: { ...related, extension: [{ url: "https://odos2020.com/fhir/StructureDefinition/guarantor-link-claim", valueReference: { reference: "Task/attach-pending" } }] } }] });
    if (url.pathname === "/guarantors/link-operations/attach-pending") return Response.json({ kind: "attach", task: { resourceType: "Task", id: "attach-pending", status: "in-progress" }, active: true, phase: "attach-pending", destinationPersonId: "D", relatedPersonIds: ["r"], patients: [{ relatedPersonId: "r", patientId: "p", name: "Synthetic Child" }] });
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  try {
    await act(async () => { renderer = create(<ResponsiblePartiesControl patientId="p" />); });
    assert.match(text(renderer), /Guarantor attach attach-pending is pending/);
    assert.match(text(renderer), /Synthetic Child/);
    assert.doesNotMatch(text(renderer), /Person\/undefined/);
  } finally { if (renderer) await act(async () => renderer.unmount()); globalThis.fetch = original; }
});

test("B4: attach history can be undone through the shipped correction route", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; body?: any }> = [];
  let renderer!: ReactTestRenderer;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://synthetic.test");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, ...(body ? { body } : {}) });
    if (url.pathname === "/guarantors/link-operations") return Response.json([{ kind: "attach", task: { resourceType: "Task", id: "attach-history", status: "completed" }, active: false, phase: "linked", destinationPersonId: "D", relatedPersonIds: ["r"], patients: [] }]);
    if (url.pathname.endsWith("/correct")) return Response.json({ kind: "correct", task: { resourceType: "Task", id: "unlink", status: "completed" }, active: false, phase: "unlinked", sourcePersonId: "D", relatedPersonIds: ["r"], patients: [] });
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  try {
    await act(async () => { renderer = create(<GuarantorLinkScreens person={destination} relatedPersonId="r" disabled={false} onReload={async () => undefined} />); });
    await act(async () => button(renderer, "Guarantor changes").props.onClick());
    await field(renderer, "Reason to undo attach-history", "Wrong guarantor");
    await act(async () => button(renderer, "Undo").props.onClick());
    const correction = calls.find(call => call.path.endsWith("/correct"))!;
    assert.equal(correction.path, "/guarantors/link-operations/attach-history/correct");
    assert.equal(correction.body.reason, "Wrong guarantor");
  } finally { if (renderer) await act(async () => renderer.unmount()); globalThis.fetch = original; }
});
