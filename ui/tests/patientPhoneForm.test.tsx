import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContactPoint, Patient } from "@medplum/fhirtypes";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createPatientDemographicsActions, patientDemographicsFromPatient, patientTelecomSnapshot, type PatientDemographicsDraft } from "../src/lib/patient-registration";
import { PatientDemographicsEditor } from "../src/components/patient/PatientDemographicsEditor";
import { SmsOptOutControl } from "../src/components/patient/SmsOptOutControl";
import { createCommsDispatch } from "../../mcp/src/comms/comms-config";
import { effectiveCommsPreferences, ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL, ODOS_TEXTABLE_NUMBER_EXTENSION_URL, resolveSmsHistoryNumber, resolveSmsNumber, resolveVoiceNumber } from "../../mcp/src/comms/suppression-gate";
import { CONTACT_NOTE, NUMBERS, TELECOM_FIXTURES, TELECOM_NOW, TEXTABLE_MARKER, telecomFixture } from "./fixtures/patient-telecom";

const marked = (point: ContactPoint) => point.extension?.some(e => e.url === ODOS_TEXTABLE_NUMBER_EXTENSION_URL && e.valueBoolean === true);
const markedValues = (patient: Patient) => patient.telecom?.filter(marked).map(p => p.value) ?? [];
const refusal = (patient: Patient) => patient.extension?.filter(e => e.url === ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL) ?? [];

function preservationOracle(before: Patient, after: Patient) {
  const unrelated = (patient: Patient) => patient.extension?.filter(e => e.url !== ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL);
  assert.equal(JSON.stringify(unrelated(after)), JSON.stringify(unrelated(before)));
  for (const point of before.telecom ?? []) {
    if (point.id === undefined) continue;
    const retained = after.telecom?.find(p => p.id === point.id);
    assert.ok(retained, `Expected telecom entry ${point.id} to be retained`);
    assert.equal(JSON.stringify(retained.extension?.filter(e => e.url !== ODOS_TEXTABLE_NUMBER_EXTENSION_URL)), JSON.stringify(point.extension?.filter(e => e.url !== ODOS_TEXTABLE_NUMBER_EXTENSION_URL)));
  }
  assert.deepEqual(effectiveCommsPreferences(after, {}).appointment.sms, effectiveCommsPreferences(before, {}).appointment.sms);
  assert.equal(effectiveCommsPreferences(after, {}).appointment.sms.source, "suppression");
}

async function savePatient(patient: Patient, edit: (draft: PatientDemographicsDraft) => void = () => {}, held = patient) {
  const draft = patientDemographicsFromPatient(patient, TELECOM_NOW);
  const snapshot = patientTelecomSnapshot(patient, TELECOM_NOW);
  edit(draft);
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.method, "PUT");
    bodies.push(String(init.body));
    return Response.json({ ...JSON.parse(String(init.body)), meta: { versionId: "4" } });
  };
  try {
    const saved = await createPatientDemographicsActions(held).save(draft, snapshot);
    assert.equal(bodies.length, 1);
    return { saved, body: bodies[0], draft, snapshot };
  } finally { globalThis.fetch = originalFetch; }
}

async function withRenderedEditor(patient: Patient, run: (renderer: ReactTestRenderer, bodies: string[], latest: () => Patient | undefined) => Promise<void>, fresh?: Patient) {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  let saved: Patient | undefined;
  let renderer!: ReactTestRenderer;
  globalThis.fetch = async (input, init) => {
    if (String(input) === `/fhir/R4/Patient/${patient.id}`) {
      if (init?.method === "PUT") {
        bodies.push(String(init.body));
        return Response.json({ ...JSON.parse(String(init.body)), meta: { versionId: String(Number((fresh ?? patient).meta!.versionId) + 1) } });
      }
      return Response.json(fresh ?? patient);
    }
    return Response.json({ error: "Unavailable in this synthetic fixture" }, { status: 403 });
  };
  try {
    await act(async () => { renderer = create(<PatientDemographicsEditor patient={patient} onSaved={value => { saved = value; }} onDiscard={() => {}} />); });
    await run(renderer, bodies, () => saved);
  } finally { act(() => renderer?.unmount()); globalThis.fetch = originalFetch; }
}

