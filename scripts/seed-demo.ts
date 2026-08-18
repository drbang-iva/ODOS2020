#!/usr/bin/env tsx
import type {
  Appointment,
  ChargeItem,
  Claim,
  ClaimResponse,
  Coverage,
  HealthcareService,
  Invoice,
  Organization,
  Patient,
  PaymentReconciliation,
  Practitioner,
  PractitionerRole,
  Resource,
  Schedule,
  Task,
} from "@medplum/fhirtypes";
import { ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL } from "../mcp/src/claims/claimmd-fhir.js";
import { buildPatientResponsibilityInvoice } from "../mcp/src/claims/patient-responsibility-invoice.js";
import { buildSchedulingAppointment } from "../mcp/src/fhir/schedulingAppointment.js";
import { buildSchedulingResource } from "../mcp/src/fhir/schedulingResource.js";
import { buildVisitType } from "../mcp/src/fhir/schedulingVisitType.js";
import type { MedplumClient } from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";
import { buildPaymentReconciliation } from "../mcp/src/payments/payment-reconciliation.js";
import {
  PATIENT_STATEMENT_CODE,
  STATEMENT_OUTPUT_CODE_SYSTEM,
  STATEMENT_RUN_CODE,
  STATEMENT_TASK_CODE_SYSTEM,
  generatePatientStatementForOperator,
  parseStatementTask,
  type StatementSnapshot,
} from "../mcp/src/statements/statements.js";
import { assertLocalMedplumBaseUrl } from "./reseed-practice-role-tags.js";
import { loadVerifiedOperatorFhirClient } from "./operator-identity.js";

const DEFAULT_MEDPLUM_BASE_URL = "http://localhost:8103";
export const DEMO_SEED_SYSTEM = "https://odos2020.com/seed/operator-demo";

type DemoResource = Patient | Practitioner | PractitionerRole | HealthcareService | Schedule | Appointment
  | ChargeItem | Claim | ClaimResponse | Coverage | Invoice | Organization | PaymentReconciliation;
type DemoResourceType = DemoResource["resourceType"];
type GeneratedDemoStatement = StatementSnapshot & { statementReference?: string };

export interface DemoSeedAdapter {
  findByIdentifier<T extends DemoResource>(resourceType: T["resourceType"], value: string): Promise<T[]>;
  create<T extends DemoResource>(resource: T, conditionalCreate?: string): Promise<T>;
  hasStatement(patientReference: string): Promise<boolean>;
  generateStatement(patientReference: string): Promise<{
    generatedCount: number;
    generatedAt?: string;
    statements: GeneratedDemoStatement[];
  }>;
}

export interface DemoSeedResult {
  readonly created: DemoResourceType[];
  readonly existing: DemoResourceType[];
  readonly patientReference: string;
  readonly insuredPatientReference: string;
  readonly statement: "CREATED" | "EXISTING";
  readonly insuredStatement: "CREATED" | "EXISTING";
}

