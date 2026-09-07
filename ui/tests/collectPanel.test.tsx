import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { CollectPanel, printReceipt } from "../src/components/CollectPanel";
import { collectRecordedTender, type OpenChargeLine } from "../src/lib/collect";

const CHARGES: OpenChargeLine[] = [
  { id: "charge-1", amountCents: 10_000, openCents: 10_000, attributedCents: 0, description: "Exam balance", date: "2026-07-15", source: "other" },
  { id: "charge-2", amountCents: 2_500, openCents: 2_500, attributedCents: 0, description: "Frames", date: "2026-07-15", source: "optical" },
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

test("CollectPanel totals and displays the residual open amount instead of the original charge amount", async () => {
  const residual = {
    ...CHARGES[0]!,
    openCents: 6_000,
    attributedCents: 4_000,
  } as OpenChargeLine;
  const renderer = create(
    <CollectPanel
      embedded
      patientReference="Patient/patient-1"
      onClose={() => undefined}
      initialCharges={[residual]}
    />,
  );
  await act(async () => undefined);

  assert.equal(renderer.root.findByProps({ "aria-label": "Collection amount" }).props.value, "60.00");
  assert.match(JSON.stringify(renderer.toJSON()), /Exam balance.*\$60\.00/);
});

test("CollectPanel surfaces an ambiguous charge reason and keeps the line non-collectable", async () => {
  const ambiguous = {
    ...CHARGES[0]!,
    openCents: null,
    attributedCents: 0,
    ambiguityReason: "Invoice/invoice-1 has a partial allocation; the charge-level open amount is ambiguous.",
  } as OpenChargeLine;
  const renderer = create(
    <CollectPanel
      embedded
      patientReference="Patient/patient-1"
      onClose={() => undefined}
      initialCharges={[ambiguous]}
    />,
  );
  await act(async () => undefined);

  assert.match(JSON.stringify(renderer.toJSON()), /charge-level open amount is ambiguous/);
  const chargeButton = renderer.root.findAllByType("button").find((button) =>
    typeof button.props.className === "string" && button.props.className.includes("rounded-full"));
  assert.equal(chargeButton?.props.disabled, true);
  assert.equal(renderer.root.findByProps({ "aria-label": "Collection amount" }).props.value, "0.00");
  assert.equal(renderer.root.findAllByType("button").find((button) => button.children.join("") === "Collect")?.props.disabled, true);
});

test("CollectPanel reuses one requestId across rerendered retries and mints a new id for a changed collection", async () => {
  const requestIds: string[] = [];
  const generated = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const collectTender = async (request: { requestId: string; tender: string }) => {
    requestIds.push(request.requestId);
    if (requestIds.length < 3) throw new Error("synthetic retryable transport failure");
    return {
      deviceRequestId: "",
      taskId: "",
      chargeItemIds: ["charge-1"],
      invoiceId: "invoice-1",
      outcome: "success" as const,
      amountChargedCents: 10_000,
      tender: request.tender as "CASH" | "CHECK" | "CARD_MANUAL",
      replayed: false,
    };
  };
  const panel = () => (
    <CollectPanel
      embedded
      patientReference="Patient/patient-1"
      onClose={() => undefined}
      initialCharges={[{ ...CHARGES[0]!, openCents: 10_000, attributedCents: 0 } as OpenChargeLine]}
      collectTender={collectTender}
      requestIdFactory={() => generated.shift()!}
    />
  );
  const renderer = create(panel());
  await act(async () => undefined);

  const clickCollect = async () => {
    const button = renderer.root.findAllByType("button").find((candidate) => candidate.children.join("") === "Collect");
    assert.ok(button);
    await act(async () => { button.props.onClick(); });
  };
  await clickCollect();
  await act(async () => { renderer.update(panel()); });
  await clickCollect();
  assert.deepEqual(requestIds, [
    "11111111-1111-4111-8111-111111111111",
    "11111111-1111-4111-8111-111111111111",
  ]);

  const check = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Check");
  assert.ok(check);
  act(() => check.props.onClick());
  await clickCollect();
  assert.deepEqual(requestIds, [
    "11111111-1111-4111-8111-111111111111",
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ]);
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

test("disabled CollectPanel exposes no financial action and closes an open deposit sheet", async () => {
  const panel = (disabled: boolean) => (
    <CollectPanel
      embedded
      disabled={disabled}
      patientReference="Patient/patient-1"
      onClose={() => undefined}
      initialCharges={CHARGES}
    />
  );
  const renderer = create(panel(false));
  await act(async () => undefined);
  const deposit = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Deposit Credit Bank");
  assert.ok(deposit);

  act(() => deposit.props.onClick());
  assert.equal(renderer.root.findAllByProps({ "aria-label": "Deposit to Credit Bank" }).length, 1);

  await act(async () => { renderer.update(panel(true)); });
  const text = renderer.root.findAllByType("button").map((button) => button.children.join("")).join("\n");
  assert.doesNotMatch(text, /Deposit Credit Bank|Add package|Apply \$/);
  assert.equal(renderer.root.findAllByProps({ "aria-label": "Deposit to Credit Bank" }).length, 0);
  assert.ok(renderer.root.findAllByType("button").every((button) => button.props.disabled === true));
});

test("CARD_MANUAL posts to the record-only collection endpoint with no processor request", async () => {
  let captured: { url: string; body: Record<string, unknown> } | undefined;
  await collectRecordedTender({
    requestId: "11111111-1111-4111-8111-111111111111",
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
        replayed: false,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(captured?.url, "/payments/collect");
  assert.equal(captured?.body.tender, "CARD_MANUAL");
  assert.equal(captured?.body.requestId, "11111111-1111-4111-8111-111111111111");
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
        replayed: false,
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

test("receipt printing reconciles a residual collection to the residual amount", () => {
  let printedHtml = "";
  printReceipt({
    patientReference: "Patient/patient-1",
    tender: "CASH",
    receipt: {
      result: {
        deviceRequestId: "",
        taskId: "",
        chargeItemIds: ["charge-1"],
        invoiceId: "invoice-residual",
        outcome: "success",
        amountChargedCents: 6_000,
        tender: "CASH",
        replayed: false,
      },
      lines: [{ ...CHARGES[0]!, openCents: 6_000, attributedCents: 4_000 }],
    },
  }, {
    openPrint: (_title, html) => {
      printedHtml = html;
      return true;
    },
  });

  assert.match(printedHtml, /\$60\.00/);
  assert.doesNotMatch(printedHtml, /\$100\.00/);
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
          replayed: false,
        },
        lines: [CHARGES[0]!],
      },
    }, { openPrint: () => false }),
    /browser blocked the receipt print window/i,
  );
});
