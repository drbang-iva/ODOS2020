import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PackageFinalizationError,
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
      paidInvoiceReference: failure!.invoiceReference,
    },
    {
      authHeader: () => "Bearer synthetic",
      fetchImpl: async (input) => {
        retryPaths.push(String(input));
        return response(200, { package: packageInstance });
      },
    },
  );

  assert.deepEqual(retryPaths, ["/commercial-engine/sales/finalize"]);
  assert.equal(activated.id, "instance-1");
});

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
