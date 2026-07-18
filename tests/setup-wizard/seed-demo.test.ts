import assert from "node:assert/strict";
import { test } from "node:test";
import type { Resource } from "@medplum/fhirtypes";
import { addStatementDetail, buildStatementSnapshot } from "../../mcp/src/statements/statements.js";
import {
  DEMO_SEED_SYSTEM,
  assertInsuranceAwareDemoStatement,
  buildDemoStatementRun,
  demoAppointmentStart,
  seedDemo,
  type DemoSeedAdapter,
} from "../../scripts/seed-demo.ts";

type SeedResource = Parameters<DemoSeedAdapter["create"]>[0];

class FakeDemoSeedAdapter implements DemoSeedAdapter {
  readonly resources: SeedResource[] = [];
  readonly statementPatients = new Set<string>();
  statementWrites = 0;

  async findByIdentifier<T extends SeedResource>(resourceType: T["resourceType"], value: string): Promise<T[]> {
    return this.resources.filter((resource) =>
      resource.resourceType === resourceType && identifierValues(resource).includes(value),
    ) as T[];
  }

  async create<T extends SeedResource>(resource: T): Promise<T> {
    const created = { ...structuredClone(resource), id: `${resource.resourceType.toLowerCase()}-${this.resources.length + 1}` } as T;
    this.resources.push(created);
    return created;
  }

  async hasStatement(patientReference: string): Promise<boolean> {
    return this.statementPatients.has(patientReference);
  }

  async generateStatement(patientReference: string) {
    this.statementPatients.add(patientReference);
    this.statementWrites += 1;
    if (identifierValues(resourceByReference(this, patientReference)).includes("patient")) {
      return {
        generatedCount: 1,
        statements: [{
          generatedAt: "2026-07-12T12:00:00.000Z",
          patientReference,
          patientName: "TEST-Rivera, Alex",
          paymentReconciliationReferences: [],
          invoices: [],
          totalGrossCents: 0,
          totalNetCents: 0,
          paymentsAppliedCents: 0,
          balanceCents: 0,
          unappliedCreditCents: 2_500,
        }],
      };
    }
    const patient = resourceByReference(this, patientReference) as Extract<SeedResource, { resourceType: "Patient" }>;
    const invoices = resourcesOf(this, "Invoice").filter((invoice) => invoice.subject?.reference === patientReference);
    const payments = resourcesOf(this, "PaymentReconciliation");
    const snapshot = buildStatementSnapshot({
      generatedAt: "2026-07-12T12:00:00.000Z",
      patient,
      invoices,
      paymentReconciliations: payments,
    });
    const detailed = addStatementDetail({
      snapshot,
      patient,
      invoices,
      paymentReconciliations: payments,
      claims: resourcesOf(this, "Claim"),
      claimResponses: resourcesOf(this, "ClaimResponse"),
      practitioners: resourcesOf(this, "Practitioner"),
      practitionerRoles: resourcesOf(this, "PractitionerRole"),
    });
    return {
      generatedCount: 1,
      statements: [{
        ...detailed,
        unappliedCreditCents: 0,
        balanceDueCents: detailed.balanceCents,
        creditBalanceCents: 0,
      }],
    };
  }
}

test("demo seed creates a synthetic patient, schedule, issued Invoice, unapplied credit, and statement", async () => {
  const adapter = new FakeDemoSeedAdapter();

  const result = await seedDemo(adapter);

  assert.deepEqual(result.created, [
    "Patient",
    "Practitioner",
    "HealthcareService",
    "Schedule",
    "Appointment",
    "Invoice",
    "PaymentReconciliation",
    "Patient",
    "Organization",
    "Coverage",
    "Practitioner",
    "PractitionerRole",
    "ChargeItem",
    "ChargeItem",
    "Claim",
    "ClaimResponse",
    "Invoice",
    "PaymentReconciliation",
  ]);
  assert.equal(result.statement, "CREATED");
  assert.equal(result.insuredStatement, "CREATED");
  assert.equal(adapter.statementWrites, 2);
  const patient = resource(adapter, "Patient");
  assert.match(JSON.stringify(patient), /TEST-Rivera/);
  assert.match(JSON.stringify(patient), /1900-01-01/);
  const invoice = resource(adapter, "Invoice") as { status?: string; totalNet?: { value?: number } };
  assert.equal(invoice.status, "issued");
  assert.equal(invoice.totalNet?.value, 125);
  const credit = resource(adapter, "PaymentReconciliation") as {
    status?: string;
    paymentAmount?: { value?: number };
    detail?: unknown[];
  };
  assert.equal(credit.status, "active");
  assert.equal(credit.paymentAmount?.value, 25);
  assert.deepEqual(credit.detail, []);

  const insuredPatient = resourcesOf(adapter, "Patient").find((candidate) =>
    identifierValues(candidate).includes("insured-patient"),
  );
  assert.ok(insuredPatient?.address?.some((address) => address.use === "home"));
  const claim = resourceWithMarker(adapter, "Claim", "insured-claim");
  assert.equal(claim.item?.length, 2);
  assert.ok(claim.item?.every((item) => item.extension?.some((extension) =>
    extension.url === "https://odos2020.com/fhir/StructureDefinition/odos-charge-item",
  )));
  assert.ok(claim.insurance?.length);
  assert.equal(claim.insurance[0]?.sequence, 1);
  assert.equal(claim.insurance[0]?.focal, true);
  const coverageReference = claim.insurance[0]?.coverage.reference;
  assert.ok(coverageReference);
  const coverage = resourceByReference(adapter, coverageReference);
  assert.equal(coverage.resourceType, "Coverage");
  assert.equal(coverage.status, "active");
  assert.equal(coverage.beneficiary?.reference, `Patient/${insuredPatient.id}`);
  const payer = resourceWithMarker(adapter, "Organization", "demo-payer");
  assert.equal(payer.name, "ODOS Demo Insurance");
  assert.ok(coverage.payor?.some((payor) => payor.reference === `Organization/${payer.id}`));
  assert.equal(claim.insurer?.reference, `Organization/${payer.id}`);
  const claimResponse = resourceWithMarker(adapter, "ClaimResponse", "insured-claim-response");
  assert.equal(claimResponse.insurer?.reference, `Organization/${payer.id}`);
  const insuredInvoice = resourceWithMarker(adapter, "Invoice", "insured-invoice");
  assert.equal(insuredInvoice.lineItem?.length, 2);
  assert.ok(insuredInvoice.lineItem?.every((line) => line.chargeItemReference?.reference?.startsWith("ChargeItem/")));
});

