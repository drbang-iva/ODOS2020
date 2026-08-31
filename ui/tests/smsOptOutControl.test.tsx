import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patient } from "@medplum/fhirtypes";
import React from "react";
import { act, create } from "react-test-renderer";
import { PatientDemographicsEditor } from "../src/components/patient/PatientDemographicsEditor";
import { SmsOptOutControl } from "../src/components/patient/SmsOptOutControl";
import { CockpitGuestPanel } from "../src/scenes/frontdesk/CockpitGuestPanel";
import { PatientSearch } from "../src/scenes/PatientPicker";

const PATIENT: Patient = {
  resourceType: "Patient",
  id: "synthetic-1",
  name: [{ use: "official", given: ["Jane"], family: "Patient" }],
  gender: "female",
  birthDate: "1980-01-02",
  telecom: [{ system: "phone", value: "+18645550199" }],
};

const SECOND_PATIENT: Patient = {
  resourceType: "Patient",
  id: "synthetic-2",
  name: [{ use: "official", given: ["Alex"], family: "Patient" }],
  gender: "male",
  birthDate: "1982-03-04",
  telecom: [{ system: "phone", value: "+18645550200" }],
};

test("the demographics opt-out control distinguishes suppressed and available SMS lanes", async () => {
  const originalFetch = globalThis.fetch;
  let laneSuppressed = true;
  let globalSuppressed = false;
  let omitFrontDeskLane = false;
  let sentBody: Record<string, unknown> | undefined;
  const readInputs: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      sentBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ outcome: "sent", providerMessageId: "synthetic-message-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    readInputs.push(String(input));
    return new Response(JSON.stringify({
    patientReference: "Patient/synthetic-1",
    smsOptedOut: globalSuppressed || laneSuppressed,
    remainingOptOuts: { global: globalSuppressed, numbers: laneSuppressed ? ["+18645550100"] : [] },
    smsLanes: [
      ...omitFrontDeskLane ? [] : [{
        label: "Front-desk texts",
        number: "+18645550100",
        roles: ["transactional-sms", "marketing-sms"],
      }],
      {
        label: "Clinical texts",
        number: "+18485550100",
        roles: ["clinical-sms"],
      },
    ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <PatientDemographicsEditor patient={PATIENT} onSaved={() => undefined} onDiscard={() => undefined} />,
      );
      await Promise.resolve();
    });
    const text = renderer.root.findAll(() => true).flatMap((node) =>
      node.children.filter((child): child is string => typeof child === "string"),
    ).join(" ");
    assert.match(text, /Front-desk texts\s+—\s+opted out \(STOP\)/);
    assert.match(text, /Clinical texts\s+—\s+OK/);
    act(() => renderer.unmount());

    await act(async () => {
      renderer = create(React.createElement(CockpitGuestPanel as never, {
        panel: "messages",
        onClose: () => undefined,
        selectedPatient: PATIENT,
      }));
      await Promise.resolve();
    });
    const panelText = renderer.root.findAll(() => true).flatMap((node) =>
      node.children.filter((child): child is string => typeof child === "string"),
    ).join(" ");
    assert.match(panelText, /Texting is blocked for this patient on the front-desk lane/);
    assert.equal(renderer.root.findByProps({ "aria-label": "Compose text message" }).props.disabled, true);

    await act(async () => {
      renderer.update(React.createElement(CockpitGuestPanel as never, {
        panel: "messages",
        onClose: () => undefined,
        selectedPatient: SECOND_PATIENT,
      }));
      await Promise.resolve();
    });
    const changedPatientText = renderer.root.findAll(() => true).flatMap((node) =>
      node.children.filter((child): child is string => typeof child === "string"),
    ).join(" ");
    assert.match(changedPatientText, /Alex Patient/);
    assert.match(readInputs.at(-1) ?? "", /patient=Patient%2Fsynthetic-2/);
    act(() => renderer.unmount());

    laneSuppressed = false;
    await act(async () => {
      renderer = create(React.createElement(CockpitGuestPanel as never, {
        panel: "messages",
        onClose: () => undefined,
        selectedPatient: PATIENT,
      }));
      await Promise.resolve();
    });
    const compose = renderer.root.findByProps({ "aria-label": "Compose text message" });
    assert.equal(compose.props.disabled, false);
    assert.equal(typeof compose.props.onChange, "function");
    act(() => compose.props.onChange({ target: { value: "Your glasses are ready." } }));
    const send = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Send text");
    assert.equal(typeof send?.props.onClick, "function");
    await act(async () => {
      send!.props.onClick();
      await Promise.resolve();
    });
    assert.equal(sentBody?.patientReference, "Patient/synthetic-1");
    assert.equal(sentBody?.body, "Your glasses are ready.");
    assert.match(String(sentBody?.idempotencyKey), /^[A-Za-z0-9._:-]{8,128}$/);

    act(() => compose.props.onChange({ target: { value: "Draft for Jane" } }));
    const changePatient = renderer.root.findAllByType("button").find((button) =>
      button.children.join("") === "Change patient",
    );
    assert.ok(changePatient);
    act(() => changePatient.props.onClick());
    await act(async () => {
      renderer.root.findByType(PatientSearch).props.onSelect(SECOND_PATIENT);
      await Promise.resolve();
    });
    assert.equal(renderer.root.findByProps({ "aria-label": "Compose text message" }).props.value, "");
    assert.match(readInputs.at(-1) ?? "", /patient=Patient%2Fsynthetic-2/);
    act(() => renderer.unmount());

    globalSuppressed = true;
    omitFrontDeskLane = true;
    await act(async () => {
      renderer = create(React.createElement(CockpitGuestPanel as never, {
        panel: "messages",
        onClose: () => undefined,
        selectedPatient: PATIENT,
      }));
      await Promise.resolve();
    });
    assert.equal(renderer.root.findByProps({ "aria-label": "Compose text message" }).props.disabled, true);
    act(() => renderer.unmount());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a 403 permission probe keeps the opt-out control politely absent", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Forbidden" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });

  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <PatientDemographicsEditor patient={PATIENT} onSaved={() => undefined} onDiscard={() => undefined} />,
      );
      await Promise.resolve();
    });
    const text = renderer.root.findAll(() => true).flatMap((node) =>
      node.children.filter((child): child is string => typeof child === "string"),
    ).join(" ");
    assert.match(text, /Save demographics/);
    assert.doesNotMatch(text, /SMS text preferences|SMS preferences unavailable|Re-enroll/);
    act(() => renderer.unmount());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a scoped clear reports a surviving general opt-out without claiming re-enrollment", async () => {
  const originalFetch = globalThis.fetch;
  let clearBody: unknown;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") {
      clearBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        patientReference: "Patient/synthetic-1",
        smsOptedOut: true,
        cleared: true,
        suppressionCleared: false,
        remainingOptOuts: { global: true, numbers: [] },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      patientReference: "Patient/synthetic-1",
      smsOptedOut: true,
      remainingOptOuts: { global: true, numbers: ["+18645550100"] },
      smsLanes: [{
        label: "Front-desk texts",
        number: "+18645550100",
        roles: ["transactional-sms", "marketing-sms"],
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SmsOptOutControl patientReference="Patient/synthetic-1" />);
      await Promise.resolve();
    });
    const reEnroll = renderer.root.findAllByType("button").find((button) =>
      button.children.join("") === "Re-enroll…",
    );
    assert.ok(reEnroll);
    act(() => reEnroll.props.onClick());
    const reason = renderer.root.findByProps({ "aria-label": "Reason for re-enrollment" });
    const verification = renderer.root.findByProps({ "aria-label": "Identity verification" });
    act(() => {
      reason.props.onChange({ target: { value: "Patient requested texting in person" } });
      verification.props.onChange({ target: { value: "in-person" } });
    });
    await act(async () => {
      renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
      await Promise.resolve();
    });
    const text = renderer.root.findAll(() => true).flatMap((node) =>
      node.children.filter((child): child is string => typeof child === "string"),
    ).join(" ");
    assert.deepEqual(clearBody, {
      patientReference: "Patient/synthetic-1",
      reason: "Patient requested texting in person",
      identityVerification: "in-person",
      number: "+18645550100",
    });
    assert.match(text, /This patient still has a general SMS opt-out — clearing one lane did not restore texting/);
    assert.doesNotMatch(text, /re-enrolled|Texting restored/i);
    act(() => renderer.unmount());
  } finally {
    globalThis.fetch = originalFetch;
  }
});
