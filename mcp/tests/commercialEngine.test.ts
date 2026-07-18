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
  PackageRedemptionOperation,
  PatientPackageInstance,
} from "../src/commercial-engine/ledger-store.js";
import {
  CommercialEngineInputError,
  PgCommercialEngineStore,
} from "../src/commercial-engine/ledger-store.js";
import { paymentTenderExtension } from "../src/fhir/odosPaymentTender.js";

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

test("package activation ignores tender metadata and requires full funding", async (t) => {
  const prepared = await preparePackageSale(
    { store: store(), now: () => "2026-07-18T14:00:00Z" },
    {
      create: async <T>(resource: T): Promise<T> => ({ ...(resource as object), id: "sale-invoice" }) as T,
      read: async () => { throw new Error("not used"); },
      search: async () => { throw new Error("not used"); },
    } as never,
    { patientReference: "Patient/patient-1", definitionId: definition.id, staffReference: "Practitioner/staff-1" },
  );
  const input = {
    patientReference: "Patient/patient-1",
    definitionId: definition.id,
    invoiceReference: "Invoice/sale-invoice",
    staffReference: "Practitioner/staff-1",
  };

  await t.test("partial manual payment does not activate the package", async () => {
    let activated = false;
    await assert.rejects(finalizePackageSale(
      { store: { ...store(), finalizeSale: async () => { activated = true; return instance(); } } },
      {
        create: async () => { throw new Error("not used"); },
        read: async () => ({ ...prepared.invoice, status: "issued" as const, extension: [paymentTenderExtension("CASH")] }),
        search: async () => ({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{
            resource: {
              resourceType: "PaymentReconciliation",
              status: "active",
              outcome: "complete",
              paymentAmount: { value: 1_000, currency: "USD" },
              detail: [{ request: { reference: "Invoice/sale-invoice" }, amount: { value: 1_000, currency: "USD" } }],
            },
          }],
        }),
      } as never,
      input,
    ), /successful payment/);
    assert.equal(activated, false);
  });

  await t.test("unpaid Invoice created with tender metadata does not activate the package", async () => {
    let activated = false;
    await assert.rejects(finalizePackageSale(
      { store: { ...store(), finalizeSale: async () => { activated = true; return instance(); } } },
      {
        create: async () => { throw new Error("not used"); },
        read: async () => ({ ...prepared.invoice, status: "issued" as const, extension: [paymentTenderExtension("CHECK")] }),
        search: async () => ({ resourceType: "Bundle", type: "searchset", entry: [] }),
      } as never,
      input,
    ), /successful payment/);
    assert.equal(activated, false);
  });
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
  const events: string[] = [];
  const conditionalHeaders: Array<Record<string, string> | undefined> = [];
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
          events.push("consume");
          consumed = input;
          return { ...instance(), remainingSessions: 1 };
        },
        completeRedemption: async (procedureFhirId, completedAt) => {
          events.push("complete");
          return redemption({ procedureFhirId, completedAt });
        },
      },
      now: () => "2026-07-18T15:00:00Z",
    },
    {
      read: async <T>(_resourceType: string, id: string): Promise<T> => (id === "procedure-1" ? procedure : chargeItem) as T,
      create: async <T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T> => {
        const saved = { ...resource, id: resource.resourceType === "Invoice" ? "redeem-invoice" : "package-payment" } as T;
        events.push(resource.resourceType);
        conditionalHeaders.push(headers);
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
  assert.deepEqual(events, ["Invoice", "consume", "PaymentReconciliation", "complete"]);
  assert.equal(conditionalHeaders.every((headers) => Boolean(headers?.["If-None-Exist"])), true);
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

test("redemption retries reject a different package, charge, or patient", async () => {
  const completed = redemption({ completedAt: "2026-07-18T15:00:00Z" });
  const cases = [
    { patientReference: "Patient/patient-1", packageInstanceId: "different-package", chargeItemReference: "ChargeItem/charge-1" },
    { patientReference: "Patient/patient-1", packageInstanceId: instance().id, chargeItemReference: "ChargeItem/charge-2" },
    { patientReference: "Patient/patient-2", packageInstanceId: instance().id, chargeItemReference: "ChargeItem/charge-1" },
  ];
  for (const input of cases) {
    const patientId = input.patientReference.replace("Patient/", "");
    const chargeId = input.chargeItemReference.replace("ChargeItem/", "");
    await assert.rejects(redeemPackageSession(
      {
        store: {
          ...store(),
          listPatientPackages: async () => [instance()],
          getRedemption: async () => completed,
          beginRedemption: async () => completed,
        },
      },
      {
        read: async <T>(_resourceType: string, id: string): Promise<T> => (id === "procedure-1"
          ? {
              resourceType: "Procedure",
              id,
              status: "completed",
              subject: { reference: input.patientReference },
              code: { coding: [{ code: "procedure:dry-eye-ipl" }] },
            }
          : {
              resourceType: "ChargeItem",
              id: chargeId,
              status: "billable",
              code: { text: "Dry-Eye IPL" },
              subject: { reference: `Patient/${patientId}` },
              supportingInformation: [{ reference: "Procedure/procedure-1" }],
              priceOverride: { value: 1_200, currency: "USD" },
            }) as T,
        create: async <T>(resource: T): Promise<T> => resource,
        search: async () => ({ resourceType: "Bundle", type: "searchset", entry: [] }),
      } as never,
      {
        ...input,
        procedureReference: "Procedure/procedure-1",
        staffReference: "Practitioner/staff-1",
      },
    ), /different package redemption operation/);
  }
});

test("a referenced redemption Invoice is revalidated on retry", async () => {
  const existing = redemption({ paymentFhirId: undefined, completedAt: undefined });
  await assert.rejects(redeemPackageSession(
    {
      store: {
        ...store(),
        listPatientPackages: async () => [instance()],
        getRedemption: async () => existing,
        beginRedemption: async () => existing,
      },
    },
    {
      read: async <T>(resourceType: string): Promise<T> => (resourceType === "Procedure"
        ? {
            resourceType: "Procedure",
            id: "procedure-1",
            status: "completed",
            subject: { reference: "Patient/patient-1" },
            code: { coding: [{ code: "procedure:dry-eye-ipl" }] },
          }
        : resourceType === "ChargeItem"
          ? {
              resourceType: "ChargeItem",
              id: "charge-1",
              status: "billable",
              code: { text: "Dry-Eye IPL" },
              subject: { reference: "Patient/patient-1" },
              supportingInformation: [{ reference: "Procedure/procedure-1" }],
              priceOverride: { value: 1_200, currency: "USD" },
            }
          : {
              resourceType: "Invoice",
              id: "redeem-invoice",
              status: "issued",
              subject: { reference: "Patient/different-patient" },
              lineItem: [{ sequence: 1, chargeItemReference: { reference: "ChargeItem/charge-1" } }],
              totalNet: { value: 1_200, currency: "USD" },
            }) as T,
      create: async <T>(resource: T): Promise<T> => resource,
      search: async () => ({ resourceType: "Bundle", type: "searchset", entry: [] }),
    } as never,
    {
      patientReference: "Patient/patient-1",
      packageInstanceId: instance().id,
      procedureReference: "Procedure/procedure-1",
      chargeItemReference: "ChargeItem/charge-1",
      staffReference: "Practitioner/staff-1",
    },
  ), /recovered package redemption Invoice does not match/);
});

test("an incomplete redemption identifier search fails closed before FHIR creation", async () => {
  let createCalls = 0;
  await assert.rejects(redeemPackageSession(
    {
      store: { ...store(), listPatientPackages: async () => [instance()] },
    },
    {
      read: async <T>(resourceType: string): Promise<T> => (resourceType === "Procedure"
        ? {
            resourceType: "Procedure",
            id: "procedure-1",
            status: "completed",
            subject: { reference: "Patient/patient-1" },
            code: { coding: [{ code: "procedure:dry-eye-ipl" }] },
          }
        : {
            resourceType: "ChargeItem",
            id: "charge-1",
            status: "billable",
            code: { text: "Dry-Eye IPL" },
            subject: { reference: "Patient/patient-1" },
            supportingInformation: [{ reference: "Procedure/procedure-1" }],
            priceOverride: { value: 1_200, currency: "USD" },
          }) as T,
      create: async <T>(resource: T): Promise<T> => { createCalls += 1; return resource; },
      search: async () => ({
        resourceType: "Bundle",
        type: "searchset",
        entry: [],
        link: [{ relation: "next", url: "http://synthetic.test/next" }],
      }),
    } as never,
    {
      patientReference: "Patient/patient-1",
      packageInstanceId: instance().id,
      procedureReference: "Procedure/procedure-1",
      chargeItemReference: "ChargeItem/charge-1",
      staffReference: "Practitioner/staff-1",
    },
  ), /search was incomplete/);
  assert.equal(createCalls, 0);
});

test("sale snapshots reject whitespace-only eligibility codes before persistence", async () => {
  const store = new PgCommercialEngineStore({
    pool: {
      connect: async () => { throw new Error("database should not be reached"); },
      query: async () => { throw new Error("database should not be reached"); },
      end: async () => undefined,
    } as never,
  });
  await assert.rejects(store.finalizeSale({
    definitionId: definition.id,
    patientFhirId: "patient-1",
    sourceSaleInvoiceId: "sale-invoice",
    actorUserId: "Practitioner/staff-1",
    soldAt: "2026-07-18T14:00:00Z",
    snapshotName: definition.name,
    snapshotEligibleProcedureTypeCodes: ["  "],
    snapshotSessionCount: definition.sessionCount,
    snapshotPriceCents: definition.priceCents,
    snapshotExpiryDays: definition.expiryDays,
    snapshotRefundPolicy: definition.refundPolicy,
  }), CommercialEngineInputError);
});

test("commercial package ledger migration enforces append-only mutation rejection", async () => {
  const sql = await readFile(new URL("../../data/migrations/2026-07-18-commercial-engine-schema.sql", import.meta.url), "utf8");
  const recoverySql = await readFile(new URL("../../data/migrations/2026-07-18-commercial-engine-redemption-recovery.sql", import.meta.url), "utf8");
  assert.match(sql, /BEFORE UPDATE OR DELETE ON odos_package_ledger/);
  assert.match(sql, /source_sale_invoice_id TEXT NOT NULL UNIQUE/);
  assert.match(sql, /snapshot_name TEXT NOT NULL/);
  assert.match(sql, /snapshot_eligible_procedure_type_codes TEXT\[\] NOT NULL/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS odos_package_redemptions/);
  assert.doesNotMatch(sql, /consumed_at TIMESTAMPTZ/);
  assert.match(recoverySql, /ALTER TABLE odos_package_redemptions/);
  assert.match(recoverySql, /ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ/);
  assert.match(sql, /sessions_delta INTEGER NOT NULL/);
  const storeSource = await readFile(new URL("../src/commercial-engine/ledger-store.ts", import.meta.url), "utf8");
  assert.match(storeSource, /ON CONFLICT \(source_sale_invoice_id\) DO NOTHING/);
  assert.match(storeSource, /2026-07-18-commercial-engine-redemption-recovery\.sql/);
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
    completeRedemption: async (procedureFhirId, completedAt) => redemption({ procedureFhirId, completedAt }),
    consume: async () => instance(),
  };
}

function redemption(overrides: Partial<PackageRedemptionOperation> = {}): PackageRedemptionOperation {
  return {
    procedureFhirId: "procedure-1",
    patientFhirId: "patient-1",
    packageInstanceId: instance().id,
    chargeItemFhirId: "charge-1",
    amountCents: 120_000,
    invoiceFhirId: "redeem-invoice",
    paymentFhirId: "package-payment",
    createdAt: "2026-07-18T15:00:00Z",
    ...overrides,
  };
}
