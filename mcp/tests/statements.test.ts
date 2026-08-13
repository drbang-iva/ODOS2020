import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Account,
  Basic,
  Bundle,
  Claim,
  ClaimResponse,
  Invoice,
  Patient,
  PaymentReconciliation,
  Practitioner,
  PractitionerRole,
  Resource,
  RelatedPerson,
  Task,
} from "@medplum/fhirtypes";
import { ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL } from "../src/claims/claimmd-fhir.js";
import { ODOS_SOURCE_CLAIM_EXTENSION_URL } from "../src/claims/patient-responsibility-invoice.js";
import { buildPaymentReconciliation } from "../src/payments/payment-reconciliation.js";
import { paymentTenderExtension } from "../src/fhir/odosPaymentTender.js";
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
import { buildStatementMessageConfigResource } from "../src/statements/statement-message-config.js";

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

test("a record-only tender Invoice is fully paid without a separate PaymentReconciliation", () => {
  const paidInvoice = invoice("i1", "p1", 18_900);
  paidInvoice.status = "balanced";
  paidInvoice.extension = [paymentTenderExtension("CASH")];
  const statement = buildStatementSnapshot({
    patient: patient("p1", "Alex Rivera"),
    invoices: [paidInvoice],
    paymentReconciliations: [],
    generatedAt: GENERATED_AT,
  });
  assert.equal(statement.paymentsAppliedCents, 18_900);
  assert.equal(statement.balanceCents, 0);
  assert.deepEqual(statement.invoices.map((row) => row.balanceCents), [0]);
});

test("a record-only tender Invoice with an active linked allocation is rejected as ambiguous", () => {
  const paidInvoice = invoice("i1", "p1", 18_900);
  paidInvoice.status = "balanced";
  paidInvoice.extension = [paymentTenderExtension("CASH")];
  assert.throws(() => buildStatementSnapshot({
    patient: patient("p1", "Alex Rivera"),
    invoices: [paidInvoice],
    paymentReconciliations: [payment("pay-1", "p1", "i1", 18_900)],
    generatedAt: GENERATED_AT,
  }), /both a record-only tender and an active PaymentReconciliation allocation/);
});

test("an issued Invoice with a record-only tender is rejected because a partial deposit is not full settlement", () => {
  const partialInvoice = invoice("i1", "p1", 18_900);
  partialInvoice.extension = [paymentTenderExtension("CASH")];
  assert.throws(() => buildStatementSnapshot({
    patient: patient("p1", "Alex Rivera"),
    invoices: [partialInvoice],
    paymentReconciliations: [],
    generatedAt: GENERATED_AT,
  }), /record-only tender but is not balanced/);
});

