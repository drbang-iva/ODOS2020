import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Bundle, Invoice, PaymentReconciliation, Resource } from "@medplum/fhirtypes";
import express from "express";
import {
  loadDayLedger,
  practiceDate,
  practiceDayRange,
  projectDayLedgerPayments,
} from "../src/desk/day-ledger.js";
import { registerDeskRoutes } from "../src/desk/desk-routes.js";
import type { FhirSearchParams } from "../src/fhir-client.js";
import { buildOpticalInvoice } from "../src/fhir/opticalInvoice.js";
import { OSOD_PAYMENT_SUBJECT_EXTENSION_URL } from "../src/payments/payment-reconciliation.js";

test("Day Ledger projects integer-cent tender totals, newest-first detail, and StaffLedgerTotal groups", () => {
  const invoices = [
    invoice("cash-1", "2026-07-15T13:00:00.000Z", "Practitioner/alex", "CASH", 1000),
    invoice("check-1", "2026-07-15T15:00:00.000Z", "Practitioner/blair", "CHECK", 2500),
    invoice("card-1", "2026-07-15T14:00:00.000Z", "Practitioner/alex", "CARD_MANUAL", 3750),
    invoice("yesterday", "2026-07-14T14:00:00.000Z", "Practitioner/alex", "CASH", 9999),
  ];
  const result = projectDayLedgerPayments(invoices, "2026-07-15", "America/New_York");
  assert.deepEqual(result.tenderTotalsCents, { CASH: 1000, CHECK: 2500, CARD_MANUAL: 3750 });
  assert.equal(result.totalCents, 7250);
  assert.deepEqual(result.detail.map((row) => row.time), [
    "2026-07-15T15:00:00.000Z",
    "2026-07-15T14:00:00.000Z",
    "2026-07-15T13:00:00.000Z",
  ]);
  assert.deepEqual(result.staffLedgerTotals, [
    { staffer: "Practitioner/alex", count: 2, subtotalCents: 4750 },
    { staffer: "Practitioner/blair", count: 1, subtotalCents: 2500 },
  ]);
});

test("dated tendered invoices with missing attribution still count and render as unattributed", () => {
  const missingStaff = invoice("missing-staff", "2026-07-15T13:00:00.000Z", "Practitioner/alex", "CASH", 1200);
  delete missingStaff.participant;
  const missingPatient = invoice("missing-patient", "2026-07-15T14:00:00.000Z", "Practitioner/blair", "CHECK", 2300);
  delete missingPatient.subject;
  const dateless = invoice("dateless", "2026-07-15T15:00:00.000Z", "Practitioner/alex", "CASH", 9900);
  delete dateless.date;
  const untendered = invoice("untendered", "2026-07-15T16:00:00.000Z", "Practitioner/alex", "CHECK", 8800);
  delete untendered.extension;

  const result = projectDayLedgerPayments(
    [missingStaff, missingPatient, dateless, untendered],
    "2026-07-15",
    "America/New_York",
  );

  assert.deepEqual(result.tenderTotalsCents, { CASH: 1200, CHECK: 2300, CARD_MANUAL: 0 });
  assert.equal(result.totalCents, 3500);
  assert.equal(result.detail.find((row) => row.tender === "CASH")?.staffer, "unattributed");
  assert.equal(result.detail.find((row) => row.tender === "CHECK")?.patientReference, "unattributed");
  assert.equal(result.detail.length, 2);
  assert.deepEqual(result.staffLedgerTotals, [
    { staffer: "Practitioner/blair", count: 1, subtotalCents: 2300 },
    { staffer: "unattributed", count: 1, subtotalCents: 1200 },
  ]);
});

test("Day Ledger queries exact practice-day date ranges and computes real held credits", async () => {
  const searches: Array<{ resourceType: string; params: URLSearchParams }> = [];
  const fhir = {
    search: async <T extends Resource>(resourceType: T["resourceType"], params: FhirSearchParams): Promise<Bundle<T>> => {
      searches.push({ resourceType: String(resourceType), params: new URLSearchParams(params) });
      const resources: Resource[] = resourceType === "Invoice"
        ? [invoice("cash-1", "2026-07-15T14:00:00.000Z", "Practitioner/alex", "CASH", 1234)]
        : [unappliedCredit()];
      return { resourceType: "Bundle", type: "searchset", entry: resources.map((resource) => ({ resource: resource as T })) };
    },
  };
  const result = await loadDayLedger(fhir, { date: "2026-07-15", timeZone: "America/New_York" });
  assert.equal(result.payments.available && result.payments.totalCents, 1234);
  assert.deepEqual(result.heldCreditsToday, { available: true, count: 1, totalCents: 5000 });
  assert.equal(searches.length, 2);
  assert.deepEqual(searches[0].params.getAll("date"), [
    "ge2026-07-15T04:00:00.000Z",
    "lt2026-07-16T04:00:00.000Z",
  ]);
  assert.deepEqual(searches[1].params.getAll("created"), [
    "ge2026-07-15T04:00:00.000Z",
    "lt2026-07-16T04:00:00.000Z",
  ]);
  assert.equal(searches[0].params.get("_count"), "1000");
});

