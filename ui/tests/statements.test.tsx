import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  fetchStatements,
  formatStatementMoney,
  generatePatientStatement,
  renderBalanceForwardStatement,
  runStatements,
  type StatementRow,
} from "../src/lib/statements";
import { Statements, StatementsContent, type StatementsServices } from "../src/scenes/claims/Statements";

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
  assert.match(html, /Balance due[\s\S]*\$60\.00/);
  assert.match(html, /no mail or email was sent/i);
  assert.throws(() => renderBalanceForwardStatement({ ...statement("bad", "2026-07-12T15:00:00.000Z", 6_000), balanceCents: 6_001 }), /do not reconcile/);
});

test("balance-forward statement renders the configured footer escaped and omits the element when unset", () => {
  const configured = {
    ...statement("new", "2026-07-12T15:00:00.000Z", 6_000),
    statementFooterMessage: '<script>alert("x")</script> Pay online',
  };
  const html = renderBalanceForwardStatement(configured);
  assert.match(html, /class="practice-message"/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; Pay online/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(
    renderBalanceForwardStatement(statement("new", "2026-07-12T15:00:00.000Z", 6_000)),
    /class="practice-message"/,
  );
});

test("insurance-aware mailer renders sourced line detail, addresses, provider identifiers, and static tear-off fields", () => {
  const row: StatementRow = {
    ...statement("new", "2026-07-12T15:00:00.000Z", 6_000),
    detail: {
      header: {
        practiceName: "Independent Eye Care",
        practiceAddress: { lines: ["20 Vision Way"], cityStatePostal: "Raleigh, NC 27601" },
        practicePhone: "919-555-0100",
        providerName: "Morgan Lee, OD",
        providerNpi: "1234567893",
        providerLicense: "OPT-1234",
        patientAddress: { lines: ["10 Main St"], cityStatePostal: "Raleigh, NC 27601" },
      },
      orders: [{
        invoiceReference: "Invoice/new",
        orderNumber: "ORDER-TEST",
        claimReference: "Claim/claim-test",
        claimNumber: "CLAIM-TEST",
        payerName: "Source Health Plan",
        mode: "insurance-aware",
        lines: [{
          sequence: 1,
          serviceDate: "2026-07-01",
          procedureCode: "PROC-TEST",
          procedureDisplay: "Source procedure display",
          diagnosisCodes: ["DX-TEST"],
          quantity: 1,
          retailCents: 10_000,
          payerName: "Source Health Plan",
          insurancePaidCents: 2_000,
          insuranceAdjustments: [{ group: "INS", code: "SOURCE", label: "adjustment INS SOURCE", amountCents: 2_000 }],
          patientAdjustments: [{ group: "PR", code: "SOURCE", label: "Source patient reason", amountCents: 6_000 }],
        }],
        patientPayments: [{ paymentReference: "PaymentReconciliation/payment-new", date: "2026-07-02", amountCents: 4_000 }],
      }],
    },
  };
  const html = renderBalanceForwardStatement(row);
  assert.match(html, /Order # ORDER-TEST/);
  assert.match(html, /Claim # CLAIM-TEST/);
  assert.match(html, /PROC-TEST\/ DX-TEST/);
  assert.match(html, /Insurance adjustment: adjustment INS SOURCE/);
  assert.match(html, /Patient adjustment: Source patient reason/);
  assert.match(html, /Patient payment/);
  assert.match(html, /Remit payment to/);
  assert.match(html, /NPI 1234567893/);
  assert.match(html, /License # OPT-1234/);
  assert.match(html, /PAY THIS AMOUNT[\s\S]*\$60\.00/);
  assert.match(html, /☐ VISA/);
  assert.match(html, /Card number/);
  assert.doesNotMatch(html, /<input|fetch\(|payment processor/i);
});

test("detailed mailer prints an invoice-only row for a pre-seam Order", () => {
  const row: StatementRow = {
    ...statement("new", "2026-07-12T15:00:00.000Z", 6_000),
    detail: {
      header: { practiceName: "Independent Eye Care" },
      orders: [{ invoiceReference: "Invoice/new", orderNumber: "LEGACY-1", mode: "invoice-only", lines: [], patientPayments: [] }],
    },
  };
  const html = renderBalanceForwardStatement(row);
  assert.match(html, /Invoice-only detail/);
  assert.match(html, /pre-seam balance/);
  assert.match(html, /PAY THIS AMOUNT[\s\S]*\$60\.00/);
});

test("insurance-aware detailed statement renders the configured footer", () => {
  const row: StatementRow = {
    ...statement("new", "2026-07-12T15:00:00.000Z", 6_000),
    statementFooterMessage: "Balances are due upon receipt.",
    detail: {
      header: { practiceName: "Independent Eye Care" },
      orders: [{
        invoiceReference: "Invoice/new",
        orderNumber: "ORDER-TEST",
        mode: "invoice-only",
        lines: [],
        patientPayments: [],
      }],
    },
  };
  assert.match(
    renderBalanceForwardStatement(row),
    /class="practice-message">Balances are due upon receipt\.<\/p>/,
  );
});

test("statement screen and print show unapplied credit as a separate line and the net balance due", () => {
  const row = {
    ...statement("new", "2026-07-12T15:00:00.000Z", 10_000),
    unappliedPaymentReconciliationReferences: ["PaymentReconciliation/credit-1"],
    unappliedCreditCents: 2_500,
    balanceDueCents: 7_500,
    creditBalanceCents: 0,
  };
  const screen = renderToStaticMarkup(<StatementsContent statements={[row]} onPrint={() => undefined} />);
  assert.match(screen, /Unapplied credit/);
  assert.match(screen, /−\$25\.00/);
  assert.match(screen, /\$75\.00/);
  const print = renderBalanceForwardStatement(row);
  assert.match(print, /Unapplied credit on account[\s\S]*−\$25\.00/);
  assert.match(print, /Balance due[\s\S]*\$75\.00/);
});

test("credit above the Invoice balance prints zero due and a positive credit balance", () => {
  const row = {
    ...statement("new", "2026-07-12T15:00:00.000Z", 10_000),
    unappliedPaymentReconciliationReferences: ["PaymentReconciliation/credit-1"],
    unappliedCreditCents: 12_500,
    balanceDueCents: 0,
    creditBalanceCents: 2_500,
  };
  const html = renderBalanceForwardStatement(row);
  assert.match(html, /Balance due[\s\S]*\$0\.00/);
  assert.match(html, /Credit balance[\s\S]*\$25\.00/);
  assert.doesNotMatch(html, /Balance due[\s\S]*−\$25\.00/);
});

test("shared statement money formatting is used by both screen and print output", () => {
  assert.equal(formatStatementMoney(6_000), "$60.00");
  const row = statement("new", "2026-07-12T15:00:00.000Z", 6_000);
  assert.match(renderToStaticMarkup(<StatementsContent statements={[row]} onPrint={() => undefined} />), /\$60\.00/);
  assert.match(renderBalanceForwardStatement(row), /\$60\.00/);
});

test("a blocked or failed print routes its error into the Statements alert", async () => {
  let renderer: ReactTestRenderer;
  const services = statementServices({
    list: async () => [statement("new", "2026-07-12T15:00:00.000Z", 6_000)],
    print: () => { throw new Error("The printable statement window was blocked."); },
  });
  await act(async () => { renderer = create(<Statements services={services} PatientSearchComponent={PatientSearchStub} />); });

  act(() => renderer.root.findAllByType("button").find((button) => button.children.includes("Print"))!.props.onClick());
  assert.match(renderer.root.findByProps({ role: "alert" }).children.join(""), /printable statement window was blocked/);
  act(() => renderer.unmount());
});

test("patient generation is blocked while a batch run is in flight", async () => {
  let finishRun!: (result: ReturnType<typeof runResult>) => void;
  let generateCalls = 0;
  const pendingRun = new Promise<ReturnType<typeof runResult>>((resolve) => { finishRun = resolve; });
  const services = statementServices({
    run: () => pendingRun,
    generate: async () => {
      generateCalls += 1;
      return runResult();
    },
  });
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(<Statements services={services} PatientSearchComponent={PatientSearchStub} />); });

  act(() => renderer.root.findAllByType("button").find((button) => button.children.includes("Run statements"))!.props.onClick());
  assert.equal(renderer.root.findByType(PatientSearchStub).props.actionLabel, "Running…");
  act(() => renderer.root.findByType(PatientSearchStub).props.onSelect({ resourceType: "Patient", id: "p1" }));
  assert.equal(generateCalls, 0);

  await act(async () => { finishRun(runResult()); await pendingRun; });
  act(() => renderer.unmount());
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

function statementServices(overrides: Partial<StatementsServices> = {}): StatementsServices {
  return {
    list: async () => [],
    generate: async () => runResult(),
    run: async () => runResult(),
    print: () => undefined,
    ...overrides,
  };
}

function PatientSearchStub(): React.JSX.Element {
  return <div />;
}