test("configured statement message originates in the Basic singleton and round-trips through persisted statement data", async () => {
  const message = "Pay online at portal.example.test or call our office.";
  const fixture = fakeFhir({
    patients: [patient("p1", "Alex Rivera")],
    invoices: [invoice("i1", "p1", 10_000)],
    payments: [],
    basics: [{
      ...buildStatementMessageConfigResource({ statementFooterMessage: message }),
      id: "statement-message-config-1",
      meta: { lastUpdated: "2026-07-18T12:00:00.000Z" },
    }],
  });
  const result = await handleGeneratePatientStatementRequest(statementDeps(fixture.fhir), {
    authHeader: "Bearer good",
    body: { patientReference: "Patient/p1" },
  });

  assert.equal(result.status, 200);
  const statement = (result.body as StatementRunResult).statements[0];
  assert.equal(statement.statementFooterMessage, message);
  const storedSnapshot = fixture.storedTasks
    .find((task) => code(task) === PATIENT_STATEMENT_CODE)
    ?.output?.find((item) => item.type.coding?.some((coding) => coding.code === "snapshot"))
    ?.valueString;
  assert.equal((JSON.parse(storedSnapshot ?? "{}") as { statementFooterMessage?: string }).statementFooterMessage, message);
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

test("minor statements mail to the current Account guarantor", async () => {
  const account = patientAccount("minor-account", "minor", "RelatedPerson/guardian");
  account.guarantor![0].period = {
    start: "2026-07-12T23:59:59Z",
    end: "2026-07-12T23:59:59Z",
  };
  const run = await generateStatementRun({
    patients: [minorPatient()],
    invoices: [invoice("minor-invoice", "minor", 10_000)],
    payments: [],
    accounts: [account],
    relatedPeople: [guardian()],
  });
  assert.equal(run.generatedCount, 1);
  assert.equal(run.invalidRejects, 0);
  const statement = run.statements[0];
  assert.equal(statement.detail?.header.recipientName, "Pat Doe");
  assert.deepEqual(statement.detail?.header.recipientAddress, {
    lines: ["2 Parent St"],
    cityStatePostal: "Greenville, SC 29602",
  });
  assert.deepEqual(statement.detail?.header.patientAddress, {
    lines: ["1 Minor St"],
    cityStatePostal: "Greenville, SC 29601",
  });
});

test("minor statements reject an addressless Account guarantor instead of redirecting to the patient", async () => {
  const run = await generateStatementRun({
    patients: [minorPatient()],
    invoices: [invoice("addressless-guardian-invoice", "minor", 10_000)],
    payments: [],
    accounts: [patientAccount("addressless-guardian-account", "minor", "RelatedPerson/addressless")],
    relatedPeople: [guardian("addressless", { address: undefined })],
  });
  assert.equal(run.generatedCount, 0);
  assert.equal(run.invalidRejects, 1);
  assert.equal(run.statements.length, 0);
  assert.match(run.rejects[0].reason, /RelatedPerson\/addressless has no usable mailing address/);
  assert.doesNotMatch(run.rejects[0].reason, /Patient\/minor is a minor and cannot receive/);
});

test("minor statements reject the patient as their own Account guarantor", async () => {
  const run = await generateStatementRun({
    patients: [minorPatient()],
    invoices: [invoice("unsafe-minor-invoice", "minor", 10_000)],
    payments: [],
    accounts: [patientAccount("unsafe-minor-account", "minor", "Patient/minor")],
  });
  assert.equal(run.generatedCount, 0);
  assert.equal(run.invalidRejects, 1);
  assert.match(run.rejects[0].reason, /minor and cannot receive a statement as their own Account guarantor/);
});

test("statements reject a guarantor without a usable name", async () => {
  const run = await generateStatementRun({
    patients: [minorPatient()],
    invoices: [invoice("unnamed-guardian-invoice", "minor", 10_000)],
    payments: [],
    accounts: [patientAccount("unnamed-guardian-account", "minor", "RelatedPerson/unnamed")],
    relatedPeople: [guardian("unnamed", { name: undefined })],
  });
  assert.equal(run.invalidRejects, 1);
  assert.match(run.rejects[0].reason, /has no usable name for statement delivery/);
});

test("statements reject an unresolved Account guarantor even when another guarantor resolves", async () => {
  const account = patientAccount("missing-guardian-account", "minor", "RelatedPerson/missing");
  account.guarantor!.push({ party: { reference: "RelatedPerson/guardian" }, onHold: false });
  const run = await generateStatementRun({
    patients: [minorPatient()],
    invoices: [invoice("missing-guardian-invoice", "minor", 10_000)],
    payments: [],
    accounts: [account],
    relatedPeople: [guardian()],
  });
  assert.equal(run.invalidRejects, 1);
  assert.match(run.rejects[0].reason, /RelatedPerson\/missing could not be resolved for Patient\/minor/);
});

test("statements reject an unsupported Account guarantor reference", async () => {
  const run = await generateStatementRun({
    patients: [minorPatient()],
    invoices: [invoice("unsupported-guardian-invoice", "minor", 10_000)],
    payments: [],
    accounts: [patientAccount("unsupported-guardian-account", "minor", "Organization/guardian")],
  });
  assert.equal(run.invalidRejects, 1);
  assert.match(run.rejects[0].reason, /Organization\/guardian is not a supported statement guarantor/);
});

test("statements reject a RelatedPerson owned by another patient", async () => {
  const run = await generateStatementRun({
    patients: [minorPatient()],
    invoices: [invoice("wrong-patient-guardian-invoice", "minor", 10_000)],
    payments: [],
    accounts: [patientAccount("wrong-patient-guardian-account", "minor", "RelatedPerson/guardian")],
    relatedPeople: [guardian("guardian", { patient: { reference: "Patient/another-patient" } })],
  });
  assert.equal(run.invalidRejects, 1);
  assert.match(run.rejects[0].reason, /does not belong to Patient\/minor/);
});

test("self-responsible adult statements mail to the patient", async () => {
  const adult = { ...patientWithAddress(), birthDate: "1980-01-02" };
  const run = await generateStatementRun({
    patients: [adult],
    invoices: [invoice("adult-invoice", "p1", 10_000)],
    payments: [],
    accounts: [patientAccount("adult-account", "p1", "Patient/p1")],
  }, "Patient/p1");
  assert.equal(run.generatedCount, 1);
  assert.equal(run.invalidRejects, 0);
  const statement = run.statements[0];
  assert.equal(statement.detail?.header.recipientName, "Alex Rivera");
  assert.deepEqual(statement.detail?.header.recipientAddress, {
    lines: ["10 Main St"],
    cityStatePostal: "Raleigh, NC 27601",
  });
});

test("statements reject self-guarantee when the patient's age is indeterminate", async () => {
  const run = await generateStatementRun({
    patients: [{ ...patientWithAddress(), birthDate: undefined }],
    invoices: [invoice("unknown-age-invoice", "p1", 10_000)],
    payments: [],
    accounts: [patientAccount("unknown-age-account", "p1", "Patient/p1")],
  }, "Patient/p1");
  assert.equal(run.invalidRejects, 1);
  assert.match(run.rejects[0].reason, /without a valid patient birth date/);
});

test("exactly one primary RelatedPerson disambiguates multiple current guarantors", async () => {
  const account = patientAccount("multi-account", "minor", "RelatedPerson/guardian");
  account.guarantor = [
    { party: { reference: "RelatedPerson/guardian" }, onHold: false },
    { party: { reference: "RelatedPerson/secondary" }, onHold: false },
  ];
  const run = await generateStatementRun({
    patients: [minorPatient()],
    invoices: [invoice("multi-invoice", "minor", 10_000)],
    payments: [],
    accounts: [account],
    relatedPeople: [
      guardian(),
      guardian("secondary", {
        name: [{ text: "Secondary Doe" }],
        extension: [{
          url: "https://odos2020.com/fhir/StructureDefinition/related-person-primary",
          valueBoolean: false,
        }],
      }),
    ],
  });
  assert.equal(run.statements[0].detail?.header.recipientName, "Pat Doe");
});

test("multiple primary guarantors are rejected as ambiguous", async () => {
  const account = patientAccount("multi-primary-account", "minor", "RelatedPerson/guardian");
  account.guarantor = [
    { party: { reference: "RelatedPerson/guardian" }, onHold: false },
    { party: { reference: "RelatedPerson/secondary" }, onHold: false },
  ];
  const run = await generateStatementRun({
    patients: [minorPatient()],
    invoices: [invoice("multi-primary-invoice", "minor", 10_000)],
    payments: [],
    accounts: [account],
    relatedPeople: [guardian(), guardian("secondary", { name: [{ text: "Secondary Doe" }] })],
  });
  assert.equal(run.invalidRejects, 1);
  assert.match(run.rejects[0].reason, /does not have one unambiguous current Account guarantor/);
});

test("on-hold and expired guarantors are excluded from statement recipients", async () => {
  const account = patientAccount("window-account", "minor", "RelatedPerson/guardian");
  account.guarantor = [
    { party: { reference: "RelatedPerson/guardian" }, onHold: false },
    { party: { reference: "RelatedPerson/on-hold" }, onHold: true },
    { party: { reference: "RelatedPerson/expired" }, onHold: false, period: { end: "2026-07-11" } },
  ];
  const run = await generateStatementRun({
    patients: [minorPatient()],
    invoices: [invoice("window-invoice", "minor", 10_000)],
    payments: [],
    accounts: [account],
    relatedPeople: [
      guardian(),
      guardian("on-hold", { name: [{ text: "On Hold" }] }),
      guardian("expired", { name: [{ text: "Expired" }] }),
    ],
  });
  assert.equal(run.statements[0].detail?.header.recipientName, "Pat Doe");
});

test("a pre-seam Claim degrades to an invoice-only Order without changing the T0 balance", () => {
  const sourceInvoice = invoice("i1", "p1", 2_500);
  sourceInvoice.extension = [{ url: ODOS_SOURCE_CLAIM_EXTENSION_URL, valueReference: { reference: "Claim/c1" } }];
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
    authenticate: async () => ({
      staffReference: "Practitioner/staff-1",
      actorRole: "provider",
      roles: ["provider", "staff", "admin"],
      fhir: fixture.fhir,
    }),
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
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "staff", roles: ["staff"], fhir: fixture.fhir }),
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
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "staff", roles: ["staff"], fhir: fixture.fhir }),
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
  assert.equal(fixture.transactions.length, 3);
  assert.equal((fixture.transactions[0].entry?.[0]?.resource as Task).status, "in-progress");
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
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "staff", roles: ["staff"], fhir: fixture.fhir }),
  }, { authHeader: "Bearer good" });
  assert.equal(result.status, 200);
  const items = (result.body as { items: Array<{ statementReference: string }> }).items;
  assert.deepEqual(items.map((item) => item.statementReference), ["Task/new", "Task/old"]);
});

