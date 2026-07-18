import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { ChargeItem, Invoice, PaymentReconciliation, Resource } from "@medplum/fhirtypes";
import { Client } from "pg";
import {
  ODOS_BANK_CREDIT_TENDER_CODE,
  finalizeCreditBankDeposit,
  prepareCreditBankDeposit,
  spendCreditBankAtCheckout,
} from "../src/commercial-engine/credit-bank-service.js";
import {
  PgCommercialEngineStore,
  largestRemainderAllocation,
  refundableRemainderCents,
  type CreditBankSpendOperation,
  type PatientCreditBank,
} from "../src/commercial-engine/ledger-store.js";

const bank: PatientCreditBank = {
  patientFhirId: "patient-1",
  balanceCents: 55_000,
  ledger: [],
};

test("Credit Bank deposit freezes bonus terms on the funding Invoice and finalizes separate ledger values", async () => {
  let created: Invoice | undefined;
  let finalized: Record<string, unknown> | undefined;
  const store = {
    finalizeCreditBankDeposit: async (input: Record<string, unknown>) => {
      finalized = input;
      return bank;
    },
  };
  const prepared = await prepareCreditBankDeposit(
    { store: store as never, now: () => "2026-07-18T14:00:00Z" },
    {
      create: async <T>(resource: T): Promise<T> => {
        created = { ...(resource as Invoice), id: "bank-funding" };
        return created as T;
      },
      read: async () => { throw new Error("not used"); },
      search: async () => { throw new Error("not used"); },
    } as never,
    {
      patientReference: "Patient/patient-1",
      depositCents: 50_000,
      bonusCents: 5_000,
      bonusReason: "Summer promotion",
      staffReference: "Practitioner/admin-1",
    },
  );
  assert.equal(prepared.totalNet?.value, 500);
  assert.equal(prepared.meta?.tag?.[0].code, "balance-funding");
  assert.equal(prepared.identifier?.some((identifier) => identifier.value === "5000"), true);
  assert.equal(prepared.identifier?.some((identifier) => identifier.value === "Summer promotion"), true);

  await finalizeCreditBankDeposit(
    { store: store as never },
    {
      read: async () => ({ ...created!, status: "balanced" as const }),
      create: async () => { throw new Error("not used"); },
      search: async () => { throw new Error("not used"); },
    } as never,
    {
      patientReference: "Patient/patient-1",
      invoiceReference: "Invoice/bank-funding",
      staffReference: "Practitioner/admin-1",
      allowBonus: true,
    },
  );
  assert.equal(finalized?.depositCents, 50_000);
  assert.equal(finalized?.bonusCents, 5_000);
  assert.equal(finalized?.bonusReason, "Summer promotion");
});

test("promotional bonus finalization remains practice-admin gated from frozen Invoice terms", async () => {
  const prepared = await prepareCreditBankDeposit(
    { store: {} as never, now: () => "2026-07-18T14:00:00Z" },
    {
      create: async <T>(resource: T): Promise<T> => ({ ...(resource as object), id: "bank-funding" }) as T,
      read: async () => { throw new Error("not used"); },
      search: async () => { throw new Error("not used"); },
    } as never,
    {
      patientReference: "Patient/patient-1",
      depositCents: 50_000,
      bonusCents: 5_000,
      bonusReason: "Summer promotion",
      staffReference: "Practitioner/admin-1",
    },
  );
  await assert.rejects(finalizeCreditBankDeposit(
    { store: { finalizeCreditBankDeposit: async () => bank } as never },
    {
      read: async () => ({ ...prepared, status: "balanced" as const }),
      create: async () => { throw new Error("not used"); },
      search: async () => { throw new Error("not used"); },
    } as never,
    {
      patientReference: "Patient/patient-1",
      invoiceReference: "Invoice/bank-funding",
      staffReference: "Practitioner/staff-1",
      allowBonus: false,
    },
  ), /Practice-admin/);
});

