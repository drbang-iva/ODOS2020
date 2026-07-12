#!/usr/bin/env tsx
import type {
  Appointment,
  HealthcareService,
  Invoice,
  Patient,
  PaymentReconciliation,
  Practitioner,
  Resource,
  Schedule,
  Task,
} from "@medplum/fhirtypes";
import { buildSchedulingAppointment } from "../mcp/src/fhir/schedulingAppointment.js";
import { buildSchedulingResource } from "../mcp/src/fhir/schedulingResource.js";
import { buildVisitType } from "../mcp/src/fhir/schedulingVisitType.js";
import { createMedplumClient, type MedplumClient } from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";
import { buildPaymentReconciliation } from "../mcp/src/payments/payment-reconciliation.js";
import {
  STATEMENT_OUTPUT_CODE_SYSTEM,
  STATEMENT_RUN_CODE,
  STATEMENT_TASK_CODE_SYSTEM,
} from "../mcp/src/statements/statements.js";
import { assertLocalMedplumBaseUrl } from "./reseed-practice-role-tags.js";
import { loginForLocalRepair } from "./repair-practice-roles.js";

const DEFAULT_MEDPLUM_BASE_URL = "http://localhost:8103";
const DEFAULT_MCP_BASE_URL = "http://localhost:3333";
export const DEMO_SEED_SYSTEM = "https://osod.dev/seed/operator-demo";

type DemoResource = Patient | Practitioner | HealthcareService | Schedule | Appointment | Invoice | PaymentReconciliation;
type DemoResourceType = DemoResource["resourceType"];

export interface DemoSeedAdapter {
  findByIdentifier<T extends DemoResource>(resourceType: T["resourceType"], value: string): Promise<T[]>;
  create<T extends DemoResource>(resource: T): Promise<T>;
  hasStatement(patientReference: string): Promise<boolean>;
  generateStatement(patientReference: string): Promise<{
    generatedCount: number;
    generatedAt?: string;
    statements: Array<{ statementReference?: string; unappliedCreditCents?: number }>;
  }>;
}

export interface DemoSeedResult {
  readonly created: DemoResourceType[];
  readonly existing: DemoResourceType[];
  readonly patientReference: string;
  readonly statement: "CREATED" | "EXISTING";
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
    const resource = await adapter.create(build());
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

  const patientReference = `Patient/${patient.id}`;
  const statement = await adapter.hasStatement(patientReference) ? "EXISTING" : "CREATED";
  if (statement === "CREATED") {
    const generated = await adapter.generateStatement(patientReference);
    if (generated.generatedCount !== 1 || generated.statements[0]?.unappliedCreditCents !== 2_500) {
      throw new Error("Demo statement did not persist the expected issued Invoice and $25 unapplied credit.");
    }
  }

  if (!invoice.id) throw new Error("Demo Invoice is missing its id.");
  return { created, existing, patientReference, statement };
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
  constructor(
    private readonly fhir: MedplumClient,
    private readonly mcpBaseUrl: string,
    private readonly authorization: string,
  ) {}

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

  async create<T extends DemoResource>(resource: T): Promise<T> {
    return this.fhir.create(resource);
  }

  async hasStatement(patientReference: string): Promise<boolean> {
    const response = await fetch(
      `${this.mcpBaseUrl}/statements?patientReference=${encodeURIComponent(patientReference)}`,
      { headers: { Authorization: this.authorization } },
    );
    const body = await response.text();
    if (!response.ok) throw new Error(`Statement lookup failed: ${response.status} ${body}`);
    const parsed = JSON.parse(body) as { items?: unknown[] };
    return (parsed.items?.length ?? 0) > 0;
  }

  async generateStatement(patientReference: string): Promise<{
    generatedCount: number;
    generatedAt?: string;
    statements: Array<{ statementReference?: string; unappliedCreditCents?: number }>;
  }> {
    const response = await fetch(`${this.mcpBaseUrl}/statements/generate`, {
      method: "POST",
      headers: {
        Authorization: this.authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ patientReference }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Statement generation failed: ${response.status} ${body}`);
    const result = JSON.parse(body) as {
      generatedCount: number;
      generatedAt?: string;
      statements: Array<{ statementReference?: string; unappliedCreditCents?: number }>;
    };
    if (result.generatedCount === 1 && !(await this.hasStatement(patientReference))) {
      await this.finishSyntheticStatementRun(result);
    }
    return result;
  }

  private async finishSyntheticStatementRun(result: {
    generatedAt?: string;
    statements: Array<{ statementReference?: string }>;
  }): Promise<void> {
    const generatedAt = result.generatedAt;
    const statementReference = result.statements[0]?.statementReference;
    const statementId = statementReference?.match(/^Task\/([^/]+)$/)?.[1];
    if (!generatedAt || !statementId) {
      throw new Error("Demo statement response is missing its generated timestamp or Task reference.");
    }
    const run = await this.fhir.create<Task>(buildDemoStatementRun(generatedAt));
    if (!run.id) throw new Error("Demo statement run create returned no id.");
    const statement = await this.fhir.read<Task>("Task", statementId);
    if (!statement.meta?.versionId) throw new Error("Demo statement Task is missing meta.versionId.");
    await this.fhir.patch<Task>(
      "Task",
      statementId,
      [{ op: "replace", path: "/partOf", value: [{ reference: `Task/${run.id}` }] }],
      { "If-Match": `W/"${statement.meta.versionId}"` },
    );
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

async function runCli(): Promise<void> {
  const medplumBaseUrl = (process.env.MEDPLUM_BASE_URL ?? DEFAULT_MEDPLUM_BASE_URL).replace(/\/$/, "");
  const mcpBaseUrl = (process.env.OSOD_MCP_BASE_URL ?? DEFAULT_MCP_BASE_URL).replace(/\/$/, "");
  assertLocalMedplumBaseUrl(medplumBaseUrl);
  assertLocalMedplumBaseUrl(mcpBaseUrl);
  const email = requireEnv("OSOD_ADMIN_EMAIL", "MEDPLUM_ADMIN_EMAIL");
  const password = requireEnv("OSOD_ADMIN_PASSWORD", "MEDPLUM_ADMIN_PASSWORD");
  const accessToken = await loginForLocalRepair({ baseUrl: medplumBaseUrl, email, password });
  const result = await seedDemo(new LiveDemoSeedAdapter(
    createMedplumClient({ baseUrl: medplumBaseUrl, accessToken }),
    mcpBaseUrl,
    `Bearer ${accessToken}`,
  ));
  console.log(`Demo resources created: ${result.created.length} [${result.created.join(", ")}]`);
  console.log(`Demo resources already present: ${result.existing.length} [${result.existing.join(", ")}]`);
  console.log(`Demo statement: ${result.statement}`);
  console.log(`Demo patient: ${result.patientReference}`);
}

function requireEnv(primary: string, fallback: string): string {
  const value = process.env[primary]?.trim() || process.env[fallback]?.trim();
  if (!value) throw new Error(`${primary} or ${fallback} is required.`);
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
