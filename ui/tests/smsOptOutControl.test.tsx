import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patient } from "@medplum/fhirtypes";
import React from "react";
import { act, create } from "react-test-renderer";
import { PatientDemographicsEditor } from "../src/components/patient/PatientDemographicsEditor";
import { SmsOptOutControl } from "../src/components/patient/SmsOptOutControl";

const PATIENT: Patient = {
  resourceType: "Patient",
  id: "synthetic-1",
  name: [{ use: "official", given: ["Jane"], family: "Patient" }],
  gender: "female",
  birthDate: "1980-01-02",
  telecom: [{ system: "phone", value: "+18645550199" }],
};

test("the demographics opt-out control distinguishes suppressed and available SMS lanes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    patientReference: "Patient/synthetic-1",
    smsOptedOut: true,
    remainingOptOuts: { global: false, numbers: ["+18645550100"] },
    smsLanes: [
      {
        label: "Front-desk texts",
        number: "+18645550100",
        roles: ["transactional-sms", "marketing-sms"],
      },
      {
        label: "Clinical texts",
        number: "+18485550100",
        roles: ["clinical-sms"],
      },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

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
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an opted-out number remains visible and clearable when no SMS lanes are configured", async () => {
  const originalFetch = globalThis.fetch;
  let clearBody: unknown;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") {
      clearBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        patientReference: "Patient/synthetic-1",
        smsOptedOut: false,
        cleared: true,
        suppressionCleared: true,
        remainingOptOuts: { global: false, numbers: [] },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      patientReference: "Patient/synthetic-1",
      smsOptedOut: true,
      remainingOptOuts: { global: false, numbers: ["+18485550123"] },
      smsLanes: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SmsOptOutControl patientReference="Patient/synthetic-1" />);
      await Promise.resolve();
    });
    const text = renderer.root.findAll(() => true).flatMap((node) =>
      node.children.filter((child): child is string => typeof child === "string"),
    ).join(" ");
    assert.match(text, /SMS number\s+\+18485550123\s+—\s+opted out \(STOP\)/);
    const reEnroll = renderer.root.findAllByType("button").find((button) =>
      button.children.join("") === "Re-enroll…",
    );
    assert.ok(reEnroll);
    act(() => reEnroll.props.onClick());
    act(() => {
      renderer.root.findByProps({ "aria-label": "Reason for re-enrollment" }).props.onChange({
        target: { value: "Patient requested texting in person" },
      });
      renderer.root.findByProps({ "aria-label": "Identity verification" }).props.onChange({
        target: { value: "in-person" },
      });
    });
    await act(async () => {
      renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
      await Promise.resolve();
    });
    assert.deepEqual(clearBody, {
      patientReference: "Patient/synthetic-1",
      reason: "Patient requested texting in person",
      identityVerification: "in-person",
      number: "+18485550123",
    });
    act(() => renderer.unmount());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an opted-out number remains visible after the practice reconfigures its SMS lanes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    patientReference: "Patient/synthetic-1",
    smsOptedOut: true,
    remainingOptOuts: { global: false, numbers: ["+18485550123"] },
    smsLanes: [{
      label: "Front-desk texts",
      number: "+18645550100",
      roles: ["transactional-sms", "marketing-sms"],
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SmsOptOutControl patientReference="Patient/synthetic-1" />);
      await Promise.resolve();
    });
    const text = renderer.root.findAll(() => true).flatMap((node) =>
      node.children.filter((child): child is string => typeof child === "string"),
    ).join(" ");
    assert.match(text, /Front-desk texts\s+—\s+OK/);
    assert.match(text, /SMS number\s+\+18485550123\s+—\s+opted out \(STOP\)/);
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
