import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, ChargeItem, Resource } from "@medplum/fhirtypes";
import type { OsodAuditEventRecord } from "../src/authz/osodAudit.js";
import {
  handleRecordedTenderCollectionRequest,
  handleOpenChargesRequest,
  type PaymentCollectionHandlerDeps,
} from "../src/payments/payment-collection-handler.js";

function fixture(searchEntries: ChargeItem[] = []) {
  const audits: OsodAuditEventRecord[] = [];
  const transactions: Bundle[] = [];
  let reads = 0;
  const fhir = {
    read: async <T extends Resource>(_type: T["resourceType"], id: string): Promise<T> => {
      reads += 1;
      return charge(id) as T;
    },
    search: async <T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> => ({
      resourceType: "Bundle",
      type: "searchset",
      entry: resourceType === "ChargeItem" ? searchEntries.map((resource) => ({ resource: resource as T })) : [],
    }),
    executeTransaction: async (bundle: Bundle): Promise<Bundle> => {
      transactions.push(bundle);
      return {
        resourceType: "Bundle",
        type: "transaction-response",
        entry: (bundle.entry ?? []).map((entry, index) => ({
          response: {
            status: "201 Created",
            location: `${entry.resource?.resourceType ?? "Resource"}/${entry.resource?.resourceType === "Invoice" ? "invoice-1" : `created-${index}`}/_history/1`,
          },
        })),
      };
    },
  };
  const deps: PaymentCollectionHandlerDeps = {
    authenticate: async (header) => header === "Bearer good" ? {
      staffReference: "Practitioner/staff-1",
      actorRole: "front-desk",
      roles: ["front-desk"],
      fhir,
    } : null,
    recordAudit: async (row) => { audits.push(row); },
    now: () => "2026-07-15T10:00:00.000Z",
  };
  return { audits, deps, reads: () => reads, transactions };
}

test("open charges returns an empty array for an authenticated patient with no billable ChargeItems", async () => {
  const { deps } = fixture();
  const result = await handleOpenChargesRequest(deps, {
    authHeader: "Bearer good",
    patientReference: "Patient/patient-1",
  });
  assert.deepEqual(result, { status: 200, body: [] });
});

test("open charges returns integer cents and derives optical source from DeviceRequest supportingInformation", async () => {
  const { deps } = fixture([charge("charge-1")]);
  const result = await handleOpenChargesRequest(deps, {
    authHeader: "Bearer good",
    patientReference: "Patient/patient-1",
  });
  assert.deepEqual(result, {
    status: 200,
    body: [{
      id: "charge-1",
      amountCents: 12_345,
      description: "Frames",
      date: "2026-07-15",
      source: "optical",
      code: "V2020",
      feeCents: 12_345,
    }],
  });
});

test("open charges rejects an unauthenticated request with 401 before querying FHIR", async () => {
  const { deps } = fixture([charge("charge-1")]);
  const result = await handleOpenChargesRequest(deps, {
    authHeader: undefined,
    patientReference: "Patient/patient-1",
  });
  assert.deepEqual(result, {
    status: 401,
    body: { error: "Authentication required to collect a payment." },
  });
});

test("recorded-tender collection posts a server-side Invoice transaction and emits a completed payment audit", async () => {
  const { audits, deps, transactions } = fixture();
  const result = await handleRecordedTenderCollectionRequest(deps, {
    authHeader: "Bearer good",
    body: {
      patientReference: "Patient/patient-1",
      selectedOpenChargeLineIds: ["charge-1"],
      amountCents: 12_345,
      tender: "CHECK",
    },
  });
  assert.equal(result.status, 200);
  assert.equal((result.body as { invoiceId: string }).invoiceId, "invoice-1");
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].entry?.[0]?.resource?.resourceType, "Invoice");
  const invoice = transactions[0].entry?.[0]?.resource;
  assert.equal(invoice?.resourceType === "Invoice" ? invoice.date : undefined, "2026-07-15T10:00:00.000Z");
  assert.equal(invoice?.resourceType === "Invoice" ? invoice.participant?.[0]?.actor.reference : undefined, "Practitioner/staff-1");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].eventType, "payment.charge.completed");
  assert.equal(audits[0].resourceType, "Invoice");
  assert.equal(audits[0].resourceId, "invoice-1");
  assert.match(audits[0].actionReason ?? "", /manual-record/);
  assert.equal(audits[0].eventTime, "2026-07-15T10:00:00.000Z");
});