export async function seedDemo(adapter: DemoSeedAdapter): Promise<DemoSeedResult> {
  const created: DemoResourceType[] = [];
  const existing: DemoResourceType[] = [];
  const ensure = async <T extends DemoResource>(
    resourceType: T["resourceType"],
    marker: string,
    build: () => T,
  ): Promise<T> => {
    const matches = await adapter.findByIdentifier<T>(resourceType, marker);
    if (matches.length > 1) {
      throw new Error(`${resourceType} demo marker ${marker} has ${matches.length} matches; seed stopped.`);
    }
    if (matches[0]) {
      existing.push(resourceType);
      return matches[0];
    }
    // PaymentReconciliation carries its demo marker in paymentIdentifier, which has no
    // server-side search parameter in R4/Medplum; the findByIdentifier pre-check above already
    // guards idempotency for this single-threaded seed, so skip the If-None-Exist guard here.
    const condition = resourceType === "PaymentReconciliation"
      ? undefined
      : `identifier=${DEMO_SEED_SYSTEM}|${marker}`;
    const resource = await adapter.create(build(), condition);
    if (!resource.id) throw new Error(`${resourceType} demo seed create returned no id.`);
    created.push(resourceType);
    return resource;
  };

  const patient = await ensure<Patient>("Patient", "patient", () => ({
    resourceType: "Patient",
    active: true,
    identifier: [demoIdentifier("patient")],
    name: [{ family: "TEST-Rivera", given: ["Alex"], text: "TEST-Rivera, Alex" }],
    birthDate: "1900-01-01",
    gender: "unknown",
  }));
  const practitioner = await ensure<Practitioner>("Practitioner", "provider", () => ({
    resourceType: "Practitioner",
    active: true,
    identifier: [demoIdentifier("provider")],
    name: [{ family: "TEST-Provider", given: ["Dev"], text: "TEST-Provider, Dev" }],
  }));
  const visitType = await ensure<HealthcareService>("HealthcareService", "visit-type", () => ({
    ...buildVisitType({
      code: "operator-demo-exam",
      name: "Demo comprehensive exam",
      discipline: "eyecare",
      durationMinutes: 30,
      color: "#4a7dff",
    }),
    identifier: [demoIdentifier("visit-type")],
  }));
  const schedule = await ensure<Schedule>("Schedule", "schedule", () => ({
    ...buildSchedulingResource({
      kind: "provider",
      actorReference: `Practitioner/${practitioner.id}`,
      actorDisplay: "TEST-Provider, Dev",
      disciplines: ["eyecare"],
    }),
    identifier: [demoIdentifier("schedule")],
  }));
  await ensure<Appointment>("Appointment", "appointment", () => ({
    ...buildSchedulingAppointment({
      patient: { reference: `Patient/${patient.id}`, display: "TEST-Rivera, Alex" },
      visitTypeCode: "operator-demo-exam",
      visitTypeDisplay: visitType.name,
      discipline: "eyecare",
      resources: [{ reference: `Practitioner/${practitioner.id}`, display: "TEST-Provider, Dev" }],
      start: demoAppointmentStart(),
      durationMinutes: 30,
      status: "scheduled",
      confirmation: "confirmed",
    }),
    identifier: [demoIdentifier("appointment")],
    supportingInformation: [{ reference: `Schedule/${schedule.id}` }],
  }));
  const invoice = await ensure<Invoice>("Invoice", "invoice", () => ({
    resourceType: "Invoice",
    identifier: [demoIdentifier("invoice")],
    status: "issued",
    subject: { reference: `Patient/${patient.id}`, display: "TEST-Rivera, Alex" },
    date: new Date().toISOString(),
    lineItem: [{
      sequence: 1,
      chargeItemCodeableConcept: { text: "Demo comprehensive exam" },
      priceComponent: [{ type: "base", amount: { value: 125, currency: "USD" } }],
    }],
    totalGross: { value: 125, currency: "USD" },
    totalNet: { value: 125, currency: "USD" },
  }));
  await ensure<PaymentReconciliation>("PaymentReconciliation", "prepaid-credit", () => ({
    ...buildPaymentReconciliation({
      outcome: "success",
      createdIso: new Date().toISOString(),
      paymentDate: new Date().toISOString().slice(0, 10),
      amountCents: 2_500,
      subjectReference: `Patient/${patient.id}`,
      processorTransactionId: "prepaid-credit",
      processorTransactionSystem: DEMO_SEED_SYSTEM,
      surface: "manual",
      tender: { code: "CASH", display: "Demo prepaid cash" },
      description: "Synthetic unapplied credit for the operator demo",
    }),
  }));

  const insuredPatient = await ensure<Patient>("Patient", "insured-patient", () => ({
    resourceType: "Patient",
    active: true,
    identifier: [demoIdentifier("insured-patient")],
    name: [{ family: "TEST-Insured", given: ["Demo"], text: "TEST-Insured, Demo" }],
    birthDate: "1900-01-02",
    gender: "unknown",
    address: [{
      use: "home",
      line: ["200 Demo Patient Way"],
      city: "Raleigh",
      state: "NC",
      postalCode: "27601",
    }],
  }));
  const demoPayer = await ensure<Organization>("Organization", "demo-payer", () => ({
    resourceType: "Organization",
    active: true,
    identifier: [demoIdentifier("demo-payer")],
    name: "ODOS Demo Insurance",
  }));
  const demoPayerReference = `Organization/${demoPayer.id}`;
  const coverage = await ensure<Coverage>("Coverage", "insured-coverage", () => ({
    resourceType: "Coverage",
    status: "active",
    identifier: [demoIdentifier("insured-coverage")],
    beneficiary: { reference: `Patient/${insuredPatient.id}`, display: "TEST-Insured, Demo" },
    payor: [{ reference: demoPayerReference, display: "ODOS Demo Insurance" }],
  }));
  const insuredProvider = await ensure<Practitioner>("Practitioner", "insured-provider", () => ({
    resourceType: "Practitioner",
    active: true,
    identifier: [
      demoIdentifier("insured-provider"),
      { system: "http://hl7.org/fhir/sid/us-npi", value: "1111111112" },
    ],
    name: [{ family: "TEST-Optometrist", given: ["Morgan"], text: "Morgan TEST-Optometrist, OD" }],
    address: [{
      use: "work",
      line: ["100 Demo Practice Ave"],
      city: "Raleigh",
      state: "NC",
      postalCode: "27601",
    }],
    qualification: [{
      identifier: [{ system: `${DEMO_SEED_SYSTEM}/license`, value: "DEMO-OD-100" }],
      code: { text: "Demo optometry license" },
    }],
  }));
  await ensure<PractitionerRole>("PractitionerRole", "insured-provider-role", () => ({
    resourceType: "PractitionerRole",
    active: true,
    identifier: [demoIdentifier("insured-provider-role")],
    practitioner: { reference: `Practitioner/${insuredProvider.id}`, display: "Morgan TEST-Optometrist, OD" },
    organization: { display: "ODOS Demo Eye Care" },
    telecom: [{ system: "phone", use: "work", value: "919-555-0100" }],
  }));
  const insuredPatientReference = `Patient/${insuredPatient.id}`;
  const chargeItems = await Promise.all([
    ensure<ChargeItem>("ChargeItem", "insured-charge-1", () => demoChargeItem(
      "insured-charge-1",
      insuredPatientReference,
      "00000",
      "Demo procedure one; synthetic pass-through code",
      100,
    )),
    ensure<ChargeItem>("ChargeItem", "insured-charge-2", () => demoChargeItem(
      "insured-charge-2",
      insuredPatientReference,
      "00001",
      "Demo procedure two; synthetic pass-through code",
      75,
    )),
  ]);
  const claim = await ensure<Claim>("Claim", "insured-claim", () => ({
    resourceType: "Claim",
    status: "active",
    type: { text: "Demo professional claim" },
    use: "claim",
    identifier: [demoIdentifier("insured-claim")],
    patient: { reference: insuredPatientReference, display: "TEST-Insured, Demo" },
    created: "2026-07-10",
    insurer: { reference: demoPayerReference, display: "ODOS Demo Insurance" },
    provider: { reference: `Practitioner/${insuredProvider.id}`, display: "Morgan TEST-Optometrist, OD" },
    priority: { text: "normal" },
    insurance: [{ sequence: 1, focal: true, coverage: { reference: `Coverage/${coverage.id}` } }],
    diagnosis: [
      { sequence: 1, diagnosisCodeableConcept: { coding: [{
        system: `${DEMO_SEED_SYSTEM}/demo-diagnosis`,
        code: "D00.00",
        display: "Demo diagnosis one; synthetic pass-through code",
      }] } },
      { sequence: 2, diagnosisCodeableConcept: { coding: [{
        system: `${DEMO_SEED_SYSTEM}/demo-diagnosis`,
        code: "D00.01",
        display: "Demo diagnosis two; synthetic pass-through code",
      }] } },
    ],
    item: chargeItems.map((chargeItem, index) => ({
      sequence: index + 1,
      extension: [{
        url: ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL,
        valueReference: { reference: `ChargeItem/${chargeItem.id}` },
      }],
      productOrService: { coding: chargeItem.code.coding },
      servicedDate: "2026-07-10",
      diagnosisSequence: [index + 1],
      quantity: { value: 1 },
      unitPrice: chargeItem.priceOverride,
      net: chargeItem.priceOverride,
    })),
    total: { value: 175, currency: "USD" },
  }));
  const claimReference = `Claim/${claim.id}`;
  const claimResponse = await ensure<ClaimResponse>("ClaimResponse", "insured-claim-response", () => ({
    resourceType: "ClaimResponse",
    status: "active",
    type: { text: "Demo professional claim response" },
    use: "claim",
    identifier: [demoIdentifier("insured-claim-response")],
    patient: { reference: insuredPatientReference },
    created: "2026-07-11T12:00:00.000Z",
    insurer: { reference: demoPayerReference, display: "ODOS Demo Insurance" },
    request: { reference: claimReference },
    outcome: "complete",
    item: [
      demoAdjudicationItem(1, 60, 20, 20, "Transfer balance to patient: Patient deductible"),
      demoAdjudicationItem(2, 30, 15, 30, "Transfer balance to patient: Patient coinsurance"),
    ],
  }));
  const insuredInvoice = await ensure<Invoice>("Invoice", "insured-invoice", () => {
    const invoice = buildPatientResponsibilityInvoice(claim, claimResponse);
    if (!invoice) throw new Error("Demo insured ClaimResponse did not produce a patient-responsibility Invoice.");
    return { ...invoice, identifier: [...(invoice.identifier ?? []), demoIdentifier("insured-invoice")] };
  });
  await ensure<PaymentReconciliation>("PaymentReconciliation", "insured-partial-payment", () => ({
    ...buildPaymentReconciliation({
      outcome: "success",
      createdIso: "2026-07-12T12:00:00.000Z",
      paymentDate: "2026-07-12",
      amountCents: 1_500,
      subjectReference: insuredPatientReference,
      invoiceReference: `Invoice/${insuredInvoice.id}`,
      processorTransactionId: "insured-partial-payment",
      processorTransactionSystem: DEMO_SEED_SYSTEM,
      surface: "manual",
      tender: { code: "CASH", display: "Demo patient payment" },
      description: "Synthetic partial patient payment for the insurance-aware statement demo",
    }),
  }));

  const patientReference = `Patient/${patient.id}`;
  const statement = await adapter.hasStatement(patientReference) ? "EXISTING" : "CREATED";
  if (statement === "CREATED") {
    const generated = await adapter.generateStatement(patientReference);
    if (generated.generatedCount !== 1 || generated.statements[0]?.unappliedCreditCents !== 2_500) {
      throw new Error("Demo statement did not persist the expected issued Invoice and $25 unapplied credit.");
    }
  }

  const insuredStatement = await adapter.hasStatement(insuredPatientReference) ? "EXISTING" : "CREATED";
  if (insuredStatement === "CREATED") {
    const generated = await adapter.generateStatement(insuredPatientReference);
    assertInsuranceAwareDemoStatement(generated);
  }

  if (!invoice.id) throw new Error("Demo Invoice is missing its id.");
  return { created, existing, patientReference, insuredPatientReference, statement, insuredStatement };
}

