import assert from "node:assert/strict";
import { test } from "node:test";
import type { Resource } from "@medplum/fhirtypes";
import {
  DEMO_SEED_SYSTEM,
  buildDemoStatementRun,
  demoAppointmentStart,
  seedDemo,
  type DemoSeedAdapter,
} from "../../scripts/seed-demo.ts";

type SeedResource = Parameters<DemoSeedAdapter["create"]>[0];

class FakeDemoSeedAdapter implements DemoSeedAdapter {
  readonly resources: SeedResource[] = [];
  statementExists = false;
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

  async hasStatement(): Promise<boolean> {
    return this.statementExists;
  }

  async generateStatement() {
    this.statementExists = true;
    this.statementWrites += 1;
    return { generatedCount: 1, statements: [{ unappliedCreditCents: 2_500 }] };
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
  ]);
  assert.equal(result.statement, "CREATED");
  assert.equal(adapter.statementWrites, 1);
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
});

test("a second demo seed run is idempotent", async () => {
  const adapter = new FakeDemoSeedAdapter();
  await seedDemo(adapter);
  const resourceCount = adapter.resources.length;

  const result = await seedDemo(adapter);

  assert.deepEqual(result.created, []);
  assert.equal(result.existing.length, 7);
  assert.equal(result.statement, "EXISTING");
  assert.equal(adapter.resources.length, resourceCount);
  assert.equal(adapter.statementWrites, 1);
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
