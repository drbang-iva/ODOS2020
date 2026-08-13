import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Invoice, PaymentReconciliation, Resource } from "@medplum/fhirtypes";
import {
  handleApplyCreditRequest,
  handlePaymentReconciliationsRequest,
  handleTransferCreditRequest,
  handleVoidCreditRequest,
  type PatientPaymentRow,
  type PaymentCreditHandlerDeps,
} from "../src/payments/payment-credit-handler.js";
import { createPaymentDispatch } from "../src/payments/payment-config.js";
import { buildPaymentReconciliation } from "../src/payments/payment-reconciliation.js";

test("patient payment list uses the credit service split and batch-enriches linked Invoices", async () => {
  const fixture = setup();
  const result = await list(fixture.deps);

  assert.equal(result.status, 200);
  const [row] = rows(result);
  assert.equal(row.amountCents, 10_000);
  assert.equal(row.allocatedCents, 4_000);
  assert.equal(row.unappliedCents, 6_000);
  assert.deepEqual(row.invoices, [{ reference: "Invoice/invoice-a", label: "INV-A", status: "issued" }]);
  assert.equal(fixture.invoiceSearchCalls(), 1);
});

test("apply and transfer mutations are visible on the next patient payment fetch", async () => {
  const fixture = setup();
  const applied = await handleApplyCreditRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: {
      paymentReconciliationReference: "PaymentReconciliation/payment-1",
      invoiceReference: "Invoice/invoice-b",
      amountCents: 2_000,
    },
  });
  assert.equal(applied.status, 200);
  let [row] = rows(await list(fixture.deps));
  assert.equal(row.unappliedCents, 4_000);
  assert.deepEqual(row.invoices.map((invoice) => invoice.reference), ["Invoice/invoice-a", "Invoice/invoice-b"]);

  const transferred = await handleTransferCreditRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: {
      paymentReconciliationReference: "PaymentReconciliation/payment-1",
      fromInvoiceReference: "Invoice/invoice-a",
      toInvoiceReference: "Invoice/invoice-c",
      reason: "allocation correction",
    },
  });
  assert.equal(transferred.status, 200);
  [row] = rows(await list(fixture.deps));
  assert.deepEqual(row.invoices.map((invoice) => invoice.reference), ["Invoice/invoice-b", "Invoice/invoice-c"]);
  assert.equal(row.allocatedCents, 6_000);
  assert.equal(row.unappliedCents, 4_000);
});

test("void eligibility is hidden outside the same-day window and the handler returns the backend reason", async () => {
  const fixture = setup({ now: "2026-07-11T12:00:00.000Z" });
  fixture.setRole("admin");
  const [row] = rows(await list(fixture.deps));
  assert.equal(row.canVoid, false);

  const result = await handleVoidCreditRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: {
      paymentReconciliationReference: "PaymentReconciliation/payment-1",
      method: "manual-cash",
    },
  });
  assert.equal(result.status, 400);
  assert.equal((result.body as { error: string }).error, "Phase 6a permits only same-day voids.");
});

test("patient payment list requires a bounded patient and enforces payment.charge", async () => {
  const fixture = setup();
  assert.equal((await handlePaymentReconciliationsRequest(fixture.deps, {
    authHeader: "Bearer good",
  })).status, 400);
  assert.equal((await handlePaymentReconciliationsRequest(fixture.deps, {
    authHeader: undefined,
    query: { patientReference: "Patient/patient-1" },
  })).status, 401);
  assert.deepEqual(rows(await handlePaymentReconciliationsRequest(fixture.deps, {
    authHeader: "Bearer good",
    query: { patientReference: "Patient/patient-1", startDate: "2026-07-11" },
  })), []);
  assert.equal((await handlePaymentReconciliationsRequest(fixture.deps, {
    authHeader: "Bearer good",
    query: { patientReference: "Patient/patient-1", startDate: "2026-02-31" },
  })).status, 400);

  fixture.setRole(undefined);
  const forbidden = await handlePaymentReconciliationsRequest(fixture.deps, {
    authHeader: "Bearer good",
    query: { patientReference: "Patient/patient-1" },
  });
  assert.deepEqual(forbidden, { status: 403, body: { error: "billing-context.read role required" } });
});