function demoChargeItem(
  marker: string,
  patientReference: string,
  code: string,
  display: string,
  price: number,
): ChargeItem {
  return {
    resourceType: "ChargeItem",
    identifier: [demoIdentifier(marker)],
    status: "billable",
    subject: { reference: patientReference },
    code: { coding: [{ system: `${DEMO_SEED_SYSTEM}/demo-procedure`, code, display }], text: display },
    quantity: { value: 1 },
    priceOverride: { value: price, currency: "USD" },
  };
}

function demoAdjudicationItem(
  itemSequence: number,
  paid: number,
  insuranceAdjustment: number,
  patientResponsibility: number,
  patientReason: string,
): NonNullable<ClaimResponse["item"]>[number] {
  return {
    itemSequence,
    adjudication: [
      { category: { text: "paid" }, amount: { value: paid, currency: "USD" } },
      {
        category: { text: "adjustment CO DEMO" },
        reason: { text: "Demo insurance contractual adjustment" },
        amount: { value: insuranceAdjustment, currency: "USD" },
      },
      {
        category: { text: "adjustment PR DEMO" },
        reason: { text: patientReason },
        amount: { value: patientResponsibility, currency: "USD" },
      },
    ],
  };
}

export function assertInsuranceAwareDemoStatement(result: {
  generatedCount: number;
  statements: GeneratedDemoStatement[];
}): void {
  const statement = result.statements[0];
  const order = statement?.detail?.orders[0];
  const lines = order?.lines ?? [];
  const procedureCodes = lines.flatMap((line) => line.procedureCode ? [line.procedureCode] : []);
  const diagnosisCodes = lines.flatMap((line) => line.diagnosisCodes);
  const insuranceAdjustments = lines.flatMap((line) => line.insuranceAdjustments);
  const patientAdjustments = lines.flatMap((line) => line.patientAdjustments);
  const header = statement?.detail?.header;
  if (result.generatedCount !== 1
    || order?.mode !== "insurance-aware"
    || !procedureCodes.includes("00000")
    || !procedureCodes.includes("00001")
    || !diagnosisCodes.includes("D00.00")
    || !diagnosisCodes.includes("D00.01")
    || order.payerName !== "ODOS Demo Insurance"
    || insuranceAdjustments.length !== 2
    || patientAdjustments.length !== 2
    || !patientAdjustments.every((row) => row.label.startsWith("Transfer balance to patient:"))
    || order.patientPayments.length !== 1
    || order.patientPayments[0].date !== "2026-07-12"
    || order.patientPayments[0].amountCents !== 1_500
    || header?.practiceName !== "ODOS Demo Eye Care"
    || header.practicePhone !== "919-555-0100"
    || header.providerNpi !== "1111111112"
    || header.providerLicense !== "DEMO-OD-100"
    || header.patientAddress?.lines[0] !== "200 Demo Patient Way"
    || statement.balanceCents !== 3_500
    || statement.balanceDueCents !== 3_500) {
    throw new Error("Demo insured statement did not preserve the insurance-aware claim, adjustment, payment, and T0 balance seam.");
  }
}