test("generate then list preserves an insurance-aware statement under server-assigned Task ids", async () => {
  const fixture = fakeFhir({
    patients: [patientWithAddress()],
    invoices: [seamInvoice("i1", "p1", 10_000)],
    payments: [],
    claims: [postedClaim()],
    claimResponses: [postedResponse()],
    practitioners: [provider()],
    practitionerRoles: [providerRole()],
  });
  const deps = statementDeps(fixture.fhir);

  const generated = await handleGeneratePatientStatementRequest(deps, {
    authHeader: "Bearer good",
    body: { patientReference: "Patient/p1" },
  });
  assert.equal(generated.status, 200);
  const run = generated.body as StatementRunResult;
  assert.equal(run.runReference, "Task/stored-1");
  assert.equal(run.statements[0].runReference, run.runReference);

  const listed = await handleStatementListRequest(deps, {
    authHeader: "Bearer good",
    patientReference: "Patient/p1",
  });
  assert.equal(listed.status, 200);
  const items = (listed.body as { items: StatementRunResult["statements"] }).items;
  assert.equal(items.length, 1);
  assert.equal(Boolean(items[0].detail), true);
  assert.equal(items[0].detail?.orders[0].mode, "insurance-aware");
});

test("a run larger than the child ceiling commits in chunks and publishes its completed marker last", async () => {
  const count = STATEMENT_TRANSACTION_CHILD_LIMIT + 1;
  const fixture = fakeFhir({
    patients: Array.from({ length: count }, (_, index) => patient(`p${index}`, `Patient ${index}`)),
    invoices: Array.from({ length: count }, (_, index) => invoice(`i${index}`, `p${index}`, 1_000)),
    payments: [],
  });
  const result = await handleRunStatementsRequest({
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "staff", roles: ["staff"], fhir: fixture.fhir }),
    now: () => GENERATED_AT,
    generateId: sequentialIds(),
  }, { authHeader: "Bearer good" });

  assert.equal(result.status, 200);
  assert.equal(fixture.transactions.length, 4);
  assert.deepEqual(fixture.transactions.slice(1, -1).map((bundle) => bundle.entry?.length), [STATEMENT_TRANSACTION_CHILD_LIMIT, 1]);
  assert.ok(fixture.transactions.slice(1, -1).every((bundle) => (bundle.entry?.length ?? 0) <= STATEMENT_TRANSACTION_CHILD_LIMIT));
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
  }, { failTransactionAt: 3 });
  const deps = {
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "staff" as const, roles: ["staff"] as const, fhir: fixture.fhir }),
    now: () => GENERATED_AT,
    generateId: sequentialIds(),
  };

  await assert.rejects(handleRunStatementsRequest(deps, { authHeader: "Bearer good" }), /chunk failed/);
  assert.deepEqual(latestStatementRun(fixture.storedTasks), { generatedAt: null, invalidRejects: 0 });
  const list = await handleStatementListRequest(deps, { authHeader: "Bearer good" });
  assert.deepEqual(list, { status: 200, body: { items: [] } });
  assert.equal(fixture.storedTasks.length, 1);
  assert.equal(fixture.storedTasks[0].status, "in-progress");
});