async function clickSave(renderer: ReactTestRenderer) {
  await act(async () => { renderer.root.findAllByType("button").find(b => b.children.join("") === "Save demographics")!.props.onClick(); });
}

async function choose(renderer: ReactTestRenderer, value: string) {
  const radio = renderer.root.findAllByType("input").find(node => node.props.type === "radio" && node.props.value === value);
  assert.ok(radio, `The real form must offer ${value}`);
  await act(async () => { radio.props.onChange(); });
}

test("K1: the real reader selects active slots in resolver order", async () => {
  const loaded = patientDemographicsFromPatient(telecomFixture("IMPORTED3"), TELECOM_NOW);
  assert.deepEqual(loaded.phones, [
    { value: NUMBERS.M, use: "mobile", sourceIndex: 3 },
    { value: NUMBERS.H, use: "home", sourceIndex: 0 },
  ]);
  for (const [fixture, first, second] of [["MARKED-W", NUMBERS.W, NUMBERS.M], ["EXPIRED", NUMBERS.M, ""], ["NONE", "", ""], ["EMPTY", "", ""]]) {
    const patient = telecomFixture(fixture);
    const draft = patientDemographicsFromPatient(patient, TELECOM_NOW);
    assert.deepEqual(draft.phones.map(p => p.value), [first, second]);
    assert.deepEqual((await savePatient(patient)).saved.telecom, patient.telecom);
  }
});

test("K2: every fixture round-trips untouched telecom and extensions, including a re-clicked loaded answer", async () => {
  for (const name of TELECOM_FIXTURES) {
    const patient = telecomFixture(name);
    const original = JSON.stringify(patient);
    const { saved, snapshot } = await savePatient(patient);
    assert.equal(JSON.stringify(saved.telecom), JSON.stringify(patient.telecom), name);
    assert.equal(JSON.stringify(saved.extension), JSON.stringify(patient.extension), name);
    assert.equal(JSON.stringify(patient), original, name);
    if (name === "ABSENT") assert.equal(Object.hasOwn(snapshot.entries[0], "value"), false);
  }
  const patient = telecomFixture("TWO-MARKED");
  await withRenderedEditor(patient, async (renderer, bodies) => {
    await choose(renderer, "phone1");
    await clickSave(renderer);
    assert.equal(bodies.length, 1);
    assert.deepEqual(JSON.parse(bodies[0]).telecom, patient.telecom);
  });
});

test("K3: clearing slot 2 removes only its original entry from one serialized PUT", async () => {
  const patient = telecomFixture("IMPORTED3");
  const { saved, body } = await savePatient(patient, draft => { draft.phones[1].value = ""; });
  assert.deepEqual(saved.telecom, patient.telecom!.slice(1));
  assert.doesNotMatch(body, /"value"\s*:\s*""/);
});

test("K4: absent and empty telecom allow an address-only save without creating telecom", async () => {
  for (const name of ["NONE", "EMPTY"]) {
    const patient = telecomFixture(name);
    const { saved } = await savePatient(patient, draft => { draft.address = "2 Synthetic Way"; });
    assert.deepEqual(saved.telecom, patient.telecom);
    assert.equal(Object.hasOwn(saved, "telecom"), Object.hasOwn(patient, "telecom"));
    assert.deepEqual(saved.address?.[0].line, ["2 Synthetic Way"]);
  }
});

test("K6: a changed phone choice leaves exactly one marker across the entire resource", async () => {
  for (const [name, answer, target] of [["MARKED-W", "phone2", NUMBERS.M], ["TWO-MARKED", "phone2", NUMBERS.M], ["OLD-MARKED", "phone1", NUMBERS.M]] as const) {
    const patient = telecomFixture(name);
    const { saved } = await savePatient(patient, draft => { draft.textable = answer; });
    assert.deepEqual(markedValues(saved), [target]);
    assert.equal(refusal(saved).length, 0);
    preservationOracle(patient, saved);
    if (name === "OLD-MARKED") assert.deepEqual(saved.telecom![0], { ...patient.telecom![0], extension: [CONTACT_NOTE] });
  }
});

