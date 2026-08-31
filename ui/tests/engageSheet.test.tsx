import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Patient, RelatedPerson } from "@medplum/fhirtypes";
import React from "react";
import { act, create } from "react-test-renderer";
import { EngageSheet, type EngageSheetApi } from "../src/components/comms/EngageSheet";
import {
  dispatchEducation,
  listEducation,
  type EducationContentItem,
  type EducationDispatchInput,
} from "../src/lib/communications-client";
import { CONSENT_AUTHORITY_EXTENSION_URL, RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL } from "../src/lib/patient-identity";

const PATIENT: Patient = {
  resourceType: "Patient",
  id: "patient-1",
  name: [{ given: ["Ella"], family: "Jenkins" }],
  birthDate: "2012-04-03",
  telecom: [
    { system: "phone", value: "+18645550101" },
    { system: "email", value: "ella@example.test" },
  ],
};

const GUARDIANS: RelatedPerson[] = [
  guardian("guardian-1", "Sarah", "mother", "+18645550111", true),
  guardian("guardian-2", "Alex", "father", "+18645550112", false),
];

const ITEMS: EducationContentItem[] = [
  {
    id: "dry-eye-basics",
    version: 2,
    title: "Understanding dry eye",
    kind: "video",
    audience: "patient",
    dxCodes: ["H04.123"],
    channels: ["sms", "email"],
    laneHint: "clinical",
    consentClass: "transactional",
    urls: {
      web: "https://education.invalid/dry-eye-basics/v2",
      email: "https://education.invalid/dry-eye-basics/v2/email",
    },
  },
  {
    id: "dry-eye-treatment-options",
    version: 1,
    title: "Dry eye treatment options",
    kind: "handout",
    audience: "patient",
    dxCodes: ["H04.123"],
    channels: ["sms", "email"],
    laneHint: "retail",
    consentClass: "marketing",
    urls: {
      web: "https://education.invalid/dry-eye-treatment-options/v1",
      email: "https://education.invalid/dry-eye-treatment-options/v1/email",
    },
  },
  {
    id: "retail-home-care",
    version: 1,
    title: "Home care guide",
    kind: "handout",
    audience: "patient",
    dxCodes: [],
    channels: ["sms", "print"],
    laneHint: "retail",
    consentClass: "transactional",
    urls: {
      web: "https://education.invalid/retail-home-care/v1",
      print: "https://education.invalid/retail-home-care/v1/print",
    },
  },
];

