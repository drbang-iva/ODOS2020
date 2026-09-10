import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patient } from "@medplum/fhirtypes";
import React from "react";
import { act, create } from "react-test-renderer";
import { PatientDemographicsEditor } from "../src/components/patient/PatientDemographicsEditor";
import { SmsOptOutControl } from "../src/components/patient/SmsOptOutControl";
import { SmsOptOutErrorBoundary } from "../src/components/patient/SmsOptOutErrorBoundary";
import { clearSmsOptOut, CommunicationsResponseError } from "../src/lib/communications-client";

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

test("a malformed 200 opt-out response reports a controlled error while the host surface remains mounted", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ definitions: [], images: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <main>
          <h1>Doctor overview host</h1>
          <SmsOptOutControl patientReference="Patient/synthetic-1" />
        </main>,
      );
      await Promise.resolve();
    });
    const text = renderer.root.findAll(() => true).flatMap((node) =>
      node.children.filter((child): child is string => typeof child === "string"),
    ).join(" ");
    assert.match(text, /Doctor overview host/);
    assert.match(text, /SMS preferences unavailable/);
    act(() => renderer.unmount());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("changing an inline lane-suppression callback does not refetch opt-out state", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(JSON.stringify({
      patientReference: "Patient/synthetic-1",
      smsOptedOut: false,
      remainingOptOuts: { global: false, numbers: [] },
      smsLanes: [{
        label: "Clinical texts",
        number: "+18485550100",
        roles: ["clinical-sms"],
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <SmsOptOutControl
          patientReference="Patient/synthetic-1"
          activeLaneRole="clinical-sms"
          onActiveLaneSuppressionChange={() => undefined}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      renderer.update(
        <SmsOptOutControl
          patientReference="Patient/synthetic-1"
          activeLaneRole="clinical-sms"
          onActiveLaneSuppressionChange={() => undefined}
        />,
      );
      await Promise.resolve();
    });
    assert.equal(fetches, 1);
    act(() => renderer.unmount());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a malformed 200 clear response is rejected instead of becoming opt-out state", async () => {
  await assert.rejects(
    () => clearSmsOptOut({
      patientReference: "Patient/synthetic-1",
      reason: "Patient requested texting in person",
      identityVerification: "in-person",
    }, async () => new Response(JSON.stringify({ definitions: [], images: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })),
    (error: unknown) => error instanceof CommunicationsResponseError
      && error.status === 200
      && /unexpected response/i.test(error.message),
  );
});

test("the SMS preferences error boundary keeps its host surface mounted after a render failure", () => {
  const originalError = console.error;
  console.error = () => undefined;
  function ThrowDuringRender(): React.ReactNode {
    throw new Error("Synthetic SMS preferences render failure");
  }
  try {
    const renderer = create(
      <main>
        <h1>Engage recipient host</h1>
        <SmsOptOutErrorBoundary>
          <ThrowDuringRender />
        </SmsOptOutErrorBoundary>
      </main>,
    );
    const text = renderer.root.findAll(() => true).flatMap((node) =>
      node.children.filter((child): child is string => typeof child === "string"),
    ).join(" ");
    assert.match(text, /Engage recipient host/);
    assert.match(text, /SMS text preferences could not load/);
    act(() => renderer.unmount());
  } finally {
    console.error = originalError;
  }
});

test("record opt-out widens an existing lane and re-renders the returned global state", async () => {
  const originalFetch = globalThis.fetch;
  const state = {
    patientReference: "Patient/synthetic-1", smsOptedOut: true,
    remainingOptOuts: { global: false, numbers: ["+18645550100"] },
    smsLanes: [{ label: "Front-desk texts", number: "+18645550100", roles: ["transactional-sms"] }],
  };
  let recordedBody: unknown;
  let notified: unknown;
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") {
      assert.match(String(url), /\/communications\/opt-out\/record$/);
      recordedBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ...state, remainingOptOuts: { ...state.remainingOptOuts, global: true } }));
    }
    return new Response(JSON.stringify(state));
  };
  let renderer!: ReturnType<typeof create>;
  try {
    await act(async () => { renderer = create(<SmsOptOutControl patientReference={state.patientReference} onStateChange={(value) => { notified = value; }} />); });
    const record = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Record opt-out — patient asked…");
    assert.ok(record);
    act(() => record.props.onClick());
    assert.equal(renderer.root.findByProps({ type: "submit" }).props.disabled, true);
    act(() => {
      renderer.root.findByProps({ "aria-label": "Reason for opt-out" }).props.onChange({ target: { value: "Please stop texting" } });
      renderer.root.findByProps({ "aria-label": "Identity verification" }).props.onChange({ target: { value: "in-person" } });
    });
    await act(async () => { await renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    assert.deepEqual(recordedBody, { patientReference: state.patientReference, reason: "Please stop texting", identityVerification: "in-person", scope: "global" });
    assert.equal((notified as typeof state).remainingOptOuts.global, true);
    assert.equal(renderer.root.findAllByType("button").some((button) => button.children.join("") === "Record opt-out — patient asked…"), false);
  } finally { if (renderer) act(() => renderer.unmount()); globalThis.fetch = originalFetch; }
});

test("record opt-out lets staff choose the configured lane and validates the response", async () => {
  const originalFetch = globalThis.fetch;
  let recordedBody: unknown;
  const state = {
    patientReference: "Patient/synthetic-1", smsOptedOut: false,
    remainingOptOuts: { global: false, numbers: [] },
    smsLanes: [
      { label: "Front-desk texts", number: "+18645550100", roles: ["transactional-sms"] },
      { label: "Clinical texts", number: "+18485550100", roles: ["clinical-sms"] },
    ],
  };
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "POST") {
      recordedBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ unexpected: true }));
    }
    return new Response(JSON.stringify(state));
  };
  let renderer!: ReturnType<typeof create>;
  try {
    await act(async () => { renderer = create(<SmsOptOutControl patientReference={state.patientReference} />); });
    const button = renderer.root.findAllByType("button").find((candidate) => candidate.children.join("") === "Record opt-out — patient asked…");
    assert.ok(button);
    act(() => button.props.onClick());
    act(() => renderer.root.findByProps({ "aria-label": "Opt-out scope" }).props.onChange({ target: { value: "per-number" } }));
    act(() => {
      renderer.root.findByProps({ "aria-label": "SMS lane" }).props.onChange({ target: { value: "+18485550100" } });
      renderer.root.findByProps({ "aria-label": "Reason for opt-out" }).props.onChange({ target: { value: "No more texts" } });
      renderer.root.findByProps({ "aria-label": "Identity verification" }).props.onChange({ target: { value: "phone-verified" } });
    });
    await act(async () => { await renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    assert.deepEqual(recordedBody, { patientReference: state.patientReference, reason: "No more texts", identityVerification: "phone-verified", scope: "per-number", number: "+18485550100" });
    assert.match(JSON.stringify(renderer.toJSON()), /SMS preferences unavailable/);
  } finally { if (renderer) act(() => renderer.unmount()); globalThis.fetch = originalFetch; }
});