test("K7: Neither writes one refusal and preserves every ContactPoint marker", async () => {
  const patient = telecomFixture("MARKED-W");
  const { saved } = await savePatient(patient, draft => { draft.textable = "neither"; });
  assert.deepEqual(refusal(saved), [{ url: ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL, valueBoolean: true }]);
  assert.deepEqual(saved.telecom, patient.telecom);
  assert.deepEqual(markedValues(saved), [NUMBERS.W]);
  preservationOracle(patient, saved);
});

test("K8: choosing a phone removes refusal and switches the actual SMS resolver", async () => {
  const patient = telecomFixture("REFUSED+MARKED");
  const { saved } = await savePatient(patient, draft => { draft.textable = "phone2"; });
  assert.equal(refusal(saved).length, 0);
  assert.deepEqual(markedValues(saved), [NUMBERS.M]);
  assert.equal(resolveSmsNumber(saved, new Date(TELECOM_NOW)), NUMBERS.M);
  preservationOracle(patient, saved);
});

test("K9: an ineffective inherited marker survives an address-only save", async () => {
  for (const name of ["OLD-MARKED", "EXPIRED"]) {
    const patient = telecomFixture(name);
    if (name === "EXPIRED") patient.telecom![0].extension!.push(TEXTABLE_MARKER);
    const { saved } = await savePatient(patient, draft => { assert.equal(draft.textable, ""); draft.address = "2 Synthetic Way"; });
    assert.deepEqual(saved.telecom, patient.telecom);
    preservationOracle(patient, saved);
  }
});

test("K10: a new mobile appends after obsolete history with the chosen use", async () => {
  const patient = telecomFixture("OLD-MARKED");
  patient.telecom!.pop();
  const { saved } = await savePatient(patient, draft => { draft.phones[0].value = NUMBERS.M; });
  assert.deepEqual(saved.telecom, [...patient.telecom!, { system: "phone", use: "mobile", value: NUMBERS.M }]);
});

test("K11: a use-only edit retains metadata and the other legacy use verbatim", async () => {
  const patient = telecomFixture("TEMP");
  const { saved } = await savePatient(patient, draft => {
    assert.deepEqual(draft.phones.map(p => p.use), ["other", "other"]);
    draft.phones[0].use = "mobile";
  });
  assert.deepEqual(saved.telecom, [{ ...patient.telecom![0], use: "mobile" }, ...patient.telecom!.slice(1)]);
  preservationOracle(patient, saved);
});

test("K12: blank and whitespace phone values save once without an empty ContactPoint", async () => {
  for (const value of ["", "   "]) {
    const patient = telecomFixture("IMPORTED3");
    patient.telecom = [patient.telecom![3]];
    const { saved, body } = await savePatient(patient, draft => { draft.phones[0].value = value; });
    assert.deepEqual(saved.telecom, []);
    assert.doesNotMatch(body, /"value"\s*:\s*""/);
  }
});

