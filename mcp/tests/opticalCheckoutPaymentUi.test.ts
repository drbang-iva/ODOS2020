import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Resolve ui/src from this test file, not the runner's cwd (the full mcp suite runs from mcp/).
const UI_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "src");
import {
  CHECKOUT_TENDERS,
  chargeOpticalCardPayment,
  invoiceTotalNetCents,
} from "../../ui/src/lib/optical-order.js";
import type { Invoice } from "@medplum/fhirtypes";

test("checkout tender picker exposes card terminal without making it an Invoice tender", () => {
  assert.deepEqual(CHECKOUT_TENDERS.map((tender) => tender.code), [
    "CASH",
    "CHECK",
    "CARD_TERMINAL",
  ]);
});

test("UI card charge helper posts only the server-owned Clover charge request", async () => {
  let captured: { url: string | URL | Request; init?: RequestInit } | undefined;
  const result = await chargeOpticalCardPayment(
    {
      amountCents: 24400,
      patientReference: "Patient/p1",
      invoiceReference: "Invoice/inv1",
      taskReference: "Task/task1",
    },
    {
      authHeader: () => "Bearer ui-token",
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return new Response(
          JSON.stringify({
            transactionId: "clover-test-0010",
            paymentRecord: { resourceType: "PaymentReconciliation", id: "pr1" },
            outcome: "success",
            amountChargedCents: 24400,
            feesCents: 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  );

  assert.deepEqual(result.paymentRecord, { resourceType: "PaymentReconciliation", id: "pr1" });
  assert.equal(captured?.url, "/payments/charge");
  assert.equal(captured?.init?.method, "POST");
  assert.equal((captured?.init?.headers as Record<string, string>).Authorization, "Bearer ui-token");
  // No role header — the server derives the role from the verified token (decision 2026-07-05 §3).
  assert.equal((captured?.init?.headers as Record<string, string>)["X-OSOD-Role"], undefined);
  const body = JSON.parse(String(captured?.init?.body)) as Record<string, unknown>;
  assert.deepEqual(body, {
    method: "clover",
    amountCents: 24400,
    patientReference: "Patient/p1",
    invoiceReference: "Invoice/inv1",
    taskReference: "Task/task1",
    description: "Optical order card payment",
    surface: "in-clinic-pos",
  });
  assert.equal("staffReference" in body, false);
});

test("UI card charge helper surfaces endpoint authz/session failures", async () => {
  await assert.rejects(
    () =>
      chargeOpticalCardPayment(
        {
          amountCents: 24400,
          patientReference: "Patient/p1",
          invoiceReference: "Invoice/inv1",
          taskReference: "Task/task1",
        },
        {
          authHeader: () => "Bearer ui-token",
          fetchImpl: async () =>
            new Response(JSON.stringify({ error: "payment.charge role required" }), { status: 403 }),
        },
      ),
    /403 payment\.charge role required/,
  );
});

test("UI card charge amount is derived from Invoice.totalNet cents", () => {
  const invoice: Invoice = {
    resourceType: "Invoice",
    status: "issued",
    totalNet: { value: 244, currency: "USD" },
  };
  assert.equal(invoiceTotalNetCents(invoice), 24400);
});

test("ui source does not import Clover processor config", () => {
  const text = listFiles(UI_SRC)
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.doesNotMatch(text, /CLOVER_(BASE_URL|ACCESS_TOKEN|DEVICE_ID|POS_ID)/);
  assert.doesNotMatch(text, /payment-config|clover-adapter/i);
});

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}