test("CARD_MANUAL uses the same record-only Invoice transaction and never a processor path", async () => {
  const { deps, transactions } = fixture();
  const result = await handleRecordedTenderCollectionRequest(deps, {
    authHeader: "Bearer good",
    body: {
      patientReference: "Patient/patient-1",
      selectedOpenChargeLineIds: ["charge-1"],
      amountCents: 12_345,
      tender: "CARD_MANUAL",
    },
  });
  assert.equal(result.status, 200);
  const invoice = transactions[0].entry?.[0]?.resource;
  assert.equal(invoice?.resourceType, "Invoice");
  assert.equal(
    invoice?.extension?.find((extension) => extension.url.endsWith("/osod-payment-tender"))
      ?.valueCodeableConcept?.coding?.[0]?.code,
    "CARD_MANUAL",
  );
});

test("recorded optical collection threads date and verified staff into its Invoice", async () => {
  const { deps, transactions } = fixture();
  const result = await handleRecordedTenderCollectionRequest(deps, {
    authHeader: "Bearer good",
    body: {
      patientReference: "Patient/patient-1",
      selectedOpenChargeLineIds: ["charge-1"],
      amountCents: 12_345,
      tender: "CASH",
      opticalOrder: {
        patientReference: "Patient/patient-1",
        visionPrescriptionReference: "VisionPrescription/rx-1",
        orderHcpcsCode: "V2020",
        charges: [{ id: "charge-1", code: "V2020", feeCents: 12_345 }],
      },
    },
  });
  assert.equal(result.status, 200);
  const invoice = transactions[0].entry?.find((entry) => entry.resource?.resourceType === "Invoice")?.resource;
  assert.equal(invoice?.resourceType === "Invoice" ? invoice.date : undefined, "2026-07-15T10:00:00.000Z");
  assert.equal(invoice?.resourceType === "Invoice" ? invoice.participant?.[0]?.actor.reference : undefined, "Practitioner/staff-1");
});

test("recorded-tender collection rejects a non-integer cent amount before reading or writing FHIR", async () => {
  const { audits, deps, reads, transactions } = fixture();
  const result = await handleRecordedTenderCollectionRequest(deps, {
    authHeader: "Bearer good",
    body: {
      patientReference: "Patient/patient-1",
      selectedOpenChargeLineIds: ["charge-1"],
      amountCents: 123.45,
      tender: "CASH",
    },
  });
  assert.equal(result.status, 400);
  assert.match((result.body as { error: string }).error, /integer number of cents/);
  assert.equal(reads(), 0);
  assert.equal(transactions.length, 0);
  assert.equal(audits.length, 0);
});

test("recorded-tender collection returns 400 when amount does not equal the selected balance", async () => {
  const { audits, deps, transactions } = fixture();
  const result = await handleRecordedTenderCollectionRequest(deps, {
    authHeader: "Bearer good",
    body: {
      patientReference: "Patient/patient-1",
      selectedOpenChargeLineIds: ["charge-1"],
      amountCents: 12_344,
      tender: "CASH",
    },
  });
  assert.equal(result.status, 400);
  assert.match((result.body as { error: string }).error, /selected open-charge total/);
  assert.equal(transactions.length, 0);
  assert.equal(audits.length, 0);
});

function charge(id: string): ChargeItem {
  return {
    resourceType: "ChargeItem",
    id,
    status: "billable",
    code: { coding: [{ code: "V2020", display: "Frames" }] },
    subject: { reference: "Patient/patient-1" },
    occurrenceDateTime: "2026-07-15",
    priceOverride: { value: 123.45, currency: "USD" },
    supportingInformation: [{ reference: "DeviceRequest/order-1" }],
  };
}
