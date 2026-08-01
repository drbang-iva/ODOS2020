import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Patient } from "@medplum/fhirtypes";
import { RouteSwitch } from "../src/App";
import { PrescriptionSection } from "../src/components/charting/PrescriptionSection";
import {
  PharmacyDirectoryPicker,
  type DirectoryResult,
  type PharmacySelection,
} from "../src/components/pharmacy/PharmacyDirectoryPicker";
import {
  pharmacyDisplay,
  pharmacyFromResource,
  type MedicationOrderPharmacy,
} from "../src/lib/fhir-medication-order";
import { PatientPharmacy } from "../src/scenes/pharmacy/PatientPharmacy";

const CODED_PHARMACY: MedicationOrderPharmacy = {
  ncpdpId: "4222222",
  npi: "1234567893",
  name: "Greenwood Pharmacy",
  addressLine1: "123 Main Street",
  city: "Greenwood",
  state: "SC",
  postalCode: "29646",
  phone: "8645550100",
};

const DIRECTORY_RESULT: DirectoryResult = {
  ncpdpId: CODED_PHARMACY.ncpdpId,
  npi: CODED_PHARMACY.npi,
  businessName: CODED_PHARMACY.name,
  addressLine1: CODED_PHARMACY.addressLine1,
  addressLine2: "",
  city: CODED_PHARMACY.city,
  state: CODED_PHARMACY.state,
  zip: CODED_PHARMACY.postalCode,
  phone: CODED_PHARMACY.phone,
  onWeno: true,
};

test("the patient pharmacy route reaches the front-desk editor", () => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<RouteSwitch view={{ kind: "picker" }} path="/patient/pharmacy" />);
  });
  assert.match(JSON.stringify(renderer.toJSON()), /Pharmacy/);
  assert.match(JSON.stringify(renderer.toJSON()), /Select a patient/);
  act(() => renderer.unmount());
});