function demoIdentifier(value: string) {
  return { system: DEMO_SEED_SYSTEM, value };
}

export function demoAppointmentStart(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZoneName: "longOffset",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const offset = value("timeZoneName").replace("GMT", "") || "-05:00";
  return `${value("year")}-${value("month")}-${value("day")}T10:00:00${offset}`;
}

class LiveDemoSeedAdapter implements DemoSeedAdapter {
  constructor(private readonly fhir: MedplumClient) {}

  async findByIdentifier<T extends DemoResource>(
    resourceType: T["resourceType"],
    value: string,
  ): Promise<T[]> {
    if (resourceType === "PaymentReconciliation") {
      const payments = await searchAll<PaymentReconciliation>(this.fhir, "PaymentReconciliation", { status: "active" });
      return payments.filter((payment) =>
        payment.paymentIdentifier?.system === DEMO_SEED_SYSTEM && payment.paymentIdentifier.value === value,
      ) as T[];
    }
    return searchAll<T>(this.fhir, resourceType, { identifier: `${DEMO_SEED_SYSTEM}|${value}` });
  }

  async create<T extends DemoResource>(resource: T, conditionalCreate?: string): Promise<T> {
    return this.fhir.create(resource, conditionalCreate ? { "If-None-Exist": conditionalCreate } : undefined);
  }

