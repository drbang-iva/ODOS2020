import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { loadConfiguredPaymentMethods } from "../src/lib/optical-order";
import { PaymentPanel } from "../src/scenes/OpticalOrder";

for (const fixture of [
  { name: "without Clover", methods: ["manual-cash", "stripe"], terminalVisible: false },
  { name: "with Clover", methods: ["manual-cash", "clover"], terminalVisible: true },
] as const) {
  test(`checkout dropdown ${fixture.name} gates Card (terminal) from the methods response`, async () => {
    const loadPaymentMethods = () => loadConfiguredPaymentMethods({
      authHeader: () => "Bearer ui-token",
      fetchImpl: async () => new Response(JSON.stringify({ methods: fixture.methods }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });
    const renderer = await renderPaymentPanel(loadPaymentMethods);
    const labels = renderer.root.findAllByType("option").map((option) => option.children.join(""));
    assert.deepEqual(labels.slice(0, 3), ["Cash", "Check", "Card — manual entry"]);
    assert.equal(labels.includes("Card (terminal)"), fixture.terminalVisible);
    act(() => renderer.unmount());
  });
}

test("checkout dropdown fails closed when the payment methods request errors", async () => {
  const renderer = await renderPaymentPanel(() => loadConfiguredPaymentMethods({
    authHeader: () => "Bearer ui-token",
    fetchImpl: async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
  }));
  const labels = renderer.root.findAllByType("option").map((option) => option.children.join(""));
  assert.deepEqual(labels, ["Cash", "Check", "Card — manual entry"]);
  act(() => renderer.unmount());
});

async function renderPaymentPanel(loadPaymentMethods: () => Promise<string[]>): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <PaymentPanel
        tender="CASH"
        paymentAmount="0.00"
        selectedTotalCents={0}
        canProcessPayment={false}
        canPrintReceipt={false}
        onTenderChange={() => undefined}
        onAmountChange={() => undefined}
        onProcess={() => undefined}
        onPrintReceipt={() => undefined}
        loadPaymentMethods={loadPaymentMethods}
      />,
    );
    await Promise.resolve();
  });
  return renderer;
}