test("Credit Bank checkout consumes before BANK_CREDIT settlement and preserves the real charge price", async () => {
  const events: string[] = [];
  const created: Resource[] = [];
  const operation: CreditBankSpendOperation = {
    chargeItemFhirId: "charge-1",
    patientFhirId: "patient-1",
    amountCents: 55_000,
    createdAt: "2026-07-18T15:00:00Z",
  };
  const store = {
    beginCreditBankSpend: async () => operation,
    recordCreditBankSpendInvoice: async (_chargeId: string, invoiceFhirId: string) => ({ ...operation, invoiceFhirId }),
    spendCreditBank: async () => { events.push("consume"); return { ...bank, balanceCents: 0 }; },
    recordCreditBankSpendPayment: async (_chargeId: string, paymentFhirId: string) => ({
      ...operation,
      invoiceFhirId: "bank-spend-invoice",
      paymentFhirId,
      consumedAt: operation.createdAt,
    }),
    completeCreditBankSpend: async () => { events.push("complete"); return operation; },
    getCreditBank: async () => bank,
  };
  const charge: ChargeItem = {
    resourceType: "ChargeItem",
    id: "charge-1",
    status: "billable",
    code: { text: "Dry-eye service" },
    subject: { reference: "Patient/patient-1" },
    priceOverride: { value: 550, currency: "USD" },
  };
  await spendCreditBankAtCheckout(
    { store: store as never, now: () => "2026-07-18T15:00:00Z" },
    {
      read: async <T>(resourceType: string): Promise<T> => (resourceType === "ChargeItem" ? charge : created.find((item) => item.resourceType === resourceType)) as T,
      search: async () => ({ resourceType: "Bundle", type: "searchset", entry: [] }),
      create: async <T extends Resource>(resource: T): Promise<T> => {
        const saved = { ...resource, id: resource.resourceType === "Invoice" ? "bank-spend-invoice" : "bank-payment" } as T;
        events.push(resource.resourceType);
        created.push(saved);
        return saved;
      },
    } as never,
    {
      patientReference: "Patient/patient-1",
      chargeItemReference: "ChargeItem/charge-1",
      staffReference: "Practitioner/staff-1",
    },
  );
  const invoice = created.find((item): item is Invoice => item.resourceType === "Invoice");
  const payment = created.find((item): item is PaymentReconciliation => item.resourceType === "PaymentReconciliation");
  assert.equal(invoice?.totalNet?.value, 550);
  assert.equal(payment?.paymentAmount?.value, 550);
  assert.equal(payment?.extension?.some((extension) => extension.valueCodeableConcept?.coding?.some((coding) => coding.code === ODOS_BANK_CREDIT_TENDER_CODE)), true);
  assert.deepEqual(events, ["Invoice", "consume", "PaymentReconciliation", "complete"]);
});

test("largest-remainder allocation keeps $1,000 divided by three exact", () => {
  assert.deepEqual(largestRemainderAllocation(100_000, 3), [33_334, 33_333, 33_333]);
  assert.equal(refundableRemainderCents(100_000, 3, 3), 100_000);
  assert.equal(refundableRemainderCents(100_000, 3, 2), 66_666);
});

test("Credit Bank spend rejects overdraft while holding the patient account row lock", async () => {
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("FROM odos_credit_bank_spends")) return { rows: [{
        charge_item_fhir_id: "charge-1",
        patient_fhir_id: "patient-1",
        amount_cents: "55000",
        invoice_fhir_id: "invoice-1",
        payment_fhir_id: null,
        consumed_at: null,
        completed_at: null,
        created_at: "2026-07-18T15:00:00Z",
      }] };
      if (sql.includes("entry_type = 'spend'")) return { rows: [] };
      if (sql.includes("sum(amount_cents)")) return { rows: [{ balance_cents: "54999" }] };
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  const store = new PgCommercialEngineStore({
    pool: {
      connect: async () => client,
      query: async () => ({ rows: [] }),
      end: async () => undefined,
    } as never,
  });
  (store as unknown as { schemaReady: Promise<void> }).schemaReady = Promise.resolve();

  await assert.rejects(store.spendCreditBank({
    chargeItemFhirId: "charge-1",
    patientFhirId: "patient-1",
    linkedFhirInvoiceId: "invoice-1",
    amountCents: 55_000,
    actorUserId: "Practitioner/staff-1",
    spentAt: "2026-07-18T15:00:00Z",
  }), /insufficient/);
  assert.equal(queries.some((sql) => sql.includes("odos_credit_bank_accounts") && sql.includes("FOR UPDATE")), true);
  assert.equal(queries.some((sql) => sql.includes("INSERT INTO odos_credit_bank_ledger") && sql.includes("'spend'")), false);
});

