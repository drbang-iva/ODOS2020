import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Patient } from "@medplum/fhirtypes";
import { PatientDemographicsEditor } from "../src/components/patient/PatientDemographicsEditor";
import { PatientRoute } from "../src/App";
import { CONCURRENT_EDIT_MESSAGE } from "../src/lib/fhir";
import { createPatientDemographicsActions, patientDemographicsFromPatient } from "../src/lib/patient-registration";

const patient: Patient = {
  resourceType: "Patient", id: "synthetic-concurrency", meta: { versionId: "5" },
  name: [{ given: ["Synthetic"], family: "Concurrency" }], birthDate: "1980-01-02",
  gender: "unknown", telecom: [{ system: "phone", value: "864-555-0100" }],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const click = async (renderer: ReactTestRenderer, text: string) => {
  await act(async () => {
    renderer.root.findAllByType("button").find((node) => node.children.join("") === text)!.props.onClick();
  });
};

test("A1: a stale demographics PUT shows the concurrent-edit alert without retrying", async () => {
  const originalFetch = globalThis.fetch;
  let puts = 0;
  let saved = false;
  let renderer!: ReactTestRenderer;
  globalThis.fetch = async (_input, init) => {
    if (init?.method !== "PUT") return json({ error: "Forbidden" }, 403);
    puts += 1;
    return json({ resourceType: "OperationOutcome", issue: [{ severity: "error", code: "conflict" }] }, 412);
  };
  try {
    await act(async () => { renderer = create(<PatientDemographicsEditor patient={patient} onSaved={() => { saved = true; }} onDiscard={() => {}} />); });
    await click(renderer, "Save demographics");
    assert.equal(renderer.root.findByProps({ role: "alert" }).children.join(""), CONCURRENT_EDIT_MESSAGE);
    assert.equal(puts, 1);
    assert.equal(saved, false);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("A2: missing Patient version refuses before any network call", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return json(patient); };
  try {
    const unversioned = { ...patient, meta: undefined };
    await assert.rejects(async () => createPatientDemographicsActions(unversioned).save(patientDemographicsFromPatient(unversioned)), /version.*reload|reload.*version/i);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("A3: the actual PatientRoute keeps the returned Patient and the next save uses its new version", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  let reloads = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { reload: () => { reloads += 1; } } } });
  let stored = structuredClone(patient);
  const versions: (string | null)[] = [];
  let reads = 0;
  let renderer!: ReactTestRenderer;
  globalThis.fetch = async (input, init) => {
    if (String(input) === `/fhir/R4/Patient/${patient.id}`) {
      if (init?.method === "PUT") {
        versions.push(new Headers(init.headers).get("If-Match"));
        stored = { ...JSON.parse(String(init.body)), meta: { versionId: String(5 + versions.length) } };
      } else reads += 1;
      return json(stored);
    }
    return json({ error: "Unavailable in this synthetic test" }, 403);
  };
  try {
    await act(async () => { renderer = create(<PatientRoute patientId={patient.id!} mode="overview" />); });
    await click(renderer, "Edit demographics");
    await click(renderer, "Save demographics");
    await click(renderer, "Edit demographics");
    assert.equal(renderer.root.findByType(PatientDemographicsEditor).props.patient.meta.versionId, "6");
    await click(renderer, "Save demographics");
    assert.deepEqual(versions, ['W/"5"', 'W/"6"']);
    assert.equal(reads, 1);
    assert.equal(reloads, 0);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});
