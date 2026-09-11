import assert from "node:assert/strict";
import { test } from "node:test";
import React, { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { CommunicationPreferencesControl, communicationPreferencesInput, type CommunicationPreferencesDraft } from "../src/components/patient/CommunicationPreferencesControl";
import { COMMS_PURPOSES, COMMS_PREFERENCE_CHANNELS, type CommunicationPreferencesResponse, type CommunicationPreferenceDefaultsResponse } from "../src/lib/communications-client";

function response(): CommunicationPreferencesResponse {
  const matrix = Object.fromEntries(COMMS_PURPOSES.map(purpose => [purpose, Object.fromEntries(COMMS_PREFERENCE_CHANNELS.map(channel =>
    [channel, { value: purpose !== "marketing-promo" || (channel !== "sms" && channel !== "call"), source: "default" }]))])) as CommunicationPreferencesResponse["matrix"];
  return { patientReference: "Patient/synthetic-matrix", matrix,
    rows: COMMS_PURPOSES.flatMap(purpose => COMMS_PREFERENCE_CHANNELS.map(channel => ({ purpose, channel, ...matrix[purpose][channel], evidenceSummary: [], lastSet: null,
      evidenceStatus: channel === "call" || channel === "mail" ? "not-applicable" : matrix[purpose][channel].value ? "gap" : "not-required" }))) };
}
function defaults(): CommunicationPreferenceDefaultsResponse {
  const matrix = response().matrix;
  return { version: "2026-09-10", defaults: Object.fromEntries(COMMS_PURPOSES.map(purpose => [purpose, Object.fromEntries(COMMS_PREFERENCE_CHANNELS.map(channel => [channel, matrix[purpose][channel].value]))])) as CommunicationPreferenceDefaultsResponse["defaults"] };
}
function body(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }
function text(renderer: ReactTestRenderer) { return renderer.root.findAll(() => true).flatMap(node => node.children.filter(child => typeof child === "string")).join(" "); }
function button(renderer: ReactTestRenderer, label: string) { return renderer.root.findAllByType("button").find(node => node.children.includes(label))!; }
async function mount(fetcher: typeof fetch, element: React.ReactElement, operation: (renderer: ReactTestRenderer) => Promise<void>) {
  const previous = globalThis.fetch; globalThis.fetch = fetcher;
  let renderer!: ReactTestRenderer;
  try { await act(async () => { renderer = create(element); }); await operation(renderer); }
  finally { if (renderer) act(() => renderer.unmount()); globalThis.fetch = previous; }
}
const patientProps = { mode: "patient" as const, patientReference: "Patient/synthetic-matrix", canEdit: true };

test("M1 STOP cells are locked amber labels, never checkboxes; default and legacy states remain distinct", async () => {
  const initial = response();
  initial.matrix.education.sms = { value: false, source: "suppression" };
  initial.matrix["marketing-promo"].sms = { value: true, source: "legacy-marketing-consent" };
  await mount(async () => body(initial), <CommunicationPreferencesControl {...patientProps} />, async renderer => {
    assert.equal(renderer.root.findAllByType("input").filter(node => node.props.type === "checkbox").length, 19);
    assert.equal(renderer.root.findAllByProps({ "aria-label": "Education Text" }).length, 0);
    const stop = renderer.root.findByProps({ "aria-disabled": "true" });
    assert.deepEqual(stop.children, ["STOP"]); assert.match(stop.props.title, /identity verification required/);
    assert.ok(renderer.root.findAllByProps({ "data-source": "default" }).length);
    assert.equal(renderer.root.findAllByProps({ "data-source": "legacy-marketing-consent" }).length, 1);
    assert.match(text(renderer), /legacy/); assert.match(text(renderer), /no automated calls/); assert.match(text(renderer), /no automated mail/);
  });
});

test("M7 unconfirmed patient save sends only changed cells and reports the server version", async () => {
  const initial = response(); const payloads: unknown[] = [], versions: unknown[] = [], dirty: boolean[] = [];
  await mount(async (_input, init) => {
    if (init?.method !== "PUT") return body(initial);
    payloads.push(JSON.parse(String(init.body)));
    return body({ ...initial, patientVersion: { writtenAgainst: "initial-uuid", current: "written-uuid" } });
  }, <CommunicationPreferencesControl {...patientProps} onPatientWritten={version => versions.push(version)} onDirtyChange={value => dirty.push(value)} />, async renderer => {
    await act(async () => renderer.root.findByProps({ "aria-label": "Education Text" }).props.onChange({ target: { checked: false } }));
    assert.equal(dirty.at(-1), true);
    await act(async () => button(renderer, "Save preferences").props.onClick());
    assert.deepEqual(payloads, [{ patientReference: patientProps.patientReference, cells: [{ purpose: "education", channel: "sms", allowed: false }] }]);
    assert.deepEqual(versions, [{ writtenAgainst: "initial-uuid", current: "written-uuid" }]);
    assert.equal(dirty.at(-1), false); assert.match(text(renderer), /preferences saved/);
  });
});

test("M7 patient paper confirmation sends all twenty cells and evidence fields", async () => {
  const initial = response(); const payloads: Array<{ cells: unknown[]; confirmedVia: string; formDate: string }> = [];
  await mount(async (_input, init) => { if (init?.method === "PUT") payloads.push(JSON.parse(String(init.body))); return body(initial); }, <CommunicationPreferencesControl {...patientProps} />, async renderer => {
    await act(async () => renderer.root.findByProps({ "aria-label": "Confirmed via" }).props.onChange({ target: { value: "paper-form" } }));
    await act(async () => renderer.root.findByProps({ "aria-label": "Form date" }).props.onChange({ target: { value: "2026-09-10" } }));
    await act(async () => button(renderer, "Save preferences").props.onClick());
    assert.equal(payloads[0].cells.length, 20); assert.equal(payloads[0].confirmedVia, "paper-form"); assert.equal(payloads[0].formDate, "2026-09-10");
  });
});

test("patient paper confirmation with no date refuses to send", async () => {
  const methods: string[] = [];
  await mount(async (_input, init) => { methods.push(init?.method ?? "GET"); return body(response()); }, <CommunicationPreferencesControl {...patientProps} />, async renderer => {
    await act(async () => renderer.root.findByProps({ "aria-label": "Confirmed via" }).props.onChange({ target: { value: "paper-form" } }));
    await act(async () => button(renderer, "Save preferences").props.onClick());
    assert.deepEqual(methods, ["GET"]); assert.match(text(renderer), /valid form date/);
  });
});

test("403 leaves the loaded grid read-only with the permission message", async () => {
  await mount(async (_input, init) => init?.method === "PUT" ? body({ error: "denied" }, 403) : body(response()), <CommunicationPreferencesControl {...patientProps} />, async renderer => {
    await act(async () => button(renderer, "Clear all").props.onClick());
    await act(async () => button(renderer, "Save preferences").props.onClick());
    assert.match(text(renderer), /don't have permission to change communication preferences/);
    const checks = renderer.root.findAllByType("input").filter(node => node.props.type === "checkbox");
    assert.equal(checks.length, 20); assert.ok(checks.every(node => node.props.disabled));
  });
});

test("409 rereads the grid, discards stale changes, and never calls the successful-write callback", async () => {
  let gets = 0, writes = 0;
  const fresh = response(); fresh.matrix.education.sms = { value: false, source: "suppression" };
  await mount(async (_input, init) => {
    if (init?.method === "PUT") return body({ error: "conflict" }, 409);
    return body(++gets === 1 ? response() : fresh);
  }, <CommunicationPreferencesControl {...patientProps} onPatientWritten={() => writes++} />, async renderer => {
    await act(async () => button(renderer, "Clear all").props.onClick());
    await act(async () => button(renderer, "Save preferences").props.onClick());
    assert.equal(gets, 2); assert.equal(writes, 0); assert.match(text(renderer), /changed elsewhere/);
    assert.equal(renderer.root.findAllByProps({ "aria-label": "Education Text" }).length, 0);
    assert.equal(button(renderer, "Save preferences").props.disabled, true);
  });
});

test("M14 a preferences GET 5xx renders the malformed-record message and no grid", async () => {
  await mount(async () => body({ error: "Malformed preferences" }, 500), <CommunicationPreferencesControl {...patientProps} />, async renderer => {
    assert.match(text(renderer), /Communication preferences can't be read for this patient. Ask a practice administrator/);
    assert.equal(renderer.root.findAllByType("table").length, 0);
    assert.equal(renderer.root.findAllByType("input").length, 0);
  });
});

test("registration reads server defaults and D2 sends only changes unless the grid is confirmed", async () => {
  const requests: string[] = []; let draft: CommunicationPreferencesDraft | undefined;
  function Registration() {
    const [value, setValue] = useState<CommunicationPreferencesDraft>();
    return <CommunicationPreferencesControl mode="registration" value={value} onChange={next => { draft = next; setValue(next); }} />;
  }
  const server = defaults(); server.defaults.education.email = false;
  await mount(async (input, init) => { requests.push(`${init?.method ?? "GET"} ${String(input)}`); return body(server); }, <Registration />, async renderer => {
    assert.equal(renderer.root.findByProps({ "aria-label": "Education Email" }).props.checked, false);
    assert.deepEqual(communicationPreferencesInput(draft!).cells, []);
    await act(async () => renderer.root.findByProps({ "aria-label": "Education Email" }).props.onChange({ target: { checked: true } }));
    assert.deepEqual(communicationPreferencesInput(draft!), { cells: [{ purpose: "education", channel: "email", allowed: true }] });
    await act(async () => renderer.root.findByProps({ "aria-label": "Confirmed via" }).props.onChange({ target: { value: "in-person" } }));
    const input = communicationPreferencesInput(draft!);
    assert.equal(input.cells.length, 20); assert.equal(input.confirmedVia, "in-person");
    assert.equal(renderer.root.findAllByType("button").filter(node => node.children.includes("Save preferences")).length, 0);
    assert.equal(requests.length, 1); assert.match(requests[0], /^GET .*\/communications\/preferences\/defaults$/);
  });
});

test("registration paper confirmation includes the date and twenty cells", async () => {
  let draft: CommunicationPreferencesDraft | undefined;
  function Registration() {
    const [value, setValue] = useState<CommunicationPreferencesDraft>();
    return <CommunicationPreferencesControl mode="registration" value={value} onChange={next => { draft = next; setValue(next); }} />;
  }
  await mount(async () => body(defaults()), <Registration />, async renderer => {
    await act(async () => renderer.root.findByProps({ "aria-label": "Confirmed via" }).props.onChange({ target: { value: "paper-form" } }));
    await act(async () => renderer.root.findByProps({ "aria-label": "Form date" }).props.onChange({ target: { value: "2026-09-10" } }));
    const input = communicationPreferencesInput(draft!);
    assert.equal(input.cells.length, 20); assert.equal(input.confirmedVia, "paper-form"); assert.equal(input.formDate, "2026-09-10");
  });
});

test("external refresh preserves unsaved changes while new STOP state locks the cell", async () => {
  let gets = 0;
  const fresh = response(); fresh.matrix.education.sms = { value: false, source: "suppression" };
  await mount(async () => body(++gets === 1 ? response() : fresh), <CommunicationPreferencesControl {...patientProps} refreshKey={0} />, async renderer => {
    await act(async () => renderer.root.findByProps({ "aria-label": "Recalls Email" }).props.onChange({ target: { checked: false } }));
    await act(async () => renderer.update(<CommunicationPreferencesControl {...patientProps} refreshKey={1} />));
    assert.equal(gets, 2); assert.equal(renderer.root.findByProps({ "aria-label": "Recalls Email" }).props.checked, false);
    assert.equal(renderer.root.findAllByProps({ "aria-label": "Education Text" }).length, 0);
    assert.equal(button(renderer, "Save preferences").props.disabled, false);
  });
});

test("evidence warning amber is reserved for uncovered marketing Text and last setter is shown", async () => {
  const initial = response(); initial.matrix["marketing-promo"].sms = { value: true, source: "explicit" };
  initial.rows.find(row => row.purpose === "education" && row.channel === "email")!.lastSet = {
    recordedAt: "2026-09-10T14:02:00Z", setBy: { reference: "Practitioner/synthetic-staff", display: "Synthetic Staff" }, surface: "staff-demographics",
  };
  await mount(async () => body(initial), <CommunicationPreferencesControl {...patientProps} />, async renderer => {
    assert.equal(renderer.root.findAllByProps({ "data-evidence-tone": "amber" }).length, 1);
    assert.match(text(renderer), /Last set by Synthetic Staff via staff entry, 2026-09-10 14:02/);
  });
});

test("M14 failed refresh removes a previously loaded grid instead of leaving editable stale preferences", async () => {
  let reads = 0;
  await mount(async () => ++reads === 1 ? body(response()) : body({ error: "Malformed preferences" }, 500), <CommunicationPreferencesControl {...patientProps} refreshKey={0} />, async renderer => {
    assert.equal(renderer.root.findAllByType("table").length, 1);
    await act(async () => renderer.update(<CommunicationPreferencesControl {...patientProps} refreshKey={1} />));
    assert.match(text(renderer), /Communication preferences can't be read for this patient/);
    assert.equal(renderer.root.findAllByType("table").length, 0);
    assert.equal(renderer.root.findAllByType("input").length, 0);
  });
});

test("bulk selection never changes a suppressed cell in an unconfirmed write", async () => {
  const initial = response(); initial.matrix.education.sms = { value: false, source: "suppression" };
  let payload: { cells: Array<{ purpose: string; channel: string }> } | undefined;
  await mount(async (_input, init) => { if (init?.method === "PUT") payload = JSON.parse(String(init.body)); return body(initial); }, <CommunicationPreferencesControl {...patientProps} />, async renderer => {
    await act(async () => button(renderer, "Select all").props.onClick());
    await act(async () => button(renderer, "Save preferences").props.onClick());
    assert.ok(payload); assert.ok(!payload.cells.some(cell => cell.purpose === "education" && cell.channel === "sms"));
    assert.equal(renderer.root.findAllByProps({ "aria-label": "Education Text" }).length, 0);
  });
});
