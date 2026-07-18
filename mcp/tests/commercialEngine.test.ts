import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { ChargeItem, Invoice, PaymentReconciliation, Procedure, Resource } from "@medplum/fhirtypes";
import {
  applicablePackages,
  finalizePackageSale,
  isBalanceFundingInvoice,
  preparePackageSale,
  redeemPackageSession,
} from "../src/commercial-engine/package-service.js";
import type {
  CommercialEngineStore,
  PackageDefinition,
  PatientPackageInstance,
} from "../src/commercial-engine/ledger-store.js";

const definition: PackageDefinition = {
  id: "9f707c89-4b51-4b16-85cb-95b48e235fd2",
  name: "Dry-Eye IPL x3",
  eligibleProcedureTypeCodes: ["procedure:dry-eye-ipl"],
  sessionCount: 3,
  priceCents: 360_000,
  expiryDays: 365,
  refundPolicy: "non_refundable",
  active: true,
  soldCount: 0,
  createdAt: "2026-07-18T12:00:00Z",
  updatedAt: "2026-07-18T12:00:00Z",
};

test("package sale Invoice is balance-funding revenue at the frozen definition price", async () => {
  let created: Invoice | undefined;
  const result = await preparePackageSale(
    { store: store(), now: () => "2026-07-18T14:00:00Z" },
    {
      create: async <T>(resource: T): Promise<T> => {
        created = { ...(resource as Invoice), id: "sale-invoice" };
        return created as T;
      },
      read: async () => { throw new Error("not used"); },
      search: async () => { throw new Error("not used"); },
    } as never,
    { patientReference: "Patient/patient-1", definitionId: definition.id, staffReference: "Practitioner/staff-1" },
  );
  assert.equal(result.invoice.totalNet?.value, 3_600);
  assert.equal(result.invoice.lineItem?.[0].priceComponent?.[0].amount?.value, 3_600);
  assert.equal(isBalanceFundingInvoice(result.invoice), true);
  assert.equal(created?.subject?.reference, "Patient/patient-1");
  assert.equal(created?.identifier?.some((identifier) => identifier.value === definition.id), true);
});

test("sale finalization reads immutable terms from the paid Invoice and requires full allocation", async () => {
  const prepared = await preparePackageSale(
    { store: store(), now: () => "2026-07-18T14:00:00Z" },
    {
      create: async <T>(resource: T): Promise<T> => ({ ...(resource as object), id: "sale-invoice" }) as T,
      read: async () => { throw new Error("not used"); },
      search: async () => { throw new Error("not used"); },
    } as never,
    { patientReference: "Patient/patient-1", definitionId: definition.id, staffReference: "Practitioner/staff-1" },
  );
  let finalized: Parameters<CommercialEngineStore["finalizeSale"]>[0] | undefined;
  const testStore = {
    ...store(),
    finalizeSale: async (input: Parameters<CommercialEngineStore["finalizeSale"]>[0]) => {
      finalized = input;
      return instance();
    },
  };
  const paidInvoice = { ...prepared.invoice, status: "issued" as const };
  const fhir = (allocatedCents: number) => ({
    create: async () => { throw new Error("not used"); },
    read: async () => paidInvoice,
    search: async () => ({
      resourceType: "Bundle",
      type: "searchset",
      entry: [{
        resource: {
          resourceType: "PaymentReconciliation",
          status: "active",
          outcome: "complete",
          created: "2026-07-18T14:01:00Z",
          paymentDate: "2026-07-18",
          paymentAmount: { value: allocatedCents / 100, currency: "USD" },
          detail: [{ request: { reference: "Invoice/sale-invoice" }, amount: { value: allocatedCents / 100, currency: "USD" } }],
        },
      }],
    }),
  });
  const input = {
    patientReference: "Patient/patient-1",
    definitionId: definition.id,
    invoiceReference: "Invoice/sale-invoice",
    staffReference: "Practitioner/staff-1",
  };

  await assert.rejects(
    finalizePackageSale({ store: testStore }, fhir(359_999) as never, input),
    /successful payment/,
  );
  await finalizePackageSale({ store: testStore }, fhir(360_000) as never, input);
  assert.equal(finalized?.snapshotName, definition.name);
  assert.deepEqual(finalized?.snapshotEligibleProcedureTypeCodes, definition.eligibleProcedureTypeCodes);
  assert.equal(finalized?.snapshotSessionCount, 3);
  assert.equal(finalized?.snapshotPriceCents, 360_000);
});