test("a cleanup failure never masks the original child-chunk error", async () => {
  const count = STATEMENT_TRANSACTION_CHILD_LIMIT + 1;
  const fixture = fakeFhir({
    patients: Array.from({ length: count }, (_, index) => patient(`p${index}`, `Patient ${index}`)),
    invoices: Array.from({ length: count }, (_, index) => invoice(`i${index}`, `p${index}`, 1_000)),
    payments: [],
  }, { failTransactionAt: 3, failCleanup: true });

  const cleanupErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => { cleanupErrors.push(values); };
  try {
    await assert.rejects(handleRunStatementsRequest({
      authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "staff", roles: ["staff"], fhir: fixture.fhir }),
      now: () => GENERATED_AT,
      generateId: sequentialIds(),
    }, { authHeader: "Bearer good" }), /chunk failed/);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(fixture.storedTasks.some((task) => code(task) === STATEMENT_RUN_CODE && task.status === "in-progress"), true);
  assert.equal(fixture.storedTasks.some((task) => code(task) === STATEMENT_RUN_CODE && task.status === "completed"), false);
  assert.equal(fixture.storedTasks.length, STATEMENT_TRANSACTION_CHILD_LIMIT + 1);
  assert.match(String(cleanupErrors[0]?.[0]), /Statement cleanup failed for child Tasks Task\/stored-2/);
});

