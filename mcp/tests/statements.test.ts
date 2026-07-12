import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Bundle,
  Claim,
  ClaimResponse,
  Invoice,
  Patient,
  PaymentReconciliation,
  Practitioner,
  PractitionerRole,
  Resource,
  Task,
} from "@medplum/fhirtypes";
import { OSOD_CLAIM_CHARGE_ITEM_EXTENSION_URL } from "../src/claims/claimmd-fhir.js";
import { OSOD_SOURCE_CLAIM_EXTENSION_URL } from "../src/claims/patient-responsibility-invoice.js";
import { buildPaymentReconciliation } from "../src/payments/payment-reconciliation.js";
import {
  addStatementDetail,
  buildStatementSnapshot,
  handleGeneratePatientStatementRequest,
  handleRunStatementsRequest,
  handleStatementListRequest,
  latestStatementRun,
  PATIENT_STATEMENT_CODE,
  STATEMENT_OUTPUT_CODE_SYSTEM,
  STATEMENT_RUN_CODE,
  STATEMENT_TASK_CODE_SYSTEM,
  STATEMENT_TRANSACTION_CHILD_LIMIT,
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

test("insurance detail passes through linked Claim diagnoses, ERA adjustments, provider identity, and patient payments", () => {
  const sourceInvoice = seamInvoice("i1", "p1", 2_500);
  const sourcePayment = payment("pay-1", "p1", "i1", 500);
  const snapshot = buildStatementSnapshot({
    patient: patientWithAddress(),
    invoices: [sourceInvoice],
    paymentReconciliations: [sourcePayment],
    generatedAt: GENERATED_AT,
  });
  const detailed = addStatementDetail({
    snapshot,
    patient: patientWithAddress(),
    invoices: [sourceInvoice],
    paymentReconciliations: [sourcePayment],
    claims: [postedClaim()],
    claimResponses: [postedResponse()],
    practitioners: [provider()],
    practitionerRoles: [providerRole()],
  });

  assert.equal(detailed.balanceCents, snapshot.balanceCents);
  assert.equal(detailed.detail?.header.practiceName, "Independent Eye Care");
  assert.equal(detailed.detail?.header.providerNpi, "1234567893");
  assert.equal(detailed.detail?.header.providerLicense, "OPT-1234");
  assert.deepEqual(detailed.detail?.header.patientAddress, { lines: ["10 Main St"], cityStatePostal: "Raleigh, NC 27601" });
  const order = detailed.detail?.orders[0];
  assert.equal(order?.mode, "insurance-aware");
  assert.equal(order?.orderNumber, "i1");
  assert.equal(order?.claimNumber, "ACCT-100");
  assert.deepEqual(order?.lines[0].diagnosisCodes, ["DX-TEST-1", "DX-TEST-2"]);
  assert.equal(order?.lines[0].retailCents, 10_000);
  assert.equal(order?.lines[0].insurancePaidCents, 5_000);
  assert.deepEqual(order?.lines[0].insuranceAdjustments, [{ group: "INS", code: "SOURCE", label: "adjustment INS SOURCE", amountCents: 2_500 }]);
  assert.deepEqual(order?.lines[0].patientAdjustments, [{ group: "PR", code: "SOURCE", label: "Source patient reason", amountCents: 2_500 }]);
  assert.deepEqual(order?.patientPayments, [{ paymentReference: "PaymentReconciliation/pay-1", date: "2026-07-02", amountCents: 500 }]);
});

test("a pre-seam Claim degrades to an invoice-only Order without changing the T0 balance", () => {
  const sourceInvoice = invoice("i1", "p1", 2_500);
  sourceInvoice.extension = [{ url: OSOD_SOURCE_CLAIM_EXTENSION_URL, valueReference: { reference: "Claim/c1" } }];
  const snapshot = buildStatementSnapshot({ patient: patient("p1", "Alex Rivera"), invoices: [sourceInvoice], paymentReconciliations: [], generatedAt: GENERATED_AT });
  const detailed = addStatementDetail({
    snapshot,
    patient: patient("p1", "Alex Rivera"),
    invoices: [sourceInvoice],
    paymentReconciliations: [],
    claims: [{ ...postedClaim(), item: postedClaim().item?.map(({ extension: _extension, ...item }) => item) }],
    claimResponses: [postedResponse()],
    practitioners: [],
    practitionerRoles: [],
  });
  assert.equal(detailed.detail?.orders[0].mode, "invoice-only");
  assert.deepEqual(detailed.detail?.orders[0].lines, []);
  assert.equal(detailed.balanceCents, 2_500);
});

test("an unapplied patient credit is displayed separately and reduces only the account-level balance due", async () => {
  const fixture = fakeFhir({
    patients: [patient("p1", "Alex Rivera")],
    invoices: [invoice("i1", "p1", 10_000)],
    payments: [unappliedPayment("credit-1", "p1", 2_500)],
  });
  const result = await handleGeneratePatientStatementRequest({
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "front-desk", fhir: fixture.fhir }),
    now: () => GENERATED_AT,
    generateId: sequentialIds(),
  }, { authHeader: "Bearer good", body: { patientReference: "Patient/p1" } });

  assert.equal(result.status, 200);
  const statement = (result.body as StatementRunResult).statements[0];
  assert.equal(statement.balanceCents, 10_000);
  assert.equal(statement.unappliedCreditCents, 2_500);
  assert.equal(statement.balanceDueCents, 7_500);
  assert.equal(statement.creditBalanceCents, 0);
  assert.deepEqual(statement.unappliedPaymentReconciliationReferences, ["PaymentReconciliation/credit-1"]);
});

