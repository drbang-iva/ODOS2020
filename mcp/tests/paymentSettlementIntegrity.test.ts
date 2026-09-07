import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, ChargeItem, Invoice, PaymentReconciliation, Resource } from "@medplum/fhirtypes";
import type { FhirSearchParams } from "../src/fhir-client.js";
import {
  handleOpenChargesRequest,
  handleRecordedTenderCollectionRequest,
  type OpenChargeLine,
  type PaymentCollectionHandlerDeps,
} from "../src/payments/payment-collection-handler.js";
import {
  HL7_PAYMENT_TYPE_SYSTEM,
  INSURANCE_CHARGE_ITEM_ALLOCATION_DETAIL_CODE,
  ODOS_INSURANCE_PAYMENT_DETAIL_LEVEL_SYSTEM,
} from "../src/payments/payment-reconciliation.js";
import { ODOS_PAYMENT_TENDER_EXTENSION_URL } from "../src/fhir/odosPaymentTender.js";
import { projectDayLedgerPayments } from "../src/desk/day-ledger.js";

const PATIENT_REFERENCE = "Patient/settlement-witness";

function fixture(input: {
  charges?: ChargeItem[];
  invoices?: Invoice[];
  payments?: PaymentReconciliation[];
} = {}): PaymentCollectionHandlerDeps {
  const charges = input.charges ?? [];
  const invoices = input.invoices ?? [];
  const payments = input.payments ?? [];
  return {
    authenticate: async () => ({
      staffReference: "Practitioner/staff-1",
      actorRole: "staff",
      roles: ["staff"],
      fhir: {
        read: async <T extends Resource>(_resourceType: T["resourceType"], id: string): Promise<T> => {
          const resource = charges.find((candidate) => candidate.id === id);
          if (!resource) throw new Error(`Missing fixture ChargeItem/${id}.`);
          return resource as T;
        },
        search: async <T extends Resource>(resourceType: T["resourceType"], _params: FhirSearchParams): Promise<Bundle<T>> => ({
          resourceType: "Bundle",
          type: "searchset",
          entry: (resourceType === "ChargeItem"
            ? charges
            : resourceType === "Invoice"
              ? invoices
              : resourceType === "PaymentReconciliation"
                ? payments
                : []).map((resource) => ({ resource: resource as T })),
        }),
        executeTransaction: async (): Promise<Bundle> => {
          throw new Error("Open-charge witnesses must not write FHIR resources.");
        },
      },
    }),
    recordAudit: async () => undefined,
  };
}

async function openLines(deps: PaymentCollectionHandlerDeps): Promise<OpenChargeLine[]> {
  const result = await handleOpenChargesRequest(deps, {
    authHeader: "Bearer synthetic",
    patientReference: PATIENT_REFERENCE,
  });
  assert.equal(result.status, 200);
  return result.body as OpenChargeLine[];
}

function charge(id: string, amountCents = 1_000): ChargeItem {
  return {
    resourceType: "ChargeItem",
    id,
    status: "billable",
    code: { text: id },
    subject: { reference: PATIENT_REFERENCE },
    occurrenceDateTime: "2026-09-07",
    priceOverride: { value: amountCents / 100, currency: "USD" },
  };
}

function invoice(id: string, lineItems: Array<{ chargeItemReference: string; amountCents: number }>): Invoice {
  const totalCents = lineItems.reduce((sum, line) => sum + line.amountCents, 0);
  return {
    resourceType: "Invoice",
    id,
    status: "issued",
    subject: { reference: PATIENT_REFERENCE },
    totalGross: { value: totalCents / 100, currency: "USD" },
    totalNet: { value: totalCents / 100, currency: "USD" },
    lineItem: lineItems.map((line) => ({
      chargeItemReference: { reference: line.chargeItemReference },
      priceComponent: [{
        type: "base",
        amount: { value: line.amountCents / 100, currency: "USD" },
      }],
    })),
  };
}

