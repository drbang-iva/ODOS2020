import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, ChargeItem, Resource } from "@medplum/fhirtypes";
import type { OdosAuditEventRecord } from "../src/authz/odosAudit.js";
import type { FhirSearchParams } from "../src/fhir-client.js";
import { ODOS_UNPRICED_CHARGE_EXTENSION_URL } from "../src/clinical-graph/procedure-fee-schedule.js";
import {
  handleRecordedTenderCollectionRequest,
  handleOpenChargesRequest,
  type PaymentCollectionHandlerDeps,
} from "../src/payments/payment-collection-handler.js";

function fixture(
  searchEntries: ChargeItem[] = [],
  sealed = false,
  now = "2026-07-15T10:00:00.000Z",
  timeZone = "America/New_York",
) {
  const audits: OdosAuditEventRecord[] = [];
  const transactions: Bundle[] = [];
  const searches: Array<{ resourceType: string; params: URLSearchParams }> = [];
  let reads = 0;
  const fhir = {
    read: async <T extends Resource>(_type: T["resourceType"], id: string): Promise<T> => {
      reads += 1;
      return (searchEntries.find((resource) => resource.id === id) ?? charge(id)) as T;
    },
    search: async <T extends Resource>(resourceType: T["resourceType"], params: FhirSearchParams): Promise<Bundle<T>> => {
      searches.push({ resourceType: String(resourceType), params: new URLSearchParams(params) });
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: resourceType === "ChargeItem"
          ? searchEntries.map((resource) => ({ resource: resource as T }))
          : resourceType === "Basic" && sealed ? [{ resource: daySeal() as T }] : [],
      };
    },
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
      actorRole: "staff",
      roles: ["staff"],
      fhir,
    } : null,
    recordAudit: async (row) => { audits.push(row); },
    now: () => now,
    timeZone,
  };
  return { audits, deps, reads: () => reads, searches, transactions };
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
  const nonbillable = { ...charge("charge-closed"), status: "billed" as const };
  const { deps } = fixture([charge("charge-1"), nonbillable]);
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
      unpriced: false,
      code: "V2020",
      feeCents: 12_345,
    }],
  });
});

test("open charges flags a materialized zero-dollar charge whose fee schedule entry is missing", async () => {
  const unpriced = {
    ...charge("charge-unpriced"),
    priceOverride: { value: 0, currency: "USD" },
    extension: [{ url: ODOS_UNPRICED_CHARGE_EXTENSION_URL, valueBoolean: true }],
  };
  const { deps } = fixture([unpriced]);

  const result = await handleOpenChargesRequest(deps, {
    authHeader: "Bearer good",
    patientReference: "Patient/patient-1",
  });

  assert.equal(result.status, 200);
  assert.deepEqual((result.body as Array<{ id: string; amountCents: number; unpriced: boolean }>)[0], {
    id: "charge-unpriced",
    amountCents: 0,
    description: "Frames",
    date: "2026-07-15",
    source: "optical",
    unpriced: true,
    code: "V2020",
    feeCents: 0,
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
    invoice?.extension?.find((extension) => extension.url.endsWith("/odos-payment-tender"))
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
        patientReference: "patient-1",
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

test("recorded-tender collection blocks a named unpriced charge before creating an Invoice", async () => {
  const unpriced = {
    ...charge("charge-unpriced"),
    priceOverride: { value: 0, currency: "USD" },
    extension: [{ url: ODOS_UNPRICED_CHARGE_EXTENSION_URL, valueBoolean: true }],
  };
  const { audits, deps, reads, transactions } = fixture([unpriced]);

  const result = await handleRecordedTenderCollectionRequest(deps, {
    authHeader: "Bearer good",
    body: {
      patientReference: "Patient/patient-1",
      selectedOpenChargeLineIds: ["charge-unpriced"],
      amountCents: 0,
      tender: "CASH",
    },
  });

  assert.equal(result.status, 400);
  assert.match(
    (result.body as { error: string }).error,
    /ChargeItem\/charge-unpriced \(Frames\) requires a fee schedule entry before it can be collected\./,
  );
  assert.equal(reads(), 1);
  assert.equal(transactions.length, 0);
  assert.equal(audits.length, 0);
});

test("recorded-tender collection still rejects an unmarked zero-dollar charge", async () => {
  const zero = {
    ...charge("charge-zero"),
    priceOverride: { value: 0, currency: "USD" },
  };
  const { audits, deps, transactions } = fixture([zero]);

  const result = await handleRecordedTenderCollectionRequest(deps, {
    authHeader: "Bearer good",
    body: {
      patientReference: "Patient/patient-1",
      selectedOpenChargeLineIds: ["charge-zero"],
      amountCents: 0,
      tender: "CASH",
    },
  });

  assert.deepEqual(result, {
    status: 400,
    body: { error: "amountCents must be a positive integer number of cents." },
  });
  assert.equal(transactions.length, 0);
  assert.equal(audits.length, 0);
});

test("recorded-tender collection rejects all record-only tenders after the day is sealed", async () => {
  for (const tender of ["CASH", "CHECK", "CARD_MANUAL"] as const) {
    const { audits, deps, reads, transactions } = fixture([], true);
    const result = await handleRecordedTenderCollectionRequest(deps, {
      authHeader: "Bearer good",
      body: {
        patientReference: "Patient/patient-1",
        selectedOpenChargeLineIds: ["charge-1"],
        amountCents: 12_345,
        tender,
      },
    });
    assert.equal(result.status, 409);
    assert.match((result.body as { error: string }).error, /already sealed.*payments can't be backdated/i);
    assert.equal(reads(), 0);
    assert.equal(transactions.length, 0);
    assert.equal(audits.length, 0);
  }
});

test("recorded-tender collection checks the practice-local seal date across a UTC boundary", async () => {
  const { deps, searches, transactions } = fixture([], true, "2026-07-16T01:30:00.000Z");
  const result = await handleRecordedTenderCollectionRequest(deps, {
    authHeader: "Bearer good",
    body: {
      patientReference: "Patient/patient-1",
      selectedOpenChargeLineIds: ["charge-1"],
      amountCents: 12_345,
      tender: "CASH",
    },
  });
  assert.equal(result.status, 409);
  assert.equal(transactions.length, 0);
  assert.equal(
    searches.find((search) => search.resourceType === "Basic")?.params.get("identifier"),
    "https://odos2020.com/fhir/NamingSystem/day-seal-date|2026-07-15",
  );
});

function daySeal(): Basic {
  return {
    resourceType: "Basic",
    id: "seal-1",
    identifier: [{ system: "https://odos2020.com/fhir/NamingSystem/day-seal-date", value: "2026-07-15" }],
    code: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/day-seal", code: "day-seal" }] },
    created: "2026-07-15",
    author: { reference: "Practitioner/staff-1" },
    extension: [{ url: "https://odos2020.com/fhir/StructureDefinition/day-seal-timestamp", valueInstant: "2026-07-15T21:00:00.000Z" }],
  };
}

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
