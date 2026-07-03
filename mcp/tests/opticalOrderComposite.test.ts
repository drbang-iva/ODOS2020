import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle } from "@medplum/fhirtypes";
import { assembleOpticalCashOrder } from "../src/fhir/opticalOrderComposite.js";

function entriesByType(bundle: Bundle, resourceType: string) {
  return (bundle.entry ?? []).filter((e) => e.resource?.resourceType === resourceType);
}

test("assembleOpticalCashOrder emits a transaction Bundle wiring order→task, order→charges, charges→invoice", () => {
  const bundle = assembleOpticalCashOrder({
    patientReference: "Patient/p1",
    visionPrescriptionReference: "VisionPrescription/vp1",
    encounterReference: "Encounter/e1",
    orderHcpcsCode: "V2020",
    orderHcpcsDisplay: "Frames, purchases",
    businessStatus: "waiting-on-payment",
    charges: [
      { code: "V2020", codeDisplay: "Frames, purchases", feeCents: 18500 },
      {
        code: "V2100",
        codeDisplay: "Sphere, single vision",
        feeCents: 12000,
        discount: { code: "PPAY", amountCents: 1500 },
      },
    ],
    tender: "CASH",
  });

  assert.equal(bundle.resourceType, "Bundle");
  assert.equal(bundle.type, "transaction");

  const [drEntry] = entriesByType(bundle, "DeviceRequest");
  const [taskEntry] = entriesByType(bundle, "Task");
  const chargeEntries = entriesByType(bundle, "ChargeItem");
  const [invoiceEntry] = entriesByType(bundle, "Invoice");

  assert.ok(drEntry, "expected a DeviceRequest entry");
  assert.ok(taskEntry, "expected a Task entry");
  assert.ok(invoiceEntry, "expected an Invoice entry");
  assert.equal(chargeEntries.length, 2);

  // every entry is a POST create with a urn:uuid fullUrl (transaction-bundle shape)
  for (const e of bundle.entry ?? []) {
    assert.equal(e.request?.method, "POST");
    assert.ok(e.fullUrl?.startsWith("urn:uuid:"), `fullUrl ${e.fullUrl} must be a urn:uuid`);
  }

  // order → Rx link (basedOn → VisionPrescription); product code = the order HCPCS
  const dr = drEntry.resource!;
  assert.equal((dr as { basedOn?: { reference?: string }[] }).basedOn?.[0]?.reference, "VisionPrescription/vp1");
  assert.equal((dr as { codeCodeableConcept?: { coding?: { code?: string }[] } }).codeCodeableConcept?.coding?.[0]?.code, "V2020");

  // Task.focus resolves to the DeviceRequest entry's fullUrl; businessStatus set
  const task = taskEntry.resource!;
  assert.equal((task as { focus?: { reference?: string } }).focus?.reference, drEntry.fullUrl);
  assert.equal((task as { businessStatus?: { coding?: { code?: string }[] } }).businessStatus?.coding?.[0]?.code, "waiting-on-payment");

  // each ChargeItem.supportingInformation resolves to the DeviceRequest fullUrl; context → encounter
  for (const ce of chargeEntries) {
    const ci = ce.resource!;
    assert.equal((ci as { supportingInformation?: { reference?: string }[] }).supportingInformation?.[0]?.reference, drEntry.fullUrl);
    assert.equal((ci as { context?: { reference?: string } }).context?.reference, "Encounter/e1");
  }

  // Invoice lines reference the ChargeItem fullUrls present in the bundle (charge→payment resolves)
  const invoice = invoiceEntry.resource!;
  const chargeUrls = new Set(chargeEntries.map((e) => e.fullUrl));
  const lineItems = (invoice as { lineItem?: { chargeItemReference?: { reference?: string } }[] }).lineItem ?? [];
  assert.equal(lineItems.length, 2);
  for (const li of lineItems) {
    assert.ok(
      chargeUrls.has(li.chargeItemReference?.reference ?? ""),
      "each invoice line must reference a ChargeItem present in the bundle",
    );
  }

  // totals: gross = 305.00, net = 305 - 15 discount = 290.00; tender = CASH
  assert.equal((invoice as { totalGross?: { value?: number } }).totalGross?.value, 305);
  assert.equal((invoice as { totalNet?: { value?: number } }).totalNet?.value, 290);
  assert.equal(
    (invoice as { extension?: { valueCodeableConcept?: { coding?: { code?: string }[] } }[] }).extension?.[0]
      ?.valueCodeableConcept?.coding?.[0]?.code,
    "CASH",
  );
});

test("assembleOpticalCashOrder defaults the lifecycle to quote and omits context when no encounter given", () => {
  const bundle = assembleOpticalCashOrder({
    patientReference: "Patient/p1",
    visionPrescriptionReference: "VisionPrescription/vp1",
    orderHcpcsCode: "V2020",
    charges: [{ code: "V2020", feeCents: 10000 }],
    tender: "CASH",
  });

  const [taskEntry] = entriesByType(bundle, "Task");
  assert.equal(
    (taskEntry.resource as { businessStatus?: { coding?: { code?: string }[] } }).businessStatus?.coding?.[0]?.code,
    "quote",
  );

  const [chargeEntry] = entriesByType(bundle, "ChargeItem");
  assert.equal((chargeEntry.resource as { context?: unknown }).context, undefined);
});

test("assembleOpticalCashOrder requires at least one charge line", () => {
  assert.throws(
    () =>
      assembleOpticalCashOrder({
        patientReference: "Patient/p1",
        visionPrescriptionReference: "VisionPrescription/vp1",
        orderHcpcsCode: "V2020",
        charges: [],
        tender: "CASH",
      }),
    /charge line/i,
  );
});

test("assembleOpticalCashOrder propagates builder validation (invalid tender, invalid status, missing Rx)", () => {
  const base = {
    patientReference: "Patient/p1",
    visionPrescriptionReference: "VisionPrescription/vp1",
    orderHcpcsCode: "V2020",
    charges: [{ code: "V2020", feeCents: 10000 }],
    tender: "CASH",
  };
  assert.throws(() => assembleOpticalCashOrder({ ...base, tender: "CARD" }), /payment tender/i);
  assert.throws(() => assembleOpticalCashOrder({ ...base, businessStatus: "shipped" }), /optical order status/i);
  assert.throws(
    () => assembleOpticalCashOrder({ ...base, visionPrescriptionReference: "" }),
    /VisionPrescription/,
  );
});

test("assembleOpticalCashOrder gives every entry a unique fullUrl", () => {
  const bundle = assembleOpticalCashOrder({
    patientReference: "Patient/p1",
    visionPrescriptionReference: "VisionPrescription/vp1",
    orderHcpcsCode: "V2020",
    charges: [
      { code: "V2020", feeCents: 10000 },
      { code: "V2100", feeCents: 5000 },
    ],
    tender: "CHECK",
  });
  const urls = (bundle.entry ?? []).map((e) => e.fullUrl);
  assert.equal(new Set(urls).size, urls.length);
});