function allocation(
  id: string,
  requestReference: string,
  amountCents: number,
  detailCode?: string,
  paymentTypeCode = "payment",
): PaymentReconciliation {
  return {
    resourceType: "PaymentReconciliation",
    id,
    status: "active",
    outcome: "complete",
    created: "2026-09-07T12:00:00.000Z",
    paymentDate: "2026-09-07",
    paymentAmount: { value: Math.abs(amountCents) / 100, currency: "USD" },
    paymentIdentifier: { system: "https://synthetic.invalid/payment", value: id },
    detail: [{
      type: {
        coding: [
          { system: HL7_PAYMENT_TYPE_SYSTEM, code: paymentTypeCode },
          ...(detailCode ? [{
            system: ODOS_INSURANCE_PAYMENT_DETAIL_LEVEL_SYSTEM,
            code: detailCode,
          }] : []),
        ],
      },
      request: { reference: requestReference },
      amount: { value: amountCents / 100, currency: "USD" },
    }],
  };
}

function observed(lines: OpenChargeLine[], chargeIds: string[]): {
  openByCharge: Record<string, number | null>;
  openLineCount: number;
} {
  return {
    openByCharge: Object.fromEntries(chargeIds.map((id) => {
      const line = lines.find((candidate) => candidate.id === id);
      return [id, line ? line.openCents : 0];
    })),
    openLineCount: lines.length,
  };
}

test("A — $10 charge with no payments has 1000 open cents and one open line", async () => {
  const lines = await openLines(fixture({ charges: [charge("charge-a")] }));

  assert.deepEqual(observed(lines, ["charge-a"]), {
    openByCharge: { "charge-a": 1_000 },
    openLineCount: 1,
  });
});

test("B — a full discriminated ChargeItem allocation leaves zero open cents and no open line", async () => {
  const lines = await openLines(fixture({
    charges: [charge("charge-b")],
    payments: [allocation(
      "payment-b",
      "ChargeItem/charge-b",
      1_000,
      INSURANCE_CHARGE_ITEM_ALLOCATION_DETAIL_CODE,
    )],
  }));

  assert.deepEqual(observed(lines, ["charge-b"]), {
    openByCharge: { "charge-b": 0 },
    openLineCount: 0,
  });
});

test("C — a $4 discriminated ChargeItem allocation leaves 600 open cents and one open line", async () => {
  const lines = await openLines(fixture({
    charges: [charge("charge-c")],
    payments: [allocation(
      "payment-c",
      "ChargeItem/charge-c",
      400,
      INSURANCE_CHARGE_ITEM_ALLOCATION_DETAIL_CODE,
    )],
  }));

  assert.deepEqual(observed(lines, ["charge-c"]), {
    openByCharge: { "charge-c": 600 },
    openLineCount: 1,
  });
});

test("D — a $1 invoice allocation leaves its $10 line visible as ambiguous", async () => {
  const lines = await openLines(fixture({
    charges: [charge("charge-d")],
    invoices: [invoice("invoice-d", [{ chargeItemReference: "ChargeItem/charge-d", amountCents: 1_000 }])],
    payments: [allocation("payment-d", "Invoice/invoice-d", 100)],
  }));

  assert.deepEqual(observed(lines, ["charge-d"]), {
    openByCharge: { "charge-d": null },
    openLineCount: 1,
  });
  assert.match(lines[0]?.ambiguityReason ?? "", /Invoice\/invoice-d.*partial.*100.*1000/i);
});

test("an Invoice reference without the payment discriminator does not settle or obscure its charge", async () => {
  const lines = await openLines(fixture({
    charges: [charge("charge-discriminator")],
    invoices: [invoice("invoice-discriminator", [{
      chargeItemReference: "ChargeItem/charge-discriminator",
      amountCents: 1_000,
    }])],
    payments: [allocation(
      "payment-discriminator",
      "Invoice/invoice-discriminator",
      100,
      undefined,
      "adjustment",
    )],
  }));

  assert.deepEqual(observed(lines, ["charge-discriminator"]), {
    openByCharge: { "charge-discriminator": 1_000 },
    openLineCount: 1,
  });
  assert.equal(lines[0]?.ambiguityReason, undefined);
});

test("E — invoice allocations totalling $10 leave zero open cents and no open line", async () => {
  const lines = await openLines(fixture({
    charges: [charge("charge-e")],
    invoices: [invoice("invoice-e", [{ chargeItemReference: "ChargeItem/charge-e", amountCents: 1_000 }])],
    payments: [
      allocation("payment-e-1", "Invoice/invoice-e", 400),
      allocation("payment-e-2", "Invoice/invoice-e", 600),
    ],
  }));

  assert.deepEqual(observed(lines, ["charge-e"]), {
    openByCharge: { "charge-e": 0 },
    openLineCount: 0,
  });
});

