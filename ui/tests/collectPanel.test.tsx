import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { CollectPanel, printReceipt } from "../src/components/CollectPanel";
import { collectRecordedTender, type OpenChargeLine } from "../src/lib/collect";

const CHARGES: OpenChargeLine[] = [
  { id: "charge-1", amountCents: 10_000, description: "Exam balance", date: "2026-07-15", source: "other" },
  { id: "charge-2", amountCents: 2_500, description: "Frames", date: "2026-07-15", source: "optical" },
];

test("CollectPanel updates its collecting subtotal and amount from selected charge chips", async () => {
  const renderer = create(
    <CollectPanel
      embedded
      patientReference="Patient/patient-1"
      onClose={() => undefined}
      initialCharges={CHARGES}
    />,
  );
  await act(async () => undefined);

  assert.equal(renderer.root.findByProps({ "aria-label": "Collection amount" }).props.value, "125.00");
  const chips = renderer.root.findAll((node) =>
    node.type === "button" && typeof node.props.className === "string" && node.props.className.includes("rounded-full"),
  );
  assert.equal(chips.length, 2);

  act(() => chips[0].props.onClick());

  assert.equal(renderer.root.findByProps({ "aria-label": "Collection amount" }).props.value, "25.00");
  assert.equal(renderer.root.findAll((node) =>
    node.type === "button" && typeof node.props.className === "string" && node.props.className.includes("rounded-full"),
  )[0].props["aria-pressed"], false);
});

test("CollectPanel switches among only Cash, Check, and manual card tenders", async () => {
  const renderer = create(
    <CollectPanel
      embedded
      patientReference="Patient/patient-1"
      onClose={() => undefined}
      initialCharges={CHARGES}
    />,
  );
  await act(async () => undefined);
  const tenderButtons = renderer.root.findAll((node) =>
    node.type === "button" && ["Cash", "Check", "Card — manual entry"].includes(node.children.join("")),
  );
  assert.deepEqual(tenderButtons.map((button) => button.children.join("")), ["Cash", "Check", "Card — manual entry"]);
  assert.equal(renderer.root.findAll((node) => node.children.join("").includes("terminal")).length, 0);

  act(() => tenderButtons[1].props.onClick());
  assert.equal(renderer.root.findAllByProps({ "aria-pressed": true }).some((node) => node.children.join("") === "Check"), true);
  act(() => tenderButtons[2].props.onClick());
  assert.equal(renderer.root.findAllByProps({ "aria-pressed": true }).some((node) => node.children.join("") === "Card — manual entry"), true);
});

test("CARD_MANUAL posts to the record-only collection endpoint with no processor request", async () => {
  let captured: { url: string; body: Record<string, unknown> } | undefined;
  await collectRecordedTender({
    patientReference: "Patient/patient-1",
    selectedOpenChargeLineIds: ["charge-1"],
    amountCents: 10_000,
    tender: "CARD_MANUAL",
  }, {
    authHeader: () => "Bearer test",
    fetchImpl: async (input, init) => {
      captured = { url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      return new Response(JSON.stringify({
        deviceRequestId: "",
        taskId: "",
        chargeItemIds: ["charge-1"],
        invoiceId: "invoice-1",
        outcome: "success",
        amountChargedCents: 10_000,
        tender: "CARD_MANUAL",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(captured?.url, "/payments/collect");
  assert.equal(captured?.body.tender, "CARD_MANUAL");
  assert.equal("method" in (captured?.body ?? {}), false);
});

test("live receipt printing passes the preloaded configured receipt footer message", () => {
  let printed: { title: string; html: string } | undefined;
  printReceipt({
    patientReference: "Patient/patient-1",
    patientName: "Alex Rivera",
    tender: "CASH",
    receiptFooterMessage: "Thank you for trusting our practice.",
    receipt: {
      result: {
        deviceRequestId: "",
        taskId: "",
        chargeItemIds: ["charge-1"],
        invoiceId: "invoice-1",
        outcome: "success",
        amountChargedCents: 10_000,
        tender: "CASH",
      },
      lines: [CHARGES[0]!],
    },
  }, {
    openPrint: (title, html) => {
      printed = { title, html };
      return true;
    },
  });
  assert.equal(printed?.title, "Receipt invoice-1");
  assert.match(printed?.html ?? "", /class="practice-message">Thank you for trusting our practice\.<\/p>/);
});

test("receipt printing reports a blocked print window", () => {
  assert.throws(
    () => printReceipt({
      patientReference: "Patient/patient-1",
      tender: "CASH",
      receipt: {
        result: {
          deviceRequestId: "",
          taskId: "",
          chargeItemIds: ["charge-1"],
          invoiceId: "invoice-1",
          outcome: "success",
          amountChargedCents: 10_000,
          tender: "CASH",
        },
        lines: [CHARGES[0]!],
      },
    }, { openPrint: () => false }),
    /browser blocked the receipt print window/i,
  );
});
