import assert from "node:assert/strict";
import test from "node:test";
import type { Basic, Patient } from "@medplum/fhirtypes";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { buildAgeOfMajorityConfigResource } from "../../mcp/src/clinic/age-of-majority-config";
import { EngageSheet, type EngageSheetApi } from "../src/components/comms/EngageSheet";
import { buildResponsiblePartyDemographics } from "../../mcp/src/clinic/responsible-party-demographics";
import { buildPatientResource, emptyPatientDemographics } from "../src/lib/patient-registration";
import { isMinorOn } from "../src/lib/patient-identity";
import { loadAgeOfMajorityConfig } from "../src/lib/age-of-majority";
import { AgeOfMajoritySettings } from "../src/scenes/settings/AgeOfMajoritySettings";

function config(age: number): Basic { return JSON.parse(JSON.stringify(buildAgeOfMajorityConfigResource({ ageOfMajorityYears: age }))); }
const now = new Date().toISOString().slice(0, 10);
const birthDate = `${Number(now.slice(0, 4)) - 19}${now.slice(4)}`;
const patient: Patient = JSON.parse(JSON.stringify({ ...buildPatientResource({ ...emptyPatientDemographics(), firstName: "PatientOnly", lastName: "Synthetic", birthDate, gender: "unknown" }), id: "synthetic-majority" }));
async function engage(setting: Basic | undefined, check: (tree: ReactTestRenderer, guardianReads: () => number, reopenWithoutSetting: () => Promise<void>) => void | Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({});
  let guardianReads = 0;
  const api: EngageSheetApi = {
    async loadAgeOfMajorityConfig() { return setting; },
    async listEducation() { return { items: [], chartDispatchLane: "staff_switchable", availableChannels: { clinicalSms: false, frontdeskSms: false, email: false, print: false } }; },
    async listConsentGuardians() { guardianReads++; return JSON.parse(JSON.stringify([{ resourceType: "RelatedPerson", id: "synthetic-guardian", patient: { reference: "Patient/synthetic-majority" }, ...buildResponsiblePartyDemographics({ firstName: "GuardianOnly", middleName: "", lastName: "Synthetic", address: "", city: "", state: "", postalCode: "", phones: [{ value: "", use: "home" }, { value: "", use: "mobile" }], textable: "" }) }])); },
    async dispatchEducation() { throw new Error("No send expected"); },
  };
  let tree!: ReactTestRenderer;
  try { await act(async () => { tree = create(<EngageSheet open patient={patient} onClose={() => undefined} api={api} />); }); await check(tree, () => guardianReads, async () => {
    await act(async () => tree.update(<EngageSheet open={false} patient={patient} onClose={() => undefined} api={api} />));
    setting = undefined;
    await act(async () => tree.update(<EngageSheet open patient={patient} onClose={() => undefined} api={api} />));
  }); }
  finally { if (tree) await act(async () => tree.unmount()); globalThis.fetch = original; }
}

test("D6 UI setting 21 routes a 19-year-old to the guardian through shared isMinorOn", async () => {
  assert.equal(isMinorOn(birthDate, now, config(21)), true);
  assert.equal(isMinorOn(birthDate, now, config(18)), false);
  await engage(config(21), (tree, reads) => {
    const recipients = tree.root.findByProps({ "aria-label": "Education recipients" }).findAll(() => true).flatMap(node => node.children.filter(child => typeof child === "string")).join(" ");
    assert.match(recipients, /GuardianOnly/);
    assert.doesNotMatch(recipients, /PatientOnly/);
    assert.equal(reads(), 1);
  });
});
for (const [label, setting] of [["missing", undefined], ["invalid", { ...config(21), extension: [] }]] as const) {
  test(`D7 UI ${label} setting is visible and exposes neither patient nor guardian recipients`, async () => {
    assert.throws(() => isMinorOn(birthDate, now, setting), /Age of majority is not configured/);
    await engage(setting, (tree, reads) => {
      assert.match(JSON.stringify(tree.toJSON()), /Age of majority is not configured/);
      assert.equal(tree.root.findByProps({ "aria-label": "Education recipients" }).findAllByType("label").length, 0);
      assert.equal(reads(), 0);
    });
  });
}

test("settings saves writer-derived value with loaded version and shows current value", async () => {
  const original = globalThis.fetch;
  const resource = { ...config(18), id: "majority", meta: { versionId: "7" } };
  let write: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "PUT") { write = init; return Response.json({ ...JSON.parse(String(init.body)), meta: { versionId: "8" } }); }
    return Response.json({ resourceType: "Bundle", entry: [{ resource }] });
  };
  let tree!: ReactTestRenderer;
  try {
    await act(async () => { tree = create(<AgeOfMajoritySettings canWrite />); });
    assert.equal(tree.root.findByType("input").props.value, "18");
    await act(async () => tree.root.findByType("input").props.onChange({ target: { value: "21" } }));
    await act(async () => tree.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    assert.equal((write?.headers as Record<string, string>)["If-Match"], 'W/"7"');
    assert.deepEqual(JSON.parse(String(write?.body)), buildAgeOfMajorityConfigResource({ ageOfMajorityYears: 21 }, resource));
    assert.match(JSON.stringify(tree.toJSON()), /Age of majority saved/);
  } finally { if (tree) await act(async () => tree.unmount()); globalThis.fetch = original; }
});


test("D7 UI reopening after setting deletion clears previously loaded guardian recipients", async () => {
  await engage(config(21), async (tree, reads, reopen) => {
    assert.equal(tree.root.findByProps({ "aria-label": "Education recipients" }).findAllByType("label").length, 1);
    await reopen();
    assert.match(JSON.stringify(tree.toJSON()), /Age of majority is not configured/);
    assert.equal(tree.root.findByProps({ "aria-label": "Education recipients" }).findAllByType("label").length, 0);
    assert.equal(reads(), 1);
  });
});


test("D7 UI duplicate singleton search refuses ambiguity and Engage exposes no recipients", async () => {
  const duplicates = [config(18), config(21)];
  const client = { async search() { return { resourceType: "Bundle", entry: duplicates.map(resource => ({ resource })) }; } };
  await assert.rejects(loadAgeOfMajorityConfig(client as never), /multiple settings/);
  const original = globalThis.fetch;
  globalThis.fetch = async input => String(input).includes("Basic?")
    ? Response.json({ resourceType: "Bundle", entry: duplicates.map(resource => ({ resource })) })
    : Response.json({ items: [], chartDispatchLane: "staff_switchable", availableChannels: { clinicalSms: false, frontdeskSms: false, email: false, print: false } });
  let tree!: ReactTestRenderer;
  try {
    await act(async () => { tree = create(<EngageSheet open patient={patient} onClose={() => undefined} />); });
    assert.match(JSON.stringify(tree.toJSON()), /Age of majority is not configured/);
    assert.equal(tree.root.findByProps({ "aria-label": "Education recipients" }).findAllByType("label").length, 0);
  } finally { if (tree) await act(async () => tree.unmount()); globalThis.fetch = original; }
});