test("applicable package matching requires code, unexpired balance, and explicit remaining sessions", () => {
  const base = instance();
  assert.deepEqual(applicablePackages([base], ["procedure:dry-eye-ipl"], "2026-07-18").map((item) => item.id), [base.id]);
  assert.deepEqual(applicablePackages([{ ...base, remainingSessions: 0 }], ["procedure:dry-eye-ipl"], "2026-07-18"), []);
  assert.deepEqual(applicablePackages([{ ...base, expiryDate: "2026-07-17" }], ["procedure:dry-eye-ipl"], "2026-07-18"), []);
  assert.deepEqual(applicablePackages([base], ["procedure:other"], "2026-07-18"), []);
});

test("redemption keeps the real procedure price, records package credit, and links consumption", async () => {
  const created: Resource[] = [];
  let consumed: Parameters<CommercialEngineStore["consume"]>[0] | undefined;
  const procedure: Procedure = {
    resourceType: "Procedure",
    id: "procedure-1",
    status: "completed",
    subject: { reference: "Patient/patient-1" },
    code: { coding: [{ code: "procedure:dry-eye-ipl" }], text: "Dry-Eye IPL" },
  };
  const chargeItem: ChargeItem = {
    resourceType: "ChargeItem",
    id: "charge-1",
    status: "billable",
    code: { text: "Dry-Eye IPL" },
    subject: { reference: "Patient/patient-1" },
    supportingInformation: [{ reference: "Procedure/procedure-1" }],
    priceOverride: { value: 1_200, currency: "USD" },
  };
  const result = await redeemPackageSession(
    {
      store: {
        ...store(),
        listPatientPackages: async () => [instance()],
        consume: async (input) => {
          consumed = input;
          return { ...instance(), remainingSessions: 1 };
        },
      },
      now: () => "2026-07-18T15:00:00Z",
    },
    {
      read: async <T>(_resourceType: string, id: string): Promise<T> => (id === "procedure-1" ? procedure : chargeItem) as T,
      create: async <T extends Resource>(resource: T): Promise<T> => {
        const saved = { ...resource, id: resource.resourceType === "Invoice" ? "redeem-invoice" : "package-payment" } as T;
        created.push(saved);
        return saved;
      },
      search: async () => ({ resourceType: "Bundle", type: "searchset", entry: [] }),
    } as never,
    {
      patientReference: "Patient/patient-1",
      packageInstanceId: instance().id,
      procedureReference: "Procedure/procedure-1",
      chargeItemReference: "ChargeItem/charge-1",
      staffReference: "Practitioner/staff-1",
    },
  );
  const invoice = created.find((resource): resource is Invoice => resource.resourceType === "Invoice");
  const payment = created.find((resource): resource is PaymentReconciliation => resource.resourceType === "PaymentReconciliation");
  assert.equal(invoice?.lineItem?.[0].priceComponent?.[0].amount?.value, 1_200);
  assert.equal(payment?.paymentAmount?.value, 1_200);
  assert.equal(payment?.extension?.some((extension) =>
    extension.valueCodeableConcept?.coding?.some((coding) => coding.code === "PACKAGE_CREDIT"),
  ), true);
  assert.equal(consumed?.linkedFhirInvoiceId, "redeem-invoice");
  assert.equal(consumed?.linkedFhirProcedureId, "procedure-1");
  assert.equal(result.package.remainingSessions, 1);
});

