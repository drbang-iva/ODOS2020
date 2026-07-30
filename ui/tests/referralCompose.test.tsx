import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ServiceRequest } from "@medplum/fhirtypes";
import {
  ReferralCompose,
  consultantChangeAction,
} from "../src/components/referral/ReferralCompose";
import {
  REFERRAL_LETTER_BODY_EXTENSION_URL,
  ReferralConflictError,
  createReferralApi,
  readReferralLetterBody,
  type ReferralApi,
  type ReferralDraftUpdate,
  type ReferralIncludeList,
} from "../src/components/referral/referral-api";

const INCLUDE_LIST: ReferralIncludeList = {
  letter: true,
  demographics: true,
  history: true,
  clinical_summary: false,
  images: false,
  hipaa_cover_sheet: false,
  history_count: 2,
};

test("the compose surface presents the locked clinical rail and honest transport controls", () => {
  const html = renderToStaticMarkup(
    <ReferralCompose
      patientReference="Patient/p1"
      encounterReference="Encounter/e1"
      onClose={() => undefined}
      api={apiStub()}
      loadContext={async () => ({ doctorDisplay: "Dr. Rivera", findingCount: 3, hasPlan: true })}
    />,
  );

  for (const label of [
    "Consultant",
    "Reason &amp; urgency",
    "Letter",
    "Packet contents",
    "Send",
    "The Packet",
  ]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /Routine|routine/);
  assert.match(html, /Urgent|urgent/);
  assert.match(html, /Stat|stat/);
  assert.match(html, />Fax<\/button>/);
  assert.doesNotMatch(html, /Fax · soon/);
  assert.match(html, /Sending records a disclosure/);
  assert.match(html, /Return to chart/);
  assert.match(html, /role="group" aria-label="Referral packet contents"/);
  assert.match(html, /aria-pressed="true"[^>]*>Referral letter/);
  assert.match(html, /aria-pressed="false"[^>]*>Clinical summary/);
    assert.match(html, /role="combobox" aria-label="Prior finalized exam history count"/);
    assert.match(html, /aria-label="Prior finalized exam history count wheel"/);
});

test("consultant changes regenerate untouched letters but protect clinician edits", () => {
  assert.equal(consultantChangeAction(false), "regenerate");
  assert.equal(consultantChangeAction(true), "warn");
});

