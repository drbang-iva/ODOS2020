import { randomUUID } from "node:crypto";
import type {
  Bundle,
  BundleEntry,
  Invoice,
  Patient,
  PaymentReconciliation,
  Task,
  TaskInput,
  TaskOutput,
} from "@medplum/fhirtypes";
import { assertBusinessActionAllowed, PRACTICE_ROLE_IDS, type PracticeRoleId } from "../authz/roles.js";
import type { MedplumClient } from "../fhir-client.js";
import { FhirSearchLimitError, searchAll } from "../fhir-search.js";
import { paymentAmountCents, paymentSubjectReference } from "../payments/payment-credit-service.js";
import { StaffRoleServiceUnavailableError } from "../payments/payment-endpoint.js";
import type { AuthenticatedStaff } from "../payments/payment-charge-handler.js";

export const STATEMENT_TASK_CODE_SYSTEM = "https://osod.dev/fhir/CodeSystem/statement-task";
export const STATEMENT_RUN_CODE = "statement-run";
export const PATIENT_STATEMENT_CODE = "patient-statement";
export const STATEMENT_RUN_IDENTIFIER_SYSTEM = "https://osod.dev/fhir/NamingSystem/statement-run";
export const STATEMENT_OUTPUT_CODE_SYSTEM = "https://osod.dev/fhir/CodeSystem/statement-output";
export const STATEMENT_TRANSACTION_CHILD_LIMIT = 40;

const RUN_OUTPUTS = {
  generated: "generated-count",
  invalidRejects: "invalid-reject-count",
  skipped: "skipped-zero-balance-count",
} as const;
const STATEMENT_OUTPUTS = { snapshot: "snapshot", balance: "balance" } as const;
const STATEMENT_INPUTS = { invoice: "invoice", payment: "payment-reconciliation" } as const;

export interface StatementInvoiceRow {
  invoiceReference: string;
  date?: string;
  grossCents: number;
  netCents: number;
  paymentsAppliedCents: number;
  balanceCents: number;
}

export interface StatementSnapshot {
  generatedAt: string;
  patientReference: string;
  patientName: string;
  paymentReconciliationReferences: string[];
  invoices: StatementInvoiceRow[];
  totalGrossCents: number;
  totalNetCents: number;
  paymentsAppliedCents: number;
  balanceCents: number;
}

export interface StatementRow extends StatementSnapshot {
  statementReference: string;
  runReference?: string;
}

export interface StatementRejectRow {
  patientReference: string;
  patientName: string;
  reason: string;
}

export interface StatementRunResult {
  runReference: string;
  generatedAt: string;
  generatedCount: number;
  invalidRejects: number;
  skippedZeroBalanceCount: number;
  statements: StatementRow[];
  rejects: StatementRejectRow[];
}

export interface StatementHandlerResult {
  status: number;
  body: unknown;
}

export interface StatementHandlerDeps {
  authenticate(authHeader: string | undefined): Promise<AuthenticatedStatementStaff | null>;
  now?: () => string;
  generateId?: () => string;
}

export interface AuthenticatedStatementStaff extends Omit<AuthenticatedStaff, "fhir"> {
  fhir: Pick<MedplumClient, "search" | "searchUrl" | "executeTransaction">;
}