test("diagnosis Engage prefilters content, names guardian recipients, blocks marketing, and warns on a front-desk override", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = unsuppressedSmsFetch;
  const listCalls: Array<{ dxCode?: string; channel?: string }> = [];
  const dispatches: EducationDispatchInput[] = [];
  const api: EngageSheetApi = {
    async listEducation(query) {
      listCalls.push(query);
      return ITEMS;
    },
    async dispatchEducation(input) {
      dispatches.push(input);
      return { outcome: "sent", providerMessageId: "SM-education" };
    },
    async listConsentGuardians() {
      return GUARDIANS;
    },
  };

  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <EngageSheet
          open
          patient={PATIENT}
          encounterReference="Encounter/encounter-1"
          diagnosis={{ reference: "Condition/condition-1", code: "H04.123", display: "Dry eye syndrome" }}
          onClose={() => undefined}
          api={api}
          chartDispatchLane="staff_switchable"
          idempotencyKeyFactory={() => "education-ui-0001"}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.deepEqual(listCalls, [{ dxCode: "H04.123" }]);
    let text = renderedText(renderer);
    assert.match(text, /Engage — Ella Jenkins/);
    assert.match(text, /For: Dry eye syndrome \(H04\.123\)/);
    assert.match(text, /Sarah Jenkins · mother/);
    assert.match(text, /Alex Jenkins · father/);
    assert.match(text, /Marketing consent not on file/);
    const marketingSms = renderer.root.findByProps({ "aria-label": "Text Dry eye treatment options" });
    assert.equal(marketingSms.props.disabled, true);

    act(() => renderer.root.findByProps({ "aria-label": "Text Understanding dry eye" }).props.onClick());
    const lane = renderer.root.findByProps({ "aria-label": "Send via lane" });
    assert.equal(lane.props.value, "clinical");
    act(() => lane.props.onChange({ target: { value: "frontdesk" } }));
    text = renderedText(renderer);
    assert.match(text, /Front-desk lane is not BAA-covered; this content is tied to a diagnosis/);

    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Confirm education send" }).props.onClick();
      await Promise.resolve();
    });
    assert.equal(dispatches.length, 1);
    assert.deepEqual(dispatches[0], {
      patientReference: "Patient/patient-1",
      educationId: "dry-eye-basics",
      version: 2,
      channel: "sms",
      lane: "frontdesk",
      recipientOverride: {
        reference: "RelatedPerson/guardian-1",
        phone: "+18645550111",
      },
      alsoUpdateChart: false,
      encounterReference: "Encounter/encounter-1",
      conditionReference: "Condition/condition-1",
      idempotencyKey: "education-ui-0001",
    });
    act(() => renderer.unmount());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("toolbar Engage stays unfiltered and a locked practice pins retail content to clinical without a toggle", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = unsuppressedSmsFetch;
  const listCalls: Array<{ dxCode?: string; channel?: string }> = [];
  const dispatches: EducationDispatchInput[] = [];
  const api: EngageSheetApi = {
    async listEducation(query) {
      listCalls.push(query);
      return [ITEMS[2]!];
    },
    async dispatchEducation(input) {
      dispatches.push(input);
      return { outcome: "sent", providerMessageId: "SM-locked" };
    },
    async listConsentGuardians() {
      return [];
    },
  };

  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <EngageSheet
          open
          patient={{ ...PATIENT, birthDate: "1980-04-03" }}
          encounterReference="Encounter/encounter-1"
          onClose={() => undefined}
          api={api}
          chartDispatchLane="locked_clinical"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(listCalls, [{}]);
    assert.equal(renderer.root.findAllByProps({ "aria-label": "Send via lane" }).length, 0);
    assert.doesNotMatch(renderedText(renderer), /For:/);
    act(() => renderer.root.findByProps({ "aria-label": "Text Home care guide" }).props.onClick());
    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Confirm education send" }).props.onClick();
      await Promise.resolve();
    });
    assert.equal(dispatches[0]?.lane, "clinical");
    act(() => renderer.unmount());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the chart exposes both diagnosis-row and toolbar doors to the same Engage sheet", () => {
  const assessment = readFileSync(new URL("../src/components/charting/AssessmentSection.tsx", import.meta.url), "utf8");
  const chart = readFileSync(new URL("../src/scenes/EncounterCharting.tsx", import.meta.url), "utf8");
  assert.match(assessment, /onEngageDiagnosis/);
  assert.match(assessment, /aria-label={`Engage \$\{displayCode\(condition\.code\)\}`}/);
  assert.match(chart, /aria-label="Engage patient"/);
  assert.match(chart, /<EngageSheet/);
  assert.match(chart, /diagnosis={engageDiagnosis}/);
});

test("the shared communications client lists filtered education and posts the exact dispatch body", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    return calls.length === 1
      ? new Response(JSON.stringify({ items: [ITEMS[0]] }), { status: 200 })
      : new Response(JSON.stringify({ outcome: "sent", providerMessageId: "SM-client" }), { status: 200 });
  };
  const listed = await listEducation({ dxCode: "H04.123", channel: "sms" }, fetchImpl);
  const input: EducationDispatchInput = {
    patientReference: "Patient/patient-1",
    educationId: "dry-eye-basics",
    version: 2,
    channel: "sms",
    lane: "clinical",
    alsoUpdateChart: false,
    idempotencyKey: "education-client-0001",
  };
  const result = await dispatchEducation(input, fetchImpl);
  assert.equal(listed[0]?.id, "dry-eye-basics");
  assert.deepEqual(result, { outcome: "sent", providerMessageId: "SM-client" });
  assert.deepEqual(calls, [
    { url: "/communications/education?dxCode=H04.123&channel=sms", method: "GET" },
    { url: "/communications/education/dispatch", method: "POST", body: input },
  ]);
});