test("credit above the open Invoice balance produces zero due and an honest credit balance", async () => {
  const fixture = fakeFhir({
    patients: [patient("p1", "Alex Rivera")],
    invoices: [invoice("i1", "p1", 10_000)],
    payments: [unappliedPayment("credit-1", "p1", 12_500)],
  });
  const result = await handleGeneratePatientStatementRequest({
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "front-desk", fhir: fixture.fhir }),
    now: () => GENERATED_AT,
    generateId: sequentialIds(),
  }, { authHeader: "Bearer good", body: { patientReference: "Patient/p1" } });

  const statement = (result.body as StatementRunResult).statements[0];
  assert.equal(statement.balanceDueCents, 0);
  assert.equal(statement.creditBalanceCents, 2_500);
  assert.equal(statement.balanceCents, 10_000);
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
  assert.equal(fixture.transactions.length, 2);
  assert.equal(code(fixture.transactions.at(-1)?.entry?.[0]?.resource as Task), STATEMENT_RUN_CODE);
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
  fixture.storedTasks.push(completedRunTask("run-1"), statementTask("old", "2026-07-11T10:00:00.000Z"), statementTask("new", GENERATED_AT), {
    ...statementTask("reject", "2026-07-13T10:00:00.000Z"), status: "failed",
  });
  const result = await handleStatementListRequest({
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "front-desk", fhir: fixture.fhir }),
  }, { authHeader: "Bearer good" });
  assert.equal(result.status, 200);
  const items = (result.body as { items: Array<{ statementReference: string }> }).items;
  assert.deepEqual(items.map((item) => item.statementReference), ["Task/new", "Task/old"]);
});

test("a run larger than the child ceiling commits in chunks and publishes its completed marker last", async () => {
  const count = STATEMENT_TRANSACTION_CHILD_LIMIT + 1;
  const fixture = fakeFhir({
    patients: Array.from({ length: count }, (_, index) => patient(`p${index}`, `Patient ${index}`)),
    invoices: Array.from({ length: count }, (_, index) => invoice(`i${index}`, `p${index}`, 1_000)),
    payments: [],
  });
  const result = await handleRunStatementsRequest({
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "front-desk", fhir: fixture.fhir }),
    now: () => GENERATED_AT,
    generateId: sequentialIds(),
  }, { authHeader: "Bearer good" });

  assert.equal(result.status, 200);
  assert.equal(fixture.transactions.length, 3);
  assert.deepEqual(fixture.transactions.slice(0, -1).map((bundle) => bundle.entry?.length), [STATEMENT_TRANSACTION_CHILD_LIMIT, 1]);
  assert.ok(fixture.transactions.slice(0, -1).every((bundle) => (bundle.entry?.length ?? 0) <= STATEMENT_TRANSACTION_CHILD_LIMIT));
  assert.equal(code(fixture.transactions.at(-1)?.entry?.[0]?.resource as Task), STATEMENT_RUN_CODE);
  assert.equal(latestStatementRun(fixture.storedTasks).generatedAt, GENERATED_AT);
});