async function renderedConversationSequence() {
  let patient = telecomFixture("IMPORTED3");
  const queries: string[] = [];
  const dispatch = createCommsDispatch([{ provider: "ghl", config: { locationId: "synthetic", accessToken: "synthetic-token" } }], {
    now: () => new Date(TELECOM_NOW),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/contacts/search") {
        const query = JSON.parse(String(init?.body)).query;
        queries.push(query);
        return Response.json(query === NUMBERS.H ? { contacts: [{ id: "H-contact", phone: NUMBERS.H }], total: 1 } : { contacts: [], total: 0 });
      }
      assert.equal(url.pathname, "/conversations/search");
      assert.equal(url.searchParams.get("contactId"), "H-contact");
      return Response.json({ conversations: [{ id: "H-thread", contactId: "H-contact", unreadCount: 1, phone: NUMBERS.H }] });
    },
  });
  const adapter = dispatch.getAdapter("ghl", { read: async () => structuredClone(patient) } as never);
  for (const [answer, sms, history, threads] of [
    ["phone2", NUMBERS.H, NUMBERS.H, ["H-thread"]],
    ["neither", undefined, NUMBERS.H, ["H-thread"]],
    ["phone2", NUMBERS.M, NUMBERS.M, []],
  ] as const) {
    const before = patient;
    await withRenderedEditor(patient, async (renderer, bodies, latest) => {
      await choose(renderer, answer);
      await clickSave(renderer);
      assert.equal(bodies.length, 1);
      assert.ok(latest());
      patient = JSON.parse(bodies[0]);
      patient.meta = latest()!.meta;
    });
    assert.equal(resolveSmsNumber(patient, new Date(TELECOM_NOW)), sms);
    assert.equal(resolveVoiceNumber(patient, new Date(TELECOM_NOW)), NUMBERS.M);
    assert.equal(resolveSmsHistoryNumber(patient, new Date(TELECOM_NOW)), history);
    assert.deepEqual((await adapter.listConversations!({ patientReference: `Patient/${patient.id}` })).map(t => t.id), threads);
    preservationOracle(before, patient);
  }
  assert.deepEqual(queries, [NUMBERS.H, NUMBERS.H, NUMBERS.M]);
  assert.deepEqual(markedValues(patient), [NUMBERS.M]);
  assert.equal(refusal(patient).length, 0);
}

test("K13: the rendered editor, serialized PUT, reload, resolvers and configured H-only history agree", renderedConversationSequence);

test("K14: unrelated extensions and effective appointment suppression survive every transition", async () => {
  for (const [name, answer] of [["MARKED-W", "phone2"], ["MARKED-W", "neither"], ["REFUSED+MARKED", "phone2"], ["OLD-MARKED", ""], ["EXPIRED", ""], ["TEMP", ""]] as const) {
    const before = telecomFixture(name);
    const { saved } = await savePatient(before, draft => { draft.textable = answer; if (name === "TEMP") draft.phones[0].use = "mobile"; });
    preservationOracle(before, saved);
  }
  await renderedConversationSequence();
});

test("K15: preserve the remainder and validate the original snapshot through preference refresh", async () => {
  const patient = telecomFixture("IMPORTED3");
  const { saved } = await savePatient(patient, draft => { draft.phones[0].value = NUMBERS.changed; });
  assert.deepEqual(saved.telecom![2], patient.telecom![2]);
  assert.equal(saved.telecom![3].value, NUMBERS.changed);
  for (const changed of [false, true]) {
    const fresh = structuredClone(patient);
    fresh.meta!.versionId = "4";
    fresh.extension!.push({ url: "urn:synthetic:preference-refresh", valueBoolean: true });
    if (changed) fresh.telecom![3].value = NUMBERS.changed;
    await withRenderedEditor(patient, async (renderer, bodies, latest) => {
      await act(async () => { renderer.root.findByType(SmsOptOutControl).props.onPatientWritten({ writtenAgainst: "3", current: "4" }); });
      await clickSave(renderer);
      assert.equal(bodies.length, changed ? 0 : 1);
      if (changed) assert.equal(renderer.root.findByProps({ role: "alert" }).children.join(""), "Contact information changed on the server. Reload before saving.");
      else {
        assert.ok(latest());
        assert.deepEqual(latest()!.extension, fresh.extension);
        assert.deepEqual(latest()!.telecom, fresh.telecom);
      }
    }, fresh);
  }
});

test("R2: choosing a blank or invalid slot blocks the real form on that slot", async () => {
  for (const value of ["", "   ", "123"]) {
    const patient = telecomFixture("IMPORTED3");
    await withRenderedEditor(patient, async (renderer, bodies) => {
      await choose(renderer, "phone1");
      const number = renderer.root.findAllByType("input").find(node => node.props.value === NUMBERS.M)!;
      await act(async () => { number.props.onChange({ target: { value } }); });
      await clickSave(renderer);
      assert.equal(bodies.length, 0);
      assert.ok(JSON.stringify(renderer.toJSON()).includes("Phone 1 was chosen as the texting number — enter it, choose another, or Neither."));
    });
  }
});
