import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { COMMS_PREFERENCE_CHANNELS, COMMS_PURPOSES } from "../src/lib/communications-client";
import { emptyPatientDemographics, registerPatient } from "../src/lib/patient-registration";
import { NewPatient } from "../src/scenes/NewPatient";

const card = { personId: "existing-guardian", versionId: "7", name: "Existing Guardian", phones: ["864-555-0199"], city: "Greenville", postalCode: "29601" };
const defaults = { version: "2026-09-14", defaults: Object.fromEntries(COMMS_PURPOSES.map(purpose => [purpose, Object.fromEntries(COMMS_PREFERENCE_CHANNELS.map(channel => [channel, true]))])) };

function text(renderer: ReactTestRenderer): string {
  return renderer.root.findAll(() => true).flatMap(node => node.children.filter(child => typeof child === "string")).join(" ");
}

function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const found = renderer.root.findAllByType("button").find(node => node.children.join("") === label);
  assert.ok(found, `button ${label}`);
  return found;
}

function catalogControl(renderer: ReactTestRenderer, key: string): ReactTestInstance {
  return renderer.root.findAll(node => node.type === "input" || node.type === "select").find(node => {
    for (let parent = node.parent; parent; parent = parent.parent) if (parent.props.field?.key === key) return true;
    return false;
  })!;
}

function labelledInput(renderer: ReactTestRenderer, label: string, occurrence = 0): ReactTestInstance {
  const labels = renderer.root.findAllByType("label").filter(node => node.children[0] === label);
  assert.ok(labels[occurrence], `${label} occurrence ${occurrence}`);
  return labels[occurrence].findByType("input");
}

function labelledControl(renderer: ReactTestRenderer, label: string, type: "select" | "textarea" | "input"): ReactTestInstance {
  const row = renderer.root.findAllByType("label").find(node => node.children.includes(label));
  assert.ok(row, label);
  return row.findByType(type);
}

test("B3: registration offers an existing guarantor, serializes only owned fields, and surfaces a failed attach with a chart link", async () => {
  const calls: Array<{ path: string; body?: any }> = [];
  const original = globalThis.fetch;
  let renderer!: ReactTestRenderer;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://synthetic.test");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, ...(body ? { body } : {}) });
    if (url.pathname.endsWith("/preferences/defaults")) return Response.json(defaults);
    if (url.pathname === "/guarantors/search") return Response.json([card]);
    if (url.pathname === "/clinic/patients") return Response.json({
      kind: "created", patient: { resourceType: "Patient", id: "registered-child" },
      guarantorLinks: [{ relatedPersonId: "related-created", personId: card.personId, taskId: "attach-failed", status: "failed", message: "Pending: Complete or Correct." }],
    }, { status: 201 });
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  try {
    await act(async () => { renderer = create(<NewPatient />); });
    for (const [key, value] of Object.entries({ firstName: "Synthetic", lastName: "Child", gender: "female" })) {
      await act(async () => catalogControl(renderer, key).props.onChange({ target: { value } }));
    }
    await act(async () => labelledInput(renderer, "Date of birth").props.onChange({ target: { value: "1980-04-03" } }));
    await act(async () => button(renderer, "Add related person").props.onClick());
    await act(async () => labelledInput(renderer, "First name").props.onChange({ target: { value: "Existing" } }));
    await act(async () => labelledInput(renderer, "Last name").props.onChange({ target: { value: "Guardian" } }));

    assert.match(text(renderer), /Already on file\?/);
    assert.equal(calls.filter(call => call.path === "/guarantors/search").length, 1);
    await act(async () => button(renderer, "Use Existing Guardian").props.onClick());
    assert.match(text(renderer), /Existing Guardian.*864-555-0199.*Greenville.*29601/);
    assert.ok(button(renderer, "Not this person"));
    assert.equal(renderer.root.findAllByType("input").some(node => node.props.value === "Existing" && !node.props.readOnly), false);

    await act(async () => labelledControl(renderer, "Relationship", "select").props.onChange({ target: { value: "legal-guardian" } }));
    await act(async () => labelledInput(renderer, "Effective date").props.onChange({ target: { value: "2026-09-13" } }));
    await act(async () => labelledControl(renderer, "Court order / custody notes", "textarea").props.onChange({ target: { value: "Synthetic restriction" } }));
    await act(async () => labelledControl(renderer, "Consent authority", "input").props.onChange({ target: { checked: true } }));
    await act(async () => button(renderer, "Not this person").props.onClick());
    assert.equal(labelledInput(renderer, "First name").props.value, "Existing");
    assert.equal(labelledInput(renderer, "Last name").props.value, "Guardian");
    assert.equal(labelledControl(renderer, "Relationship", "select").props.value, "legal-guardian");
    assert.equal(labelledInput(renderer, "Effective date").props.value, "2026-09-13");
    assert.equal(labelledControl(renderer, "Court order / custody notes", "textarea").props.value, "Synthetic restriction");
    assert.equal(labelledControl(renderer, "Consent authority", "input").props.checked, true);
    await act(async () => button(renderer, "Use Existing Guardian").props.onClick());
    await act(async () => button(renderer, "Create patient").props.onClick());

    const payload = calls.find(call => call.path === "/clinic/patients")!.body;
    const existing = payload.responsibleParties.find((party: any) => party.kind === "existing");
    assert.deepEqual(Object.keys(existing).sort(), ["consentAuthority", "courtOrderNotes", "effectiveDate", "endDate", "financialResponsible", "kind", "localId", "personId", "primary", "relationship"].sort());
    assert.equal(existing.personId, card.personId);
    assert.match(text(renderer), /Patient registered/);
    assert.match(text(renderer), /failed/i);
    assert.match(text(renderer), /Pending: Complete or Correct\./);
    assert.ok(button(renderer, "Open patient chart"));
    assert.doesNotMatch(text(renderer), /Create patient|Create anyway/);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    globalThis.fetch = original;
  }
});

test("B3: registration rejects a non-string guarantor link status", async () => {
  const draft = {
    ...emptyPatientDemographics(),
    firstName: "Synthetic",
    lastName: "Child",
    birthDate: "1980-04-03",
    gender: "female" as const,
  };
  const fetchImpl: typeof fetch = async () => Response.json({
    kind: "created",
    patient: { resourceType: "Patient", id: "registered-child" },
    guarantorLinks: [{ relatedPersonId: "related-created", personId: card.personId, status: ["linked"], message: "Guarantor linked." }],
  }, { status: 201 });
  await assert.rejects(registerPatient(draft, {}, fetchImpl), /Patient registration returned an invalid response/);
});