  async hasStatement(patientReference: string): Promise<boolean> {
    const [tasks, runs] = await Promise.all([
      searchAll<Task>(this.fhir, "Task", {
        code: `${STATEMENT_TASK_CODE_SYSTEM}|${PATIENT_STATEMENT_CODE}`,
        status: "completed",
      }),
      searchAll<Task>(this.fhir, "Task", {
        code: `${STATEMENT_TASK_CODE_SYSTEM}|${STATEMENT_RUN_CODE}`,
        status: "completed",
      }),
    ]);
    const completedRuns = new Set(runs.flatMap((run) => run.id ? [`Task/${run.id}`] : []));
    return tasks.some((task) => {
      try {
        const statement = parseStatementTask(task);
        return statement.patientReference === patientReference
          && Boolean(statement.runReference && completedRuns.has(statement.runReference));
      } catch {
        return false;
      }
    });
  }

  async generateStatement(patientReference: string): Promise<{
    generatedCount: number;
    generatedAt?: string;
    statements: GeneratedDemoStatement[];
  }> {
    return generatePatientStatementForOperator(this.fhir, {
      patientReference,
      generatedAt: new Date().toISOString(),
    });
  }
}

export function buildDemoStatementRun(generatedAt: string): Task {
  return {
      resourceType: "Task",
      identifier: [{ system: DEMO_SEED_SYSTEM, value: "statement-run" }],
      status: "completed",
      intent: "order",
      code: {
        coding: [{ system: STATEMENT_TASK_CODE_SYSTEM, code: STATEMENT_RUN_CODE, display: "Statement run" }],
        text: "Statement run",
      },
      authoredOn: generatedAt,
      executionPeriod: { start: generatedAt, end: generatedAt },
      output: [
        statementRunCount("generated-count", 1),
        statementRunCount("invalid-reject-count", 0),
        statementRunCount("skipped-zero-balance-count", 0),
      ],
  };
}