export async function handleStatementListRequest(
  deps: StatementHandlerDeps,
  input: { authHeader: string | undefined; patientReference?: string },
): Promise<StatementHandlerResult> {
  const staff = await authorizedStaff(deps, input.authHeader);
  if ("result" in staff) return staff.result;
  if (input.patientReference !== undefined && !isPatientReference(input.patientReference)) {
    return badRequest("patientReference must be a local Patient/<id> reference.");
  }
  try {
    const [tasks, runs] = await Promise.all([
      searchAll<Task>(staff.staff.fhir, "Task", {
        code: `${STATEMENT_TASK_CODE_SYSTEM}|${PATIENT_STATEMENT_CODE}`,
        _sort: "-authored-on",
      }),
      searchAll<Task>(staff.staff.fhir, "Task", {
        code: `${STATEMENT_TASK_CODE_SYSTEM}|${STATEMENT_RUN_CODE}`,
        status: "completed",
      }),
    ]);
    const completedRuns = new Set(runs.flatMap((task) =>
      task.status === "completed" && taskCodeIs(task, STATEMENT_RUN_CODE) && task.id ? [`Task/${task.id}`] : [],
    ));
    const items = tasks
      .filter((task) => task.status === "completed")
      .flatMap((task) => {
        try {
          return [parseStatementTask(task)];
        } catch {
          return [];
        }
      })
      .filter((statement) => statement.runReference && completedRuns.has(statement.runReference))
      .filter((statement) => !input.patientReference || statement.patientReference === input.patientReference)
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
    return { status: 200, body: { items } };
  } catch (error) {
    if (error instanceof FhirSearchLimitError) return conflict(error.message);
    throw error;
  }
}