test("a failed child chunk leaves no completed run visible to either statement reader", async () => {
  const count = STATEMENT_TRANSACTION_CHILD_LIMIT + 1;
  const fixture = fakeFhir({
    patients: Array.from({ length: count }, (_, index) => patient(`p${index}`, `Patient ${index}`)),
    invoices: Array.from({ length: count }, (_, index) => index < STATEMENT_TRANSACTION_CHILD_LIMIT - 1
      ? invoice(`i${index}`, `p${index}`, 1_000)
      : inconsistentInvoice(`i${index}`, `p${index}`)),
    payments: [],
  }, { failTransactionAt: 2 });
  const deps = {
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "front-desk" as const, fhir: fixture.fhir }),
    now: () => GENERATED_AT,
    generateId: sequentialIds(),
  };

  await assert.rejects(handleRunStatementsRequest(deps, { authHeader: "Bearer good" }), /chunk failed/);
  assert.deepEqual(latestStatementRun(fixture.storedTasks), { generatedAt: null, invalidRejects: 0 });
  const list = await handleStatementListRequest(deps, { authHeader: "Bearer good" });
  assert.deepEqual(list, { status: 200, body: { items: [] } });
  assert.equal(fixture.storedTasks.length, 0);
});

test("a cleanup failure never masks the original child-chunk error", async () => {
  const count = STATEMENT_TRANSACTION_CHILD_LIMIT + 1;
  const fixture = fakeFhir({
    patients: Array.from({ length: count }, (_, index) => patient(`p${index}`, `Patient ${index}`)),
    invoices: Array.from({ length: count }, (_, index) => invoice(`i${index}`, `p${index}`, 1_000)),
    payments: [],
  }, { failTransactionAt: 2, failCleanup: true });

  const cleanupErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => { cleanupErrors.push(values); };
  try {
    await assert.rejects(handleRunStatementsRequest({
      authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "front-desk", fhir: fixture.fhir }),
      now: () => GENERATED_AT,
      generateId: sequentialIds(),
    }, { authHeader: "Bearer good" }), /chunk failed/);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(fixture.storedTasks.some((task) => code(task) === STATEMENT_RUN_CODE), false);
  assert.equal(fixture.storedTasks.length, STATEMENT_TRANSACTION_CHILD_LIMIT);
  assert.match(String(cleanupErrors[0]?.[0]), /Statement cleanup failed for child Tasks Task\/stored-1/);
});

test("a failed completion marker cleans children only after confirming no completed run exists", async () => {
  const fixture = fakeFhir({
    patients: [patient("p1", "Alex Rivera")],
    invoices: [invoice("i1", "p1", 1_000)],
    payments: [],
  }, { failTransactionAt: 2 });

  await assert.rejects(handleRunStatementsRequest(statementDeps(fixture.fhir), { authHeader: "Bearer good" }), /chunk failed/);
  assert.deepEqual(fixture.storedTasks, []);
  assert.deepEqual(latestStatementRun(fixture.storedTasks), { generatedAt: null, invalidRejects: 0 });
});

test("generate-one distinguishes no issued Invoices from a paid-in-full balance", async () => {
  const noInvoices = fakeFhir({ patients: [patient("p1", "Alex Rivera")], invoices: [], payments: [] });
  const noInvoiceResult = await handleGeneratePatientStatementRequest(statementDeps(noInvoices.fhir), {
    authHeader: "Bearer good",
    body: { patientReference: "Patient/p1" },
  });
  const noInvoiceRun = noInvoiceResult.body as StatementRunResult;
  assert.equal(noInvoiceResult.status, 200);
  assert.equal(noInvoiceRun.generatedCount, 0);
  assert.equal(noInvoiceRun.skippedZeroBalanceCount, 0);
  assert.equal(noInvoiceRun.invalidRejects, 1);
  assert.match(noInvoiceRun.rejects[0].reason, /No issued Invoices/);

  const paid = fakeFhir({
    patients: [patient("p1", "Alex Rivera")],
    invoices: [invoice("i1", "p1", 10_000)],
    payments: [payment("pay-1", "p1", "i1", 10_000)],
  });
  const paidResult = await handleGeneratePatientStatementRequest(statementDeps(paid.fhir), {
    authHeader: "Bearer good",
    body: { patientReference: "Patient/p1" },
  });
  const paidRun = paidResult.body as StatementRunResult;
  assert.equal(paidResult.status, 200);
  assert.equal(paidRun.generatedCount, 0);
  assert.equal(paidRun.skippedZeroBalanceCount, 1);
  assert.equal(paidRun.invalidRejects, 0);
  assert.deepEqual(paidRun.rejects, []);
});

