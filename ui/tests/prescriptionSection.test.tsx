import assert from "node:assert/strict";
import { test } from "node:test";
import React, { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { MedicationRequest } from "@medplum/fhirtypes";
import {
  EMPTY_PRESCRIPTION_DRAFT,
  PrescriptionEditor,
  PrescriptionSection,
  type DirectoryResult,
  type FormularyResult,
  type PrescriptionDraft,
  type WenoSearchApi,
  draftFromRequest,
  draftWithPreferredPharmacy,
  formatDate,
  isControlledSubstanceDrug,
  mergeMedicationRequestUpdate,
  withDirectoryResult,
  withDrugText,
} from "../src/components/charting/PrescriptionSection";
import { ConfirmDestructiveProvider } from "../src/components/charting/ConfirmDestructive";
import { CONCURRENT_EDIT_MESSAGE, toError } from "../src/lib/fhir";
import {
  buildMedicationRequest,
  pharmacyFromResource,
  WENO_MESSAGE_ID_IDENTIFIER_SYSTEM,
  withPreferredPharmacy,
  type MedicationOrderPharmacy,
} from "../src/lib/fhir-medication-order";

const NOOP = () => undefined;

test("PrescriptionEditor exposes every prescription field with the specified control shape", () => {
  const html = renderToStaticMarkup(
    <PrescriptionEditor
      draft={EMPTY_PRESCRIPTION_DRAFT}
      conditions={[]}
      onChange={NOOP}
      onSave={NOOP}
    />,
  );

  for (const label of [
    "Formulary",
    "Sig",
    "Quantity",
    "Refills",
    "Days supply",
    "Route",
    "Assessment diagnosis",
    "Indication fallback",
    "Directory ZIP or city",
    "Directory state",
  ]) {
    assert.match(html, new RegExp(`aria-label="${label}"`));
  }
  assert.match(html, /role="combobox"[^>]*aria-label="Refills"/);
  assert.match(html, /role="combobox"[^>]*aria-label="Days supply"/);
  assert.match(html, /data-default="true"[^>]*>30</);
  for (const route of ["Ophthalmic", "Oral", "Topical", "Otic", "Nasal", "Other"]) {
    assert.match(html, new RegExp(`>${route}</button>`));
  }
  assert.match(html, /value="printed"/);
  assert.match(html, /value="phoned-in"/);
  assert.doesNotMatch(html, /Send electronically|electronically-sent/);
  assert.doesNotMatch(html, /role="alert"/);
});

test("a test-populated controlled match shows the banner and forces phoned-in transmission", () => {
  const terms = ["test-controlled"];
  const controlledDraft = withDrugText(EMPTY_PRESCRIPTION_DRAFT, "Test-Controlled 5 mg", terms);
  const html = renderToStaticMarkup(
    <PrescriptionEditor
      draft={controlledDraft}
      conditions={[]}
      controlledSubstanceTerms={terms}
      onChange={NOOP}
      onSave={NOOP}
    />,
  );

  assert.equal(isControlledSubstanceDrug("TEST-CONTROLLED 5 mg", terms), true);
  assert.equal(controlledDraft.transmissionMethod, "phoned-in");
  assert.match(html, /Controlled substance — WENO e-Rx not available for this medication\. Call it in to the pharmacy\./);
  assert.match(html, /value="printed"[^>]*disabled=""|disabled=""[^>]*value="printed"/);
  assert.match(html, /value="phoned-in"[^>]*checked=""|checked=""[^>]*value="phoned-in"/);
});

test("saving an edit preserves an on-hold prescription status, original requester, and original recorder", () => {
  const existing: MedicationRequest = {
    resourceType: "MedicationRequest",
    id: "rx-1",
    status: "on-hold",
    intent: "order",
    subject: { reference: "Patient/patient-1" },
    medicationCodeableConcept: { text: "Original medication" },
    requester: { reference: "Practitioner/original-prescriber" },
    recorder: { reference: "Practitioner/original-keyer" },
  };
  const edited: MedicationRequest = {
    resourceType: "MedicationRequest",
    status: "active",
    intent: "order",
    subject: { reference: "Patient/patient-1" },
    medicationCodeableConcept: { text: "Edited medication" },
    requester: { reference: "Practitioner/current-user" },
    recorder: { reference: "Practitioner/current-user" },
  };

  const update = mergeMedicationRequestUpdate(existing, edited);

  assert.equal(update.medicationCodeableConcept?.text, "Edited medication");
  assert.equal(update.status, "on-hold");
  assert.deepEqual(update.requester, { reference: "Practitioner/original-prescriber" });
  assert.deepEqual(update.recorder, { reference: "Practitioner/original-keyer" });
});

test("PrescriptionSection rejects a stale loaded version with the friendly concurrent-edit message", async () => {
  const originalFetch = globalThis.fetch;
  const updateHeaders: Headers[] = [];
  let saved = 0;
  const request: MedicationRequest = {
    resourceType: "MedicationRequest",
    id: "rx-1",
    meta: { versionId: "7" },
    status: "active",
    intent: "order",
    subject: { reference: "Patient/patient-1" },
    encounter: { reference: "Encounter/encounter-1" },
    medicationCodeableConcept: { text: "Latanoprost" },
    dosageInstruction: [{ text: "1 drop OU nightly" }],
    requester: { reference: "Practitioner/doc-1" },
    authoredOn: "2026-07-24",
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "PUT") {
      updateHeaders.push(new Headers(init.headers));
      return new Response("stale version", {
        status: 412,
        statusText: "Precondition Failed",
      });
    }
    if (url.endsWith("/Encounter/encounter-1")) {
      return jsonResponse({
        resourceType: "Encounter",
        id: "encounter-1",
        status: "in-progress",
        class: {},
        subject: { reference: "Patient/patient-1" },
        participant: [{ individual: { reference: "Practitioner/doc-1" } }],
      });
    }
    if (url.endsWith("/Patient/patient-1")) {
      return jsonResponse({
        resourceType: "Patient",
        id: "patient-1",
        meta: { versionId: "3" },
      });
    }
    if (url.endsWith("/weno/switch/configuration")) {
      return jsonResponse({
        configured: false,
        reason: "WENO Switch is not configured.",
      });
    }
    if (url.includes("/Condition?")) {
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] });
    }
    if (url.includes("/MedicationRequest?")) {
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: request }],
      });
    }
    throw new Error(`Unexpected FHIR request ${url}`);
  };

  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <PrescriptionSection
          patientReference="Patient/patient-1"
          encounterReference="Encounter/encounter-1"
          onSaved={() => { saved += 1; }}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const editButton = renderer.root.findAllByType("button")
      .find((button) => button.children.includes("Edit"));
    assert.ok(editButton);
    act(() => editButton.props.onClick());

    const updateButton = renderer.root.findAllByType("button")
      .find((button) => button.children.includes("Update prescription"));
    assert.ok(updateButton);
    await act(async () => {
      updateButton.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(updateHeaders.length, 1);
    assert.equal(updateHeaders[0]?.get("If-Match"), 'W/"7"');
    assert.equal(saved, 0);
    assert.match(JSON.stringify(renderer.toJSON()), new RegExp(CONCURRENT_EDIT_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    if (renderer) act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("an unconfigured WENO Switch disables the saved-row send action with its reason", async () => {
  const originalFetch = globalThis.fetch;
  const reason = "WENO Switch is not configured. Complete the WENO_SWITCH settings before sending.";
  const request: MedicationRequest = {
    resourceType: "MedicationRequest",
    id: "rx-1",
    status: "active",
    intent: "order",
    subject: { reference: "Patient/patient-1" },
    encounter: { reference: "Encounter/encounter-1" },
    medicationCodeableConcept: { text: "Latanoprost" },
    dosageInstruction: [{ text: "1 drop OU nightly" }],
    requester: { reference: "Practitioner/doc-1" },
    authoredOn: "2026-07-31",
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/Encounter/encounter-1")) {
      return jsonResponse({
        resourceType: "Encounter",
        id: "encounter-1",
        status: "in-progress",
        class: {},
        subject: { reference: "Patient/patient-1" },
        participant: [{ individual: { reference: "Practitioner/doc-1" } }],
      });
    }
    if (url.endsWith("/Patient/patient-1")) {
      return jsonResponse({ resourceType: "Patient", id: "patient-1" });
    }
    if (url.endsWith("/weno/switch/configuration")) {
      return jsonResponse({ configured: false, reason });
    }
    if (url.includes("/Condition?")) {
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] });
    }
    if (url.includes("/MedicationRequest?")) {
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: request }],
      });
    }
    throw new Error(`Unexpected request ${url}`);
  };

  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <PrescriptionSection
          patientReference="Patient/patient-1"
          encounterReference="Encounter/encounter-1"
          onSaved={NOOP}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const send = renderer.root.findAllByType("button")
      .find((button) => button.children.includes("Send to pharmacy"));
    assert.ok(send);
    assert.equal(send.props.disabled, true);
    assert.equal(send.props.title, reason);
    assert.match(JSON.stringify(renderer.toJSON()), new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    if (renderer) act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("an indeterminate WENO send stays blocked until staff clears it after pharmacy verification", async () => {
  const originalFetch = globalThis.fetch;
  const clearRequests: Array<{ url: string; method: string | undefined }> = [];
  const request: MedicationRequest = {
    resourceType: "MedicationRequest",
    id: "rx-1",
    meta: { versionId: "2" },
    status: "active",
    intent: "order",
    subject: { reference: "Patient/patient-1" },
    encounter: { reference: "Encounter/encounter-1" },
    medicationCodeableConcept: { text: "Latanoprost" },
    dosageInstruction: [{ text: "1 drop OU nightly" }],
    requester: { reference: "Practitioner/doc-1" },
    authoredOn: "2026-07-31",
    identifier: [{
      system: WENO_MESSAGE_ID_IDENTIFIER_SYSTEM,
      value: "test-message-id",
    }],
    note: [{
      time: "2026-07-31T12:00:00.000Z",
      text: "WENO Switch outcome unknown test-message-id: Synthetic response timeout",
    }],
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/weno/medication-requests/rx-1/clear-indeterminate-send")) {
      clearRequests.push({ url, method: init?.method });
      return jsonResponse({
        medicationRequest: {
          ...request,
          meta: { versionId: "3" },
          identifier: undefined,
          note: [
            ...(request.note ?? []),
            {
              time: "2026-07-31T12:05:00.000Z",
              text: "WENO Switch outcome-unknown reservation cleared test-message-id by Practitioner/staff-1.",
            },
          ],
        },
        clearedMessageId: "test-message-id",
      });
    }
    if (url.endsWith("/Encounter/encounter-1")) {
      return jsonResponse({
        resourceType: "Encounter",
        id: "encounter-1",
        status: "in-progress",
        class: {},
        subject: { reference: "Patient/patient-1" },
        participant: [{ individual: { reference: "Practitioner/doc-1" } }],
      });
    }
    if (url.endsWith("/Patient/patient-1")) {
      return jsonResponse({ resourceType: "Patient", id: "patient-1" });
    }
    if (url.endsWith("/weno/switch/configuration")) {
      return jsonResponse({ configured: true, reason: "WENO Switch is configured." });
    }
    if (url.includes("/Condition?")) {
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] });
    }
    if (url.includes("/MedicationRequest?")) {
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: request }],
      });
    }
    throw new Error(`Unexpected request ${url}`);
  };

  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <PrescriptionSection
          patientReference="Patient/patient-1"
          encounterReference="Encounter/encounter-1"
          onSaved={NOOP}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(JSON.stringify(renderer.toJSON()), /Delivery outcome unknown/);
    assert.match(JSON.stringify(renderer.toJSON()), /Verify with the pharmacy before resending/);
    assert.match(JSON.stringify(renderer.toJSON()), /Synthetic response timeout/);
    const blockedSend = renderer.root.findAllByType("button")
      .find((button) => button.children.includes("Send to pharmacy"));
    assert.ok(blockedSend);
    assert.equal(blockedSend.props.disabled, true);

    const clear = renderer.root.findAllByType("button")
      .find((button) => button.children.includes("Pharmacy verified not received — clear reservation"));
    assert.ok(clear);
    await act(async () => {
      clear.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(clearRequests.length, 1);
    assert.match(
      clearRequests[0]!.url,
      /\/weno\/medication-requests\/rx-1\/clear-indeterminate-send$/,
    );
    assert.equal(clearRequests[0]!.method, "POST");
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Delivery outcome unknown/);
    assert.match(JSON.stringify(renderer.toJSON()), /reservation cleared after staff verification/);
    const resend = renderer.root.findAllByType("button")
      .find((button) => button.children.includes("Send to pharmacy"));
    assert.ok(resend);
    assert.equal(resend.props.disabled, false);
  } finally {
    if (renderer) act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("the cancel action is hidden when a prescription was never electronically sent", async () => {
  const originalFetch = globalThis.fetch;
  const request = prescriptionRequest();
  globalThis.fetch = prescriptionSectionFetch(request);

  let renderer: ReactTestRenderer | undefined;
  try {
    renderer = await renderPrescriptionSection();
    assert.equal(Boolean(findButton(renderer, "Cancel prescription")), false);
  } finally {
    if (renderer) act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("the cancel action is hidden when an electronically sent prescription is already cancelled", async () => {
  const originalFetch = globalThis.fetch;
  const request = electronicallySentPrescription({ status: "cancelled" });
  globalThis.fetch = prescriptionSectionFetch(request);

  let renderer: ReactTestRenderer | undefined;
  try {
    renderer = await renderPrescriptionSection();
    assert.match(JSON.stringify(renderer.toJSON()), /cancelled/);
    assert.equal(Boolean(findButton(renderer, "Cancel prescription")), false);
  } finally {
    if (renderer) act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a cancelled WENO prescription shows its durable electronic cancellation date", async () => {
  const originalFetch = globalThis.fetch;
  const request = electronicallySentPrescription({
    status: "cancelled",
    note: [{
      time: "2026-08-21T14:15:00.000Z",
      text: "WENO Switch CancelRx completed cancel-message-id by Practitioner/staff-1.",
    }],
  });
  globalThis.fetch = prescriptionSectionFetch(request);

  let renderer: ReactTestRenderer | undefined;
  try {
    renderer = await renderPrescriptionSection();
    const provenance = renderer.root.findAllByProps({
      className: "mt-2 text-xs text-white/45",
    }).find((node) => node.children.join("").startsWith("Cancelled electronically via WENO"));
    assert.ok(provenance);
    assert.equal(
      provenance.children.join(""),
      "Cancelled electronically via WENO on Aug 21, 2026",
    );
  } finally {
    if (renderer) act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a cancelled prescription without WENO completion provenance makes no electronic claim", async () => {
  const originalFetch = globalThis.fetch;
  const request = electronicallySentPrescription({ status: "cancelled" });
  globalThis.fetch = prescriptionSectionFetch(request);

  let renderer: ReactTestRenderer | undefined;
  try {
    renderer = await renderPrescriptionSection();
    assert.doesNotMatch(
      JSON.stringify(renderer.toJSON()),
      /Cancelled electronically via WENO/,
    );
  } finally {
    if (renderer) act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a non-cancelled prescription never shows completed WENO cancellation provenance", async () => {
  const originalFetch = globalThis.fetch;
  const request = electronicallySentPrescription({
    status: "active",
    note: [{
      time: "2026-08-21T14:15:00.000Z",
      text: "WENO Switch CancelRx completed cancel-message-id by Practitioner/staff-1.",
    }],
  });
  globalThis.fetch = prescriptionSectionFetch(request);

  let renderer: ReactTestRenderer | undefined;
  try {
    renderer = await renderPrescriptionSection();
    assert.doesNotMatch(
      JSON.stringify(renderer.toJSON()),
      /Cancelled electronically via WENO/,
    );
  } finally {
    if (renderer) act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("declining cancellation confirmation does not call the WENO cancel route", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const request = electronicallySentPrescription();
  globalThis.fetch = prescriptionSectionFetch(request, async (url, init) => {
    requests.push({ url, method: init?.method });
    return undefined;
  });
  let renderer: ReactTestRenderer | undefined;
  try {
    renderer = await renderPrescriptionSection();
    const cancel = findButton(renderer, "Cancel prescription");
    assert.ok(cancel);
    await act(async () => cancel.props.onClick());
    const dialog = renderer.root.findByProps({ role: "alertdialog" });
    assert.match(JSON.stringify(renderer.toJSON()), /already at the pharmacy/i);
    assert.match(JSON.stringify(renderer.toJSON()), /cannot be undone from ODOS/i);
    await act(async () => findButton(renderer, "Keep")!.props.onClick());
    assert.equal(
      requests.some(({ url }) => url.endsWith("/weno/medication-requests/rx-1/cancel")),
      false,
    );
  } finally {
    if (renderer) act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a successful WENO cancellation updates the row and shows status feedback", async () => {
  const originalFetch = globalThis.fetch;
  const cancelRequests: Array<{ url: string; method: string | undefined }> = [];
  const request = electronicallySentPrescription();
  const cancelled = { ...request, status: "cancelled" as const };
  globalThis.fetch = prescriptionSectionFetch(request, async (url, init) => {
    if (!url.endsWith("/weno/medication-requests/rx-1/cancel")) return undefined;
    cancelRequests.push({ url, method: init?.method });
    return jsonResponse({
      result: { kind: "status", code: "000", description: "Cancellation accepted" },
      medicationRequest: cancelled,
      resendable: false,
    });
  });
  let renderer: ReactTestRenderer | undefined;
  try {
    renderer = await renderPrescriptionSection();
    const cancel = findButton(renderer, "Cancel prescription");
    assert.ok(cancel);
    await act(async () => {
      cancel.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      findButton(renderer!, "Continue")!.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(cancelRequests, [{
      url: "/weno/medication-requests/rx-1/cancel",
      method: "POST",
    }]);
    assert.match(JSON.stringify(renderer.toJSON()), /cancelled/);
    assert.match(JSON.stringify(renderer.toJSON()), /WENO Cancellation Status 000: Cancellation accepted/);
    assert.equal(findButton(renderer, "Cancel prescription"), undefined);
  } finally {
    if (renderer) act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("an unknown WENO cancellation outcome renders the cancellation reservation panel", async () => {
  const originalFetch = globalThis.fetch;
  const request = electronicallySentPrescription();
  globalThis.fetch = prescriptionSectionFetch(request, async (url) => {
    if (!url.endsWith("/weno/medication-requests/rx-1/cancel")) return undefined;
    return jsonResponse({
      result: {
        kind: "unknown",
        messageId: "cancel-message-id",
        description: "Synthetic transport timeout",
      },
      medicationRequest: {
        ...request,
        identifier: [
          ...(request.identifier ?? []),
          {
            system: "https://odos2020.com/fhir/sid/weno-switch-cancel-message-id",
            value: "cancel-message-id",
          },
        ],
      },
      resendable: false,
    });
  });
  let renderer: ReactTestRenderer | undefined;
  try {
    renderer = await renderPrescriptionSection();
    const cancel = findButton(renderer, "Cancel prescription");
    assert.ok(cancel);
    await act(async () => {
      cancel.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      findButton(renderer!, "Continue")!.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const rendered = JSON.stringify(renderer.toJSON());
    assert.match(rendered, /Cancellation outcome unknown/);
    assert.match(rendered, /WENO did not confirm whether the pharmacy received the cancellation/);
    assert.match(rendered, /Verify with the pharmacy before retrying/);
    assert.ok(findButton(renderer, "Pharmacy verified — clear cancellation reservation"));
  } finally {
    if (renderer) act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("clearing an indeterminate cancellation calls the cancel clear route and re-enables cancelling", async () => {
  const originalFetch = globalThis.fetch;
  const clearRequests: Array<{ url: string; method: string | undefined }> = [];
  const request = electronicallySentPrescription({
    identifier: [
      {
        system: WENO_MESSAGE_ID_IDENTIFIER_SYSTEM,
        value: "new-rx-message-id",
      },
      {
        system: "https://odos2020.com/fhir/sid/weno-switch-cancel-message-id",
        value: "cancel-message-id",
      },
    ],
  });
  globalThis.fetch = prescriptionSectionFetch(request, async (url, init) => {
    if (!url.endsWith("/weno/medication-requests/rx-1/clear-indeterminate-cancel")) {
      return undefined;
    }
    clearRequests.push({ url, method: init?.method });
    return jsonResponse({
      medicationRequest: electronicallySentPrescription(),
      clearedMessageId: "cancel-message-id",
    });
  });

  let renderer: ReactTestRenderer | undefined;
  try {
    renderer = await renderPrescriptionSection();
    const blockedCancel = findButton(renderer, "Cancel prescription");
    assert.ok(blockedCancel);
    assert.equal(blockedCancel.props.disabled, true);
    const clear = findButton(renderer, "Pharmacy verified — clear cancellation reservation");
    assert.ok(clear);
    await act(async () => {
      clear.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(clearRequests, [{
      url: "/weno/medication-requests/rx-1/clear-indeterminate-cancel",
      method: "POST",
    }]);
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Cancellation outcome unknown/);
    const enabledCancel = findButton(renderer, "Cancel prescription");
    assert.ok(enabledCancel);
    assert.equal(enabledCancel.props.disabled, false);
  } finally {
    if (renderer) act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("FHIR conflict conversion only humanizes explicitly versioned writes", async () => {
  const versionedError = await toError(new Response("conflict", {
    status: 409,
    statusText: "Conflict",
  }), true);
  const unversionedError = await toError(new Response("conditional create conflict", {
    status: 409,
    statusText: "Conflict",
  }));

  assert.equal(versionedError.message, CONCURRENT_EDIT_MESSAGE);
  assert.equal(unversionedError.message, "FHIR 409 Conflict: conditional create conflict");
});

test("formatDate safely renders malformed and absent authoredOn values", () => {
  assert.equal(formatDate("not-a-date"), "not-a-date");
  assert.equal(formatDate(undefined), "Date unknown");
});

test("a Formulary query becomes free text only through the explicit create action", async () => {
  let latestDraft = EMPTY_PRESCRIPTION_DRAFT;
  const html = renderToStaticMarkup(
    <PrescriptionEditor
      draft={EMPTY_PRESCRIPTION_DRAFT}
      conditions={[]}
      onChange={(draft) => { latestDraft = draft; }}
      onSave={NOOP}
    />,
  );
  assert.match(html, /aria-label="Formulary"/);

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <Harness />,
    );
  });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Formulary" }).props.onChange({ target: { value: "Custom compound" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.equal(latestDraft.drug, "");
  const createButton = renderer!.root.findAllByType("button")
    .find((button) => button.children.join("").includes("Use as written"));
  assert.ok(createButton);
  await act(async () => { await createButton.props.onClick(); });
  assert.equal(latestDraft.drug, "Custom compound");
  assert.equal(latestDraft.drugDbCode, undefined);
  assert.equal(latestDraft.drugDbCodeQualifier, undefined);
  assert.equal(latestDraft.quantityUnitOfMeasureCode, undefined);
  act(() => renderer!.unmount());

  function Harness() {
    const [draft, setDraft] = useState(EMPTY_PRESCRIPTION_DRAFT);
    return <PrescriptionEditor draft={draft} conditions={[]} searchApi={searchApiStub()} formularyDebounceMs={0} onChange={(next) => { latestDraft = next; setDraft(next); }} onSave={NOOP} />;
  }
});

test("selecting a Formulary result stores coded fields and later text edits clear them", async () => {
  const result = formularyResult();
  let latestDraft = EMPTY_PRESCRIPTION_DRAFT;
  let renderer: ReactTestRenderer;
  let searchStarted!: () => void;
  const searchStartedPromise = new Promise<void>((resolve) => { searchStarted = resolve; });
  const searchApi = searchApiStub({
    formulary: async () => {
      searchStarted();
      return [result];
    },
  });

  function Harness() {
    const [draft, setDraft] = useState(EMPTY_PRESCRIPTION_DRAFT);
    return (
      <PrescriptionEditor
        draft={draft}
        conditions={[]}
        searchApi={searchApi}
        formularyDebounceMs={0}
        onChange={(next) => { latestDraft = next; setDraft(next); }}
        onSave={NOOP}
      />
    );
  }

  await act(async () => { renderer = create(<Harness />); });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Formulary" }).props.onChange({ target: { value: "lata" } });
    await searchStartedPromise;
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await act(async () => {
    renderer!.root.findAllByProps({ role: "option" }).find((option) =>
      option.findAllByType("span").some((span) => span.children.join("") === result.psnDescription)
    )!.props.onClick();
  });
  assert.equal(latestDraft.drugDbCode, result.drugDbCode);
  assert.equal(latestDraft.route, result.route);
  assert.match(JSON.stringify(renderer!.toJSON()), /Coded — from WENO drug database/);

  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Formulary" }).props.onChange({ target: { value: `${result.psnDescription} edited` } });
  });
  assert.equal(latestDraft.drug, "");
  assert.equal(latestDraft.drugDbCode, undefined);
  assert.doesNotMatch(JSON.stringify(renderer!.toJSON()), /Coded — from WENO drug database/);
  await act(async () => renderer!.unmount());
});

test("the Directory waits for both place and state before firing a search", async () => {
  let calls = 0;
  const searchApi = searchApiStub({
    directory: async () => { calls += 1; return [directoryResult()]; },
  });
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <PrescriptionEditor
        draft={EMPTY_PRESCRIPTION_DRAFT}
        conditions={[]}
        searchApi={searchApi}
        onChange={NOOP}
        onSave={NOOP}
      />,
    );
  });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Directory ZIP or city" }).props.onChange({ target: { value: "29646" } });
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  assert.equal(calls, 0);
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Directory state" }).props.onChange({ target: { value: "sc" } });
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  assert.equal(calls, 1);
  await act(async () => renderer!.unmount());
});

test("changing Directory criteria invalidates a stale response", async () => {
  let resolveSearch!: (results: DirectoryResult[]) => void;
  const pending = new Promise<DirectoryResult[]>((resolve) => { resolveSearch = resolve; });
  const searchApi = searchApiStub({ directory: async () => pending });
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <PrescriptionEditor
        draft={EMPTY_PRESCRIPTION_DRAFT}
        conditions={[]}
        searchApi={searchApi}
        onChange={NOOP}
        onSave={NOOP}
      />,
    );
  });
  const state = renderer!.root.findByProps({ "aria-label": "Directory state" });
  await act(async () => {
    state.props.onChange({ target: { value: "SC" } });
    renderer!.root.findByProps({ "aria-label": "Directory ZIP or city" }).props.onChange({ target: { value: "29646" } });
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Directory ZIP or city" }).props.onChange({ target: { value: "29649" } });
  });
  await act(async () => { resolveSearch([directoryResult()]); await pending; });
  assert.doesNotMatch(JSON.stringify(renderer!.toJSON()), /Greenwood Pharmacy/);
  await act(async () => renderer!.unmount());
});

test("MedicationRequest readback restores WENO fields only as a complete group", () => {
  const request: MedicationRequest = {
    resourceType: "MedicationRequest",
    status: "active",
    intent: "order",
    subject: { reference: "Patient/patient-1" },
    medicationCodeableConcept: {
      text: "Latanoprost 0.005% ophthalmic solution",
      coding: [{
        system: "http://www.nlm.nih.gov/research/umls/rxnorm",
        code: "196502",
        extension: [{
          url: "https://odos2020.com/fhir/StructureDefinition/odos-weno-drug-db-code-qualifier",
          valueCode: "SCD",
        }],
      }],
    },
  };
  assert.equal(draftFromRequest(request).drugDbCode, undefined);

  request.medicationCodeableConcept!.coding!.push({
    system: "http://www.nlm.nih.gov/research/umls/rxnorm",
    code: "196502",
    extension: [
      {
        url: "https://odos2020.com/fhir/StructureDefinition/odos-weno-drug-db-code-qualifier",
        valueCode: "SCD",
      },
      {
        url: "https://odos2020.com/fhir/StructureDefinition/odos-weno-quantity-unit-of-measure-code",
        valueCode: "C48542",
      },
    ],
  });
  assert.deepEqual(
    {
      drugDbCode: draftFromRequest(request).drugDbCode,
      drugDbCodeQualifier: draftFromRequest(request).drugDbCodeQualifier,
      quantityUnitOfMeasureCode: draftFromRequest(request).quantityUnitOfMeasureCode,
    },
    {
      drugDbCode: "196502",
      drugDbCodeQualifier: "SCD",
      quantityUnitOfMeasureCode: "C48542",
    },
  );
});

test("preferred pharmacy round trip defaults a new prescription without locking its snapshot", () => {
  const preferred: MedicationOrderPharmacy = {
    ncpdpId: "4222222",
    npi: "1234567893",
    name: "Preferred Pharmacy",
    addressLine1: "123 Main Street",
    city: "Greenwood",
    state: "SC",
    postalCode: "29646",
    phone: "8645550100",
  };
  const patient = withPreferredPharmacy({
    resourceType: "Patient",
    id: "patient-1",
  }, preferred);
  const prefilled = draftWithPreferredPharmacy(
    EMPTY_PRESCRIPTION_DRAFT,
    pharmacyFromResource(patient),
  );
  assert.equal(prefilled.pharmacyNcpdpId, preferred.ncpdpId);

  const overrideResult: DirectoryResult = {
    ncpdpId: "4333333",
    npi: "1098765432",
    businessName: "Override Pharmacy",
    addressLine1: "456 Oak Avenue",
    addressLine2: "Suite 2",
    city: "Abbeville",
    state: "SC",
    zip: "29620",
    phone: "8645550200",
    onWeno: true,
  };
  const overridden = withDirectoryResult(prefilled, overrideResult);
  assert.equal(overridden.pharmacyNcpdpId, overrideResult.ncpdpId);
  assert.equal(pharmacyFromResource(patient)?.ncpdpId, preferred.ncpdpId);

  const request = buildMedicationRequest({
    patientReference: "Patient/patient-1",
    practitionerReference: "Practitioner/prescriber-1",
    encounterReference: "Encounter/encounter-1",
    medicationText: "Latanoprost",
    dosageText: "One drop nightly",
    pharmacy: overridden.pharmacyDetails,
    transmissionMethod: "printed",
  });
  assert.deepEqual(pharmacyFromResource(request), overridden.pharmacyDetails);
  assert.equal(
    request.dispenseRequest?.performer?.identifier?.value,
    overrideResult.ncpdpId,
  );
});

test("a failed Formulary search keeps the query but blocks free-text creation on uncertainty", async () => {
  let latestDraft = EMPTY_PRESCRIPTION_DRAFT;
  let renderer: ReactTestRenderer;
  const searchApi = searchApiStub({ formulary: async () => { throw new Error("offline"); } });
  function Harness() {
    const [draft, setDraft] = useState(EMPTY_PRESCRIPTION_DRAFT);
    return <PrescriptionEditor draft={draft} conditions={[]} searchApi={searchApi} formularyDebounceMs={0} onChange={(next) => { latestDraft = next; setDraft(next); }} onSave={NOOP} />;
  }
  await act(async () => { renderer = create(<Harness />); });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Formulary" }).props.onChange({ target: { value: "Unlisted medication" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.equal(renderer!.root.findByProps({ "aria-label": "Formulary" }).props.value, "Unlisted medication");
  assert.equal(latestDraft.drug, "");
  assert.match(JSON.stringify(renderer!.toJSON()), /offline/);
  const createButton = renderer!.root.findAllByType("button")
    .find((button) => button.children.join("").includes("Use as written"));
  assert.equal(createButton, undefined);
  assert.equal(latestDraft.drug, "");
  await act(async () => renderer!.unmount());
});

function searchApiStub(overrides: {
  formulary?: (query: string) => Promise<FormularyResult[]>;
  directory?: (input: { state: string; place: string; searchType: "local-retail" | "mail-order" }) => Promise<DirectoryResult[]>;
} = {}): WenoSearchApi {
  return {
    searchFormulary: overrides.formulary ?? (async () => []),
    searchDirectory: overrides.directory ?? (async () => []),
  };
}

function formularyResult(): FormularyResult {
  return {
    drugDbCode: "196502",
    drugDbCodeQualifier: "SCD",
    quantityUnitOfMeasureCode: "C48542",
    psnDescription: "Latanoprost 0.005% ophthalmic solution",
    route: "OPHTHALMIC",
    strength: "0.005%",
  };
}

function directoryResult(): DirectoryResult {
  return {
    ncpdpId: "4222222",
    businessName: "Greenwood Pharmacy",
    addressLine1: "123 Main Street",
    addressLine2: "",
    city: "Greenwood",
    state: "SC",
    zip: "29646",
    phone: "8645550100",
    onWeno: true,
  };
}

function prescriptionRequest(
  overrides: Partial<MedicationRequest> = {},
): MedicationRequest {
  return {
    resourceType: "MedicationRequest",
    id: "rx-1",
    meta: { versionId: "2" },
    status: "active",
    intent: "order",
    subject: { reference: "Patient/patient-1" },
    encounter: { reference: "Encounter/encounter-1" },
    medicationCodeableConcept: { text: "Latanoprost" },
    dosageInstruction: [{ text: "1 drop OU nightly" }],
    requester: { reference: "Practitioner/doc-1" },
    authoredOn: "2026-08-21",
    ...overrides,
  };
}

function electronicallySentPrescription(
  overrides: Partial<MedicationRequest> = {},
): MedicationRequest {
  return prescriptionRequest({
    extension: [{
      url: "https://odos2020.com/fhir/StructureDefinition/odos-transmission-method",
      valueCode: "electronically-sent",
    }],
    identifier: [{
      system: WENO_MESSAGE_ID_IDENTIFIER_SYSTEM,
      value: "new-rx-message-id",
    }],
    ...overrides,
  });
}

function prescriptionSectionFetch(
  request: MedicationRequest,
  handle?: (url: string, init?: RequestInit) => Promise<Response | undefined>,
): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const handled = await handle?.(url, init);
    if (handled) return handled;
    if (url.endsWith("/Encounter/encounter-1")) {
      return jsonResponse({
        resourceType: "Encounter",
        id: "encounter-1",
        status: "in-progress",
        class: {},
        subject: { reference: "Patient/patient-1" },
        participant: [{ individual: { reference: "Practitioner/doc-1" } }],
      });
    }
    if (url.endsWith("/Patient/patient-1")) {
      return jsonResponse({ resourceType: "Patient", id: "patient-1" });
    }
    if (url.endsWith("/weno/switch/configuration")) {
      return jsonResponse({ configured: true, reason: "WENO Switch is configured." });
    }
    if (url.includes("/Condition?")) {
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] });
    }
    if (url.includes("/MedicationRequest?")) {
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: request }],
      });
    }
    throw new Error(`Unexpected request ${url}`);
  };
}

async function renderPrescriptionSection(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ConfirmDestructiveProvider>
        <PrescriptionSection
          patientReference="Patient/patient-1"
          encounterReference="Encounter/encounter-1"
          onSaved={NOOP}
        />
      </ConfirmDestructiveProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return renderer;
}

function findButton(renderer: ReactTestRenderer, text: string) {
  return renderer.root.findAllByType("button")
    .find((button) => button.children.includes(text));
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/fhir+json" },
  });
}