test("F — a direct allocation closes only its line on a two-line invoice", async () => {
  const lines = await openLines(fixture({
    charges: [charge("charge-f-paid"), charge("charge-f-open")],
    invoices: [invoice("invoice-f", [
      { chargeItemReference: "ChargeItem/charge-f-paid", amountCents: 1_000 },
      { chargeItemReference: "ChargeItem/charge-f-open", amountCents: 1_000 },
    ])],
    payments: [allocation(
      "payment-f",
      "ChargeItem/charge-f-paid",
      1_000,
      INSURANCE_CHARGE_ITEM_ALLOCATION_DETAIL_CODE,
    )],
  }));

  assert.deepEqual(observed(lines, ["charge-f-paid", "charge-f-open"]), {
    openByCharge: { "charge-f-paid": 0, "charge-f-open": 1_000 },
    openLineCount: 1,
  });
});

test("G — a record-only tender on a balanced invoice leaves zero open cents and no open line", async () => {
  const tendered = invoice("invoice-g", [{ chargeItemReference: "ChargeItem/charge-g", amountCents: 1_000 }]);
  tendered.status = "balanced";
  tendered.extension = [{
    url: ODOS_PAYMENT_TENDER_EXTENSION_URL,
    valueCodeableConcept: { coding: [{ code: "CASH" }] },
  }];
  const lines = await openLines(fixture({ charges: [charge("charge-g")], invoices: [tendered] }));

  assert.deepEqual(observed(lines, ["charge-g"]), {
    openByCharge: { "charge-g": 0 },
    openLineCount: 0,
  });
});

test("J — a reversing allocation restores the reversed amount to the open charge", async () => {
  const lines = await openLines(fixture({
    charges: [charge("charge-j")],
    payments: [
      allocation(
        "payment-j-original",
        "ChargeItem/charge-j",
        1_000,
        INSURANCE_CHARGE_ITEM_ALLOCATION_DETAIL_CODE,
      ),
      allocation(
        "payment-j-reversal",
        "ChargeItem/charge-j",
        -400,
        INSURANCE_CHARGE_ITEM_ALLOCATION_DETAIL_CODE,
      ),
    ],
  }));

  assert.deepEqual(observed(lines, ["charge-j"]), {
    openByCharge: { "charge-j": 400 },
    openLineCount: 1,
  });
});

test("over-attribution stays visible as a named nonnegative warning", async () => {
  const lines = await openLines(fixture({
    charges: [charge("charge-over")],
    payments: [allocation(
      "payment-over",
      "ChargeItem/charge-over",
      1_100,
      INSURANCE_CHARGE_ITEM_ALLOCATION_DETAIL_CODE,
    )],
  }));

  assert.deepEqual(observed(lines, ["charge-over"]), {
    openByCharge: { "charge-over": 0 },
    openLineCount: 1,
  });
  assert.match(lines[0]?.attributionWarning ?? "", /ChargeItem\/charge-over.*1100.*1000/i);
});

interface CollectionHarness {
  audits: unknown[];
  deps: PaymentCollectionHandlerDeps;
  invoices: Invoice[];
  transactionCount(): number;
}