test("statement list skips one corrupt Task while returning a valid statement from a completed run", async () => {
  const fixture = fakeFhir({ patients: [], invoices: [], payments: [] });
  const corrupt = statementTask("corrupt", GENERATED_AT);
  corrupt.output![0].valueString = "not-json";
  fixture.storedTasks.push(completedRunTask("run-1"), corrupt, statementTask("valid", GENERATED_AT));

  const result = await handleStatementListRequest({
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "front-desk", fhir: fixture.fhir }),
  }, { authHeader: "Bearer good" });

  assert.equal(result.status, 200);
  assert.deepEqual((result.body as { items: Array<{ statementReference: string }> }).items.map((item) => item.statementReference), ["Task/valid"]);
});

function fakeFhir(
  input: { patients: Patient[]; invoices: Invoice[]; payments: PaymentReconciliation[] },
  options: { failTransactionAt?: number; failCleanup?: boolean } = {},
) {
  const transactions: Bundle[] = [];
  const storedTasks: Task[] = [];
  let storedTaskCount = 0;
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
      if (transactions.length === options.failTransactionAt) throw new Error("chunk failed");
      const entries = bundle.entry ?? [];
      if (options.failCleanup && entries.some((entry) => entry.request?.method === "DELETE")) {
        throw new Error("cleanup failed");
      }
      const locations = entries.map((entry) => {
        if (entry.request?.method === "DELETE") {
          const id = entry.request.url.replace("Task/", "");
          const storedIndex = storedTasks.findIndex((task) => task.id === id);
          if (storedIndex >= 0) storedTasks.splice(storedIndex, 1);
          return entry.request.url;
        }
        const task = structuredClone(entry.resource) as Task;
        const id = task.id ?? `stored-${++storedTaskCount}`;
        if (entry.resource?.resourceType === "Task") storedTasks.push({ ...task, id });
        return `Task/${id}/_history/1`;
      });
      return {
        resourceType: "Bundle",
        type: "transaction-response",
        entry: locations.map((location) => ({ response: { status: "201", location } })),
      };
    },
  };
  return { fhir, transactions, storedTasks };
}

function statementDeps(fhir: ReturnType<typeof fakeFhir>["fhir"]) {
  return {
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "front-desk" as const, fhir }),
    now: () => GENERATED_AT,
    generateId: sequentialIds(),
  };
}

function patient(id: string, text: string): Patient {
  return { resourceType: "Patient", id, name: [{ text }] };
}

