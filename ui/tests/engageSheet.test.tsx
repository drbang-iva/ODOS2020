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
      return educationList(ITEMS);
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
      return educationList([ITEMS[2]!], "locked_clinical");
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
  assert.doesNotMatch(chart, /VITE_ODOS_CHART_DISPATCH_LANE/);
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
      ? new Response(JSON.stringify({ items: [ITEMS[0]], chartDispatchLane: "locked_clinical" }), { status: 200 })
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
  const suppressed = await dispatchEducation(input, async () => new Response(JSON.stringify({
    outcome: "suppressed",
    reason: "patient-opt-out",
  }), { status: 200 }));
  assert.equal(listed.items[0]?.id, "dry-eye-basics");
  assert.equal(listed.chartDispatchLane, "locked_clinical");
  assert.deepEqual(result, { outcome: "sent", providerMessageId: "SM-client" });
  assert.deepEqual(suppressed, { outcome: "suppressed", reason: "patient-opt-out" });
  assert.deepEqual(calls, [
    { url: "/communications/education?dxCode=H04.123&channel=sms", method: "GET" },
    { url: "/communications/education/dispatch", method: "POST", body: input },
  ]);
});

test("a minor without a recorded consent-authority guardian cannot dispatch education", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = unsuppressedSmsFetch;
  const api: EngageSheetApi = {
    async listEducation() { return educationList([ITEMS[0]!]); },
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
    async listEducation() { return educationList([ITEMS[0]!]); },
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

test("a provider-shaped 403 preference probe keeps Text available for dispatch enforcement", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Forbidden" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
  const dispatches: EducationDispatchInput[] = [];
  const api: EngageSheetApi = {
    async listEducation() { return educationList([ITEMS[0]!]); },
    async dispatchEducation(input) {
      dispatches.push(input);
      return { outcome: "sent", providerMessageId: "SM-provider" };
    },
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
    assert.match(renderedText(renderer), /SMS preferences could not be read; dispatch will enforce opt-outs/);
    const textButton = renderer.root.findByProps({ "aria-label": "Text Understanding dry eye" });
    assert.equal(textButton.props.disabled, false);
    act(() => textButton.props.onClick());
    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Confirm education send" }).props.onClick();
      await Promise.resolve();
    });
    assert.equal(dispatches.length, 1);
    act(() => renderer.unmount());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("suppressed and rescheduled education outcomes render actionable sentences", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = unsuppressedSmsFetch;
  const outcomes = [
    { outcome: "suppressed", reason: "patient-opt-out" } as const,
    { outcome: "rescheduled", reason: "quiet-hours", rescheduledAt: "2026-08-31T22:00:00.000Z" } as const,
  ];
  const api: EngageSheetApi = {
    async listEducation() { return educationList([ITEMS[0]!]); },
    async dispatchEducation() { return outcomes.shift()!; },
    async listConsentGuardians() { return []; },
  };
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<EngageSheet open patient={{ ...PATIENT, birthDate: "1980-04-03" }} onClose={() => undefined} api={api} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => renderer.root.findByProps({ "aria-label": "Text Understanding dry eye" }).props.onClick());
    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Confirm education send" }).props.onClick();
      await Promise.resolve();
    });
    assert.match(renderedText(renderer), /Texting is blocked — this patient opted out/);
    act(() => renderer.root.findByProps({ "aria-label": "Text Understanding dry eye" }).props.onClick());
    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Confirm education send" }).props.onClick();
      await Promise.resolve();
    });
    assert.match(renderedText(renderer), /Not sent — try after 2026-08-31T22:00:00.000Z/);
    act(() => renderer.unmount());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed confirmation reuses its idempotency key until the send succeeds", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = unsuppressedSmsFetch;
  const keys: string[] = [];
  let attempts = 0;
  const api: EngageSheetApi = {
    async listEducation() { return educationList([ITEMS[0]!]); },
    async dispatchEducation(input) {
      keys.push(input.idempotencyKey);
      attempts += 1;
      if (attempts === 1) throw new Error("Lost response");
      return { outcome: "sent", providerMessageId: "SM-retry" };
    },
    async listConsentGuardians() { return []; },
  };
  let generated = 0;
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<EngageSheet open patient={{ ...PATIENT, birthDate: "1980-04-03" }} onClose={() => undefined} api={api} idempotencyKeyFactory={() => `education-retry-${++generated}`} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => renderer.root.findByProps({ "aria-label": "Text Understanding dry eye" }).props.onClick());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await act(async () => {
        renderer.root.findByProps({ "aria-label": "Confirm education send" }).props.onClick();
        await Promise.resolve();
      });
    }
    assert.deepEqual(keys, ["education-retry-1", "education-retry-1"]);
    act(() => renderer.unmount());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("selecting a second guardian clears and disables a one-person override", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = unsuppressedSmsFetch;
  const dispatches: EducationDispatchInput[] = [];
  const api: EngageSheetApi = {
    async listEducation() { return educationList([ITEMS[0]!]); },
    async dispatchEducation(input) { dispatches.push(input); return { outcome: "sent", providerMessageId: `SM-${dispatches.length}` }; },
    async listConsentGuardians() { return GUARDIANS; },
  };
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<EngageSheet open patient={PATIENT} onClose={() => undefined} api={api} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => renderer.root.findByProps({ "aria-label": "Text Understanding dry eye" }).props.onClick());
    const overrideButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "✎ Override for this send");
    assert.ok(overrideButton);
    act(() => overrideButton.props.onClick());
    act(() => renderer.root.findByProps({ "aria-label": "Recipient override" }).props.onChange({ target: { value: "+18645550177" } }));
    const secondGuardian = renderer.root.findAllByType("input").find((input) => input.props.type === "checkbox" && input.props.checked === false);
    assert.ok(secondGuardian);
    act(() => secondGuardian.props.onChange({ target: { checked: true } }));
    assert.match(renderedText(renderer), /Override is available only when one recipient is selected/);
    assert.equal(overrideButton.props.disabled, true);
    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Confirm education send" }).props.onClick();
      await Promise.resolve();
    });
    assert.deepEqual(dispatches.map((dispatch) => dispatch.recipientOverride?.phone), ["+18645550111", "+18645550112"]);
    act(() => renderer.unmount());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chart update appears only after an override value and print returns a user-clicked link", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = unsuppressedSmsFetch;
  const api: EngageSheetApi = {
    async listEducation() { return educationList([ITEMS[2]!]); },
    async dispatchEducation() { return { outcome: "print", url: "https://education.invalid/retail-home-care/v1/print" }; },
    async listConsentGuardians() { return []; },
  };
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<EngageSheet open patient={{ ...PATIENT, birthDate: "1980-04-03" }} onClose={() => undefined} api={api} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => renderer.root.findByProps({ "aria-label": "Text Home care guide" }).props.onClick());
    assert.equal(textCount(renderer, "Also update chart"), 0);
    const overrideButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "✎ Override for this send");
    assert.ok(overrideButton);
    act(() => overrideButton.props.onClick());
    assert.equal(textCount(renderer, "Also update chart"), 0);
    act(() => renderer.root.findByProps({ "aria-label": "Recipient override" }).props.onChange({ target: { value: "+18645550177" } }));
    assert.equal(textCount(renderer, "Also update chart"), 1);
    const cancel = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Cancel");
    assert.ok(cancel);
    act(() => cancel.props.onClick());
    act(() => renderer.root.findByProps({ "aria-label": "Print Home care guide" }).props.onClick());
    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Confirm education send" }).props.onClick();
      await Promise.resolve();
    });
    const printLink = renderer.root.findByProps({ "aria-label": "Open print artifact" });
    assert.equal(printLink.props.href, "https://education.invalid/retail-home-care/v1/print");
    assert.doesNotMatch(renderedText(renderer), /Print artifact ready/);
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

function textCount(renderer: ReturnType<typeof create>, value: string): number {
  return renderer.root.findAll(() => true).flatMap((node) =>
    node.children.filter((child): child is string => typeof child === "string"),
  ).filter((text) => text === value).length;
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

function educationList(
  items: EducationContentItem[],
  chartDispatchLane: "locked_clinical" | "staff_switchable" = "staff_switchable",
) {
  return { items, chartDispatchLane };
}
