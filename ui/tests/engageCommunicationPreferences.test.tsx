import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patient } from "@medplum/fhirtypes";
import React from "react";
import { act, create } from "react-test-renderer";
import { EngageSheet } from "../src/components/comms/EngageSheet";
import { COMMS_PURPOSES, COMMS_PREFERENCE_CHANNELS, type CommunicationPreferencesResponse, type EducationDispatchResult, type EducationContentItem } from "../src/lib/communications-client";

const patient: Patient = { resourceType: "Patient", id: "synthetic-engage", birthDate: "1980-01-01", name: [{ given: ["Sample"], family: "Patient" }], telecom: [{ system: "email", value: "sample@example.test" }, { system: "phone", value: "+12025550111" }] };
const education: EducationContentItem = { id: "synthetic-education", version: 1, title: "Education guide", kind: "handout", audience: "patient", dxCodes: [], channels: ["sms", "email", "print"], laneHint: "clinical", consentClass: "transactional", urls: { web: "https://education.invalid/guide", email: "https://education.invalid/guide/email", print: "https://education.invalid/guide/print" } };
const marketing: EducationContentItem = { ...education, id: "synthetic-marketing", title: "Marketing guide", consentClass: "marketing" };
function preferences(): CommunicationPreferencesResponse {
  const matrix = Object.fromEntries(COMMS_PURPOSES.map(p => [p, Object.fromEntries(COMMS_PREFERENCE_CHANNELS.map(c => [c, { value: true, source: "default" }]))])) as CommunicationPreferencesResponse["matrix"];
  return { patientReference: "Patient/synthetic-engage", matrix, rows: COMMS_PURPOSES.flatMap(purpose => COMMS_PREFERENCE_CHANNELS.map(channel => ({ purpose, channel, ...matrix[purpose][channel], evidenceSummary: [], lastSet: null, evidenceStatus: "gap" as const }))) };
}
function text(renderer: ReturnType<typeof create>): string { return renderer.root.findAll(() => true).flatMap(node => node.children.filter((child): child is string => typeof child === "string")).join(" "); }
async function fixture(options: { view?: CommunicationPreferencesResponse; result?: EducationDispatchResult; failedRead?: boolean; stop?: boolean; legacy?: boolean } = {}) {
  const originalFetch = globalThis.fetch;
  const view = options.view ?? preferences();
  const sends: Record<string, unknown>[] = [];
  const reads: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); reads.push(url);
    if (url.includes("/communications/preferences")) return options.failedRead ? new Response(JSON.stringify({ error: "Unreadable" }), { status: 500 }) : new Response(JSON.stringify(view));
    if (url.includes("/education/dispatch")) { sends.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify(options.result ?? { outcome: "sent", providerMessageId: "synthetic-receipt" })); }
    if (url.includes("/communications/education")) return new Response(JSON.stringify({ items: [education, marketing], chartDispatchLane: "staff_switchable", availableChannels: { clinicalSms: true, frontdeskSms: true, email: true, print: true } }));
    if (url.includes("/communications/opt-out")) return new Response(JSON.stringify({ patientReference: "Patient/synthetic-engage", smsOptedOut: options.stop ?? false, remainingOptOuts: { global: false, numbers: options.stop ? ["+12025550100"] : [] }, smsLanes: [{ label: "Clinical", number: "+12025550100", roles: ["clinical-sms"] }] }));
    throw new Error(`Unexpected fetch ${url}`);
  };
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<EngageSheet open patient={options.legacy ? { ...patient, extension: [{ url: "https://odos2020.com/fhir/StructureDefinition/odos-comms-marketing-consent", extension: [{ url: "consent", valueBoolean: true }, { url: "recorded", valueDateTime: "2026-09-10T12:00:00Z" }] }] } : patient} onClose={() => undefined} />); });
  return { renderer, sends, reads, button: (label: string) => renderer.root.findByProps({ "aria-label": label }),
    async send(label: string) {
      act(() => renderer.root.findByProps({ "aria-label": label }).props.onClick());
      await act(async () => { renderer.root.findByProps({ "aria-label": "Confirm education send" }).props.onClick(); });
    }, close() { act(() => renderer.unmount()); globalThis.fetch = originalFetch; } };
}