test("a failed completion marker cleans children only after confirming no completed run exists", async () => {
  const fixture = fakeFhir({
    patients: [patient("p1", "Alex Rivera")],
    invoices: [invoice("i1", "p1", 1_000)],
    payments: [],
  }, { failTransactionAt: 3 });

  await assert.rejects(handleRunStatementsRequest(statementDeps(fixture.fhir), { authHeader: "Bearer good" }), /chunk failed/);
  assert.equal(fixture.storedTasks.length, 1);
  assert.equal(fixture.storedTasks[0].status, "in-progress");
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
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "staff", roles: ["staff"], fhir: fixture.fhir }),
  }, { authHeader: "Bearer good" });

  assert.equal(result.status, 200);
  assert.deepEqual((result.body as { items: Array<{ statementReference: string }> }).items.map((item) => item.statementReference), ["Task/valid"]);
});

function fakeFhir(
  input: {
    patients: Patient[];
    invoices: Invoice[];
    payments: PaymentReconciliation[];
    claims?: Claim[];
    claimResponses?: ClaimResponse[];
    practitioners?: Practitioner[];
    practitionerRoles?: PractitionerRole[];
    basics?: Basic[];
    accounts?: Account[];
    relatedPeople?: RelatedPerson[];
  },
  options: { failTransactionAt?: number; failCleanup?: boolean } = {},
) {
  const transactions: Bundle[] = [];
  const storedTasks: Task[] = [];
  let storedTaskCount = 0;
  const fhir = {
    search: async <T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> => {
      const rows: Resource[] = resourceType === "Patient" ? input.patients
        : resourceType === "Invoice" ? input.invoices
          : resourceType === "PaymentReconciliation" ? input.payments
            : resourceType === "Claim" ? input.claims ?? []
              : resourceType === "ClaimResponse" ? input.claimResponses ?? []
                : resourceType === "Practitioner" ? input.practitioners ?? []
                  : resourceType === "PractitionerRole" ? input.practitionerRoles ?? []
                    : resourceType === "Basic" ? input.basics ?? []
                      : resourceType === "Account" ? input.accounts ?? []
                        : resourceType === "RelatedPerson" ? input.relatedPeople ?? []
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
      const assignedReferences = new Map<string, string>();
      const assignedIds = entries.map((entry) => {
        if (entry.request?.method === "DELETE") return undefined;
        const requestedId = entry.request?.method === "PUT" ? entry.request.url.replace("Task/", "") : undefined;
        const existing = requestedId && storedTasks.some((task) => task.id === requestedId);
        const id = existing ? requestedId : `stored-${++storedTaskCount}`;
        if (entry.fullUrl?.startsWith("urn:uuid:")) assignedReferences.set(entry.fullUrl, `Task/${id}`);
        return id;
      });
      const locations = entries.map((entry, index) => {
        if (entry.request?.method === "DELETE") {
          const id = entry.request.url.replace("Task/", "");
          const storedIndex = storedTasks.findIndex((task) => task.id === id);
          if (storedIndex >= 0) storedTasks.splice(storedIndex, 1);
          return entry.request.url;
        }
        const task = structuredClone(entry.resource) as Task;
        const id = assignedIds[index]!;
        if (entry.request?.method === "POST" || !storedTasks.some((stored) => stored.id === id)) delete task.id;
        rewriteReferences(task, assignedReferences);
        if (entry.resource?.resourceType === "Task") {
          const storedIndex = storedTasks.findIndex((stored) => stored.id === id);
          if (storedIndex >= 0) storedTasks[storedIndex] = { ...task, id };
          else storedTasks.push({ ...task, id });
        }
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

function rewriteReferences(value: unknown, references: ReadonlyMap<string, string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) rewriteReferences(item, references);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "reference" && typeof child === "string" && references.has(child)) {
      (value as Record<string, unknown>)[key] = references.get(child);
    } else {
      rewriteReferences(child, references);
    }
  }
}

function statementDeps(fhir: ReturnType<typeof fakeFhir>["fhir"]) {
  return {
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "staff" as const, roles: ["staff"] as const, fhir }),
    now: () => GENERATED_AT,
    generateId: sequentialIds(),
  };
}