function collectionFixture(options: {
  concurrentWrites?: number;
  invoices?: Invoice[];
  payments?: PaymentReconciliation[];
} = {}): CollectionHarness {
  const charges = [charge("charge-collection")];
  const invoices: Invoice[] = options.invoices ? [...options.invoices] : [];
  const payments = options.payments ?? [];
  const audits: unknown[] = [];
  let transactionCount = 0;
  let waitingWrites = 0;
  let releaseWrites: (() => void) | undefined;
  const writesReady = new Promise<void>((resolve) => { releaseWrites = resolve; });
  const awaitConcurrentWrites = async (): Promise<void> => {
    if (!options.concurrentWrites) return;
    waitingWrites += 1;
    if (waitingWrites === options.concurrentWrites) releaseWrites?.();
    await writesReady;
  };
  const fhir = {
    read: async <T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> => {
      const resource = resourceType === "Invoice"
        ? invoices.find((candidate) => candidate.id === id)
        : charges.find((candidate) => candidate.id === id);
      if (!resource) throw new Error(`Missing fixture ${String(resourceType)}/${id}.`);
      return resource as T;
    },
    search: async <T extends Resource>(resourceType: T["resourceType"], params: FhirSearchParams): Promise<Bundle<T>> => {
      const query = params instanceof URLSearchParams ? params : new URLSearchParams(params);
      let resources: Resource[] = [];
      if (resourceType === "ChargeItem") resources = charges;
      if (resourceType === "PaymentReconciliation") resources = payments;
      if (resourceType === "Invoice") {
        const identifier = query.get("identifier");
        resources = identifier
          ? invoices.filter((candidate) => candidate.identifier?.some(
            (value) => `${value.system}|${value.value}` === identifier,
          ))
          : invoices;
      }
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: resources.map((resource) => ({ resource: resource as T })),
      };
    },
    executeTransaction: async (bundle: Bundle): Promise<Bundle> => {
      transactionCount += 1;
      await awaitConcurrentWrites();
      const entry = bundle.entry?.[0];
      assert.equal(entry?.resource?.resourceType, "Invoice");
      const candidate = entry.resource as Invoice;
      const condition = entry.request?.ifNoneExist;
      const existing = condition?.startsWith("identifier=")
        ? invoices.find((invoice) => invoice.identifier?.some(
          (value) => `${value.system}|${value.value}` === condition.slice("identifier=".length),
        ))
        : undefined;
      if (existing?.id) {
        return transactionResponse("200 OK", existing.id);
      }
      const created = { ...candidate, id: `invoice-${invoices.length + 1}` };
      invoices.push(created);
      return transactionResponse("201 Created", created.id!);
    },
  };
  return {
    audits,
    invoices,
    transactionCount: () => transactionCount,
    deps: {
      authenticate: async () => ({
        staffReference: "Practitioner/staff-1",
        actorRole: "staff",
        roles: ["staff"],
        fhir,
      }),
      recordAudit: async (row) => { audits.push(row); },
      now: () => "2026-09-07T12:00:00.000Z",
      timeZone: "America/New_York",
    },
  };
}

function transactionResponse(status: string, invoiceId: string): Bundle {
  return {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [{ response: { status, location: `Invoice/${invoiceId}/_history/1` } }],
  };
}

function collectionBody(requestId: string): Record<string, unknown> {
  return {
    requestId,
    patientReference: PATIENT_REFERENCE,
    selectedOpenChargeLineIds: ["charge-collection"],
    amountCents: 1_000,
    tender: "CASH",
  };
}

test("H — concurrent replay with the same requestId returns one Invoice and reports one replay", async () => {
  const harness = collectionFixture({ concurrentWrites: 2 });
  const requestId = "11111111-1111-4111-8111-111111111111";

  const [first, replay] = await Promise.all([
    handleRecordedTenderCollectionRequest(harness.deps, {
      authHeader: "Bearer synthetic",
      body: collectionBody(requestId),
    }),
    handleRecordedTenderCollectionRequest(harness.deps, {
      authHeader: "Bearer synthetic",
      body: collectionBody(requestId),
    }),
  ]);

  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(harness.invoices.length, 1);
  assert.deepEqual(
    [first, replay].map((result) => (result.body as { replayed: boolean }).replayed).sort(),
    [false, true],
  );
  assert.deepEqual(
    [first, replay].map((result) => (result.body as { invoiceId: string }).invoiceId),
    ["invoice-1", "invoice-1"],
  );
  assert.equal(harness.audits.length, 1);
  assert.equal(projectDayLedgerPayments(harness.invoices, "2026-09-07", "America/New_York").totalCents, 1_000);
});