test("a front-desk directory selection becomes the chart default and clearing removes the next default", async () => {
  const store = patientStore([DIRECTORY_RESULT]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = store.fetch;
  let front: ReactTestRenderer | undefined;
  let chart: ReactTestRenderer | undefined;
  try {
    front = await renderFrontDesk();
    await chooseDirectoryPharmacy(front, "29646", "SC", CODED_PHARMACY.name);
    await click(front, "Save preferred pharmacy");

    chart = await renderChart();
    assert.equal(chartPrescriptionPicker(chart).props.pharmacy, pharmacyDisplay(CODED_PHARMACY));
    assert.equal(chartPrescriptionPicker(chart).props.pharmacyNcpdpId, CODED_PHARMACY.ncpdpId);
    act(() => chart?.unmount());
    chart = undefined;

    await click(front, "Clear preferred pharmacy");
    chart = await renderChart();
    assert.equal(chartPrescriptionPicker(chart).props.pharmacy, "");
    assert.equal(pharmacyFromResource(store.patient), undefined);
  } finally {
    if (front) act(() => front?.unmount());
    if (chart) act(() => chart?.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a free-text front-desk pharmacy saves and round-trips through the Patient resource", async () => {
  const store = patientStore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = store.fetch;
  let first: ReactTestRenderer | undefined;
  let reopened: ReactTestRenderer | undefined;
  try {
    first = await renderFrontDesk();
    await chooseFreeTextPharmacy(first, "Neighborhood Drug", "SC");
    await click(first, "Save preferred pharmacy");
    assert.deepEqual(pharmacyFromResource(store.patient), { name: "Neighborhood Drug" });
    act(() => first?.unmount());
    first = undefined;

    reopened = await renderFrontDesk();
    assert.equal(frontDeskPicker(reopened).props.pharmacy, "Neighborhood Drug");
    assert.equal(frontDeskPicker(reopened).props.allowFreeText, true);
  } finally {
    if (first) act(() => first?.unmount());
    if (reopened) act(() => reopened?.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a chart-saved preferred pharmacy appears on the front-desk screen", async () => {
  const store = patientStore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = store.fetch;
  let chart: ReactTestRenderer | undefined;
  let front: ReactTestRenderer | undefined;
  try {
    chart = await renderChart();
    const preferredPicker = chartPreferredPicker(chart);
    act(() => preferredPicker.props.onChange(codedSelection(CODED_PHARMACY)));
    await click(chart, "Save preferred pharmacy");
    act(() => chart?.unmount());
    chart = undefined;

    front = await renderFrontDesk();
    assert.equal(frontDeskPicker(front).props.pharmacy, pharmacyDisplay(CODED_PHARMACY));
    assert.equal(frontDeskPicker(front).props.pharmacyNcpdpId, CODED_PHARMACY.ncpdpId);
  } finally {
    if (chart) act(() => chart?.unmount());
    if (front) act(() => front?.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("typing into a populated front-desk pharmacy does not clear the saved free-text pharmacy", async () => {
  const store = patientStore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = store.fetch;
  let first: ReactTestRenderer | undefined;
  let reopened: ReactTestRenderer | undefined;
  try {
    first = await renderFrontDesk();
    await chooseFreeTextPharmacy(first, "Neighborhood Drug", "SC");
    await click(first, "Save preferred pharmacy");
    act(() => first?.unmount());
    first = undefined;

    reopened = await renderFrontDesk();
    typeIntoPharmacyInput(reopened, "Preferred pharmacy ZIP or city", "Neighborhood Drugx");
    await click(reopened, "Save preferred pharmacy");

    assert.deepEqual(pharmacyFromResource(store.patient), { name: "Neighborhood Drug" });
  } finally {
    if (first) act(() => first?.unmount());
    if (reopened) act(() => reopened?.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("typing into the populated chart picker does not clear the saved coded pharmacy", async () => {
  const store = patientStore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = store.fetch;
  let first: ReactTestRenderer | undefined;
  let reopened: ReactTestRenderer | undefined;
  try {
    first = await renderChart();
    act(() => chartPreferredPicker(first!).props.onChange(codedSelection(CODED_PHARMACY)));
    await click(first, "Save preferred pharmacy");
    const savedPharmacy = pharmacyFromResource(store.patient);
    act(() => first?.unmount());
    first = undefined;

    reopened = await renderChart();
    typeIntoPharmacyInput(reopened, "Preferred pharmacy ZIP or city", `${pharmacyDisplay(CODED_PHARMACY)}x`);
    await click(reopened, "Save preferred pharmacy");

    assert.deepEqual(pharmacyFromResource(store.patient), savedPharmacy);
  } finally {
    if (first) act(() => first?.unmount());
    if (reopened) act(() => reopened?.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a free-text pharmacy can be saved without entering a directory state and round-trips", async () => {
  const store = patientStore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = store.fetch;
  let first: ReactTestRenderer | undefined;
  let reopened: ReactTestRenderer | undefined;
  try {
    first = await renderFrontDesk();
    await chooseFreeTextPharmacy(first, "No State Pharmacy", "");
    await click(first, "Save preferred pharmacy");
    assert.deepEqual(pharmacyFromResource(store.patient), { name: "No State Pharmacy" });
    act(() => first?.unmount());
    first = undefined;

    reopened = await renderFrontDesk();
    assert.equal(frontDeskPicker(reopened).props.pharmacy, "No State Pharmacy");
  } finally {
    if (first) act(() => first?.unmount());
    if (reopened) act(() => reopened?.unmount());
    globalThis.fetch = originalFetch;
  }
});

function patientStore(directoryResults: DirectoryResult[] = []) {
  let patient: Patient = {
    resourceType: "Patient",
    id: "patient-1",
    meta: { versionId: "1" },
    name: [{ given: ["Avery"], family: "Patient" }],
  };
  return {
    get patient() { return patient; },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/Patient/patient-1") && init?.method === "PUT") {
        const update = JSON.parse(String(init.body)) as Patient;
        patient = { ...update, meta: { ...update.meta, versionId: String(Number(patient.meta?.versionId ?? "0") + 1) } };
        return jsonResponse(patient);
      }
      if (url.endsWith("/Patient/patient-1")) return jsonResponse(patient);
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
        return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] });
      }
      if (url.includes("/weno/pharmacies/search?")) {
        return jsonResponse({ results: directoryResults });
      }
      if (url.endsWith("/weno/switch/configuration")) {
        return jsonResponse({ configured: false, reason: "WENO Switch is not configured." });
      }
      throw new Error(`Unexpected request ${url}`);
    },
  };
}

async function renderFrontDesk(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<PatientPharmacy initialPatientId="patient-1" />);
    await settle();
  });
  return renderer;
}

async function renderChart(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <PrescriptionSection
        patientReference="Patient/patient-1"
        encounterReference="Encounter/encounter-1"
        onSaved={() => undefined}
      />,
    );
    await settle();
  });
  return renderer;
}

function frontDeskPicker(renderer: ReactTestRenderer) {
  return renderer.root.findByType(PharmacyDirectoryPicker);
}

function chartPreferredPicker(renderer: ReactTestRenderer) {
  const picker = renderer.root.findAllByType(PharmacyDirectoryPicker)
    .find((candidate) => candidate.props.label === "Preferred pharmacy ZIP or city");
  assert.ok(picker);
  return picker;
}

function chartPrescriptionPicker(renderer: ReactTestRenderer) {
  const picker = renderer.root.findAllByType(PharmacyDirectoryPicker)
    .find((candidate) => candidate.props.label === undefined);
  assert.ok(picker);
  return picker;
}

async function click(renderer: ReactTestRenderer, label: string): Promise<void> {
  const button = renderer.root.findAllByType("button")
    .find((candidate) => candidate.children.includes(label));
  assert.ok(button, `Expected button ${label}`);
  await act(async () => {
    button.props.onClick();
    await settle();
  });
}

async function chooseDirectoryPharmacy(
  renderer: ReactTestRenderer,
  query: string,
  state: string,
  name: string,
): Promise<void> {
  await enterPharmacyQuery(renderer, query, state);
  const options = renderer.root.findAllByProps({ role: "option" });
  assert.equal(options.length, 1, `Expected one directory option for ${name}`);
  const option = options[0]!;
  act(() => option.props.onClick());
}

async function chooseFreeTextPharmacy(
  renderer: ReactTestRenderer,
  query: string,
  state: string,
): Promise<void> {
  await enterPharmacyQuery(renderer, query, state);
  const createButton = renderer.root.findAllByType("button")
    .find((candidate) => candidate.children.join("").includes("Use as written"));
  assert.ok(createButton, "Expected the free-text pharmacy action");
  await act(async () => {
    createButton.props.onClick();
    await settle();
  });
}

async function enterPharmacyQuery(
  renderer: ReactTestRenderer,
  query: string,
  state: string,
): Promise<void> {
  const stateInput = renderer.root.findByProps({ "aria-label": "Preferred pharmacy state" });
  const pharmacyInput = renderer.root.findByProps({ "aria-label": "Preferred pharmacy ZIP or city" });
  act(() => stateInput.props.onChange({ target: { value: state } }));
  await act(async () => {
    pharmacyInput.props.onChange({ target: { value: query } });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
  });
}

function typeIntoPharmacyInput(
  renderer: ReactTestRenderer,
  label: string,
  value: string,
): void {
  const pharmacyInput = renderer.root.findByProps({ "aria-label": label });
  act(() => pharmacyInput.props.onChange({ target: { value } }));
}

function codedSelection(pharmacy: MedicationOrderPharmacy): PharmacySelection {
  return {
    pharmacy: pharmacyDisplay(pharmacy),
    pharmacyNcpdpId: pharmacy.ncpdpId,
    pharmacyDetails: pharmacy,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/fhir+json" },
  });
}