function patientWithAddress(): Patient {
  return {
    ...patient("p1", "Alex Rivera"),
    address: [{ use: "home", line: ["10 Main St"], city: "Raleigh", state: "NC", postalCode: "27601" }],
  };
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

function seamInvoice(id: string, patientId: string, netCents: number): Invoice {
  return {
    ...invoice(id, patientId, netCents),
    identifier: [{ system: "https://osod.dev/fhir/NamingSystem/patient-responsibility-invoice", value: `claim-pr-${id}` }],
    extension: [{ url: OSOD_SOURCE_CLAIM_EXTENSION_URL, valueReference: { reference: "Claim/c1" } }],
    lineItem: [{
      sequence: 1,
      chargeItemReference: { reference: "ChargeItem/ch1" },
      priceComponent: [{ type: "base", amount: { value: netCents / 100, currency: "USD" } }],
    }],
  };
}

function postedClaim(): Claim {
  return {
    resourceType: "Claim",
    id: "c1",
    status: "active",
    type: { text: "Professional" },
    use: "claim",
    patient: { reference: "Patient/p1" },
    created: "2026-07-01T12:00:00.000Z",
    insurer: { reference: "Organization/payer-1", display: "Cigna Health Care" },
    provider: { reference: "Practitioner/dr-1" },
    priority: { text: "normal" },
    identifier: [{ value: "ACCT-100" }],
    diagnosis: [
      { sequence: 1, diagnosisCodeableConcept: { coding: [{ code: "DX-TEST-1" }] } },
      { sequence: 2, diagnosisCodeableConcept: { coding: [{ code: "DX-TEST-2" }] } },
    ],
    item: [{
      sequence: 1,
      extension: [{ url: OSOD_CLAIM_CHARGE_ITEM_EXTENSION_URL, valueReference: { reference: "ChargeItem/ch1" } }],
      productOrService: { coding: [{ code: "PROC-TEST", display: "Source procedure display" }] },
      servicedDate: "2026-07-01",
      diagnosisSequence: [1, 2],
      quantity: { value: 1 },
      unitPrice: { value: 100, currency: "USD" },
      net: { value: 100, currency: "USD" },
    }],
    total: { value: 100, currency: "USD" },
  };
}

function postedResponse(): ClaimResponse {
  return {
    resourceType: "ClaimResponse",
    id: "cr1",
    status: "active",
    type: { text: "Professional" },
    use: "claim",
    patient: { reference: "Patient/p1" },
    created: "2026-07-02T12:00:00.000Z",
    insurer: { reference: "Organization/payer-1", display: "Cigna Health Care" },
    request: { reference: "Claim/c1" },
    outcome: "complete",
    item: [{
      itemSequence: 1,
      adjudication: [
        { category: { text: "paid" }, amount: { value: 50, currency: "USD" } },
        { category: { text: "patient responsibility" }, amount: { value: 25, currency: "USD" } },
        { category: { text: "adjustment INS SOURCE" }, amount: { value: 25, currency: "USD" } },
        { category: { text: "adjustment PR SOURCE" }, reason: { text: "Source patient reason" }, amount: { value: 25, currency: "USD" } },
      ],
    }],
  };
}

function provider(): Practitioner {
  return {
    resourceType: "Practitioner",
    id: "dr-1",
    active: true,
    name: [{ text: "Morgan Lee, OD" }],
    address: [{ use: "work", line: ["20 Vision Way"], city: "Raleigh", state: "NC", postalCode: "27601" }],
    telecom: [{ system: "phone", use: "work", value: "919-555-0100" }],
    identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "1234567893" }],
    qualification: [{ identifier: [{ system: "https://example.test/license", value: "OPT-1234" }], code: { text: "Optometrist" } }],
  };
}

function providerRole(): PractitionerRole {
  return {
    resourceType: "PractitionerRole",
    id: "role-1",
    active: true,
    practitioner: { reference: "Practitioner/dr-1" },
    organization: { reference: "Organization/practice-1", display: "Independent Eye Care" },
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

function unappliedPayment(id: string, patientId: string, amountCents: number): PaymentReconciliation {
  return {
    ...buildPaymentReconciliation({
      outcome: "success",
      createdIso: "2026-07-02T12:00:00.000Z",
      paymentDate: "2026-07-02",
      amountCents,
      subjectReference: `Patient/${patientId}`,
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
    partOf: [{ reference: "Task/run-1" }],
    output: [
      { type: { coding: [{ system: STATEMENT_OUTPUT_CODE_SYSTEM, code: "snapshot" }] }, valueString: JSON.stringify(snapshot) },
      { type: { coding: [{ system: STATEMENT_OUTPUT_CODE_SYSTEM, code: "balance" }] }, valueMoney: { value: 100, currency: "USD" } },
    ],
  };
}

function completedRunTask(id: string): Task {
  return {
    resourceType: "Task",
    id,
    status: "completed",
    intent: "order",
    authoredOn: GENERATED_AT,
    code: { coding: [{ system: STATEMENT_TASK_CODE_SYSTEM, code: STATEMENT_RUN_CODE }] },
    output: [{ type: { coding: [{ system: STATEMENT_OUTPUT_CODE_SYSTEM, code: "invalid-reject-count" }] }, valueInteger: 0 }],
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