test("expiry sweep is idempotent and row-locks against redemption", async () => {
  let remaining = 2;
  let expiryWritten = false;
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("FROM odos_package_instances i") && sql.includes("HAVING")) {
        return { rows: remaining > 0 ? [{ id: "f38e17e5-d279-4cb7-a87b-04895533380d", patient_fhir_id: "patient-1" }] : [] };
      }
      return { rows: [] };
    },
    connect: async () => ({
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("snapshot_expiry_date::text")) return { rows: [{ patient_fhir_id: "patient-1", snapshot_expiry_date: "2026-07-17" }] };
        if (sql.includes("entry_type = 'expiry'") && sql.startsWith("SELECT")) return { rows: expiryWritten ? [{}] : [], rowCount: expiryWritten ? 1 : 0 };
        if (sql.includes("remaining_sessions")) return { rows: [{ remaining_sessions: String(remaining) }] };
        if (sql.includes("INSERT INTO odos_package_ledger")) { expiryWritten = true; remaining = 0; return { rows: [], rowCount: 1 }; }
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    }),
    end: async () => undefined,
  };
  const store = new PgCommercialEngineStore({ pool: pool as never });
  (store as unknown as { schemaReady: Promise<void> }).schemaReady = Promise.resolve();
  const input = { asOfDate: "2026-07-18", actorUserId: "odos-package-expiry-sweep", expiredAt: "2026-07-18T06:00:00Z" };

  assert.deepEqual(await store.expirePackages(input), { expiredPackages: 1, expiredSessions: 2 });
  assert.deepEqual(await store.expirePackages(input), { expiredPackages: 0, expiredSessions: 0 });
  assert.equal(queries.some((sql) => sql.includes("FOR UPDATE")), true);
});

test("an injected pool remains owned by its caller", async () => {
  let ended = false;
  const store = new PgCommercialEngineStore({
    pool: {
      connect: async () => { throw new Error("not used"); },
      query: async () => ({ rows: [] }),
      end: async () => { ended = true; },
    } as never,
  });
  await store.close();
  assert.equal(ended, false);
});

test("Credit Bank migration enforces append-only dollars and cash-refund evidence storage", async () => {
  const sql = await readFile(new URL("../../data/migrations/2026-07-18-commercial-engine-credit-bank.sql", import.meta.url), "utf8");
  assert.match(sql, /BEFORE UPDATE OR DELETE ON odos_credit_bank_ledger/);
  assert.match(sql, /entry_type = 'bonus'.*linked_fhir_invoice_id IS NULL/s);
  assert.match(sql, /ALTER TABLE odos_package_ledger[\s\S]*external_reference TEXT/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS odos_credit_bank_spends/);
});

