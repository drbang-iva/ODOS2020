import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  fetchStatements,
  generatePatientStatement,
  renderBalanceForwardStatement,
  runStatements,
  type StatementRow,
} from "../src/lib/statements";
import { StatementsContent } from "../src/scenes/claims/Statements";

test("Statements list renders newest-first rows, real balances, print actions, and an honest empty state", () => {
  const rows = [statement("new", "2026-07-12T15:00:00.000Z", 6_000), statement("old", "2026-07-11T15:00:00.000Z", 10_000)];
  const html = renderToStaticMarkup(<StatementsContent statements={rows} onPrint={() => undefined} />);
  assert.ok(html.indexOf("Task/new") === -1);
  assert.ok(html.indexOf("Alex Rivera") < html.indexOf("Jordan Lee"));
  assert.match(html, /\$60\.00/);
  assert.equal((html.match(/>Print</g) ?? []).length, 2);
  const empty = renderToStaticMarkup(<StatementsContent statements={[]} onPrint={() => undefined} />);
  assert.match(empty, /No statements generated yet/);
  assert.match(empty, /No balance is shown until reconciliation succeeds/);
});

test("printable statement renders only a reconciled balance-forward snapshot", () => {
  const html = renderBalanceForwardStatement(statement("new", "2026-07-12T15:00:00.000Z", 6_000));
  assert.match(html, /Balance-forward statement/);
  assert.match(html, /Total charges[\s\S]*\$100\.00/);
  assert.match(html, /Payments applied[\s\S]*\$40\.00/);
  assert.match(html, /Balance forward[\s\S]*\$60\.00/);
  assert.match(html, /no mail or email was sent/i);
  assert.throws(() => renderBalanceForwardStatement({ ...statement("bad", "2026-07-12T15:00:00.000Z", 6_000), balanceCents: 6_001 }), /do not reconcile/);
});

test("statement API client lists, generates one patient, and runs the batch on the shipped routes", async () => {
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body as string | undefined });
    const body = String(input).endsWith("/statements") ? { items: [statement("new", "2026-07-12T15:00:00.000Z", 6_000)] } : runResult();
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const options = { authorization: "Bearer test", fetchImpl };
  assert.equal((await fetchStatements(options)).length, 1);
  assert.equal((await generatePatientStatement("Patient/p1", options)).generatedCount, 1);
  assert.equal((await runStatements(options)).generatedCount, 1);
  assert.deepEqual(requests.map((request) => [request.url, request.method]), [
    ["/statements", "GET"], ["/statements/generate", "POST"], ["/statements/run", "POST"],
  ]);
  assert.deepEqual(JSON.parse(requests[1].body!), { patientReference: "Patient/p1" });
});

function statement(id: string, generatedAt: string, balanceCents: number): StatementRow {
  const patientName = id === "old" ? "Jordan Lee" : "Alex Rivera";
  const paymentsAppliedCents = 10_000 - balanceCents;
  return {
    statementReference: `Task/${id}`, generatedAt, patientReference: `Patient/${id}`, patientName,
    paymentReconciliationReferences: paymentsAppliedCents ? [`PaymentReconciliation/payment-${id}`] : [],
    invoices: [{ invoiceReference: `Invoice/${id}`, date: generatedAt, grossCents: 10_000, netCents: 10_000, paymentsAppliedCents, balanceCents }],
    totalGrossCents: 10_000, totalNetCents: 10_000, paymentsAppliedCents, balanceCents,
  };
}

function runResult() {
  const row = statement("new", "2026-07-12T15:00:00.000Z", 6_000);
  return { runReference: "Task/run", generatedAt: row.generatedAt, generatedCount: 1, invalidRejects: 0, skippedZeroBalanceCount: 0, statements: [row], rejects: [] };
}
