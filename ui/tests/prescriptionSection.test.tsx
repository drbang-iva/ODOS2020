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
  formatDate,
  isControlledSubstanceDrug,
  mergeMedicationRequestUpdate,
  withDrugText,
} from "../src/components/charting/PrescriptionSection";
import { CONCURRENT_EDIT_MESSAGE, toError } from "../src/lib/fhir";

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
    "Directory entry",
    "Directory ZIP or city",
    "Directory state",
  ]) {
    assert.match(html, new RegExp(`aria-label="${label}"`));
  }
  assert.match(html, /role="combobox"[^>]*aria-label="Refills"/);
  assert.match(html, /role="combobox"[^>]*aria-label="Days supply"/);
  assert.match(html, /data-default="true"[^>]*>30</);
  for (const route of ["Ophthalmic", "Oral", "Topical", "Otic", "Nasal", "Other"]) {
    assert.match(html, new RegExp(`<option value="${route}"`));
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

test("saving an edit preserves an on-hold prescription status and original requester", () => {
  const existing: MedicationRequest = {
    resourceType: "MedicationRequest",
    id: "rx-1",
    status: "on-hold",
    intent: "order",
    subject: { reference: "Patient/patient-1" },
    medicationCodeableConcept: { text: "Original medication" },
    requester: { reference: "Practitioner/original-prescriber" },
  };
  const edited: MedicationRequest = {
    resourceType: "MedicationRequest",
    status: "active",
    intent: "order",
    subject: { reference: "Patient/patient-1" },
    medicationCodeableConcept: { text: "Edited medication" },
    requester: { reference: "Practitioner/current-user" },
  };

  const update = mergeMedicationRequestUpdate(existing, edited);

  assert.equal(update.medicationCodeableConcept?.text, "Edited medication");
  assert.equal(update.status, "on-hold");
  assert.deepEqual(update.requester, { reference: "Practitioner/original-prescriber" });
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

test("typing in the Formulary without selecting remains a freeform draft", () => {
  let changed: PrescriptionDraft | undefined;
  const html = renderToStaticMarkup(
    <PrescriptionEditor
      draft={EMPTY_PRESCRIPTION_DRAFT}
      conditions={[]}
      onChange={(draft) => { changed = draft; }}
      onSave={NOOP}
    />,
  );
  assert.match(html, /aria-label="Formulary"/);

  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      <PrescriptionEditor
        draft={EMPTY_PRESCRIPTION_DRAFT}
        conditions={[]}
        onChange={(draft) => { changed = draft; }}
        onSave={NOOP}
      />,
    );
  });
  act(() => renderer!.root.findByProps({ "aria-label": "Formulary" }).props.onChange({ target: { value: "Custom compound" } }));
  assert.equal(changed?.drug, "Custom compound");
  assert.equal(changed?.drugDbCode, undefined);
  assert.equal(changed?.drugDbCodeQualifier, undefined);
  assert.equal(changed?.quantityUnitOfMeasureCode, undefined);
  act(() => renderer!.unmount());
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
    await Promise.resolve();
  });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": `Choose ${result.psnDescription} from the Formulary` }).props.onClick();
  });
  assert.equal(latestDraft.drugDbCode, result.drugDbCode);
  assert.equal(latestDraft.route, result.route);
  assert.match(JSON.stringify(renderer!.toJSON()), /Coded — from WENO drug database/);

  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Formulary" }).props.onChange({ target: { value: `${result.psnDescription} edited` } });
  });
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
  const searchButton = () => renderer!.root.findAllByType("button").find((button) => button.children.includes("Search Directory"))!;
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Directory ZIP or city" }).props.onChange({ target: { value: "29646" } });
  });
  await act(async () => { await searchButton().props.onClick(); });
  assert.equal(calls, 0);
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Directory state" }).props.onChange({ target: { value: "sc" } });
  });
  await act(async () => { await searchButton().props.onClick(); });
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
  const place = renderer!.root.findByProps({ "aria-label": "Directory ZIP or city" });
  const state = renderer!.root.findByProps({ "aria-label": "Directory state" });
  await act(async () => {
    place.props.onChange({ target: { value: "29646" } });
    state.props.onChange({ target: { value: "SC" } });
  });
  const searchButton = renderer!.root.findAllByType("button")
    .find((button) => button.children.includes("Search Directory"))!;
  await act(async () => { void searchButton.props.onClick(); });
  await act(async () => { place.props.onChange({ target: { value: "29649" } }); });
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

test("a failed Formulary search leaves the field typeable as freeform text", async () => {
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
  assert.equal(latestDraft.drug, "Unlisted medication");
  assert.match(JSON.stringify(renderer!.toJSON()), /You can keep this entry as written/);
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/fhir+json" },
  });
}