async function generateStatementRun(
  input: Parameters<typeof fakeFhir>[0],
  patientReference = "Patient/minor",
): Promise<StatementRunResult> {
  const fixture = fakeFhir(input);
  const result = await handleGeneratePatientStatementRequest(statementDeps(fixture.fhir), {
    authHeader: "Bearer good",
    body: { patientReference },
  });
  return result.body as StatementRunResult;
}

function minorPatient(): Patient {
  return {
    ...patient("minor", "Jamie Doe"),
    birthDate: "2015-01-02",
    address: [{
      use: "home",
      line: ["1 Minor St"],
      city: "Greenville",
      state: "SC",
      postalCode: "29601",
    }],
  };
}

function guardian(id = "guardian", overrides: Partial<RelatedPerson> = {}): RelatedPerson {
  return {
    resourceType: "RelatedPerson",
    id,
    active: true,
    patient: { reference: "Patient/minor" },
    name: [{ use: "official", given: ["Pat"], family: "Doe" }],
    address: [{
      use: "home",
      line: ["2 Parent St"],
      city: "Greenville",
      state: "SC",
      postalCode: "29602",
    }],
    extension: [{
      url: "https://odos2020.com/fhir/StructureDefinition/related-person-primary",
      valueBoolean: true,
    }],
    ...overrides,
  };
}

function patient(id: string, text: string): Patient {
  return { resourceType: "Patient", id, birthDate: "1980-01-02", name: [{ text }] };
}

function patientWithAddress(): Patient {
  return {
    ...patient("p1", "Alex Rivera"),
    address: [{ use: "home", line: ["10 Main St"], city: "Raleigh", state: "NC", postalCode: "27601" }],
  };
}

function patientAccount(
  id: string,
  patientId: string,
  guarantorReference: string,
): Account {
  return {
    resourceType: "Account",
    id,
    status: "active",
    subject: [{ reference: `Patient/${patientId}` }],
    guarantor: [{ party: { reference: guarantorReference }, onHold: false }],
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
    identifier: [{ system: "https://odos2020.com/fhir/NamingSystem/patient-responsibility-invoice", value: `claim-pr-${id}` }],
    extension: [{ url: ODOS_SOURCE_CLAIM_EXTENSION_URL, valueReference: { reference: "Claim/c1" } }],
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
      extension: [{ url: ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL, valueReference: { reference: "ChargeItem/ch1" } }],
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
      processorTransactionSystem: "https://odos2020.com/test/payment",
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
      processorTransactionSystem: "https://odos2020.com/test/payment",
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
