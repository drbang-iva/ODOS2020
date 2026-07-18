import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Basic, Bundle, ChargeItem, Invoice, PaymentReconciliation, Resource } from "@medplum/fhirtypes";
import express from "express";
import { loadDayClose, loadDaySealArchive, sealDay } from "../src/desk/day-close.js";
import { createDaySeal, loadDaySeal } from "../src/desk/day-seal.js";
import { registerDeskRoutes } from "../src/desk/desk-routes.js";
import { createManualCashAdapter } from "../src/payments/adapters/manual-cash-adapter.js";
import type { ChargeRequest } from "../src/payments/payment-processor-adapter.js";
import type { FhirSearchParams } from "../src/fhir-client.js";
import { buildOpticalInvoice } from "../src/fhir/opticalInvoice.js";

function fixture(resources: Resource[] = []) {
  const store = resources.map((resource) => structuredClone(resource));
  const searches: Array<{ resourceType: string; params: URLSearchParams }> = [];
  return {
    store,
    searches,
    search: async <T extends Resource>(resourceType: T["resourceType"], params: FhirSearchParams): Promise<Bundle<T>> => {
      searches.push({ resourceType: String(resourceType), params: new URLSearchParams(params) });
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: store.filter((resource) => resource.resourceType === resourceType).map((resource) => ({ resource: resource as T })),
      };
    },
    create: async <T extends Resource>(resource: T): Promise<T> => {
      const created = { ...resource, id: `created-${store.length + 1}` } as T;
      store.push(created);
      return created;
    },
  };
}

test("DaySeal is created once with date identity, verified staff, and exact timestamp", async () => {
  const fhir = fixture();
  const seal = await createDaySeal(fhir, {
    date: "2026-07-15",
    staffReference: "Practitioner/staff-1",
    sealedAt: "2026-07-15T21:45:00.000Z",
  });
  assert.deepEqual(seal, {
    id: "created-1",
    date: "2026-07-15",
    sealedBy: "Practitioner/staff-1",
    sealedAt: "2026-07-15T21:45:00.000Z",
  });
  assert.deepEqual(await loadDaySeal(fhir, "2026-07-15"), seal);
  const stored = fhir.store.find((resource): resource is Basic => resource.resourceType === "Basic")!;
  assert.equal(stored.extension?.[0]?.valueInstant, "2026-07-15T21:45:00.000Z");
  await assert.rejects(() => createDaySeal(fhir, {
    date: "2026-07-15",
    staffReference: "Practitioner/staff-2",
    sealedAt: "2026-07-15T22:00:00.000Z",
  }), /already sealed/i);
  assert.equal(fhir.store.filter((resource) => resource.resourceType === "Basic").length, 1);
});

test("DaySeal reads reject mismatched date identity and unverified staff attribution", async () => {
  const mismatched = daySeal("seal-1", "2026-07-15", "2026-07-15T22:00:00.000Z");
  mismatched.created = "2026-07-14";
  await assert.rejects(() => loadDaySeal(fixture([mismatched]), "2026-07-15"), /date identity/i);

  const unverified = daySeal("seal-2", "2026-07-15", "2026-07-15T22:00:00.000Z");
  unverified.author = { reference: "Patient/p1" };
  await assert.rejects(() => loadDaySeal(fixture([unverified]), "2026-07-15"), /staff reference/i);
});