function statementRunCount(code: string, valueInteger: number) {
  return {
    type: { coding: [{ system: STATEMENT_OUTPUT_CODE_SYSTEM, code }] },
    valueInteger,
  };
}

export async function runSeedDemoCli(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly loadOperator?: typeof loadVerifiedOperatorFhirClient;
  readonly seed?: typeof seedDemo;
} = {}): Promise<DemoSeedResult> {
  const env = options.env ?? process.env;
  const medplumBaseUrl = (env.MEDPLUM_BASE_URL ?? DEFAULT_MEDPLUM_BASE_URL).replace(/\/$/, "");
  assertLocalMedplumBaseUrl(medplumBaseUrl);
  const projectId = requireEnv(env, "MEDPLUM_PROJECT_ID");
  const operator = await (options.loadOperator ?? loadVerifiedOperatorFhirClient)({
    baseUrl: medplumBaseUrl,
    projectId,
  });
  return (options.seed ?? seedDemo)(new LiveDemoSeedAdapter(operator.fhir));
}

async function runCli(): Promise<void> {
  const result = await runSeedDemoCli();
  console.log(`Demo resources created: ${result.created.length} [${result.created.join(", ")}]`);
  console.log(`Demo resources already present: ${result.existing.length} [${result.existing.join(", ")}]`);
  console.log(`Demo statement: ${result.statement}`);
  console.log(`Demo patient: ${result.patientReference}`);
  console.log(`Demo insured statement: ${result.insuredStatement}`);
  console.log(`Demo insured patient: ${result.insuredPatientReference}`);
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