test("the packet preview is a sandboxed srcDoc iframe and never joins artifact HTML to the app DOM", () => {
  const source = readFileSync(
    new URL("../src/components/referral/ReferralCompose.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /<iframe[\s\S]*sandbox="allow-modals"[\s\S]*srcDoc=\{artifact\}/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  assert.match(source, /Consultant changed — this letter may still address the previous consultant/);
  assert.match(source, /Regenerate this letter and discard your edits/);
});

test("the assessment disposition exposes the referral compose screen from the live encounter", () => {
  const assessment = readFileSync(
    new URL("../src/components/charting/AssessmentSection.tsx", import.meta.url),
    "utf8",
  );
  const encounter = readFileSync(
    new URL("../src/scenes/EncounterCharting.tsx", import.meta.url),
    "utf8",
  );
  assert.match(assessment, /onRefer\?\(\)|onRefer/);
  assert.match(assessment, /Refer to…/);
  assert.match(encounter, /<ReferralCompose/);
  assert.match(encounter, /onRefer=\{\(\) => setReferralComposeOpen\(true\)\}/);
});

test("Vite proxies the server-owned fax boundary to MCP", () => {
  const viteConfig = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.ok(viteConfig.includes('"/fax": { target: mcpTarget, changeOrigin: true }'));
});

test("the referral API uses the directory, mutation, artifact, and fax contracts", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown; headers?: HeadersInit }> = [];
  const serviceRequest = referral();
  const api = createReferralApi(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      ...(init?.headers ? { headers: init.headers } : {}),
    });
    const body = url.endsWith("/status")
      ? { fax: { reference: "DocumentReference/f1", status: "Sent" } }
      : url.startsWith("/fax/referrals/")
        ? { fax: { reference: "DocumentReference/f1", status: "Pending" } }
        : url.endsWith("/defaults")
      ? { includeList: INCLUDE_LIST }
      : url.includes("/consultants")
        ? { consultants: [{ reference: "Organization/o1", display: "Retina Group" }] }
        : url.endsWith("/preview") || url.endsWith("/send")
          ? { serviceRequestReference: "ServiceRequest/r1", artifact: "<!doctype html><html></html>" }
          : { serviceRequest };
    return jsonResponse(body);
  });

  await api.loadDefaults();
  await api.saveDefaults(INCLUDE_LIST);
  await api.loadRecentConsultants();
  await api.searchConsultants("retina");
  await api.createReferral({
    patientId: "p1",
    targetReference: "Organization/o1",
    encounterReference: "Encounter/e1",
    includeList: INCLUDE_LIST,
    priority: "urgent",
    reasonText: "  macular change  ",
  });
  await api.updateReferral("p1", "r1", { priority: "stat" });
  await api.updateReferral("p1", "r1", { reasonText: null });
  await api.regenerateReferral("p1", "r1");
  await api.previewReferral("p1", "r1", "Edited preview");
  await api.sendReferral("p1", "r1", "Edited send");
  await api.faxReferral({
    patientId: "p1",
    referralId: "r1",
    destinationNumber: "8645550100",
    documentBase64: Buffer.from("%PDF-synthetic").toString("base64"),
    filename: "referral-r1.pdf",
    billingCode: "r1",
  });
  await api.loadFaxStatus("p1", "r1");

  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ["GET", "/referrals/defaults"],
    ["PUT", "/referrals/defaults"],
    ["GET", "/referrals/consultants/recent"],
    ["GET", "/referrals/consultants?q=retina"],
    ["POST", "/referrals/patients/p1"],
    ["PATCH", "/referrals/patients/p1/r1"],
    ["PATCH", "/referrals/patients/p1/r1"],
    ["POST", "/referrals/patients/p1/r1/regenerate"],
    ["POST", "/referrals/patients/p1/r1/preview"],
    ["POST", "/referrals/patients/p1/r1/send"],
    ["POST", "/fax/referrals/p1/r1"],
    ["GET", "/fax/referrals/p1/r1/status"],
  ]);
  assert.deepEqual(calls[4]?.body, {
    targetReference: "Organization/o1",
    encounterReference: "Encounter/e1",
    includeList: INCLUDE_LIST,
    priority: "urgent",
    reasonText: "macular change",
  });
  assert.deepEqual(calls[5]?.body, { priority: "stat" });
  assert.deepEqual(calls[6]?.body, { reasonText: null });
  assert.deepEqual(calls[8]?.body, { editedLetterBody: "Edited preview" });
  assert.deepEqual(calls[9]?.body, { editedLetterBody: "Edited send" });
  assert.equal((calls[10]?.headers as Record<string, string>)["X-ODOS-Fax-Destination"], "8645550100");
  assert.equal((calls[10]?.headers as Record<string, string>)["X-ODOS-Billing-Code"], "r1");
  assert.equal((calls[10]?.headers as Record<string, string>)["Content-Type"], "application/pdf");
});

test("the referral API turns documented 409 responses into a reopen-required conflict", async () => {
  const api = createReferralApi(async () => jsonResponse({ error: "stale" }, 409));
  await assert.rejects(
    api.updateReferral("p1", "r1", { priority: "urgent" }),
    (error: unknown) => error instanceof ReferralConflictError && error.message === "stale",
  );
});