test("a minor without a recorded consent-authority guardian cannot dispatch education", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = unsuppressedSmsFetch;
  const api: EngageSheetApi = {
    async listEducation() { return [ITEMS[0]!]; },
    async dispatchEducation() { return { outcome: "sent", providerMessageId: "should-not-send" }; },
    async listConsentGuardians() { return []; },
  };
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<EngageSheet open patient={PATIENT} onClose={() => undefined} api={api} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(renderedText(renderer), /No current consent-authority guardian is recorded/);
    assert.equal(renderer.root.findByProps({ "aria-label": "Text Understanding dry eye" }).props.disabled, true);
    act(() => renderer.unmount());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a suppressed default SMS lane disables Text before compose and names the suppression", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    patientReference: "Patient/patient-1",
    smsOptedOut: true,
    remainingOptOuts: { global: false, numbers: ["+18485550100"] },
    smsLanes: [{ label: "Clinical texts", number: "+18485550100", roles: ["clinical-sms"] }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  const api: EngageSheetApi = {
    async listEducation() { return [ITEMS[0]!]; },
    async dispatchEducation() { return { outcome: "sent", providerMessageId: "should-not-send" }; },
    async listConsentGuardians() { return []; },
  };
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<EngageSheet open patient={{ ...PATIENT, birthDate: "1980-04-03" }} onClose={() => undefined} api={api} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(renderer.root.findByProps({ "aria-label": "Text Understanding dry eye" }).props.disabled, true);
    assert.match(renderedText(renderer), /Texting is suppressed on this item’s default lane/);
    act(() => renderer.unmount());

    globalThis.fetch = async () => new Response(JSON.stringify({
      patientReference: "Patient/patient-1",
      smsOptedOut: true,
      remainingOptOuts: { global: false, numbers: ["+18645550100"] },
      smsLanes: [
        { label: "Clinical texts", number: "+18485550100", roles: ["clinical-sms"] },
        { label: "Front-desk texts", number: "+18645550100", roles: ["transactional-sms"] },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    await act(async () => {
      renderer = create(<EngageSheet open patient={{ ...PATIENT, birthDate: "1980-04-03" }} onClose={() => undefined} api={api} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const textButton = renderer.root.findByProps({ "aria-label": "Text Understanding dry eye" });
    assert.equal(textButton.props.disabled, false);
    act(() => textButton.props.onClick());
    act(() => renderer.root.findByProps({ "aria-label": "Send via lane" }).props.onChange({ target: { value: "frontdesk" } }));
    assert.equal(renderer.root.findByProps({ "aria-label": "Confirm education send" }).props.disabled, true);
    assert.match(renderedText(renderer), /Texting is suppressed on the selected lane/);
    act(() => renderer.unmount());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unavailable SMS preference response keeps Engage mounted and Text fail closed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ definitions: [], images: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  const api: EngageSheetApi = {
    async listEducation() { return [ITEMS[0]!]; },
    async dispatchEducation() { return { outcome: "sent", providerMessageId: "should-not-send" }; },
    async listConsentGuardians() { return []; },
  };
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<EngageSheet open patient={{ ...PATIENT, birthDate: "1980-04-03" }} onClose={() => undefined} api={api} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(renderedText(renderer), /Engage — Ella Jenkins/);
    assert.match(renderedText(renderer), /SMS availability is loading or unavailable/);
    assert.equal(renderer.root.findByProps({ "aria-label": "Text Understanding dry eye" }).props.disabled, true);
    act(() => renderer.unmount());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function guardian(
  id: string,
  given: string,
  relationship: string,
  phone: string,
  primary: boolean,
): RelatedPerson {
  return {
    resourceType: "RelatedPerson",
    id,
    active: true,
    patient: { reference: "Patient/patient-1" },
    relationship: [{ coding: [{ code: relationship, display: relationship }] }],
    name: [{ given: [given], family: "Jenkins" }],
    telecom: [{ system: "phone", value: phone }],
    extension: [
      { url: CONSENT_AUTHORITY_EXTENSION_URL, valueBoolean: true },
      { url: RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL, valueBoolean: primary },
    ],
  };
}

function renderedText(renderer: ReturnType<typeof create>): string {
  return renderer.root.findAll(() => true).flatMap((node) =>
    node.children.filter((child): child is string => typeof child === "string"),
  ).join(" ");
}

async function unsuppressedSmsFetch(): Promise<Response> {
  return new Response(JSON.stringify({
    patientReference: "Patient/patient-1",
    smsOptedOut: false,
    remainingOptOuts: { global: false, numbers: [] },
    smsLanes: [
      { label: "Clinical texts", number: "+18485550100", roles: ["clinical-sms"] },
      { label: "Front-desk texts", number: "+18645550100", roles: ["transactional-sms", "marketing-sms"] },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}