export async function handleGeneratePatientStatementRequest(
  deps: StatementHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<StatementHandlerResult> {
  const staff = await authorizedStaff(deps, input.authHeader);
  if ("result" in staff) return staff.result;
  const patientReference = patientReferenceBody(input.body);
  if (!patientReference) return badRequest("A valid patientReference is required.");
  return runStatements(staff.staff.fhir, {
    generatedAt: now(deps),
    patientReference,
    generateId: deps.generateId,
  });
}

export async function handleRunStatementsRequest(
  deps: StatementHandlerDeps,
  input: { authHeader: string | undefined },
): Promise<StatementHandlerResult> {
  const staff = await authorizedStaff(deps, input.authHeader);
  if ("result" in staff) return staff.result;
  return runStatements(staff.staff.fhir, {
    generatedAt: now(deps),
    generateId: deps.generateId,
  });
}

export function buildStatementSnapshot(input: {
  patient: Patient;
  invoices: Invoice[];
  paymentReconciliations: PaymentReconciliation[];
  generatedAt: string;
}): StatementSnapshot {
  if (!validDateTime(input.generatedAt)) throw new StatementValidationError("Statement generatedAt must be a valid dateTime.");
  const patientReference = patientReferenceOf(input.patient);
  if (input.invoices.length === 0) {
    throw new StatementValidationError("No issued Invoices are available for this patient.");
  }
  const invoiceReferences = new Set(input.invoices.map(invoiceReferenceOf));
  const payments = input.paymentReconciliations.filter((payment) =>
    payment.status === "active"
      && (payment.detail ?? []).some((detail) => invoiceReferences.has(detail.request?.reference ?? "")),
  );
  for (const payment of payments) validateLinkedPayment(payment, patientReference);

  const invoices = input.invoices.map((invoice) => {
    const invoiceReference = invoiceReferenceOf(invoice);
    if (invoice.status !== "issued") {
      throw new StatementValidationError(`${invoiceReference} is ${invoice.status}, not issued.`);
    }
    if (invoice.subject?.reference !== patientReference) {
      throw new StatementValidationError(`${invoiceReference} does not belong to ${patientReference}.`);
    }
    const totals = reconcileInvoiceTotals(invoice);
    const paymentsAppliedCents = payments.reduce((sum, payment) => sum + allocationCents(payment, invoiceReference), 0);
    if (paymentsAppliedCents > totals.netCents) {
      throw new StatementValidationError(
        `${invoiceReference} has ${paymentsAppliedCents} paid cents against ${totals.netCents} net cents.`,
      );
    }
    return {
      invoiceReference,
      ...(invoice.date ? { date: invoice.date } : {}),
      grossCents: totals.grossCents,
      netCents: totals.netCents,
      paymentsAppliedCents,
      balanceCents: totals.netCents - paymentsAppliedCents,
    };
  });
  const totalGrossCents = sum(invoices.map((invoice) => invoice.grossCents));
  const totalNetCents = sum(invoices.map((invoice) => invoice.netCents));
  const paymentsAppliedCents = sum(invoices.map((invoice) => invoice.paymentsAppliedCents));
  const balanceCents = sum(invoices.map((invoice) => invoice.balanceCents));
  if (balanceCents !== totalNetCents - paymentsAppliedCents) {
    throw new StatementValidationError("Statement total does not reconcile to its Invoice totals and payment allocations.");
  }
  return {
    generatedAt: input.generatedAt,
    patientReference,
    patientName: patientName(input.patient),
    paymentReconciliationReferences: payments.map(paymentReferenceOf),
    invoices,
    totalGrossCents,
    totalNetCents,
    paymentsAppliedCents,
    balanceCents,
  };
}

export function buildStatementTransaction(input: {
  generatedAt: string;
  statements: StatementSnapshot[];
  rejects: StatementRejectRow[];
  skippedZeroBalanceCount: number;
  generateId?: () => string;
}): { childBundles: Bundle[]; completionBundle: Bundle; runReference: string } {
  const generateId = input.generateId ?? randomUUID;
  const runId = generateId();
  const runReference = `Task/${runId}`;
  const runTask: Task = {
    resourceType: "Task",
    id: runId,
    identifier: [{ system: STATEMENT_RUN_IDENTIFIER_SYSTEM, value: runId }],
    status: "completed",
    intent: "order",
    code: taskCode(STATEMENT_RUN_CODE, "Statement run"),
    authoredOn: input.generatedAt,
    executionPeriod: { start: input.generatedAt, end: input.generatedAt },
    output: [
      integerOutput(RUN_OUTPUTS.generated, input.statements.length),
      integerOutput(RUN_OUTPUTS.invalidRejects, input.rejects.length),
      integerOutput(RUN_OUTPUTS.skipped, input.skippedZeroBalanceCount),
    ],
  };
  const childTasks: Array<{ fullUrl: string; task: Task }> = [];
  for (const snapshot of input.statements) {
    const fullUrl = `urn:uuid:${generateId()}`;
    childTasks.push({ fullUrl, task: statementTask(snapshot, runReference) });
  }
  for (const reject of input.rejects) {
    childTasks.push({ fullUrl: `urn:uuid:${generateId()}`, task: rejectTask(reject, input.generatedAt, runReference) });
  }
  const childEntries: BundleEntry[] = childTasks.map(({ fullUrl, task }) => ({
    fullUrl,
    resource: task,
    request: { method: "POST", url: "Task" },
  }));
  const childBundles: Bundle[] = [];
  for (let index = 0; index < childEntries.length; index += STATEMENT_TRANSACTION_CHILD_LIMIT) {
    childBundles.push({
      resourceType: "Bundle",
      type: "transaction",
      entry: childEntries.slice(index, index + STATEMENT_TRANSACTION_CHILD_LIMIT),
    });
  }
  return {
    childBundles,
    runReference,
    completionBundle: {
      resourceType: "Bundle",
      type: "transaction",
      entry: [{ resource: runTask, request: { method: "PUT", url: runReference } }],
    },
  };
}

export function parseStatementTask(task: Task): StatementRow {
  if (!taskCodeIs(task, PATIENT_STATEMENT_CODE) || task.status !== "completed") {
    throw new StatementValidationError("Task is not a completed OSOD patient statement.");
  }
  if (!task.id) throw new StatementValidationError("Patient statement Task is missing its id.");
  const snapshotJson = output(task.output, STATEMENT_OUTPUTS.snapshot)?.valueString;
  if (!snapshotJson) throw new StatementValidationError("Patient statement Task is missing its snapshot.");
  let snapshot: StatementSnapshot;
  try {
    snapshot = JSON.parse(snapshotJson) as StatementSnapshot;
  } catch {
    throw new StatementValidationError("Patient statement snapshot is not valid JSON.");
  }
  validateSnapshot(snapshot);
  const persistedBalance = moneyOutputCents(output(task.output, STATEMENT_OUTPUTS.balance));
  if (persistedBalance !== snapshot.balanceCents) {
    throw new StatementValidationError("Patient statement balance does not match its persisted snapshot.");
  }
  const runReference = task.partOf?.[0]?.reference;
  return {
    ...snapshot,
    statementReference: `Task/${task.id}`,
    ...(runReference ? { runReference } : {}),
  };
}

export function latestStatementRun(tasks: readonly Task[]): {
  generatedAt: string | null;
  invalidRejects: number;
} {
  const latest = tasks
    .filter((task) => task.status === "completed" && taskCodeIs(task, STATEMENT_RUN_CODE))
    .sort((left, right) => (right.authoredOn ?? "").localeCompare(left.authoredOn ?? ""))[0];
  if (!latest) return { generatedAt: null, invalidRejects: 0 };
  if (!latest.authoredOn) return { generatedAt: null, invalidRejects: 0 };
  return { generatedAt: latest.authoredOn, invalidRejects: integerOutputValue(latest.output, RUN_OUTPUTS.invalidRejects) };
}

export class StatementValidationError extends Error {}

async function runStatements(
  fhir: AuthenticatedStatementStaff["fhir"],
  options: { generatedAt: string; patientReference?: string; generateId?: () => string },
): Promise<StatementHandlerResult> {
  try {
    const invoiceParams: Record<string, string> = options.patientReference
      ? { status: "issued", subject: options.patientReference, _sort: "date" }
      : { status: "issued", _sort: "subject,date" };
    const [invoices, payments] = await Promise.all([
      searchAll<Invoice>(fhir, "Invoice", invoiceParams),
      searchAll<PaymentReconciliation>(fhir, "PaymentReconciliation", { status: "active" }),
    ]);
    const patientReferences = options.patientReference
      ? [options.patientReference]
      : unique(invoices.flatMap((invoice) => isPatientReference(invoice.subject?.reference) ? [invoice.subject.reference] : []));
    const patients = patientReferences.length === 0
      ? []
      : await searchAll<Patient>(fhir, "Patient", { _id: patientReferences.map(referenceId).join(",") });
    const patientByReference = new Map(patients.map((patient) => [patientReferenceOf(patient), patient]));
    const statements: StatementSnapshot[] = [];
    const rejects: StatementRejectRow[] = [];
    let skippedZeroBalanceCount = 0;
    for (const patientReference of patientReferences) {
      const patient = patientByReference.get(patientReference);
      const patientInvoices = invoices.filter((invoice) => invoice.subject?.reference === patientReference);
      if (!patient) {
        rejects.push({ patientReference, patientName: patientReference, reason: `${patientReference} could not be loaded.` });
        continue;
      }
      if (patientInvoices.length === 0) {
        if (options.patientReference) {
          rejects.push({ patientReference, patientName: patientName(patient), reason: "No issued Invoices are available for this patient." });
        } else {
          skippedZeroBalanceCount += 1;
        }
        continue;
      }
      try {
        const snapshot = buildStatementSnapshot({ patient, invoices: patientInvoices, paymentReconciliations: payments, generatedAt: options.generatedAt });
        if (snapshot.balanceCents === 0) skippedZeroBalanceCount += 1;
        else statements.push(snapshot);
      } catch (error) {
        rejects.push({ patientReference, patientName: patientName(patient), reason: messageOf(error) });
      }
    }
    const transaction = buildStatementTransaction({
      generatedAt: options.generatedAt,
      statements,
      rejects,
      skippedZeroBalanceCount,
      generateId: options.generateId,
    });
    const childResponses: BundleEntry[] = [];
    const createdChildReferences: string[] = [];
    try {
      for (const bundle of transaction.childBundles) {
        const response = await fhir.executeTransaction(bundle);
        const responseEntries = response.entry ?? [];
        childResponses.push(...responseEntries);
        createdChildReferences.push(...responseEntries.flatMap((entry) => {
          try {
            return [transactionReference(entry, "Task")];
          } catch {
            return [];
          }
        }));
      }
    } catch (error) {
      await deleteStatementChildren(fhir, createdChildReferences);
      throw error;
    }
    try {
      await fhir.executeTransaction(transaction.completionBundle);
    } catch (error) {
      let runCompleted = true;
      try {
        const runId = transaction.runReference.slice("Task/".length);
        const runs = await searchAll<Task>(fhir, "Task", { _id: runId });
        runCompleted = runs.some((task) => task.id === runId && task.status === "completed" && taskCodeIs(task, STATEMENT_RUN_CODE));
      } catch {}
      if (!runCompleted) await deleteStatementChildren(fhir, createdChildReferences);
      throw error;
    }
    const runReference = transaction.runReference;
    const rows = statements.map((statement, index) => ({
      ...statement,
      statementReference: transactionReference(childResponses[index], "Task"),
      runReference,
    }));
    return {
      status: 200,
      body: {
        runReference,
        generatedAt: options.generatedAt,
        generatedCount: rows.length,
        invalidRejects: rejects.length,
        skippedZeroBalanceCount,
        statements: rows,
        rejects,
      } satisfies StatementRunResult,
    };
  } catch (error) {
    if (error instanceof FhirSearchLimitError) return conflict(error.message);
    throw error;
  }
}

async function deleteStatementChildren(
  fhir: AuthenticatedStatementStaff["fhir"],
  references: readonly string[],
): Promise<void> {
  for (let index = 0; index < references.length; index += STATEMENT_TRANSACTION_CHILD_LIMIT) {
    const batchReferences = references.slice(index, index + STATEMENT_TRANSACTION_CHILD_LIMIT);
    try {
      await fhir.executeTransaction({
        resourceType: "Bundle",
        type: "transaction",
        entry: batchReferences.map((reference) => ({
          request: { method: "DELETE", url: reference },
        })),
      });
    } catch (error) {
      console.error(`Statement cleanup failed for child Tasks ${batchReferences.join(", ")}: ${messageOf(error)}`);
    }
  }
}

async function authorizedStaff(
  deps: StatementHandlerDeps,
  authHeader: string | undefined,
): Promise<{ staff: AuthenticatedStatementStaff } | { result: StatementHandlerResult }> {
  let staff: AuthenticatedStatementStaff | null;
  try {
    staff = await deps.authenticate(authHeader);
  } catch (error) {
    if (error instanceof StaffRoleServiceUnavailableError) {
      return { result: { status: 503, body: { error: "Statement service temporarily unavailable." } } };
    }
    throw error;
  }
  if (!staff) return { result: { status: 401, body: { error: "Authentication required to manage statements." } } };
  if (!PRACTICE_ROLE_IDS.includes(staff.actorRole as PracticeRoleId)) {
    return { result: { status: 403, body: { error: "payment.charge role required" } } };
  }
  try {
    assertBusinessActionAllowed(staff.actorRole as PracticeRoleId, "payment.charge");
  } catch {
    return { result: { status: 403, body: { error: "payment.charge role required" } } };
  }
  return { staff };
}

function reconcileInvoiceTotals(invoice: Invoice): { grossCents: number; netCents: number } {
  const reference = invoiceReferenceOf(invoice);
  if (!invoice.lineItem?.length) throw new StatementValidationError(`${reference} has no line items.`);
  let computedGrossCents = 0;
  let computedNetCents = 0;
  for (const line of invoice.lineItem) {
    if (!line.priceComponent?.length) throw new StatementValidationError(`${reference} has a line without price components.`);
    for (const component of line.priceComponent) {
      const cents = moneyCents(component.amount?.value, component.amount?.currency, `${reference} ${component.type}`);
      if (component.type === "informational") continue;
      if (component.type === "discount" || component.type === "deduction") computedNetCents -= cents;
      else {
        computedGrossCents += cents;
        computedNetCents += cents;
      }
    }
  }
  const grossCents = moneyCents(invoice.totalGross?.value, invoice.totalGross?.currency, `${reference} totalGross`);
  const netCents = moneyCents(invoice.totalNet?.value, invoice.totalNet?.currency, `${reference} totalNet`);
  if (computedGrossCents !== grossCents || computedNetCents !== netCents) {
    throw new StatementValidationError(
      `${reference} does not reconcile: computed gross ${computedGrossCents}/net ${computedNetCents} cents vs persisted gross ${grossCents}/net ${netCents}.`,
    );
  }
  return { grossCents, netCents };
}

function validateLinkedPayment(payment: PaymentReconciliation, patientReference: string): void {
  const reference = `PaymentReconciliation/${payment.id ?? "unknown"}`;
  if (paymentSubjectReference(payment) !== patientReference) {
    throw new StatementValidationError(`${reference} allocation does not belong to ${patientReference}.`);
  }
  const amountCents = paymentAmountCents(payment);
  const allocatedCents = sum((payment.detail ?? []).map((detail) =>
    moneyCents(detail.amount?.value, detail.amount?.currency, `${reference} allocation`),
  ));
  if (allocatedCents > amountCents) {
    throw new StatementValidationError(`${reference} allocations exceed its payment amount.`);
  }
}

function allocationCents(payment: PaymentReconciliation, invoiceReference: string): number {
  return sum((payment.detail ?? [])
    .filter((detail) => detail.request?.reference === invoiceReference)
    .map((detail) => moneyCents(detail.amount?.value, detail.amount?.currency, `${invoiceReference} payment allocation`)));
}

function statementTask(snapshot: StatementSnapshot, runReference: string): Task {
  return {
    resourceType: "Task",
    status: "completed",
    intent: "order",
    code: taskCode(PATIENT_STATEMENT_CODE, "Patient balance-forward statement"),
    for: { reference: snapshot.patientReference, display: snapshot.patientName },
    partOf: [{ reference: runReference }],
    authoredOn: snapshot.generatedAt,
    executionPeriod: { start: snapshot.generatedAt, end: snapshot.generatedAt },
    input: [
      ...snapshot.invoices.map((invoice): TaskInput => ({ type: outputCode(STATEMENT_INPUTS.invoice), valueReference: { reference: invoice.invoiceReference } })),
      ...snapshot.paymentReconciliationReferences.map((reference): TaskInput => ({ type: outputCode(STATEMENT_INPUTS.payment), valueReference: { reference } })),
    ],
    output: [
      { type: outputCode(STATEMENT_OUTPUTS.snapshot), valueString: JSON.stringify(snapshot) },
      { type: outputCode(STATEMENT_OUTPUTS.balance), valueMoney: { value: snapshot.balanceCents / 100, currency: "USD" } },
    ],
  };
}

function rejectTask(reject: StatementRejectRow, generatedAt: string, runReference: string): Task {
  return {
    resourceType: "Task",
    status: "failed",
    statusReason: { text: reject.reason },
    intent: "order",
    code: taskCode(PATIENT_STATEMENT_CODE, "Patient balance-forward statement"),
    for: { reference: reject.patientReference, display: reject.patientName },
    partOf: [{ reference: runReference }],
    authoredOn: generatedAt,
    executionPeriod: { start: generatedAt, end: generatedAt },
  };
}

function validateSnapshot(snapshot: StatementSnapshot): void {
  if (!isPatientReference(snapshot.patientReference) || !snapshot.patientName || !snapshot.generatedAt
    || !Array.isArray(snapshot.invoices) || !Array.isArray(snapshot.paymentReconciliationReferences)
    || snapshot.paymentReconciliationReferences.some((reference) => !/^PaymentReconciliation\/[A-Za-z0-9.-]+$/.test(reference))) {
    throw new StatementValidationError("Patient statement snapshot is incomplete.");
  }
  for (const value of [snapshot.totalGrossCents, snapshot.totalNetCents, snapshot.paymentsAppliedCents, snapshot.balanceCents]) {
    if (!Number.isInteger(value) || value < 0) throw new StatementValidationError("Patient statement snapshot contains invalid money.");
  }
  for (const invoice of snapshot.invoices) {
    if (!/^Invoice\/[A-Za-z0-9.-]+$/.test(invoice.invoiceReference)
      || [invoice.grossCents, invoice.netCents, invoice.paymentsAppliedCents, invoice.balanceCents]
        .some((value) => !Number.isInteger(value) || value < 0)
      || invoice.balanceCents !== invoice.netCents - invoice.paymentsAppliedCents) {
      throw new StatementValidationError("Patient statement snapshot contains an invalid Invoice row.");
    }
  }
  const totalGrossCents = sum(snapshot.invoices.map((invoice) => invoice.grossCents));
  const totalNetCents = sum(snapshot.invoices.map((invoice) => invoice.netCents));
  const paymentsAppliedCents = sum(snapshot.invoices.map((invoice) => invoice.paymentsAppliedCents));
  const balanceCents = sum(snapshot.invoices.map((invoice) => invoice.balanceCents));
  if (totalGrossCents !== snapshot.totalGrossCents || totalNetCents !== snapshot.totalNetCents
    || paymentsAppliedCents !== snapshot.paymentsAppliedCents || balanceCents !== snapshot.balanceCents
    || balanceCents !== totalNetCents - paymentsAppliedCents) {
    throw new StatementValidationError("Patient statement snapshot totals do not reconcile.");
  }
}

function taskCode(code: string, display: string) {
  return { coding: [{ system: STATEMENT_TASK_CODE_SYSTEM, code, display }], text: display };
}

function outputCode(code: string) {
  return { coding: [{ system: STATEMENT_OUTPUT_CODE_SYSTEM, code }] };
}

function integerOutput(code: string, valueInteger: number): TaskOutput {
  return { type: outputCode(code), valueInteger };
}

function output(outputs: TaskOutput[] | undefined, code: string): TaskOutput | undefined {
  return outputs?.find((candidate) => candidate.type.coding?.some((coding) =>
    coding.system === STATEMENT_OUTPUT_CODE_SYSTEM && coding.code === code,
  ));
}

function integerOutputValue(outputs: TaskOutput[] | undefined, code: string): number {
  const value = output(outputs, code)?.valueInteger;
  if (!Number.isInteger(value) || value! < 0) throw new StatementValidationError(`Statement run is missing ${code}.`);
  return value!;
}

function moneyOutputCents(value: TaskOutput | undefined): number {
  return moneyCents(value?.valueMoney?.value, value?.valueMoney?.currency, "patient statement balance");
}

function taskCodeIs(task: Task, code: string): boolean {
  return task.code?.coding?.some((coding) => coding.system === STATEMENT_TASK_CODE_SYSTEM && coding.code === code) ?? false;
}

function transactionReference(entry: BundleEntry | undefined, resourceType: string): string {
  const match = entry?.response?.location?.match(new RegExp(`^${resourceType}/([^/]+)`));
  if (!match) throw new Error(`Statement transaction did not return a ${resourceType} location.`);
  return `${resourceType}/${match[1]}`;
}

function invoiceReferenceOf(invoice: Invoice): string {
  if (!invoice.id) throw new StatementValidationError("Invoice is missing its id.");
  return `Invoice/${invoice.id}`;
}

function patientReferenceOf(patient: Patient): string {
  if (!patient.id) throw new StatementValidationError("Patient is missing its id.");
  return `Patient/${patient.id}`;
}

function paymentReferenceOf(payment: PaymentReconciliation): string {
  if (!payment.id) throw new StatementValidationError("PaymentReconciliation is missing its id.");
  return `PaymentReconciliation/${payment.id}`;
}

function patientName(patient: Patient): string {
  const name = patient.name?.[0];
  const label = name?.text ?? [name?.given?.join(" "), name?.family].filter(Boolean).join(" ");
  return label || patientReferenceOf(patient);
}

function moneyCents(value: number | undefined, currency: string | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new StatementValidationError(`${label} is missing or invalid.`);
  }
  if (currency !== undefined && currency !== "USD") throw new StatementValidationError(`${label} is not USD.`);
  return Math.round(value * 100);
}

function patientReferenceBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>).patientReference;
  return isPatientReference(value) ? value : undefined;
}

function isPatientReference(value: unknown): value is string {
  return typeof value === "string" && /^Patient\/[A-Za-z0-9.-]+$/.test(value);
}

function validDateTime(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function referenceId(reference: string): string {
  return reference.slice("Patient/".length);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function now(deps: StatementHandlerDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

function badRequest(error: string): StatementHandlerResult {
  return { status: 400, body: { error } };
}

function conflict(error: string): StatementHandlerResult {
  return { status: 409, body: { error } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