test("clearing the composed reason sends an explicit null draft update", async () => {
  const originalWindow = globalThis.window;
  const updates: ReferralDraftUpdate[] = [];
  let current = referral();
  const api: ReferralApi = {
    ...apiStub(),
    loadRecentConsultants: async () => [{ reference: "Organization/o1", display: "Retina Group" }],
    createReferral: async () => current,
    updateReferral: async (_patientId, _referralId, input) => {
      updates.push(input);
      current = withDraftUpdate(current, input);
      return current;
    },
  };
  let renderer!: ReactTestRenderer;
  Object.defineProperty(globalThis, "window", { configurable: true, value: immediateTimerWindow() });
  try {
    await act(async () => {
      renderer = create(<ReferralCompose patientReference="Patient/p1" encounterReference="Encounter/e1" onClose={() => undefined} api={api} loadContext={async () => ({ doctorDisplay: "Dr. Rivera", findingCount: 3, hasPlan: true })} />);
      await flushMicrotasks();
    });
    await act(async () => {
      consultantButton(renderer.root).props.onClick();
      await flushMicrotasks();
    });
    const reasonInput = renderer.root.findByProps({ "aria-label": "Referral reason" });
    await act(async () => {
      reasonInput.props.onChange({ target: { value: "Retinal concern" } });
      await flushMicrotasks();
    });
    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Referral reason" }).props.onChange({ target: { value: "" } });
      await flushMicrotasks();
    });
    assert.deepEqual(updates, [
      { reasonText: "Retinal concern" },
      { reasonText: null },
    ]);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("sending freezes composition and ignores previews that finish after the sent artifact", async () => {
  const originalWindow = globalThis.window;
  const preview = deferred<{ serviceRequestReference: string; artifact: string }>();
  const update = deferred<ServiceRequest>();
  const send = deferred<{ serviceRequestReference: string; artifact: string }>();
  const sentPayloads: Array<{ referralId: string; letter: string }> = [];
  let closeCalls = 0;
  let renderer!: ReactTestRenderer;
  const api: ReferralApi = {
    ...apiStub(),
    loadRecentConsultants: async () => [{ reference: "Organization/o1", display: "Retina Group" }],
    createReferral: async () => referral(),
    updateReferral: async () => update.promise,
    previewReferral: async () => preview.promise,
    sendReferral: async (_patientId, referralId, letter) => {
      sentPayloads.push({ referralId, letter });
      return send.promise;
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: immediateTimerWindow() });
  try {
    await act(async () => {
      renderer = create(<ReferralCompose patientReference="Patient/p1" encounterReference="Encounter/e1" onClose={() => { closeCalls += 1; }} api={api} loadContext={async () => ({ doctorDisplay: "Dr. Rivera", findingCount: 3, hasPlan: true })} />);
      await flushMicrotasks();
    });
    await act(async () => {
      consultantButton(renderer.root).props.onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Referral reason" }).props.onChange({ target: { value: "Retinal concern" } });
      renderer.root.findByProps({ "aria-label": "Referral letter" }).props.onChange({ target: { value: "Final clinician letter" } });
    });
    const sendButton = buttonNamed(renderer.root, "Send packet");
    act(() => sendButton.props.onClick());

    const closeButton = buttonNamed(renderer.root, "Return to chart");
    assert.equal(closeButton.props.disabled, true);
    assert.ok(renderer.root.findAllByType("input").every((input) => input.props.disabled));
    assert.equal(renderer.root.findByProps({ "aria-label": "Referral letter" }).props.disabled, true);
    act(() => closeButton.props.onClick());
    assert.equal(closeCalls, 0);

    await act(async () => {
      update.resolve(withDraftUpdate(referral(), { reasonText: "Retinal concern" }));
      await flushMicrotasks();
    });
    assert.deepEqual(sentPayloads, [{ referralId: "r1", letter: "Final clinician letter" }]);

    await act(async () => {
      send.resolve({ serviceRequestReference: "ServiceRequest/r1", artifact: "<html>sent artifact</html>" });
      await flushMicrotasks();
    });
    await act(async () => {
      preview.resolve({ serviceRequestReference: "ServiceRequest/r1", artifact: "<html>late preview</html>" });
      await flushMicrotasks();
    });
    assert.equal(renderer.root.findByType("iframe").props.srcDoc, "<html>sent artifact</html>");
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("Fax sends the combined PDF to the consultant number and renders callback completion", async () => {
  const originalWindow = globalThis.window;
  const faxCalls: Array<{
    destinationNumber: string;
    documentBase64: string;
    billingCode: string;
  }> = [];
  const api: ReferralApi = {
    ...apiStub(),
    loadRecentConsultants: async () => [{
      reference: "Organization/o1",
      display: "Retina Group",
      faxNumber: "8645550100",
    }],
    createReferral: async () => referral(),
    previewReferral: async () => ({
      serviceRequestReference: "ServiceRequest/r1",
      artifact: "<html><body>combined packet</body></html>",
    }),
    faxReferral: async (input) => {
      faxCalls.push(input);
      return { fax: { reference: "DocumentReference/f1", status: "Pending" } };
    },
    loadFaxStatus: async () => ({ reference: "DocumentReference/f1", status: "Sent" }),
  };
  let renderer!: ReactTestRenderer;
  Object.defineProperty(globalThis, "window", { configurable: true, value: immediateTimerWindow() });
  try {
    await act(async () => {
      renderer = create(
        <ReferralCompose
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          onClose={() => undefined}
          api={api}
          createPdf={async () => "JVBERi1zeW50aGV0aWM="}
          loadContext={async () => ({ doctorDisplay: "Dr. Rivera", findingCount: 3, hasPlan: true })}
        />,
      );
      await flushMicrotasks();
    });
    await act(async () => {
      consultantButton(renderer.root).props.onClick();
      await flushMicrotasks();
    });
    const faxButton = buttonNamed(renderer.root, "Fax");
    assert.equal(faxButton.props.disabled, false);
    await act(async () => {
      faxButton.props.onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      buttonNamed(renderer.root, "Fax packet").props.onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    assert.equal(faxCalls.length, 1);
    assert.equal(faxCalls[0]?.destinationNumber, "8645550100");
    assert.equal(faxCalls[0]?.documentBase64, "JVBERi1zeW50aGV0aWM=");
    assert.equal(faxCalls[0]?.billingCode, "r1");
    assert.ok(renderer.root.findAll((node) => node.children.join("") === "✓ Fax sent").length > 0);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("Fax failure surfaces an inline error instead of a false sent state", async () => {
  const originalWindow = globalThis.window;
  const api: ReferralApi = {
    ...apiStub(),
    loadRecentConsultants: async () => [{
      reference: "Organization/o1",
      display: "Retina Group",
      faxNumber: "8645550100",
    }],
    createReferral: async () => referral(),
    previewReferral: async () => ({
      serviceRequestReference: "ServiceRequest/r1",
      artifact: "<html><body>combined packet</body></html>",
    }),
    faxReferral: async () => {
      throw new Error("WestFax rejected the destination number.");
    },
  };
  let renderer!: ReactTestRenderer;
  Object.defineProperty(globalThis, "window", { configurable: true, value: immediateTimerWindow() });
  try {
    await act(async () => {
      renderer = create(
        <ReferralCompose
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          onClose={() => undefined}
          api={api}
          createPdf={async () => "JVBERi1zeW50aGV0aWM="}
          loadContext={async () => ({ doctorDisplay: "Dr. Rivera", findingCount: 3, hasPlan: true })}
        />,
      );
      await flushMicrotasks();
    });
    await act(async () => {
      consultantButton(renderer.root).props.onClick();
      await flushMicrotasks();
      buttonNamed(renderer.root, "Fax").props.onClick();
      await flushMicrotasks();
      buttonNamed(renderer.root, "Fax packet").props.onClick();
      await flushMicrotasks();
    });

    const alert = renderer.root.findByProps({ role: "alert" });
    assert.match(alert.children.join(""), /WestFax rejected the destination number/);
    assert.equal(renderer.root.findAll((node) => node.children.join("") === "✓ Fax sent").length, 0);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("the created ServiceRequest supplies the editable generated letter without another fetch", () => {
  assert.equal(readReferralLetterBody(referral()), "Dear Retina Group,\n\nPlease evaluate this patient.");
});

function referral(): ServiceRequest {
  return {
    resourceType: "ServiceRequest",
    id: "r1",
    meta: { versionId: "1" },
    status: "draft",
    intent: "order",
    code: { text: "Specialist referral" },
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" },
    requester: { reference: "Practitioner/doctor" },
    performer: [{ reference: "Organization/o1", display: "Retina Group" }],
    extension: [{
      url: REFERRAL_LETTER_BODY_EXTENSION_URL,
      valueString: "Dear Retina Group,\n\nPlease evaluate this patient.",
    }],
  };
}

function apiStub(): ReferralApi {
  return {
    loadDefaults: async () => INCLUDE_LIST,
    saveDefaults: async (includeList) => includeList,
    searchConsultants: async () => [],
    loadRecentConsultants: async () => [],
    createReferral: async () => referral(),
    updateReferral: async () => referral(),
    regenerateReferral: async () => referral(),
    previewReferral: async () => ({ serviceRequestReference: "ServiceRequest/r1", artifact: "" }),
    sendReferral: async () => ({ serviceRequestReference: "ServiceRequest/r1", artifact: "" }),
    faxReferral: async () => ({ fax: { reference: "DocumentReference/f1", status: "Pending" } }),
    loadFaxStatus: async () => null,
  };
}

function consultantButton(root: ReactTestInstance): ReactTestInstance {
  const button = root.findAllByType("button").find((candidate) =>
    candidate.findAllByType("span").some((span) => span.children.join("") === "Retina Group"),
  );
  assert.ok(button);
  return button;
}

function buttonNamed(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAllByType("button").find((candidate) => candidate.children.join("") === label);
  assert.ok(button);
  return button;
}

function withDraftUpdate(serviceRequest: ServiceRequest, input: ReferralDraftUpdate): ServiceRequest {
  const updated = { ...serviceRequest };
  if (input.reasonText !== undefined) {
    if (input.reasonText) updated.reasonCode = [{ text: input.reasonText }];
    else delete updated.reasonCode;
  }
  if (input.letterBody !== undefined) {
    updated.extension = [{
      url: REFERRAL_LETTER_BODY_EXTENSION_URL,
      valueString: input.letterBody,
    }];
  }
  return updated;
}

function immediateTimerWindow(): Window & typeof globalThis {
  return {
    setTimeout: (handler: TimerHandler) => {
      queueMicrotask(() => { if (typeof handler === "function") handler(); });
      return 1;
    },
    clearTimeout: () => undefined,
    confirm: () => true,
  } as unknown as Window & typeof globalThis;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