test("a second demo seed run is idempotent", async () => {
  const adapter = new FakeDemoSeedAdapter();
  await seedDemo(adapter);
  const resourceCount = adapter.resources.length;

  const result = await seedDemo(adapter);

  assert.deepEqual(result.created, []);
  assert.equal(result.existing.length, 18);
  assert.equal(result.statement, "EXISTING");
  assert.equal(result.insuredStatement, "EXISTING");
  assert.equal(adapter.resources.length, resourceCount);
  assert.equal(adapter.statementWrites, 2);
});

test("insured demo seed passes the real insurance-aware statement acceptance assertion", async () => {
  const adapter = new FakeDemoSeedAdapter();
  const result = await seedDemo(adapter);

  const generated = await adapter.generateStatement(result.insuredPatientReference);

  assert.doesNotThrow(() => assertInsuranceAwareDemoStatement(generated));
  const statement = generated.statements[0];
  assert.equal(statement.detail?.orders[0]?.mode, "insurance-aware");
  assert.equal(statement.balanceCents, 3_500);
  assert.equal(statement.balanceDueCents, 3_500);
});

test("demo appointment uses the practice date and a real New York UTC offset", () => {
  assert.equal(demoAppointmentStart(new Date("2026-07-12T15:00:00.000Z")), "2026-07-12T10:00:00-04:00");
  assert.equal(demoAppointmentStart(new Date("2026-01-12T15:00:00.000Z")), "2026-01-12T10:00:00-05:00");
});

test("demo statement visibility marker uses the shipped completed-run codes", () => {
  const run = buildDemoStatementRun("2026-07-12T15:00:00.000Z");
  assert.equal(run.status, "completed");
  assert.equal(run.identifier?.[0]?.system, DEMO_SEED_SYSTEM);
  assert.deepEqual(run.output?.map((output) => output.type.coding?.[0]?.code), [
    "generated-count",
    "invalid-reject-count",
    "skipped-zero-balance-count",
  ]);
});

function identifierValues(resource: Resource): string[] {
  const identifiers = (resource as Resource & { identifier?: Array<{ system?: string; value?: string }> }).identifier ?? [];
  const paymentIdentifier = (resource as Resource & { paymentIdentifier?: { system?: string; value?: string } }).paymentIdentifier;
  return [...identifiers, ...(paymentIdentifier ? [paymentIdentifier] : [])]
    .filter((identifier) => identifier.system === DEMO_SEED_SYSTEM)
    .map((identifier) => identifier.value)
    .filter((value): value is string => Boolean(value));
}

function resource(adapter: FakeDemoSeedAdapter, resourceType: string): SeedResource {
  const found = adapter.resources.find((candidate) => candidate.resourceType === resourceType);
  assert.ok(found);
  return found;
}

function resourceByReference(adapter: FakeDemoSeedAdapter, reference: string): SeedResource {
  const [resourceType, id] = reference.split("/");
  const found = adapter.resources.find((candidate) => candidate.resourceType === resourceType && candidate.id === id);
  assert.ok(found);
  return found;
}

function resourcesOf<T extends SeedResource["resourceType"]>(
  adapter: FakeDemoSeedAdapter,
  resourceType: T,
): Array<Extract<SeedResource, { resourceType: T }>> {
  return adapter.resources.filter((candidate): candidate is Extract<SeedResource, { resourceType: T }> =>
    candidate.resourceType === resourceType,
  );
}

function resourceWithMarker<T extends SeedResource["resourceType"]>(
  adapter: FakeDemoSeedAdapter,
  resourceType: T,
  marker: string,
): Extract<SeedResource, { resourceType: T }> {
  const found = resourcesOf(adapter, resourceType).find((candidate) => identifierValues(candidate).includes(marker));
  assert.ok(found);
  return found;
}