test("concurrent reuse of one requestId for different collection details refuses the collision", async () => {
  const harness = collectionFixture({ concurrentWrites: 2 });
  const requestId = "99999999-9999-4999-8999-999999999999";

  const results = await Promise.all([
    handleRecordedTenderCollectionRequest(harness.deps, {
      authHeader: "Bearer synthetic",
      body: collectionBody(requestId),
    }),
    handleRecordedTenderCollectionRequest(harness.deps, {
      authHeader: "Bearer synthetic",
      body: { ...collectionBody(requestId), tender: "CHECK" },
    }),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
  assert.match(
    (results.find((result) => result.status === 400)?.body as { error: string }).error,
    /requestId .*already used for a different collection/i,
  );
  assert.equal(harness.invoices.length, 1);
  assert.equal(harness.audits.length, 1);
});

test("I — a different requestId cannot recollect a charge settled by the first request", async () => {
  const harness = collectionFixture();
  const first = await handleRecordedTenderCollectionRequest(harness.deps, {
    authHeader: "Bearer synthetic",
    body: collectionBody("22222222-2222-4222-8222-222222222222"),
  });

  const second = await handleRecordedTenderCollectionRequest(harness.deps, {
    authHeader: "Bearer synthetic",
    body: collectionBody("33333333-3333-4333-8333-333333333333"),
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 400);
  assert.match((second.body as { error: string }).error, /ChargeItem\/charge-collection.*zero open amount/i);
  assert.equal(harness.invoices.length, 1);
});

test("collection refuses an ambiguous charge with its id and ambiguity reason", async () => {
  const harness = collectionFixture({
    invoices: [invoice("invoice-ambiguous", [{
      chargeItemReference: "ChargeItem/charge-collection",
      amountCents: 1_000,
    }])],
    payments: [allocation("payment-ambiguous", "Invoice/invoice-ambiguous", 100)],
  });

  const result = await handleRecordedTenderCollectionRequest(harness.deps, {
    authHeader: "Bearer synthetic",
    body: collectionBody("77777777-7777-4777-8777-777777777777"),
  });

  assert.equal(result.status, 400);
  assert.match(
    (result.body as { error: string }).error,
    /ChargeItem\/charge-collection cannot be collected because its open amount is ambiguous: Invoice\/invoice-ambiguous.*partial/i,
  );
  assert.equal(harness.transactionCount(), 0);
});

test("collection refuses an over-attributed charge with its id and attribution reason", async () => {
  const harness = collectionFixture({
    payments: [allocation(
      "payment-over-collection",
      "ChargeItem/charge-collection",
      1_100,
      INSURANCE_CHARGE_ITEM_ALLOCATION_DETAIL_CODE,
    )],
  });

  const result = await handleRecordedTenderCollectionRequest(harness.deps, {
    authHeader: "Bearer synthetic",
    body: collectionBody("88888888-8888-4888-8888-888888888888"),
  });

  assert.equal(result.status, 400);
  assert.match(
    (result.body as { error: string }).error,
    /ChargeItem\/charge-collection cannot be collected because attributed payments exceed the charge amount:.*1100.*1000/i,
  );
  assert.equal(harness.transactionCount(), 0);
});

test("different requestIds can both collect the same charge concurrently at the in-memory boundary", async () => {
  const harness = collectionFixture({ concurrentWrites: 2 });

  const results = await Promise.all([
    handleRecordedTenderCollectionRequest(harness.deps, {
      authHeader: "Bearer synthetic",
      body: collectionBody("44444444-4444-4444-8444-444444444444"),
    }),
    handleRecordedTenderCollectionRequest(harness.deps, {
      authHeader: "Bearer synthetic",
      body: collectionBody("55555555-5555-4555-8555-555555555555"),
    }),
  ]);

  assert.deepEqual(results.map((result) => result.status), [200, 200]);
  assert.deepEqual(results.map((result) => (result.body as { replayed: boolean }).replayed), [false, false]);
  assert.equal(harness.invoices.length, 2);
});

test("recorded-tender collection requires a client-supplied UUID requestId", async () => {
  const harness = collectionFixture();

  const missing = await handleRecordedTenderCollectionRequest(harness.deps, {
    authHeader: "Bearer synthetic",
    body: { ...collectionBody("66666666-6666-4666-8666-666666666666"), requestId: undefined },
  });
  const malformed = await handleRecordedTenderCollectionRequest(harness.deps, {
    authHeader: "Bearer synthetic",
    body: collectionBody("not-a-uuid"),
  });

  assert.equal(missing.status, 400);
  assert.match((missing.body as { error: string }).error, /requestId.*UUID/i);
  assert.equal(malformed.status, 400);
  assert.match((malformed.body as { error: string }).error, /requestId.*UUID/i);
  assert.equal(harness.transactionCount(), 0);
});