test("M8 marketing email and Print follow effective preferences without a legacy consent record", async () => {
  const f = await fixture(); try {
    assert.equal(f.button("Email Marketing guide").props.disabled, false);
    assert.equal(f.button("Print Marketing guide").props.disabled, false);
    await f.send("Email Marketing guide");
    assert.equal(f.sends.length, 1); assert.equal(f.sends[0].channel, "email");
    assert.match(text(f.renderer), /Education sent\./);
  } finally { f.close(); }
});
for (const legacy of [false, true]) test(`M8 withheld marketing email and Text stay disabled; Print stays available, legacy=${legacy}`, async () => {
  const view = preferences(); view.matrix["marketing-promo"].email = { value: false, source: "explicit" }; view.matrix["marketing-promo"].sms = { value: false, source: "explicit" };
  const f = await fixture({ view, legacy }); try {
    assert.equal(f.button("Email Marketing guide").props.disabled, true); assert.equal(f.button("Text Marketing guide").props.disabled, true);
    assert.equal(f.button("Print Marketing guide").props.disabled, false);
    assert.match(text(f.renderer), /Marketing texts are off for this patient\./); assert.match(text(f.renderer), /Marketing email is off for this patient\./);
  } finally { f.close(); }
});
test("M9 education Text withheld disables; education Email remains enabled with override note", async () => {
  const view = preferences(); view.matrix.education.sms = { value: false, source: "explicit" }; view.matrix.education.email = { value: false, source: "explicit" };
  const f = await fixture({ view }); try {
    assert.equal(f.button("Text Education guide").props.disabled, true); assert.equal(f.button("Email Education guide").props.disabled, false);
    assert.match(text(f.renderer), /Education by text is switched off in this patient's communication preferences\./);
    assert.match(text(f.renderer), /Their education email setting is off\. Sending will switch it on\./);
    await f.send("Email Education guide"); assert.equal(f.sends.length, 1);
    assert.match(text(f.renderer), /Education sent\. Their education email setting is now on\./);
  } finally { f.close(); }
});
test("STOP still disables Text for both item purposes; email suppression cannot be overridden", async () => {
  const view = preferences(); view.matrix.education.email = { value: false, source: "suppression" };
  const f = await fixture({ view, stop: true }); try {
    assert.equal(f.button("Text Education guide").props.disabled, true); assert.equal(f.button("Text Marketing guide").props.disabled, true);
    assert.equal(f.button("Email Education guide").props.disabled, true); assert.doesNotMatch(text(f.renderer), /Sending will switch it on/);
  } finally { f.close(); }
});
for (const item of [education, marketing]) for (const channel of ["sms", "email"] as const) test(`M10 preference-withheld result names ${item.consentClass} ${channel}`, async () => {
  const f = await fixture({ result: { outcome: "suppressed", reason: "preference-withheld" } }); try {
    await f.send(`${channel === "sms" ? "Text" : "Email"} ${item.title}`);
    const expected = item.consentClass === "marketing" ? (channel === "sms" ? "Marketing texts are off for this patient." : "Marketing email is off for this patient.") : `Education by ${channel === "sms" ? "text" : "email"} is switched off in this patient's communication preferences.`;
    assert.ok(text(f.renderer).includes(expected)); assert.equal(f.sends.length, 1);
  } finally { f.close(); }
});
for (const chartUpdate of [undefined, "conflict"] as const) test(`M10 sent preference failure remains success and preserves chart conflict=${chartUpdate}`, async () => {
  const view = preferences(); view.matrix.education.email = { value: false, source: "explicit" };
  const f = await fixture({ view, result: { outcome: "sent", providerMessageId: "receipt", preferenceUpdate: "failed", ...(chartUpdate ? { chartUpdate } : {}) } }); try {
    await f.send("Email Education guide");
    assert.match(text(f.renderer), /Education sent, but their education email setting couldn't be switched on\. Update it in Edit demographics\./);
    assert.equal(f.renderer.root.findAllByProps({ role: "alert" }).length, 0);
    assert.equal(f.renderer.root.findAllByProps({ "aria-label": "Confirm education send" }).length, 0);
    if (chartUpdate) assert.match(text(f.renderer), /The chart's contact wasn't updated because the record changed/);
  } finally { f.close(); }
});
test("failed matrix read is explicit and dispatch remains the enforcement boundary", async () => {
  const f = await fixture({ failedRead: true, result: { outcome: "refused", reason: "marketing-consent-absent" } }); try {
    assert.match(text(f.renderer), /Communication preferences could not be read; dispatch will enforce them\./);
    assert.equal(f.button("Text Marketing guide").props.disabled, false); await f.send("Text Marketing guide");
    assert.match(text(f.renderer), /marketing-consent-absent/); assert.equal(f.sends.length, 1);
  } finally { f.close(); }
});

test("matrix read loading holds electronic buttons while Print remains available", async () => {
  const originalFetch = globalThis.fetch;
  let finish!: (response: Response) => void;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes("/communications/preferences")) return new Promise<Response>(resolve => { finish = resolve; });
    if (url.includes("/communications/education")) return new Response(JSON.stringify({ items: [education], chartDispatchLane: "staff_switchable", availableChannels: { clinicalSms: true, frontdeskSms: true, email: true, print: true } }));
    return new Response(JSON.stringify({ patientReference: "Patient/synthetic-engage", smsOptedOut: false, remainingOptOuts: { global: false, numbers: [] }, smsLanes: [] }));
  };
  let renderer!: ReturnType<typeof create>;
  try {
    await act(async () => { renderer = create(<EngageSheet open patient={patient} onClose={() => undefined} />); });
    assert.equal(renderer.root.findByProps({ "aria-label": "Email Education guide" }).props.disabled, true);
    assert.equal(renderer.root.findByProps({ "aria-label": "Text Education guide" }).props.disabled, true);
    assert.equal(renderer.root.findByProps({ "aria-label": "Print Education guide" }).props.disabled, false);
    await act(async () => { finish(new Response(JSON.stringify(preferences()))); });
    assert.equal(renderer.root.findByProps({ "aria-label": "Email Education guide" }).props.disabled, false);
  } finally { if (renderer) act(() => renderer.unmount()); globalThis.fetch = originalFetch; }
});