test("a persisted seal blocks a later backdated manual payment before its Invoice write", async () => {
  const invoice = paidInvoice("invoice-1", "Patient/p1", "ChargeItem/c1", 4200);
  delete invoice.extension;
  const base = fixture([invoice]);
  await createDaySeal(base, {
    date: "2026-07-15",
    staffReference: "Practitioner/staff-1",
    sealedAt: "2026-07-15T22:00:00.000Z",
  });
  let updates = 0;
  const fhir = {
    ...base,
    read: async <T>(): Promise<T> => structuredClone(invoice) as T,
    update: async <T>(_resourceType: string, _id: string, resource: T): Promise<T> => { updates += 1; return resource; },
  };
  const adapter = createManualCashAdapter(fhir, { now: () => "2026-07-15T18:00:00.000Z", timeZone: "America/New_York" });
  const request: ChargeRequest = {
    amountCents: 4200,
    currency: "USD",
    patientReference: "Patient/p1",
    invoiceReference: "Invoice/invoice-1",
    staffReference: "Practitioner/staff-1",
    description: "Backdated cash",
    surface: "manual",
    tender: { code: "CASH" },
  };
  await assert.rejects(() => adapter.charge(request), /already sealed.*payments can't be backdated/i);
  assert.equal(updates, 0);
});

test("close review finds billable charges missing from same-day Invoice lines and derives patient skim from ledger detail", async () => {
  const attached = charge("attached", "Patient/p1", 5000);
  const unattached = charge("unattached", "Patient/p2", 3750);
  const invoice = paidInvoice("invoice-1", "Patient/p1", "ChargeItem/attached", 5000);
  const result = await loadDayClose(fixture([attached, unattached, invoice]), {
    date: "2026-07-15",
    timeZone: "America/New_York",
  });
  assert.equal(result.ledger.payments.available && result.ledger.payments.totalCents, 5000);
  assert.equal(result.review.available, true);
  if (!result.review.available) return;
  assert.deepEqual(result.review.unattachedCharges, [{
    chargeItemReference: "ChargeItem/unattached",
    patientReference: "Patient/p2",
    description: "Unattached charge",
    amountCents: 3750,
  }]);
  assert.deepEqual(result.review.patientSkim, [{
    patientReference: "Patient/p1",
    chargesTotalCents: 5000,
    paidTotalCents: 5000,
  }, {
    patientReference: "Patient/p2",
    chargesTotalCents: 3750,
    paidTotalCents: 0,
  }]);
});

test("close review refuses partial ChargeItem results and seal refuses unavailable money totals", async () => {
  const fhir = fixture();
  const originalSearch = fhir.search;
  fhir.search = async <T extends Resource>(resourceType: T["resourceType"], params: FhirSearchParams): Promise<Bundle<T>> => {
    if (resourceType === "ChargeItem") {
      return { resourceType: "Bundle", type: "searchset", link: [{ relation: "next", url: "ChargeItem?_page=2" }] } as Bundle<T>;
    }
    if (resourceType === "Invoice") {
      return { resourceType: "Bundle", type: "searchset", link: [{ relation: "next", url: "Invoice?_page=2" }] } as Bundle<T>;
    }
    return originalSearch(resourceType, params);
  };
  const review = await loadDayClose(fhir, { date: "2026-07-15" });
  assert.deepEqual(review.review, {
    available: false,
    reason: "The day review exceeds the guarded FHIR read limit.",
    heldCreditsToday: { available: true, count: 0, totalCents: 0 },
  });
  await assert.rejects(() => sealDay(fhir, {
    date: "2026-07-15",
    staffReference: "Practitioner/staff-1",
    sealedAt: "2026-07-15T22:00:00.000Z",
  }), /totals are unavailable/i);
  assert.equal(fhir.store.length, 0);
});

test("archive lists sealed dates with totals live-read from each Day Ledger", async () => {
  const fhir = fixture([
    daySeal("seal-1", "2026-07-15", "2026-07-15T22:00:00.000Z"),
    paidInvoice("invoice-1", "Patient/p1", "ChargeItem/c1", 4200),
  ]);
  const archive = await loadDaySealArchive(fhir, "America/New_York");
  assert.deepEqual(archive, [{
    id: "seal-1",
    date: "2026-07-15",
    sealedBy: "Practitioner/staff-1",
    sealedAt: "2026-07-15T22:00:00.000Z",
    totalCents: 4200,
  }]);
  const basicSearch = fhir.searches.find((search) => search.resourceType === "Basic");
  assert.equal(basicSearch?.params.get("_count"), "1000");
});

test("seal endpoint enforces payment.seal-day and returns the sealed summary without claims writes", async () => {
  const fhir = fixture([paidInvoice("invoice-1", "Patient/p1", "ChargeItem/c1", 4200)]);
  const app = express();
  app.use(express.json());
  let role: "clinician" | "front-desk" = "clinician";
  registerDeskRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => ({
      staffReference: "Practitioner/staff-1",
      actorRole: role,
      roles: [role],
      fhir: fhir as never,
    }),
    resolveRoles: async () => null,
    terminalMode: "NOT CONFIGURED",
    timeZone: "America/New_York",
    now: () => "2026-07-15T22:00:00.000Z",
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
  const { port } = listener.address() as AddressInfo;
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/desk/ledger/seal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-07-15" }),
    });
    assert.equal(denied.status, 403);
    role = "front-desk";
    const response = await fetch(`http://127.0.0.1:${port}/desk/ledger/seal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-07-15" }),
    });
    assert.equal(response.status, 201);
    const body = await response.json() as { seal: { date: string; sealedBy: string }; ledger: { payments: { totalCents: number } } };
    assert.deepEqual(body.seal, {
      id: "created-2",
      date: "2026-07-15",
      sealedBy: "Practitioner/staff-1",
      sealedAt: "2026-07-15T22:00:00.000Z",
    });
    assert.equal(body.ledger.payments.totalCents, 4200);
    assert.equal(fhir.store.some((resource) => resource.resourceType === "Claim" || resource.resourceType === "Task"), false);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

function charge(id: string, patientReference: string, amountCents: number): ChargeItem {
  return {
    resourceType: "ChargeItem",
    id,
    status: "billable",
    code: { text: id === "unattached" ? "Unattached charge" : "Attached charge" },
    subject: { reference: patientReference },
    occurrenceDateTime: "2026-07-15T14:00:00.000Z",
    priceOverride: { value: amountCents / 100, currency: "USD" },
  };
}

function paidInvoice(id: string, patientReference: string, chargeReference: string, amountCents: number): Invoice {
  return {
    ...buildOpticalInvoice({
      patientReference,
      date: "2026-07-15T15:00:00.000Z",
      staffReference: "Practitioner/staff-1",
      tender: "CASH",
      lineItems: [{ chargeItemReference: chargeReference, amountCents }],
    }),
    id,
  };
}

function daySeal(id: string, date: string, sealedAt: string): Basic {
  return {
    resourceType: "Basic",
    id,
    identifier: [{ system: "https://odos2020.com/fhir/NamingSystem/day-seal-date", value: date }],
    code: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/day-seal", code: "day-seal" }] },
    created: date,
    author: { reference: "Practitioner/staff-1" },
    extension: [{ url: "https://odos2020.com/fhir/StructureDefinition/day-seal-timestamp", valueInstant: sealedAt }],
  };
}
