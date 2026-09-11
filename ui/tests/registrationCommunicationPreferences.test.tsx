import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { NewPatient } from "../src/scenes/NewPatient";
import { COMMS_PURPOSES, COMMS_PREFERENCE_CHANNELS } from "../src/lib/communications-client";
import { createPatient, emptyPatientDemographics, registerPatient } from "../src/lib/patient-registration";

function defaults() {
  return { version: "2026-09-10", defaults: Object.fromEntries(COMMS_PURPOSES.map(purpose => [purpose, Object.fromEntries(COMMS_PREFERENCE_CHANNELS.map(channel =>
    [channel, purpose !== "marketing-promo" || (channel !== "sms" && channel !== "call")]))])) };
}
function reply(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
const created = { kind: "created", patient: { resourceType: "Patient", id: "synthetic-created" } };
function button(renderer: ReactTestRenderer, label: string) { return renderer.root.findAllByType("button").find(node => node.children.includes(label))!; }
function text(renderer: ReactTestRenderer) { return renderer.root.findAll(() => true).flatMap(node => node.children.filter(child => typeof child === "string")).join(" "); }
function catalogControl(renderer: ReactTestRenderer, key: string): ReactTestInstance {
  return renderer.root.findAll(node => node.type === "input" || node.type === "select").find(node => {
    for (let parent = node.parent; parent; parent = parent.parent) if (parent.props.field?.key === key) return true;
    return false;
  })!;
}
async function fillDemographics(renderer: ReactTestRenderer) {
  for (const [key, value] of Object.entries({ firstName: "Synthetic", lastName: "Registration", gender: "female" })) {
    await act(async () => catalogControl(renderer, key).props.onChange({ target: { value } }));
  }
  for (const [label, value] of Object.entries({ "Date of birth": "1980-01-02", Phone: "555-555-0199" })) {
    await act(async () => renderer.root.findAllByType("label").find(node => node.children.includes(label))!.findByType("input").props.onChange({ target: { value } }));
  }
}
async function mounted(fetcher: typeof fetch, run: (renderer: ReactTestRenderer) => Promise<void>) {
  const previous = globalThis.fetch; globalThis.fetch = fetcher; let renderer!: ReactTestRenderer;
  try { await act(async () => { renderer = create(<NewPatient />); }); await run(renderer); }
  finally { if (renderer) act(() => renderer.unmount()); globalThis.fetch = previous; }
}

test("M7 New Patient unconfirmed registration sends only changed cells and grid makes no separate writes", async () => {
  const requests: Array<{ path: string; method: string; body?: any }> = [];
  await mounted(async (input, init) => {
    requests.push({ path: String(input), method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return String(input).includes("preferences/defaults") ? reply(defaults()) : reply(created, 201);
  }, async renderer => {
    await fillDemographics(renderer);
    assert.equal(renderer.root.findAllByProps({ "aria-disabled": "true" }).length, 0);
    assert.equal(renderer.root.findAllByType("button").filter(node => node.children.includes("Save preferences")).length, 0);
    await act(async () => renderer.root.findByProps({ "aria-label": "Education Email" }).props.onChange({ target: { checked: false } }));
    assert.equal(requests.filter(request => request.method !== "GET").length, 0);
    await act(async () => button(renderer, "Create patient").props.onClick());
    const writes = requests.filter(request => request.method === "POST");
    assert.equal(writes.length, 1); assert.equal(writes[0].path, "/clinic/patients");
    assert.deepEqual(writes[0].body.communicationPreferences, { cells: [{ purpose: "education", channel: "email", allowed: false }] });
    assert.equal(writes[0].body.confirmDuplicate, false);
  });
});

test("M7 New Patient paper confirmation sends all twenty cells and carries them through Create anyway", async () => {
  const payloads: any[] = [];
  await mounted(async (input, init) => {
    if (String(input).includes("preferences/defaults")) return reply(defaults());
    const payload = JSON.parse(String(init?.body)); payloads.push(payload);
    return payload.confirmDuplicate ? reply(created, 201) : reply({ kind: "duplicates", patients: [{ resourceType: "Patient", id: "synthetic-existing", name: [{ given: ["Synthetic"], family: "Registration" }], birthDate: "1980-01-02" }] }, 409);
  }, async renderer => {
    await fillDemographics(renderer);
    await act(async () => renderer.root.findByProps({ "aria-label": "Confirmed via" }).props.onChange({ target: { value: "paper-form" } }));
    await act(async () => renderer.root.findByProps({ "aria-label": "Form date" }).props.onChange({ target: { value: "2026-09-10" } }));
    await act(async () => button(renderer, "Create patient").props.onClick());
    assert.match(text(renderer), /Possible duplicate patient/);
    await act(async () => button(renderer, "Create anyway").props.onClick());
    assert.equal(payloads.length, 2); assert.equal(payloads[0].confirmDuplicate, false); assert.equal(payloads[1].confirmDuplicate, true);
    assert.equal(payloads[0].communicationPreferences.cells.length, 20);
    assert.equal(payloads[0].communicationPreferences.confirmedVia, "paper-form"); assert.equal(payloads[0].communicationPreferences.formDate, "2026-09-10");
    assert.deepEqual(payloads[1].communicationPreferences, payloads[0].communicationPreferences);
  });
});

test("unchanged and unconfirmed registration leaves defaults implicit", async () => {
  let payload: any;
  await mounted(async (input, init) => {
    if (String(input).includes("preferences/defaults")) return reply(defaults());
    payload = JSON.parse(String(init?.body)); return reply(created, 201);
  }, async renderer => {
    await fillDemographics(renderer);
    await act(async () => button(renderer, "Create patient").props.onClick());
    assert.ok(payload); assert.equal(Object.hasOwn(payload, "communicationPreferences"), false);
  });
});

test("registration preference denial shows a specific message", async () => {
  await mounted(async input => String(input).includes("preferences/defaults") ? reply(defaults()) : reply({ error: "communications.preferences.manage role required" }, 403), async renderer => {
    await fillDemographics(renderer);
    await act(async () => renderer.root.findByProps({ "aria-label": "Education Email" }).props.onChange({ target: { checked: false } }));
    await act(async () => button(renderer, "Create patient").props.onClick());
    assert.match(text(renderer), /don't have permission to change communication preferences during registration/);
    assert.equal(renderer.root.findByProps({ "aria-label": "Education Email" }).props.checked, false);
  });
});

test("failed server defaults remain visible and prevent registration without a loaded grid", async () => {
  const methods: string[] = [];
  await mounted(async (_input, init) => { methods.push(init?.method ?? "GET"); return reply({ error: "unavailable" }, 500); }, async renderer => {
    assert.match(text(renderer), /Communication preferences can't be read/);
    assert.equal(renderer.root.findAllByType("table").length, 0);
    assert.equal(button(renderer, "Create patient").props.disabled, true);
    assert.deepEqual(methods, ["GET"]);
  });
});

test("paper confirmation requires a valid date before registration", async () => {
  const methods: string[] = [];
  await mounted(async (_input, init) => { methods.push(init?.method ?? "GET"); return reply(defaults()); }, async renderer => {
    await fillDemographics(renderer);
    await act(async () => renderer.root.findByProps({ "aria-label": "Confirmed via" }).props.onChange({ target: { value: "paper-form" } }));
    await act(async () => button(renderer, "Create patient").props.onClick());
    assert.match(text(renderer), /valid form date/); assert.deepEqual(methods, ["GET"]);
  });
});

test("both registration client entry points omit an empty optional preference payload", async () => {
  const draft = { ...emptyPatientDemographics(), firstName: "Synthetic", lastName: "Registration", gender: "female" as const, birthDate: "1980-01-02", phone: "555-555-0199" };
  for (const request of [registerPatient, createPatient]) {
    await request(draft, { communicationPreferences: { cells: [] } }, async (_input, init) => {
      assert.equal(Object.hasOwn(JSON.parse(String(init?.body)), "communicationPreferences"), false); return reply(created, 201);
    });
  }
});
