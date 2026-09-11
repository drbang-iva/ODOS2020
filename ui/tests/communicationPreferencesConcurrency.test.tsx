import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Patient } from "@medplum/fhirtypes";
import { PatientDemographicsEditor } from "../src/components/patient/PatientDemographicsEditor";
import { COMMS_PURPOSES, COMMS_PREFERENCE_CHANNELS } from "../src/lib/communications-client";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const patient: Patient = { resourceType: "Patient", id: "synthetic-sync", meta: { versionId: "opaque-before" }, name: [{ given: ["Synthetic"], family: "Sync" }], birthDate: "1980-01-02", gender: "unknown", telecom: [{ system: "phone", value: "864-555-0100" }] };
const notice = "This patient's record also changed elsewhere. Reload before saving demographics.";
function preferences() { return { patientReference: "Patient/synthetic-sync", matrix: Object.fromEntries(COMMS_PURPOSES.map(p => [p, Object.fromEntries(COMMS_PREFERENCE_CHANNELS.map(c => [c, { value: true, source: "default" }]))])), rows: COMMS_PURPOSES.flatMap(purpose => COMMS_PREFERENCE_CHANNELS.map(channel => ({ purpose, channel, value: true, source: "default", evidenceSummary: [], lastSet: null, evidenceStatus: "gap" }))) }; }
async function fixture(options: { outside?: boolean; unknown?: boolean; readMismatch?: boolean; blocked?: boolean; conflict?: boolean; readFailure?: boolean; deferRead?: boolean } = {}) {
  const original = globalThis.fetch;
  let stored = structuredClone(patient), blocked = options.blocked ?? false;
  let renderer!: ReactTestRenderer;
  const reads: Array<() => void> = [];
  const saves: Patient[] = [], refreshed: Patient[] = [], ifMatches: (string | null)[] = [];
  const sms = () => ({ patientReference: "Patient/synthetic-sync", smsOptedOut: blocked, remainingOptOuts: { global: blocked, numbers: [] }, smsLanes: [] });
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.startsWith("/communications/")) {
      if (init?.method === "PUT" || init?.method === "POST") {
        if (options.conflict) return json({ error: "Changed elsewhere" }, 409);
        const writtenAgainst = options.outside ? "outside-version" : stored.meta!.versionId;
        stored = { ...stored, meta: { versionId: options.readMismatch ? "after-report" : "opaque-after" } };
        const patientVersion = options.unknown ? {} : { patientVersion: { writtenAgainst, current: "opaque-after" } };
        if (path.endsWith("/record")) blocked = true;
        if (path.endsWith("/clear")) blocked = false;
        return json(path.includes("opt-out") ? { ...sms(), cleared: true, ...patientVersion } : { ...preferences(), ...patientVersion });
      }
      return json(path.includes("opt-out") ? sms() : preferences());
    }
    if (init?.method === "PUT") {
      const version = new Headers(init.headers).get("If-Match"); ifMatches.push(version);
      if (version !== `W/"${stored.meta!.versionId}"`) return json({ resourceType: "OperationOutcome", issue: [{ severity: "error", code: "conflict" }] }, 412);
      stored = JSON.parse(String(init.body)); return json(stored);
    }
    if (options.readFailure) return json({ error: "Read unavailable" }, 500);
    if (options.deferRead) return new Promise<Response>(resolve => { reads.push(() => resolve(json(stored))); });
    return json(stored);
  };
  await act(async () => { renderer = create(<PatientDemographicsEditor patient={patient} onSaved={value => saves.push(value)} onDiscard={() => {}} onPatientRefreshed={value => refreshed.push(value)} />); });
  const click = async (label: string) => { await act(async () => { renderer.root.findAllByType("button").find(n => n.children.join("") === label)!.props.onClick(); }); };
  const change = async (label: string, value: unknown) => { await act(async () => { renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value, checked: value } }); }); };
  return { renderer, saves, refreshed, ifMatches, click, change, resolveReads: () => { reads.splice(0).forEach(resolve => resolve()); }, close: () => { act(() => renderer.unmount()); globalThis.fetch = original; } };
}
test("M2 preferences save adopts the post-write version while keeping the demographic draft", async () => {
  const f = await fixture(); try {
    await act(async () => { f.renderer.root.findAllByType("input").find(n => n.props.value === "Synthetic")!.props.onChange({ target: { value: "Edited" } }); });
    await f.change("Education Email", false); await f.click("Save preferences"); await f.click("Save demographics");
    assert.equal(f.saves.length, 1); assert.deepEqual(f.ifMatches, ['W/"opaque-after"']);
    assert.equal(f.refreshed.length, 1); assert.equal(f.saves[0].name?.[0].given?.[0], "Edited");
  } finally { f.close(); }
});
for (const [name, options] of [["M4 intervening write", { outside: true }], ["unknown version", { unknown: true }], ["fresh read version mismatch", { readMismatch: true }], ["fresh read failure", { readFailure: true }]] as const) {
  test(`${name} refuses adoption and leaves demographics conditional save stale`, async () => {
    const f = await fixture(options); try {
      await f.change("Education Email", false); await f.click("Save preferences");
      assert.ok(f.renderer.root.findAllByProps({ role: "status" }).some(n => n.children.join("") === notice));
      assert.equal(f.refreshed.length, 0);
      await f.click("Save demographics"); assert.equal(f.saves.length, 0);
      assert.deepEqual(f.ifMatches, ['W/"opaque-before"']);
    } finally { f.close(); }
  });
}
test("M15 dirty preferences warn and stay available until saved before demographics", async () => {
  const f = await fixture(); try {
    await f.change("Education Email", false); await f.click("Save demographics");
    assert.ok(f.renderer.root.findAllByProps({ role: "status" }).some(n => n.children.join("") === "You have unsaved communication preferences."));
    assert.equal(f.saves.length, 0); assert.deepEqual(f.ifMatches, []);
    assert.equal(f.renderer.root.findByProps({ "aria-label": "Education Email" }).props.checked, false);
    await f.click("Save preferences"); await f.click("Save demographics"); assert.equal(f.saves.length, 1);
  } finally { f.close(); }
});
async function submitOptOut(f: Awaited<ReturnType<typeof fixture>>, clear = false) {
  await f.click(clear ? "Clear all SMS opt-outs…" : "Record opt-out — patient asked…");
  await f.change(clear ? "Reason for re-enrollment" : "Reason for opt-out", "Synthetic patient requested change");
  await f.change("Identity verification", "in-person");
  await act(async () => { f.renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
}
for (const clear of [false, true]) test(`M3 ${clear ? "clear" : "record"} opt-out adopts before saving demographics`, async () => {
  const f = await fixture({ blocked: clear }); try {
    await submitOptOut(f, clear); await f.click("Save demographics");
    assert.equal(f.refreshed.length, 1); assert.equal(f.saves.length, 1);
    assert.deepEqual(f.ifMatches, ['W/"opaque-after"']);
  } finally { f.close(); }
});
for (const clear of [false, true]) test(`opt-out ${clear ? "clear" : "record"} 409 recovery never reports an owned write`, async () => {
  const f = await fixture({ blocked: clear, conflict: true }); try {
    await submitOptOut(f, clear); assert.equal(f.refreshed.length, 0);
    assert.equal(f.renderer.root.findAllByProps({ role: "status" }).some(n => n.children.join("") === notice), false);
  } finally { f.close(); }
});

test("a later unowned write prevents a pending read from adopting its earlier report", async () => {
  const f = await fixture({ deferRead: true }); try {
    await f.change("Education Email", false); await f.click("Save preferences");
    await f.click("Save demographics"); assert.deepEqual(f.ifMatches, []);
    await f.change("Education Email", false); await f.click("Save preferences");
    await act(async () => { f.resolveReads(); });
    assert.equal(f.refreshed.length, 0);
    assert.ok(f.renderer.root.findAllByProps({ role: "status" }).some(n => n.children.join("") === notice));
    await f.click("Save demographics"); assert.deepEqual(f.ifMatches, ['W/"opaque-before"']); assert.equal(f.saves.length, 0);
  } finally { f.close(); }
});
