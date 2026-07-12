import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Invoice, Patient, PaymentReconciliation, Resource, Task } from "@medplum/fhirtypes";
import { buildPaymentReconciliation } from "../src/payments/payment-reconciliation.js";
import {
  buildStatementSnapshot,
  handleRunStatementsRequest,
  handleStatementListRequest,
  PATIENT_STATEMENT_CODE,
  STATEMENT_OUTPUT_CODE_SYSTEM,
  STATEMENT_RUN_CODE,
  STATEMENT_TASK_CODE_SYSTEM,
  type StatementRunResult,
} from "../src/statements/statements.js";

const GENERATED_AT = "2026-07-12T15:00:00.000Z";

test("a partial payment produces a balance-forward statement exactly reconciled to its Invoice", () => {
  const statement = buildStatementSnapshot({
    patient: patient("p1", "Alex Rivera"),
    invoices: [invoice("i1", "p1", 10_000)],
    paymentReconciliations: [payment("pay-1", "p1", "i1", 4_000)],
    generatedAt: GENERATED_AT,
  });
  assert.equal(statement.totalNetCents, 10_000);
  assert.equal(statement.paymentsAppliedCents, 4_000);
  assert.equal(statement.balanceCents, 6_000);
  assert.deepEqual(statement.invoices.map((row) => row.balanceCents), [6_000]);
});

test("an internally inconsistent Invoice is rejected instead of emitting a wrong balance", () => {
  const inconsistent = invoice("i1", "p1", 10_000);
  inconsistent.totalNet = { value: 99, currency: "USD" };
  assert.throws(() => buildStatementSnapshot({
    patient: patient("p1", "Alex Rivera"),
    invoices: [inconsistent],
    paymentReconciliations: [],
    generatedAt: GENERATED_AT,
  }), /does not reconcile/);
});

test("batch persists one atomic run, generates every open balance, skips zero balances, and records invalid rejects", async () => {
  const fixture = fakeFhir({
    patients: [patient("p1", "Alex Rivera"), patient("p2", "Jordan Lee"), patient("p3", "Sam Patel")],
    invoices: [invoice("i1", "p1", 10_000), invoice("i2", "p2", 5_000), inconsistentInvoice("i3", "p3")],
    payments: [payment("pay-1", "p1", "i1", 4_000), payment("pay-2", "p2", "i2", 5_000)],
  });
  const result = await handleRunStatementsRequest({
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "front-desk", fhir: fixture.fhir }),
    now: () => GENERATED_AT,
    generateId: sequentialIds(),
  }, { authHeader: "Bearer good" });
  assert.equal(result.status, 200);
  const run = result.body as StatementRunResult;
  assert.equal(run.generatedCount, 1);
  assert.equal(run.skippedZeroBalanceCount, 1);
  assert.equal(run.invalidRejects, 1);
  assert.equal(run.statements[0].patientReference, "Patient/p1");
  assert.equal(run.statements[0].balanceCents, 6_000);
  assert.match(run.rejects[0].reason, /does not reconcile/);
  assert.equal(fixture.transactions.length, 1);
  assert.equal(fixture.storedTasks.filter((task) => code(task) === STATEMENT_RUN_CODE).length, 1);
  assert.equal(fixture.storedTasks.filter((task) => code(task) === PATIENT_STATEMENT_CODE && task.status === "completed").length, 1);
  assert.equal(fixture.storedTasks.filter((task) => code(task) === PATIENT_STATEMENT_CODE && task.status === "failed").length, 1);
  const runTask = fixture.storedTasks.find((task) => code(task) === STATEMENT_RUN_CODE)!;
  assert.equal(runTask.authoredOn, GENERATED_AT);
  assert.equal(outputInteger(runTask, "generated-count"), 1);
  assert.equal(outputInteger(runTask, "invalid-reject-count"), 1);
});

test("statement list returns completed snapshots newest-first and never exposes failed reject Tasks", async () => {
  const fixture = fakeFhir({ patients: [], invoices: [], payments: [] });
  fixture.storedTasks.push(statementTask("old", "2026-07-11T10:00:00.000Z"), statementTask("new", GENERATED_AT), {
    ...statementTask("reject", "2026-07-13T10:00:00.000Z"), status: "failed",
  });
  const result = await handleStatementListRequest({
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "front-desk", fhir: fixture.fhir }),
  }, { authHeader: "Bearer good" });
  assert.equal(result.status, 200);
  const items = (result.body as { items: Array<{ statementReference: string }> }).items;
  assert.deepEqual(items.map((item) => item.statementReference), ["Task/new", "Task/old"]);
});