test("a completed redemption retry reuses its persisted FHIR records without writing again", async () => {
  const completed = {
    procedureFhirId: "procedure-1",
    patientFhirId: "patient-1",
    packageInstanceId: instance().id,
    chargeItemFhirId: "charge-1",
    amountCents: 120_000,
    invoiceFhirId: "redeem-invoice",
    paymentFhirId: "package-payment",
    completedAt: "2026-07-18T15:00:00Z",
    createdAt: "2026-07-18T15:00:00Z",
  };
  let createCalls = 0;
  const result = await redeemPackageSession(
    {
      store: {
        ...store(),
        listPatientPackages: async () => [instance()],
        getRedemption: async () => completed,
        beginRedemption: async () => completed,
      },
      now: () => "2026-07-18T16:00:00Z",
    },
    {
      read: async <T>(_resourceType: string, id: string): Promise<T> => (id === "procedure-1"
        ? {
            resourceType: "Procedure",
            id,
            status: "completed",
            subject: { reference: "Patient/patient-1" },
            code: { coding: [{ code: "procedure:dry-eye-ipl" }] },
          }
        : {
            resourceType: "ChargeItem",
            id,
            status: "billable",
            code: { text: "Dry-Eye IPL" },
            subject: { reference: "Patient/patient-1" },
            supportingInformation: [{ reference: "Procedure/procedure-1" }],
            priceOverride: { value: 1_200, currency: "USD" },
          }) as T,
      create: async <T>(resource: T): Promise<T> => { createCalls += 1; return resource; },
      search: async () => { throw new Error("not used"); },
    } as never,
    {
      patientReference: "Patient/patient-1",
      packageInstanceId: instance().id,
      procedureReference: "Procedure/procedure-1",
      chargeItemReference: "ChargeItem/charge-1",
      staffReference: "Practitioner/staff-1",
    },
  );

  assert.equal(createCalls, 0);
  assert.equal(result.invoiceReference, "Invoice/redeem-invoice");
  assert.equal(result.paymentReference, "PaymentReconciliation/package-payment");
});

test("commercial package ledger migration enforces append-only mutation rejection", async () => {
  const sql = await readFile(new URL("../../data/migrations/2026-07-18-commercial-engine-schema.sql", import.meta.url), "utf8");
  assert.match(sql, /BEFORE UPDATE OR DELETE ON odos_package_ledger/);
  assert.match(sql, /source_sale_invoice_id TEXT NOT NULL UNIQUE/);
  assert.match(sql, /snapshot_name TEXT NOT NULL/);
  assert.match(sql, /snapshot_eligible_procedure_type_codes TEXT\[\] NOT NULL/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS odos_package_redemptions/);
  assert.match(sql, /sessions_delta INTEGER NOT NULL/);
  const storeSource = await readFile(new URL("../src/commercial-engine/ledger-store.ts", import.meta.url), "utf8");
  assert.match(storeSource, /ON CONFLICT \(source_sale_invoice_id\) DO NOTHING/);
});

function instance(): PatientPackageInstance {
  return {
    id: "f38e17e5-d279-4cb7-a87b-04895533380d",
    patientFhirId: "patient-1",
    definitionId: definition.id,
    name: definition.name,
    eligibleProcedureTypeCodes: definition.eligibleProcedureTypeCodes,
    sessionCount: 3,
    priceCents: 360_000,
    expiryDate: "2027-07-18",
    refundPolicy: "non_refundable",
    sourceSaleInvoiceId: "sale-invoice",
    remainingSessions: 2,
    createdAt: "2026-07-18T14:00:00Z",
    ledger: [],
  };
}

function store(): CommercialEngineStore {
  return {
    listDefinitions: async () => [definition],
    getDefinition: async () => definition,
    saveDefinition: async () => definition,
    archiveDefinition: async () => ({ ...definition, active: false }),
    listPatientPackages: async () => [],
    finalizeSale: async () => instance(),
    getRedemption: async () => undefined,
    beginRedemption: async (input) => ({
      procedureFhirId: input.procedureFhirId,
      patientFhirId: input.patientFhirId,
      packageInstanceId: input.packageInstanceId,
      chargeItemFhirId: input.chargeItemFhirId,
      amountCents: input.amountCents,
      createdAt: input.createdAt,
    }),
    recordRedemptionInvoice: async (procedureFhirId, invoiceFhirId) => ({
      procedureFhirId,
      patientFhirId: "patient-1",
      packageInstanceId: instance().id,
      chargeItemFhirId: "charge-1",
      amountCents: 120_000,
      invoiceFhirId,
      createdAt: "2026-07-18T15:00:00Z",
    }),
    recordRedemptionPayment: async (procedureFhirId, paymentFhirId) => ({
      procedureFhirId,
      patientFhirId: "patient-1",
      packageInstanceId: instance().id,
      chargeItemFhirId: "charge-1",
      amountCents: 120_000,
      invoiceFhirId: "redeem-invoice",
      paymentFhirId,
      createdAt: "2026-07-18T15:00:00Z",
    }),
    consume: async () => instance(),
  };
}