function setup(options: { now?: string } = {}) {
  let role: "staff" | "provider" | "admin" | undefined = "staff";
  let payment = {
    ...buildPaymentReconciliation({
      outcome: "success",
      createdIso: "2026-07-10T10:00:00.000Z",
      paymentDate: "2026-07-10",
      amountCents: 10_000,
      subjectReference: "Patient/patient-1",
      allocations: [{ invoiceReference: "Invoice/invoice-a", amountCents: 4_000 }],
      staffReference: "Practitioner/staff-1",
      processorTransactionId: "cash-1",
      processorTransactionSystem: "https://odos2020.com/fhir/NamingSystem/manual-payment",
      surface: "manual",
      tender: { code: "CASH", display: "Cash" },
    }),
    id: "payment-1",
    meta: { versionId: "1" },
  };
  const invoices: Invoice[] = [
    invoice("invoice-a", "INV-A"),
    invoice("invoice-b", "INV-B"),
    invoice("invoice-c", "INV-C"),
  ];
  let invoiceSearchCalls = 0;
  const fhir = {
    read: async <T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> => {
      if (resourceType === "PaymentReconciliation" && id === payment.id) return structuredClone(payment) as T;
      const found = invoices.find((candidate) => candidate.resourceType === resourceType && candidate.id === id);
      if (!found) throw new Error(`${resourceType}/${id} not found`);
      return structuredClone(found) as T;
    },
    search: async <T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> => {
      if (resourceType === "PaymentReconciliation") {
        return bundle([structuredClone(payment) as T]);
      }
      if (resourceType === "Invoice") {
        invoiceSearchCalls += 1;
        const ids = new Set((params._id ?? "").split(","));
        return bundle(invoices.filter((candidate) => candidate.id && ids.has(candidate.id)).map((candidate) => candidate as T));
      }
      return bundle([]);
    },
    update: async <T extends Resource>(
      _resourceType: T["resourceType"],
      _id: string,
      next: T,
      headers?: Record<string, string>,
    ): Promise<T> => {
      assert.equal(headers?.["If-Match"], `W/"${payment.meta?.versionId}"`);
      payment = {
        ...(next as PaymentReconciliation),
        id: "payment-1",
        meta: { versionId: String(Number(payment.meta?.versionId) + 1) },
      };
      return structuredClone(payment) as T;
    },
    create: async <T extends Resource>(resource: T): Promise<T> => resource,
  };
  const deps: PaymentCreditHandlerDeps = {
    authenticate: async (header) => header === "Bearer good"
      ? { staffReference: "Practitioner/staff-1", actorRole: role ?? "admin", roles: role ? [role] : [], fhir: fhir as never }
      : null,
    lifecycleFhir: fhir,
    dispatch: createPaymentDispatch([{ method: "manual-cash" }]),
    recordAudit: async () => undefined,
    now: () => options.now ?? "2026-07-10T12:00:00.000Z",
  };
  return {
    deps,
    invoiceSearchCalls: () => invoiceSearchCalls,
    setRole: (next: "staff" | "provider" | "admin" | undefined) => { role = next; },
  };
}

async function list(deps: PaymentCreditHandlerDeps) {
  return handlePaymentReconciliationsRequest(deps, {
    authHeader: "Bearer good",
    query: { patientReference: "Patient/patient-1" },
  });
}

function rows(result: { body: unknown }): PatientPaymentRow[] {
  return (result.body as { items: PatientPaymentRow[] }).items;
}

function invoice(id: string, identifier: string): Invoice {
  return {
    resourceType: "Invoice",
    id,
    status: "issued",
    subject: { reference: "Patient/patient-1" },
    identifier: [{ value: identifier }],
  };
}

function bundle<T extends Resource>(resources: T[]): Bundle<T> {
  return { resourceType: "Bundle", type: "searchset", entry: resources.map((resource) => ({ resource })) };
}