function fakeFhir(input: { patients: Patient[]; invoices: Invoice[]; payments: PaymentReconciliation[] }) {
  const transactions: Bundle[] = [];
  const storedTasks: Task[] = [];
  const fhir = {
    search: async <T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> => {
      const rows = resourceType === "Patient" ? input.patients
        : resourceType === "Invoice" ? input.invoices
          : resourceType === "PaymentReconciliation" ? input.payments
            : resourceType === "Task" ? storedTasks
              : [];
      return { resourceType: "Bundle", type: "searchset", entry: rows.map((resource) => ({ resource: structuredClone(resource) as T })) };
    },
    executeTransaction: async (bundle: Bundle): Promise<Bundle> => {
      transactions.push(structuredClone(bundle));
      const entries = bundle.entry ?? [];
      entries.forEach((entry, index) => {
        if (entry.resource?.resourceType === "Task") storedTasks.push({ ...(structuredClone(entry.resource) as Task), id: `stored-${index + 1}` });
      });
      return {
        resourceType: "Bundle",
        type: "transaction-response",
        entry: entries.map((_, index) => ({ response: { status: "201", location: `Task/stored-${index + 1}/_history/1` } })),
      };
    },
  };
  return { fhir, transactions, storedTasks };
}

function patient(id: string, text: string): Patient {
  return { resourceType: "Patient", id, name: [{ text }] };
}

function invoice(id: string, patientId: string, netCents: number): Invoice {
  return {
    resourceType: "Invoice",
    id,
    status: "issued",
    subject: { reference: `Patient/${patientId}` },
    date: "2026-07-01T12:00:00.000Z",
    lineItem: [{ sequence: 1, priceComponent: [{ type: "base", amount: { value: netCents / 100, currency: "USD" } }] }],
    totalGross: { value: netCents / 100, currency: "USD" },
    totalNet: { value: netCents / 100, currency: "USD" },
  };
}

function inconsistentInvoice(id: string, patientId: string): Invoice {
  return { ...invoice(id, patientId, 8_000), totalNet: { value: 70, currency: "USD" } };
}

function payment(id: string, patientId: string, invoiceId: string, amountCents: number): PaymentReconciliation {
  return {
    ...buildPaymentReconciliation({
      outcome: "success",
      createdIso: "2026-07-02T12:00:00.000Z",
      paymentDate: "2026-07-02",
      amountCents,
      subjectReference: `Patient/${patientId}`,
      invoiceReference: `Invoice/${invoiceId}`,
      processorTransactionId: id,
      processorTransactionSystem: "https://osod.dev/test/payment",
      surface: "in-clinic",
      tender: { code: "CASH", display: "Cash" },
    }),
    id,
  };
}

function statementTask(id: string, generatedAt: string): Task {
  const snapshot = buildStatementSnapshot({ patient: patient("p1", "Alex Rivera"), invoices: [invoice("i1", "p1", 10_000)], paymentReconciliations: [], generatedAt });
  return {
    resourceType: "Task", id, status: "completed", intent: "order", authoredOn: generatedAt,
    code: { coding: [{ system: STATEMENT_TASK_CODE_SYSTEM, code: PATIENT_STATEMENT_CODE }] },
    for: { reference: "Patient/p1" },
    output: [
      { type: { coding: [{ system: STATEMENT_OUTPUT_CODE_SYSTEM, code: "snapshot" }] }, valueString: JSON.stringify(snapshot) },
      { type: { coding: [{ system: STATEMENT_OUTPUT_CODE_SYSTEM, code: "balance" }] }, valueMoney: { value: 100, currency: "USD" } },
    ],
  };
}

function code(task: Task): string | undefined {
  return task.code?.coding?.find((coding) => coding.system === STATEMENT_TASK_CODE_SYSTEM)?.code;
}

function outputInteger(task: Task, codeValue: string): number | undefined {
  return task.output?.find((item) => item.type.coding?.some((coding) => coding.system === STATEMENT_OUTPUT_CODE_SYSTEM && coding.code === codeValue))?.valueInteger;
}

function sequentialIds(): () => string {
  let value = 0;
  return () => `id-${++value}`;
}
