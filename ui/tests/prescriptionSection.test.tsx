import assert from "node:assert/strict";
import { test } from "node:test";
import React, { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { MedicationRequest } from "@medplum/fhirtypes";
import {
  EMPTY_PRESCRIPTION_DRAFT,
  PrescriptionEditor,
  type DirectoryResult,
  type FormularyResult,
  type PrescriptionDraft,
  type WenoSearchApi,
  formatDate,
  isControlledSubstanceDrug,
  mergeMedicationRequestUpdate,
  withDrugText,
} from "../src/components/charting/PrescriptionSection";

const NOOP = () => undefined;

test("PrescriptionEditor exposes every prescription field as a directly typeable control", () => {
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
  assert.match(html, /type="number" min="0"[^>]*aria-label="Refills"|aria-label="Refills"[^>]*type="number"/);
  assert.match(html, /type="number" min="1"[^>]*aria-label="Days supply"|aria-label="Days supply"[^>]*type="number"/);
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
  const searchApi = searchApiStub({ formulary: async () => [result] });

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
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": `Choose ${result.psnDescription} from the Formulary` }).props.onClick();
  });
  assert.equal(latestDraft.drugDbCode, result.drugDbCode);
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