test("fresh Postgres applies the Credit Bank migration and rejects ledger UPDATE and DELETE", { timeout: 30_000 }, async (t) => {
  const adminUrl = process.env.ODOS_POSTGRES_URL;
  if (!adminUrl) {
    t.skip("ODOS_POSTGRES_URL is required for the fresh Postgres Credit Bank fixture.");
    return;
  }
  const databaseName = `odos_credit_bank_${randomUUID().replaceAll("-", "")}`;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl });
  const probe = new Client({ connectionString: testUrl.toString() });
  const store = new PgCommercialEngineStore({ postgresUrl: testUrl.toString() });
  let probeConnected = false;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName} TEMPLATE template0`);
    assert.deepEqual(await store.getCreditBank("fresh-patient"), {
      patientFhirId: "fresh-patient",
      balanceCents: 0,
      ledger: [],
    });
    const funded = await store.finalizeCreditBankDeposit({
      patientFhirId: "fresh-patient",
      sourceInvoiceId: "funding-invoice",
      depositCents: 50_000,
      bonusCents: 5_000,
      bonusReason: "Synthetic promotion",
      actorUserId: "Practitioner/admin-1",
      depositedAt: "2026-07-18T14:00:00Z",
    });
    assert.equal(funded.balanceCents, 55_000);
    const depositEntry = funded.ledger.find((entry) => entry.entryType === "deposit");
    const bonusEntry = funded.ledger.find((entry) => entry.entryType === "bonus");
    assert.equal(depositEntry?.amountCents, 50_000);
    assert.equal(depositEntry?.linkedFhirInvoiceId, "funding-invoice");
    assert.equal(bonusEntry?.amountCents, 5_000);
    assert.equal(bonusEntry?.linkedFhirInvoiceId, undefined);
    assert.equal(bonusEntry?.reason, "Synthetic promotion");
    await store.beginCreditBankSpend({
      chargeItemFhirId: "service-charge",
      patientFhirId: "fresh-patient",
      amountCents: 55_000,
      createdAt: "2026-07-18T15:00:00Z",
    });
    await store.recordCreditBankSpendInvoice("service-charge", "service-invoice");
    const spent = await store.spendCreditBank({
      chargeItemFhirId: "service-charge",
      patientFhirId: "fresh-patient",
      linkedFhirInvoiceId: "service-invoice",
      amountCents: 55_000,
      actorUserId: "Practitioner/staff-1",
      spentAt: "2026-07-18T15:00:00Z",
    });
    assert.equal(spent.balanceCents, 0);
    assert.equal(spent.ledger.find((entry) => entry.entryType === "spend")?.amountCents, -55_000);
    const definition = await store.saveDefinition({
      name: "Three-session synthetic package",
      eligibleProcedureTypeCodes: ["synthetic-procedure"],
      sessionCount: 3,
      priceCents: 100_000,
      expiryDays: 365,
      refundPolicy: "store_credit_only",
    });
    const packageInstance = await store.finalizeSale({
      definitionId: definition.id,
      patientFhirId: "conversion-patient",
      sourceSaleInvoiceId: "package-funding-invoice",
      actorUserId: "Practitioner/admin-1",
      soldAt: "2026-07-18T14:00:00Z",
      snapshotName: definition.name,
      snapshotEligibleProcedureTypeCodes: definition.eligibleProcedureTypeCodes,
      snapshotSessionCount: definition.sessionCount,
      snapshotPriceCents: definition.priceCents,
      snapshotExpiryDays: definition.expiryDays,
      snapshotRefundPolicy: definition.refundPolicy,
    });
    await store.consume({
      packageInstanceId: packageInstance.id,
      patientFhirId: "conversion-patient",
      procedureTypeCodes: ["synthetic-procedure"],
      linkedFhirInvoiceId: "first-session-invoice",
      linkedFhirProcedureId: "first-session-procedure",
      actorUserId: "Practitioner/staff-1",
      consumedAt: "2026-07-19T15:00:00Z",
    });
    const converted = await store.convertPackageToCreditBank({
      packageInstanceId: packageInstance.id,
      patientFhirId: "conversion-patient",
      actorUserId: "Practitioner/admin-1",
      reason: "Patient requested frozen store-credit remedy",
      convertedAt: "2026-07-20T15:00:00Z",
    });
    assert.equal(converted.amountCents, 66_666);
    assert.equal(converted.package.remainingSessions, 0);
    assert.equal(converted.creditBank?.balanceCents, 66_666);
    assert.equal(33_334 + converted.amountCents, 100_000);
    await probe.connect();
    probeConnected = true;
    const ledgerId = depositEntry!.id;
    await assert.rejects(
      probe.query("UPDATE odos_credit_bank_ledger SET amount_cents = 1 WHERE id = $1", [ledgerId]),
      /append-only/,
    );
    await assert.rejects(
      probe.query("DELETE FROM odos_credit_bank_ledger WHERE id = $1", [ledgerId]),
      /append-only/,
    );
    const retained = await probe.query("SELECT amount_cents::text FROM odos_credit_bank_ledger WHERE id = $1", [ledgerId]);
    assert.equal(retained.rows[0]?.amount_cents, "50000");
  } finally {
    if (probeConnected) await probe.end();
    await store.close();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});
