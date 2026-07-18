import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PackageFinalizationError,
  readPendingPackageSale,
  sellPackage,
  type PackageDefinition,
} from "../src/lib/commercial-engine";

const definition: PackageDefinition = {
  id: "definition-1",
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

test("a paid package sale retries only finalization with the original Invoice", async () => {
  const storage = memoryStorage();
  const firstPaths: string[] = [];
  const firstResponses = [
    response(200, { invoiceReference: "Invoice/sale-1" }),
    response(200, { outcome: "success" }),
    response(500, { error: "temporary activation failure" }),
  ];
  let failure: PackageFinalizationError | undefined;
  try {
    await sellPackage(
      { patientReference: "Patient/patient-1", definition, tender: "CASH" },
      {
        authHeader: () => "Bearer synthetic",
        storage,
        fetchImpl: async (input) => {
          firstPaths.push(String(input));
          return firstResponses.shift()!;
        },
      },
    );
  } catch (cause) {
    if (cause instanceof PackageFinalizationError) failure = cause;
    else throw cause;
  }
  assert.equal(failure?.invoiceReference, "Invoice/sale-1");
  const pending = readPendingPackageSale("Patient/patient-1", storage);
  assert.equal(pending?.invoiceReference, "Invoice/sale-1");
  assert.equal(pending?.definition.id, definition.id);
  assert.deepEqual(firstPaths, [
    "/commercial-engine/sales/prepare",
    "/payments/charge",
    "/commercial-engine/sales/finalize",
  ]);

  const retryPaths: string[] = [];
  const packageInstance = {
    id: "instance-1",
    patientFhirId: "patient-1",
    definitionId: definition.id,
    name: definition.name,
    eligibleProcedureTypeCodes: definition.eligibleProcedureTypeCodes,
    sessionCount: 3,
    priceCents: 360_000,
    expiryDate: "2027-07-18",
    refundPolicy: "non_refundable" as const,
    sourceSaleInvoiceId: "sale-1",
    remainingSessions: 3,
    createdAt: "2026-07-18T12:00:00Z",
    ledger: [],
  };
  const activated = await sellPackage(
    {
      patientReference: "Patient/patient-1",
      definition,
      tender: "CASH",
      paidInvoiceReference: pending!.invoiceReference,
    },
    {
      authHeader: () => "Bearer synthetic",
      storage,
      fetchImpl: async (input) => {
        retryPaths.push(String(input));
        return response(200, { package: packageInstance });
      },
    },
  );

  assert.deepEqual(retryPaths, ["/commercial-engine/sales/finalize"]);
  assert.equal(activated.id, "instance-1");
  assert.equal(readPendingPackageSale("Patient/patient-1", storage), undefined);
});

test("browser storage failures cannot change payment finalization outcomes", async () => {
  const storage = throwingStorage();
  const packageInstance = {
    id: "instance-1",
    patientFhirId: "patient-1",
    definitionId: definition.id,
    name: definition.name,
    eligibleProcedureTypeCodes: definition.eligibleProcedureTypeCodes,
    sessionCount: 3,
    priceCents: 360_000,
    expiryDate: "2027-07-18",
    refundPolicy: "non_refundable" as const,
    sourceSaleInvoiceId: "sale-1",
    remainingSessions: 3,
    createdAt: "2026-07-18T12:00:00Z",
    ledger: [],
  };
  const activated = await sellPackage(
    {
      patientReference: "Patient/patient-1",
      definition,
      tender: "CASH",
      paidInvoiceReference: "Invoice/sale-1",
    },
    {
      authHeader: () => "Bearer synthetic",
      storage,
      fetchImpl: async () => response(200, { package: packageInstance }),
    },
  );
  assert.equal(activated.id, "instance-1");
  assert.equal(readPendingPackageSale("Patient/patient-1", storage), undefined);
});

test("pending package recovery is keyed by Invoice so one finalization cannot erase another", async () => {
  const storage = memoryStorage();
  for (const invoiceReference of ["Invoice/sale-1", "Invoice/sale-2"]) {
    await assert.rejects(sellPackage(
      {
        patientReference: "Patient/patient-1",
        definition,
        tender: "CASH",
        paidInvoiceReference: invoiceReference,
      },
      {
        authHeader: () => "Bearer synthetic",
        storage,
        fetchImpl: async () => response(500, { error: "temporary activation failure" }),
      },
    ), PackageFinalizationError);
  }
  assert.equal(storage.length, 2);
  assert.equal(readPendingPackageSale("Patient/patient-1", storage)?.invoiceReference, "Invoice/sale-1");

  await sellPackage(
    {
      patientReference: "Patient/patient-1",
      definition,
      tender: "CASH",
      paidInvoiceReference: "Invoice/sale-1",
    },
    {
      authHeader: () => "Bearer synthetic",
      storage,
      fetchImpl: async () => response(200, {
        package: {
          id: "instance-1",
          patientFhirId: "patient-1",
          definitionId: definition.id,
          name: definition.name,
          eligibleProcedureTypeCodes: definition.eligibleProcedureTypeCodes,
          sessionCount: 3,
          priceCents: 360_000,
          expiryDate: "2027-07-18",
          refundPolicy: "non_refundable",
          sourceSaleInvoiceId: "sale-1",
          remainingSessions: 3,
          createdAt: "2026-07-18T12:00:00Z",
          ledger: [],
        },
      }),
    },
  );

  assert.equal(storage.length, 1);
  assert.equal(readPendingPackageSale("Patient/patient-1", storage)?.invoiceReference, "Invoice/sale-2");
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

function throwingStorage(): Storage {
  const failure = () => { throw new DOMException("Storage blocked", "SecurityError"); };
  return {
    get length() { return failure(); },
    clear: failure,
    getItem: failure,
    key: failure,
    removeItem: failure,
    setItem: failure,
  } as Storage;
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
