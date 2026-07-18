import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { ChargeItem, Invoice, PaymentReconciliation, Procedure, Resource } from "@medplum/fhirtypes";
import {
  applicablePackages,
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

test("commercial package ledger migration enforces append-only mutation rejection", async () => {
  const sql = await readFile(new URL("../../data/migrations/2026-07-18-commercial-engine-schema.sql", import.meta.url), "utf8");
  assert.match(sql, /BEFORE UPDATE OR DELETE ON odos_package_ledger/);
  assert.match(sql, /source_sale_invoice_id TEXT NOT NULL UNIQUE/);
  assert.match(sql, /sessions_delta INTEGER NOT NULL/);
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
    consume: async () => instance(),
  };
}