test("Day Ledger degrades overflowing sections without partial totals or a whole-ledger error", async () => {
  const fhir = {
    search: async <T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> => resourceType === "Invoice"
      ? { resourceType: "Bundle", type: "searchset", link: [{ relation: "next", url: "Invoice?_page=2" }] } as Bundle<T>
      : { resourceType: "Bundle", type: "searchset" },
  };
  const result = await loadDayLedger(fhir, { date: "2026-07-15", timeZone: "America/New_York" });
  assert.deepEqual(result.payments, { available: false, reason: "The day's Invoice results exceed the ledger read limit." });
  assert.deepEqual(result.heldCreditsToday, { available: true, count: 0, totalCents: 0 });
});

test("practice-day ranges honor daylight-saving offsets", () => {
  assert.deepEqual(practiceDayRange("2026-07-15", "America/New_York"), {
    start: "2026-07-15T04:00:00.000Z",
    end: "2026-07-16T04:00:00.000Z",
  });
  assert.deepEqual(practiceDayRange("2026-01-15", "America/New_York"), {
    start: "2026-01-15T05:00:00.000Z",
    end: "2026-01-16T05:00:00.000Z",
  });
});

test("an unset ledger timezone uses UTC for both search windows and day rebucketing", () => {
  const previousTimeZone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    assert.deepEqual(practiceDayRange("2026-07-15"), {
      start: "2026-07-15T00:00:00.000Z",
      end: "2026-07-16T00:00:00.000Z",
    });
    assert.equal(practiceDate("2026-07-15T02:00:00.000Z"), "2026-07-15");
    assert.equal(
      projectDayLedgerPayments([
        invoice("utc-evening", "2026-07-15T02:00:00.000Z", "Practitioner/alex", "CASH", 1800),
      ], "2026-07-15").totalCents,
      1800,
    );
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
});

test("GET /desk/ledger returns 401 before FHIR reads and uses payment.charge for authorized reads", async () => {
  let searches = 0;
  const fhir = { search: async <T extends Resource>(): Promise<Bundle<T>> => { searches += 1; return { resourceType: "Bundle", type: "searchset" }; } };
  const app = express();
  registerDeskRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async (header) => header === "Bearer good" ? {
      staffReference: "Practitioner/staff-1",
      actorRole: "front-desk",
      roles: ["front-desk"],
      fhir: fhir as never,
    } : null,
    resolveRoles: async () => null,
    terminalMode: "LIVE",
    timeZone: "America/New_York",
    now: () => "2026-07-15T14:00:00.000Z",
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
  const { port } = listener.address() as AddressInfo;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/desk/ledger`)).status, 401);
    assert.equal(searches, 0);
    const response = await fetch(`http://127.0.0.1:${port}/desk/ledger`, { headers: { Authorization: "Bearer good" } });
    assert.equal(response.status, 200);
    assert.equal(searches, 2);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

test("one dated tendered Invoice without staff attribution cannot blank the ledger or Desk summary", async () => {
  const unattributedInvoice = invoice(
    "unattributed",
    "2026-07-15T14:00:00.000Z",
    "Practitioner/removed",
    "CASH",
    4200,
  );
  delete unattributedInvoice.participant;
  const fhir = {
    search: async <T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> => ({
      resourceType: "Bundle",
      type: "searchset",
      ...(resourceType === "Invoice" ? { entry: [{ resource: unattributedInvoice as T }] } : {}),
    }),
  };
  const app = express();
  registerDeskRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => ({
      staffReference: "Practitioner/staff-1",
      actorRole: "front-desk",
      roles: ["front-desk"],
      fhir: fhir as never,
    }),
    resolveRoles: async () => ({ email: "staff@example.test", roles: ["front-desk"] }),
    terminalMode: "LIVE",
    timeZone: "America/New_York",
    now: () => "2026-07-15T15:00:00.000Z",
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
  const { port } = listener.address() as AddressInfo;
  try {
    const ledgerResponse = await fetch(`http://127.0.0.1:${port}/desk/ledger`, {
      headers: { Authorization: "Bearer good" },
    });
    assert.equal(ledgerResponse.status, 200);
    const ledger = await ledgerResponse.json() as {
      payments: { totalCents: number; tenderTotalsCents: { CASH: number }; detail: Array<{ staffer: string }> };
    };
    assert.equal(ledger.payments.totalCents, 4200);
    assert.equal(ledger.payments.tenderTotalsCents.CASH, 4200);
    assert.equal(ledger.payments.detail[0].staffer, "unattributed");

    const summaryResponse = await fetch(`http://127.0.0.1:${port}/desk/summary`, {
      headers: { Authorization: "Bearer good" },
    });
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json() as { day: { collectedCents: { value: number } } };
    assert.equal(summary.day.collectedCents.value, 4200);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

function invoice(
  id: string,
  date: string,
  staffReference: string,
  tender: "CASH" | "CHECK" | "CARD_MANUAL",
  amountCents: number,
): Invoice {
  return {
    ...buildOpticalInvoice({
      patientReference: `Patient/${id}`,
      date,
      staffReference,
      tender,
      lineItems: [{ chargeItemReference: `ChargeItem/${id}`, amountCents }],
    }),
    id,
  };
}

function unappliedCredit(): PaymentReconciliation {
  return {
    resourceType: "PaymentReconciliation",
    id: "credit-1",
    status: "active",
    outcome: "complete",
    created: "2026-07-15T16:00:00.000Z",
    paymentDate: "2026-07-15",
    paymentAmount: { value: 50, currency: "USD" },
    paymentIdentifier: { system: "https://osod.dev/fhir/NamingSystem/manual-payment", value: "credit-1" },
    extension: [{ url: OSOD_PAYMENT_SUBJECT_EXTENSION_URL, valueReference: { reference: "Patient/credit" } }],
  };
}
