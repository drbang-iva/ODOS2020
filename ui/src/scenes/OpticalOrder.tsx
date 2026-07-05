import type { ChargeItem, Invoice, PaymentReconciliation, VisionPrescription } from "@medplum/fhirtypes";
import { useEffect, useState } from "react";
import { RoleSelector } from "../components/RoleSelector";
import { fhir } from "../lib/fhir";
import {
  buildFinancialSummary,
  paymentReconciliationsToTenderLines,
  renderReceiptSheet,
} from "../lib/optical-financial-summary";
import {
  buildLabOrder,
  labOrderToExport,
  renderLabOrderSheet,
  type BuildLabOrderInput,
  type LabOrderFrame,
  type LabOrderRxEye,
} from "../lib/optical-lab-order";
import {
  CHARGE_COLUMNS,
  CHECKOUT_TENDERS,
  OPTICAL_ADJUSTMENTS,
  OPTICAL_ORDER_STATUSES,
  OPTICAL_ORDER_TYPES,
  RX_COLUMNS,
  canTransitionOpticalOrderStatus,
  chargeOpticalCardPayment,
  createOpticalCashOrder,
  invoiceTotalNetCents,
  labOrderFrameFromAttachedFrame,
  loadVisionPrescription,
  transitionOpticalOrderStatus,
  visionPrescriptionRows,
  type AttachedFrame,
  type CheckoutTenderCode,
  type OpticalChargeLineDraft,
  type OpticalOrderStatusCode,
  type OpticalOrderTypeCode,
  type RxDisplayRow,
} from "../lib/optical-order";
import {
  decrementPracticeFrameInventory,
  loadPracticeFrameInventory,
  rankFramePosLookupRows,
  searchFrameCatalog,
  type FramePosLookupMatch,
  type PracticeFrameInventoryItem,
} from "../lib/optical-frames";
import { openPrintWindow } from "../lib/print-window";
import { useRole } from "../lib/role-context";

interface OrderHeaderState {
  staffLocation: string;
  orderStatus: OpticalOrderStatusCode;
  lab: string;
  staff: string;
  orderType: OpticalOrderTypeCode;
  serviceDate: string;
  provider: string;
  diagnosis: string;
  trayNumber: string;
  orderNumber: string;
}

interface ReceiptSourceIds {
  invoiceId: string;
  chargeItemIds: string[];
  paymentKind: "invoice-tender" | "payment-reconciliation";
  paymentReconciliationIds?: string[];
}

type FrameCriteriaKey = "upc" | "barcode" | "designer" | "material" | "category" | "name";

const IVA_LABS = ["Best Price Digital Lab", "Cherry Optical Lab", "Zeiss (VISUSTORE)"] as const;
const LAB_OTHER_OPTION = "Other";
const LAB_ORDER_JOB_TYPES = ["Rx", "Frame To Come", "Frame Only", "Lenses Only"] as const;
const FRAME_SOURCE_OPTIONS: Array<{ value: LabOrderFrame["source"]; label: string }> = [
  { value: "frame-to-come", label: "Frame To Come" },
  { value: "patient-own", label: "Patient Own" },
  { value: "stock", label: "Stock" },
];

interface LabOrderEyeFittingState {
  distPd: string;
  nearPd: string;
  segHeight: string;
}

interface LabOrderCaptureState {
  patientName: string;
  shipTo: string;
  jobType: (typeof LAB_ORDER_JOB_TYPES)[number];
  lensDesign: string;
  lensMaterial: string;
  treatments: string[];
  specialInstructions: string;
  commentsToLab: string;
  lensCpt: string;
  frameSource: LabOrderFrame["source"];
  frameTraceRef: string;
  fitting: {
    od: LabOrderEyeFittingState;
    os: LabOrderEyeFittingState;
  };
}

// Quick-advance walks the corpus happy path (Quote → … → At Lab → Notified → Dispensed).
// Foxfire's Product Pickup tab also offers "Mark As Product Received", but the 17-value order-status
// vocabulary has no "received" state — pickup tracking is a separate Foxfire surface — so ODOS does
// not invent a mapping for it; the free-pick status dropdown covers everything else.
const QUICK_ADVANCE: Array<{ label: string; status: OpticalOrderStatusCode }> = [
  { label: "At Lab", status: "at-lab" },
  { label: "Notified", status: "notified" },
  { label: "Picked Up", status: "dispensed" },
  { label: "Cancelled", status: "cancelled" },
];

export function OpticalOrder() {
  const { role } = useRole();
  const params = new URLSearchParams(window.location.search);
  const [patientReference] = useState(params.get("patient") ?? "");
  const [rxReference] = useState(params.get("rx") ?? "");
  const [encounterReference] = useState(params.get("encounter") ?? "");
  const [header, setHeader] = useState<OrderHeaderState>({
    staffLocation: "",
    orderStatus: "quote",
    lab: "",
    staff: "",
    orderType: "rx",
    serviceDate: new Date().toISOString().slice(0, 10),
    provider: "",
    diagnosis: "",
    trayNumber: "",
    orderNumber: "",
  });
  const [chargeLines, setChargeLines] = useState<OpticalChargeLineDraft[]>([
    newChargeLine("Frame", true),
    newChargeLine("Lenses", false),
  ]);
  const [selectedChargeId, setSelectedChargeId] = useState(chargeLines[0].id);
  const [tender, setTender] = useState<CheckoutTenderCode>("CASH");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [discountMode, setDiscountMode] = useState<"percent" | "amount">("percent");
  const [discountPercent, setDiscountPercent] = useState("20");
  const [discountAmount, setDiscountAmount] = useState("");
  const [adjustmentCode, setAdjustmentCode] = useState("PPAY");
  const [customAdjustmentCode, setCustomAdjustmentCode] = useState("");
  const [labOption, setLabOption] = useState("");
  const [otherLab, setOtherLab] = useState("");
  const [labOrderCapture, setLabOrderCapture] = useState<LabOrderCaptureState>(initialLabOrderCapture());
  const [frameCriteria, setFrameCriteria] = useState<Record<FrameCriteriaKey, string>>({
    upc: "",
    barcode: "",
    designer: "",
    material: "",
    category: "",
    name: "",
  });
  const [frameType, setFrameType] = useState("");
  const [frameMatches, setFrameMatches] = useState<FramePosLookupMatch[]>([]);
  const [inventoryRows, setInventoryRows] = useState<PracticeFrameInventoryItem[]>([]);
  const [visionPrescription, setVisionPrescription] = useState<VisionPrescription | null>(null);
  const [rxRows, setRxRows] = useState<RxDisplayRow[]>(visionPrescriptionRows(null));
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const [receiptSourceIds, setReceiptSourceIds] = useState<ReceiptSourceIds | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selectedCharge = chargeLines.find((line) => line.id === selectedChargeId) ?? chargeLines[0];
  const selectedLines = chargeLines.filter((line) => line.selected);
  const selectedTotalCents = selectedLines.reduce((sum, line) => sum + patientBalanceCents(line), 0);
  const attachedLabFrame = chargeLines.find((line) => line.frame)?.frame;
  const signedVisionPrescription = visionPrescription?.status === "active" ? visionPrescription : null;
  const canPrintLabSheet = Boolean(
    patientReference && signedVisionPrescription && header.lab.trim() && labOrderCapture.patientName.trim(),
  );

  useEffect(() => {
    if (!rxReference) {
      return;
    }
    let cancelled = false;
    loadVisionPrescription(rxReference)
      .then((rx) => {
        if (!cancelled) {
          setVisionPrescription(rx);
          setRxRows(visionPrescriptionRows(rx));
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [rxReference]);

  useEffect(() => {
    let cancelled = false;
    const query = Object.values(frameCriteria).filter(Boolean).join(" ");
    Promise.all([searchFrameCatalog(query), loadPracticeFrameInventory()])
      .then(([catalog, inventory]) => {
        if (cancelled) return;
        setInventoryRows(inventory);
        setFrameMatches(rankFramePosLookupRows(catalog, inventory, query, 12) as FramePosLookupMatch[]);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [frameCriteria]);

  useEffect(() => {
    setPaymentAmount(formatMoneyInput(selectedTotalCents));
  }, [selectedTotalCents]);

  const hasPendingCardPayment = Boolean(
    createdTaskId &&
      receiptSourceIds?.paymentKind === "payment-reconciliation" &&
      !receiptSourceIds.paymentReconciliationIds?.length,
  );
  const canProcessPayment =
    patientReference &&
    rxReference &&
    selectedLines.length > 0 &&
    (!createdTaskId || (tender === "CARD_TERMINAL" && hasPendingCardPayment));
  const canPrintReceipt = Boolean(
    createdTaskId &&
      receiptSourceIds &&
      receiptSourceIds.invoiceId &&
      receiptSourceIds.chargeItemIds.length > 0 &&
      (receiptSourceIds.paymentKind === "invoice-tender" ||
        Boolean(receiptSourceIds.paymentReconciliationIds?.length)),
  );
  const selectedFrameLocked = Boolean(selectedCharge.frame);

  function selectLabOption(option: string) {
    setLabOption(option);
    if (option === LAB_OTHER_OPTION) {
      setHeader((current) => ({ ...current, lab: otherLab }));
      return;
    }
    setOtherLab("");
    setHeader((current) => ({ ...current, lab: option }));
  }

  function changeOtherLab(lab: string) {
    setOtherLab(lab);
    setHeader((current) => ({ ...current, lab }));
  }

  function patchLabOrderCapture(patch: Partial<LabOrderCaptureState>) {
    setLabOrderCapture((current) => ({ ...current, ...patch }));
  }

  function updateTreatment(index: number, value: string) {
    setLabOrderCapture((current) => ({
      ...current,
      treatments: current.treatments.map((treatment, treatmentIndex) =>
        treatmentIndex === index ? value : treatment,
      ),
    }));
  }

  function addTreatment() {
    setLabOrderCapture((current) => ({ ...current, treatments: [...current.treatments, ""] }));
  }

  function removeTreatment(index: number) {
    setLabOrderCapture((current) => ({
      ...current,
      treatments: current.treatments.filter((_, treatmentIndex) => treatmentIndex !== index),
    }));
  }

  function updateFitting(eye: "od" | "os", field: keyof LabOrderEyeFittingState, value: string) {
    setLabOrderCapture((current) => ({
      ...current,
      fitting: {
        ...current.fitting,
        [eye]: { ...current.fitting[eye], [field]: value },
      },
    }));
  }

  async function changeOrderStatus(next: OpticalOrderStatusCode) {
    setError(null);
    if (createdTaskId) {
      if (!canTransitionOpticalOrderStatus(header.orderStatus, next)) {
        setError(`Optical order status "${header.orderStatus}" is terminal.`);
        return;
      }
      await transitionOpticalOrderStatus(createdTaskId, next);
    }
    setHeader((current) => ({ ...current, orderStatus: next }));
  }

  async function processPayment() {
    setError(null);
    setStatus("");
    if (!canProcessPayment) {
      setError("Patient, signed Rx, and selected charge lines are required before payment.");
      return;
    }
    const expectedAmount = formatMoneyInput(selectedTotalCents);
    if (paymentAmount !== expectedAmount) {
      setError(`Payment amount must equal selected patient balance ${expectedAmount}.`);
      return;
    }
    try {
      if (tender === "CARD_TERMINAL") {
        await processCardPayment();
        return;
      }
      const created = await createOpticalCashOrder({
        patientReference,
        visionPrescriptionReference: visionPrescriptionReference(rxReference),
        encounterReference: encounterReference || undefined,
        orderHcpcsCode: primaryOrderCode(selectedLines),
        orderHcpcsDisplay: primaryOrderCode(selectedLines) === "V2020" ? "Frames, purchases" : undefined,
        businessStatus: header.orderStatus,
        orderType: header.orderType,
        charges: selectedLines,
        tender,
      });
      setCreatedTaskId(created.taskId);
      setReceiptSourceIds({
        invoiceId: created.invoiceId,
        chargeItemIds: created.chargeItemIds,
        paymentKind: "invoice-tender",
      });
      setHeader((current) => ({ ...current, orderNumber: created.deviceRequestId }));
      setStatus(`Order ${created.deviceRequestId} paid by ${tender}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function processCardPayment() {
    let order =
      createdTaskId && receiptSourceIds?.paymentKind === "payment-reconciliation"
        ? {
            taskId: createdTaskId,
            invoiceId: receiptSourceIds.invoiceId,
            chargeItemIds: receiptSourceIds.chargeItemIds,
            deviceRequestId: header.orderNumber,
          }
        : null;

    if (!order) {
      const created = await createOpticalCashOrder({
        patientReference,
        visionPrescriptionReference: visionPrescriptionReference(rxReference),
        encounterReference: encounterReference || undefined,
        orderHcpcsCode: primaryOrderCode(selectedLines),
        orderHcpcsDisplay: primaryOrderCode(selectedLines) === "V2020" ? "Frames, purchases" : undefined,
        businessStatus: "waiting-on-payment",
        orderType: header.orderType,
        charges: selectedLines,
      });
      order = created;
      setCreatedTaskId(created.taskId);
      setReceiptSourceIds({
        invoiceId: created.invoiceId,
        chargeItemIds: created.chargeItemIds,
        paymentKind: "payment-reconciliation",
      });
      setHeader((current) => ({ ...current, orderNumber: created.deviceRequestId }));
    }

    const invoice = await fhir.read<Invoice>("Invoice", order.invoiceId);
    const result = await chargeOpticalCardPayment({
      amountCents: invoiceTotalNetCents(invoice),
      patientReference,
      invoiceReference: `Invoice/${order.invoiceId}`,
      taskReference: `Task/${order.taskId}`,
      role,
    });

    if (result.outcome !== "success") {
      setHeader((current) => ({ ...current, orderStatus: "waiting-on-payment" }));
      setError(result.declineReason ?? `Card payment ${result.outcome}.`);
      setStatus(`Order ${order.deviceRequestId || order.taskId} is waiting on payment.`);
      return;
    }

    if (result.paymentRecord?.resourceType !== "PaymentReconciliation" || !result.paymentRecord.id) {
      throw new Error("Card payment succeeded but did not return a PaymentReconciliation id.");
    }

    const paidSources: ReceiptSourceIds = {
      invoiceId: order.invoiceId,
      chargeItemIds: order.chargeItemIds,
      paymentKind: "payment-reconciliation",
      paymentReconciliationIds: [result.paymentRecord.id],
    };
    setReceiptSourceIds(paidSources);

    if (header.orderStatus !== "waiting-on-payment") {
      await transitionOpticalOrderStatus(order.taskId, header.orderStatus);
    }

    const printed = await renderReceiptFromSources(paidSources, false);
    if (!printed) return;
    setStatus(`Order ${order.deviceRequestId || order.taskId} paid by card terminal. Receipt ready.`);
  }

  async function printReceipt() {
    setError(null);
    setStatus("");
    if (!createdTaskId || !receiptSourceIds) {
      setError("A paid order is required before printing a receipt.");
      return;
    }
    try {
      await renderReceiptFromSources(receiptSourceIds, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function renderReceiptFromSources(sourceIds: ReceiptSourceIds, announce: boolean): Promise<boolean> {
    const paymentReconciliationIds = sourceIds.paymentReconciliationIds ?? [];
    const [invoice, chargeItems, paymentReconciliations] = await Promise.all([
      fhir.read<Invoice>("Invoice", sourceIds.invoiceId),
      Promise.all(sourceIds.chargeItemIds.map((id) => fhir.read<ChargeItem>("ChargeItem", id))),
      Promise.all(paymentReconciliationIds.map((id) => fhir.read<PaymentReconciliation>("PaymentReconciliation", id))),
    ]);
    const summary = buildFinancialSummary({
      practiceName: optionalString(header.staffLocation) ?? "Integrated Vision & Aesthetics",
      patientName: labOrderCapture.patientName.trim(),
      patientRef: patientReference || undefined,
      receiptDate: header.serviceDate,
      orderId: header.orderNumber || createdTaskId || sourceIds.invoiceId,
      providerName: optionalString(header.provider),
      invoice,
      chargeItems,
      ...(paymentReconciliations.length
        ? { payments: paymentReconciliationsToTenderLines(paymentReconciliations) }
        : {}),
    });
    const printed = openPrintWindow(`Receipt ${summary.header.orderId}`, renderReceiptSheet(summary));
    if (!printed) {
      setError("The browser blocked the receipt print window.");
      return false;
    }
    if (announce) {
      setStatus(`Receipt ready for order ${summary.header.orderId}.`);
    }
    return true;
  }

  function applyDiscount() {
    const code = (customAdjustmentCode || adjustmentCode).trim();
    if (!code) return;
    setChargeLines((current) =>
      current.map((line) => {
        if (!line.selected) return line;
        const amountCents =
          discountMode === "percent"
            ? Math.round(line.feeCents * (Number(discountPercent) / 100))
            : dollarsToCents(discountAmount);
        return { ...line, discount: { code, amountCents: Math.max(0, amountCents) } };
      }),
    );
  }

  function attachFrame(match: FramePosLookupMatch) {
    if (!selectedCharge || selectedCharge.frame) return;
    const attached = attachedFrameFromMatch(match, frameType);
    setChargeLines((current) =>
      current.map((line) =>
        line.id === selectedCharge.id
          ? {
              ...line,
              procedure: "V2020",
              feeCents: match.inventory?.salePriceCents ?? line.feeCents,
              frame: attached,
            }
          : line,
      ),
    );
  }

  async function dispenseSelectedFrame() {
    if (!selectedCharge.frame?.inventoryId) return;
    const inventory = inventoryRows.find((row) => row.id === selectedCharge.frame?.inventoryId);
    if (!inventory) return;
    const updated = await decrementPracticeFrameInventory(inventory);
    setInventoryRows((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
    setChargeLines((current) =>
      current.map((line) => (line.id === selectedCharge.id ? { ...line, dispensed: true } : line)),
    );
  }

  function assembleLabOrderInput(): BuildLabOrderInput | null {
    setError(null);
    if (!patientReference) {
      setError("Patient is required before printing a lab sheet.");
      return null;
    }
    if (!signedVisionPrescription) {
      setError("An active signed VisionPrescription is required before printing a lab sheet.");
      return null;
    }
    if (!header.lab.trim()) {
      setError("Lab is required before printing a lab sheet.");
      return null;
    }
    if (!labOrderCapture.patientName.trim()) {
      setError("Patient name is required before printing a lab sheet.");
      return null;
    }

    return {
      orderId: header.orderNumber || createdTaskId || `draft-${header.serviceDate}`,
      orderDate: header.serviceDate,
      lab: header.lab.trim(),
      shipTo: optionalString(labOrderCapture.shipTo),
      patientName: labOrderCapture.patientName.trim(),
      patientRef: patientReference,
      providerName: optionalString(header.provider),
      trayNumber: optionalString(header.trayNumber),
      visionPrescription: signedVisionPrescription,
      lensSpec: {
        jobType: labOrderCapture.jobType,
        lensDesign: labOrderCapture.lensDesign.trim(),
        lensMaterial: labOrderCapture.lensMaterial.trim(),
        treatments: labOrderCapture.treatments.map((treatment) => treatment.trim()).filter(Boolean),
        specialInstructions: optionalString(labOrderCapture.specialInstructions),
        commentsToLab: optionalString(labOrderCapture.commentsToLab),
      },
      fitting: {
        od: fittingEye(labOrderCapture.fitting.od),
        os: fittingEye(labOrderCapture.fitting.os),
      },
      frame: labOrderFrameFromAttachedFrame(attachedLabFrame, labOrderCapture.frameSource),
      lensCpt: optionalString(labOrderCapture.lensCpt),
      frameTraceRef: optionalString(labOrderCapture.frameTraceRef),
    };
  }

  function printLabSheet() {
    const input = assembleLabOrderInput();
    if (!input) return;
    const order = buildLabOrder(input);
    const html = renderLabOrderSheet(order);
    const printed = openPrintWindow(`Lab Order ${input.orderId}`, html);
    if (!printed) {
      setError("The browser blocked the lab sheet print window.");
      return;
    }
    setStatus(`Lab sheet ready for ${input.lab}.`);
  }

  function downloadLabOrderJson() {
    const input = assembleLabOrderInput();
    if (!input) return;
    const order = buildLabOrder(input);
    const blob = new Blob([JSON.stringify(labOrderToExport(order), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFilename(input.orderId)}-lab-order.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setStatus(`Lab order JSON downloaded for ${input.lab}.`);
  }

  return (
    <div className="min-h-screen bg-bg-deep text-white">
      <div className="mx-auto flex max-w-[1800px] flex-col gap-4 px-4 py-4">
        <HeaderFields
          header={header}
          orderCreated={Boolean(createdTaskId)}
          labOption={labOption}
          otherLab={otherLab}
          onChange={setHeader}
          onLabOptionChange={selectLabOption}
          onOtherLabChange={changeOtherLab}
          onStatusChange={(next) => void changeOrderStatus(next)}
        />

        <section className="overflow-hidden rounded border border-white/10">
          <div className="border-b border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-semibold">
            Rx Information
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-[1800px] border-collapse text-left text-xs">
              <thead className="bg-white/[0.03] text-white/55">
                <tr>
                  {RX_COLUMNS.map((column) => (
                    <th key={column} className="border-r border-white/10 px-2 py-2 last:border-r-0">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rxRows.map((row) => (
                  <tr key={row.eye} className="border-t border-white/10 text-white/80">
                    {RX_COLUMNS.map((column) => (
                      <td key={`${row.eye}-${column}`} className="border-r border-white/10 px-2 py-2 last:border-r-0">
                        {row.values[column]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(420px,0.65fr)]">
          <section className="overflow-hidden rounded border border-white/10">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[0.04] px-3 py-2">
              <div className="text-sm font-semibold">Charge And Payment</div>
              <button className="sidebar-button" onClick={() => setChargeLines((lines) => [...lines, newChargeLine("Procedure", false)])}>
                Add Line
              </button>
            </div>
            <ChargeTable
              lines={chargeLines}
              selectedChargeId={selectedChargeId}
              onSelectCharge={setSelectedChargeId}
              onChange={setChargeLines}
            />
          </section>

          <div className="grid gap-4">
            <PaymentPanel
              tender={tender}
              paymentAmount={paymentAmount}
              selectedTotalCents={selectedTotalCents}
              canProcessPayment={Boolean(canProcessPayment)}
              canPrintReceipt={canPrintReceipt}
              onTenderChange={setTender}
              onAmountChange={setPaymentAmount}
              onProcess={() => void processPayment()}
              onPrintReceipt={() => void printReceipt()}
            />
            <DiscountPanel
              mode={discountMode}
              percent={discountPercent}
              amount={discountAmount}
              adjustmentCode={adjustmentCode}
              customAdjustmentCode={customAdjustmentCode}
              onModeChange={setDiscountMode}
              onPercentChange={setDiscountPercent}
              onAmountChange={setDiscountAmount}
              onAdjustmentCodeChange={setAdjustmentCode}
              onCustomAdjustmentCodeChange={setCustomAdjustmentCode}
              onApply={applyDiscount}
            />
            <LabOrderPanel
              header={header}
              patientReference={patientReference}
              activeRxLoaded={Boolean(signedVisionPrescription)}
              attachedFrame={attachedLabFrame}
              capture={labOrderCapture}
              canPrint={canPrintLabSheet}
              onHeaderChange={setHeader}
              onCapturePatch={patchLabOrderCapture}
              onTreatmentChange={updateTreatment}
              onAddTreatment={addTreatment}
              onRemoveTreatment={removeTreatment}
              onFittingChange={updateFitting}
              onPrint={printLabSheet}
              onDownload={downloadLabOrderJson}
            />
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
          <FrameAttachPanel
            criteria={frameCriteria}
            frameType={frameType}
            matches={frameMatches}
            locked={selectedFrameLocked}
            selectedCharge={selectedCharge}
            onCriteriaChange={setFrameCriteria}
            onFrameTypeChange={setFrameType}
            onAttach={attachFrame}
            onUnattach={() =>
              setChargeLines((lines) =>
                lines.map((line) =>
                  line.id === selectedCharge.id ? { ...line, frame: undefined, dispensed: false } : line,
                ),
              )
            }
            onDispense={() => void dispenseSelectedFrame()}
          />
          <QuickAdvancePanel
            currentStatus={header.orderStatus}
            disabled={!createdTaskId}
            onAdvance={(next) => void changeOrderStatus(next)}
          />
        </div>

        {error ? <div className="rounded border border-red-500/50 bg-red-950/30 p-3 text-sm text-red-100">{error}</div> : null}
        {status ? <div className="rounded border border-emerald-500/40 bg-emerald-950/20 p-3 text-sm text-emerald-100">{status}</div> : null}
      </div>
    </div>
  );
}

function HeaderFields({
  header,
  orderCreated,
  labOption,
  otherLab,
  onChange,
  onLabOptionChange,
  onOtherLabChange,
  onStatusChange,
}: {
  header: OrderHeaderState;
  orderCreated: boolean;
  labOption: string;
  otherLab: string;
  onChange: (next: OrderHeaderState) => void;
  onLabOptionChange: (next: string) => void;
  onOtherLabChange: (next: string) => void;
  onStatusChange: (next: OpticalOrderStatusCode) => void;
}) {
  return (
    <section className="rounded border border-white/10">
      <div className="grid gap-3 p-3 md:grid-cols-5 xl:grid-cols-10">
        <Field label="Staff Location" value={header.staffLocation} onChange={(staffLocation) => onChange({ ...header, staffLocation })} />
        <div className="flex items-end">
          <RoleSelector />
        </div>
        <label className="grid gap-1 text-xs text-white/60">
          <span>Order Status</span>
          <select
            className="sidebar-input"
            value={header.orderStatus}
            onChange={(event) => onStatusChange(event.target.value as OpticalOrderStatusCode)}
          >
            {OPTICAL_ORDER_STATUSES.map((status) => (
              <option key={status.code} value={status.code}>
                {status.display}
              </option>
            ))}
          </select>
        </label>
        <LabSelect
          labOption={labOption}
          otherLab={otherLab}
          onLabOptionChange={onLabOptionChange}
          onOtherLabChange={onOtherLabChange}
        />
        <Field label="Staff" value={header.staff} onChange={(staff) => onChange({ ...header, staff })} />
        <label className="grid gap-1 text-xs text-white/60">
          <span>Order Type</span>
          <select
            className="sidebar-input disabled:text-white/40"
            value={header.orderType}
            disabled={orderCreated}
            onChange={(event) => onChange({ ...header, orderType: event.target.value as OpticalOrderTypeCode })}
          >
            {OPTICAL_ORDER_TYPES.map((type) => (
              <option key={type.code} value={type.code}>
                {type.display}
              </option>
            ))}
          </select>
        </label>
        <Field label="Service Date" type="date" value={header.serviceDate} onChange={(serviceDate) => onChange({ ...header, serviceDate })} />
        <Field label="Provider" value={header.provider} onChange={(provider) => onChange({ ...header, provider })} />
        <Field label="Diagnosis" value={header.diagnosis} onChange={(diagnosis) => onChange({ ...header, diagnosis })} />
        <Field label="Tray #" value={header.trayNumber} onChange={(trayNumber) => onChange({ ...header, trayNumber })} />
        <Field label="Order #" value={header.orderNumber} readOnly onChange={() => undefined} />
      </div>
    </section>
  );
}

function LabSelect({
  labOption,
  otherLab,
  onLabOptionChange,
  onOtherLabChange,
}: {
  labOption: string;
  otherLab: string;
  onLabOptionChange: (next: string) => void;
  onOtherLabChange: (next: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs text-white/60">
      <span>Lab</span>
      <select className="sidebar-input" value={labOption} onChange={(event) => onLabOptionChange(event.target.value)}>
        <option value="">Select lab</option>
        {IVA_LABS.map((lab) => (
          <option key={lab} value={lab}>
            {lab}
          </option>
        ))}
        <option value={LAB_OTHER_OPTION}>{LAB_OTHER_OPTION}</option>
      </select>
      {labOption === LAB_OTHER_OPTION ? (
        <input
          className="sidebar-input"
          value={otherLab}
          onChange={(event) => onOtherLabChange(event.target.value)}
        />
      ) : null}
    </label>
  );
}

function ChargeTable({
  lines,
  selectedChargeId,
  onSelectCharge,
  onChange,
}: {
  lines: OpticalChargeLineDraft[];
  selectedChargeId: string;
  onSelectCharge: (id: string) => void;
  onChange: (lines: OpticalChargeLineDraft[]) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-[1500px] table-fixed border-collapse text-left text-xs">
        <thead className="bg-white/[0.03] text-white/55">
          <tr>
            {CHARGE_COLUMNS.map((column) => (
              <th key={column} className="border-r border-white/10 px-2 py-2 last:border-r-0">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr
              key={line.id}
              className={`border-t border-white/10 ${selectedChargeId === line.id ? "bg-brand/10" : ""} ${line.dispensed ? "text-emerald-200" : "text-white/80"}`}
              onClick={() => onSelectCharge(line.id)}
            >
              <td className="border-r border-white/10 px-2 py-2">
                <input
                  className="sidebar-input h-8 w-full"
                  value={line.procedure}
                  onChange={(event) => onChange(updateLine(lines, line.id, { procedure: event.target.value }))}
                />
              </td>
              <td className="border-r border-white/10 px-2 py-2">
                <input
                  className="sidebar-input h-8 w-full"
                  value={line.modifier}
                  onChange={(event) => onChange(updateLine(lines, line.id, { modifier: event.target.value }))}
                />
              </td>
              <td className="border-r border-white/10 px-2 py-2">
                <input
                  className="sidebar-input h-8 w-full"
                  value={line.diagnosis}
                  onChange={(event) => onChange(updateLine(lines, line.id, { diagnosis: event.target.value }))}
                />
              </td>
              <DisabledCell value="" />
              <DisabledCell value="" />
              <td className="border-r border-white/10 px-2 py-2">
                <input
                  className="sidebar-input h-8 w-full"
                  type="number"
                  min="1"
                  value={line.units}
                  onChange={(event) => onChange(updateLine(lines, line.id, { units: Number(event.target.value) || 1 }))}
                />
              </td>
              <td className="border-r border-white/10 px-2 py-2">
                <input
                  className="sidebar-input h-8 w-full"
                  value={formatMoneyInput(line.feeCents)}
                  onChange={(event) => onChange(updateLine(lines, line.id, { feeCents: dollarsToCents(event.target.value) }))}
                />
              </td>
              <DisabledCell value="$0.00" />
              <td className="border-r border-white/10 px-2 py-2">
                <input
                  className="sidebar-input h-8 w-full"
                  value={formatMoneyInput(line.taxCents)}
                  onChange={(event) => onChange(updateLine(lines, line.id, { taxCents: dollarsToCents(event.target.value) }))}
                />
              </td>
              <ReadCell value={formatMoneyInput(patientBalanceCents(line))} />
              <ReadCell value="P" />
              <ReadCell value={formatMoneyInput(patientBalanceCents(line))} />
              <DisabledCell value="$0.00" />
              <td className="border-r border-white/10 px-2 py-2">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={line.selected}
                    onChange={(event) => onChange(updateLine(lines, line.id, { selected: event.target.checked }))}
                  />
                  <input
                    type="checkbox"
                    checked={line.taxable}
                    onChange={(event) => onChange(updateLine(lines, line.id, { taxable: event.target.checked }))}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PaymentPanel({
  tender,
  paymentAmount,
  selectedTotalCents,
  canProcessPayment,
  canPrintReceipt,
  onTenderChange,
  onAmountChange,
  onProcess,
  onPrintReceipt,
}: {
  tender: CheckoutTenderCode;
  paymentAmount: string;
  selectedTotalCents: number;
  canProcessPayment: boolean;
  canPrintReceipt: boolean;
  onTenderChange: (tender: CheckoutTenderCode) => void;
  onAmountChange: (amount: string) => void;
  onProcess: () => void;
  onPrintReceipt: () => void;
}) {
  return (
    <section className="rounded border border-white/10 p-3">
      <div className="grid gap-3 md:grid-cols-3">
        <label className="grid gap-1 text-xs text-white/60">
          <span>Tender</span>
          <select className="sidebar-input" value={tender} onChange={(event) => onTenderChange(event.target.value as CheckoutTenderCode)}>
            {CHECKOUT_TENDERS.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.display}
              </option>
            ))}
          </select>
        </label>
        <Field label="Amount" value={paymentAmount} onChange={onAmountChange} />
        <label className="grid gap-1 text-xs text-white/60">
          <span>Selected Balance</span>
          <input className="sidebar-input text-white/50" value={formatMoneyInput(selectedTotalCents)} readOnly />
        </label>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <button className="sidebar-button" disabled={!canProcessPayment} onClick={onProcess}>
          Process Payment
        </button>
        <button className="sidebar-button" disabled={!canPrintReceipt} onClick={onPrintReceipt}>
          Print Receipt
        </button>
      </div>
    </section>
  );
}

function DiscountPanel({
  mode,
  percent,
  amount,
  adjustmentCode,
  customAdjustmentCode,
  onModeChange,
  onPercentChange,
  onAmountChange,
  onAdjustmentCodeChange,
  onCustomAdjustmentCodeChange,
  onApply,
}: {
  mode: "percent" | "amount";
  percent: string;
  amount: string;
  adjustmentCode: string;
  customAdjustmentCode: string;
  onModeChange: (mode: "percent" | "amount") => void;
  onPercentChange: (value: string) => void;
  onAmountChange: (value: string) => void;
  onAdjustmentCodeChange: (value: string) => void;
  onCustomAdjustmentCodeChange: (value: string) => void;
  onApply: () => void;
}) {
  return (
    <section className="rounded border border-white/10 p-3">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex items-center gap-2 text-xs text-white/70">
          <input type="radio" checked={mode === "percent"} onChange={() => onModeChange("percent")} />
          Percent To Selected Item
        </label>
        <label className="flex items-center gap-2 text-xs text-white/70">
          <input type="radio" checked={mode === "amount"} onChange={() => onModeChange("amount")} />
          Amount To Apply
        </label>
        <Field label="Percent To Selected Item" value={percent} disabled={mode !== "percent"} onChange={onPercentChange} />
        <Field label="Amount To Apply" value={amount} disabled={mode !== "amount"} onChange={onAmountChange} />
        <label className="grid gap-1 text-xs text-white/60">
          <span>Adjustment Code</span>
          <select className="sidebar-input" value={adjustmentCode} onChange={(event) => onAdjustmentCodeChange(event.target.value)}>
            {OPTICAL_ADJUSTMENTS.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.code} - {entry.display}
              </option>
            ))}
          </select>
        </label>
        <Field label="Adjustment Code" value={customAdjustmentCode} onChange={onCustomAdjustmentCodeChange} />
      </div>
      <button className="sidebar-button mt-3 w-full" onClick={onApply}>
        Apply
      </button>
    </section>
  );
}

function LabOrderPanel({
  header,
  patientReference,
  activeRxLoaded,
  attachedFrame,
  capture,
  canPrint,
  onHeaderChange,
  onCapturePatch,
  onTreatmentChange,
  onAddTreatment,
  onRemoveTreatment,
  onFittingChange,
  onPrint,
  onDownload,
}: {
  header: OrderHeaderState;
  patientReference: string;
  activeRxLoaded: boolean;
  attachedFrame: AttachedFrame | undefined;
  capture: LabOrderCaptureState;
  canPrint: boolean;
  onHeaderChange: (next: OrderHeaderState) => void;
  onCapturePatch: (patch: Partial<LabOrderCaptureState>) => void;
  onTreatmentChange: (index: number, value: string) => void;
  onAddTreatment: () => void;
  onRemoveTreatment: (index: number) => void;
  onFittingChange: (eye: "od" | "os", field: keyof LabOrderEyeFittingState, value: string) => void;
  onPrint: () => void;
  onDownload: () => void;
}) {
  return (
    <section className="rounded border border-white/10 p-3">
      <div className="mb-3 text-sm font-semibold">Lab Sheet</div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Patient Name" value={capture.patientName} onChange={(patientName) => onCapturePatch({ patientName })} />
        <Field label="Patient Ref" value={patientReference} readOnly onChange={() => undefined} />
        <Field label="Ship To" value={capture.shipTo} onChange={(shipTo) => onCapturePatch({ shipTo })} />
        <Field label="Provider" value={header.provider} onChange={(provider) => onHeaderChange({ ...header, provider })} />
        <Field label="Tray #" value={header.trayNumber} onChange={(trayNumber) => onHeaderChange({ ...header, trayNumber })} />
        <Field label="Lens CPT" value={capture.lensCpt} onChange={(lensCpt) => onCapturePatch({ lensCpt })} />
        <label className="grid gap-1 text-xs text-white/60">
          <span>Job Type</span>
          <select
            className="sidebar-input"
            value={capture.jobType}
            onChange={(event) => onCapturePatch({ jobType: event.target.value as LabOrderCaptureState["jobType"] })}
          >
            {LAB_ORDER_JOB_TYPES.map((jobType) => (
              <option key={jobType} value={jobType}>
                {jobType}
              </option>
            ))}
          </select>
        </label>
        <Field label="Lens Design" value={capture.lensDesign} onChange={(lensDesign) => onCapturePatch({ lensDesign })} />
        <Field label="Lens Material" value={capture.lensMaterial} onChange={(lensMaterial) => onCapturePatch({ lensMaterial })} />
        <label className="grid gap-1 text-xs text-white/60">
          <span>Frame Source</span>
          <select
            className="sidebar-input"
            value={capture.frameSource}
            onChange={(event) => onCapturePatch({ frameSource: event.target.value as LabOrderFrame["source"] })}
          >
            {FRAME_SOURCE_OPTIONS.map((source) => (
              <option key={source.value} value={source.value}>
                {source.label}
              </option>
            ))}
          </select>
        </label>
        <Field label="Frame Trace Ref" value={capture.frameTraceRef} onChange={(frameTraceRef) => onCapturePatch({ frameTraceRef })} />
        <Field label="Active Rx" value={activeRxLoaded ? "Loaded" : ""} readOnly onChange={() => undefined} />
        <Field label="Attached Frame" value={attachedFrame ? attachedFrame.model : ""} readOnly onChange={() => undefined} />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <TextAreaField
          label="Special Instructions"
          value={capture.specialInstructions}
          onChange={(specialInstructions) => onCapturePatch({ specialInstructions })}
        />
        <TextAreaField
          label="Comments To Lab"
          value={capture.commentsToLab}
          onChange={(commentsToLab) => onCapturePatch({ commentsToLab })}
        />
      </div>

      <div className="mt-3 rounded border border-white/10 p-2">
        <div className="mb-2 text-xs font-semibold text-white/70">Treatments</div>
        <div className="grid gap-2">
          {capture.treatments.map((treatment, index) => (
            <div key={index} className="grid grid-cols-[minmax(0,1fr)_92px] gap-2">
              <input
                className="sidebar-input"
                value={treatment}
                onChange={(event) => onTreatmentChange(index, event.target.value)}
              />
              <button className="sidebar-button py-1" onClick={() => onRemoveTreatment(index)}>
                Remove
              </button>
            </div>
          ))}
        </div>
        <button className="sidebar-button mt-2 w-full" onClick={onAddTreatment}>
          Add Treatment
        </button>
      </div>

      <div className="mt-3 rounded border border-white/10 p-2">
        <div className="mb-2 text-xs font-semibold text-white/70">Fitting Measurements</div>
        <div className="grid gap-3 md:grid-cols-2">
          <FittingEyeFields eye="OD" values={capture.fitting.od} onChange={(field, value) => onFittingChange("od", field, value)} />
          <FittingEyeFields eye="OS" values={capture.fitting.os} onChange={(field, value) => onFittingChange("os", field, value)} />
        </div>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <button className="sidebar-button" disabled={!canPrint} onClick={onPrint}>
          Print Lab Sheet
        </button>
        <button className="sidebar-button" disabled={!canPrint} onClick={onDownload}>
          Download Order (JSON)
        </button>
      </div>
    </section>
  );
}

function FittingEyeFields({
  eye,
  values,
  onChange,
}: {
  eye: "OD" | "OS";
  values: LabOrderEyeFittingState;
  onChange: (field: keyof LabOrderEyeFittingState, value: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <div className="text-xs font-semibold text-white/70">{eye}</div>
      <Field label="Dist PD" type="number" value={values.distPd} onChange={(value) => onChange("distPd", value)} />
      <Field label="Near PD" type="number" value={values.nearPd} onChange={(value) => onChange("nearPd", value)} />
      <Field label="Seg Height" type="number" value={values.segHeight} onChange={(value) => onChange("segHeight", value)} />
    </div>
  );
}

function FrameAttachPanel({
  criteria,
  frameType,
  matches,
  locked,
  selectedCharge,
  onCriteriaChange,
  onFrameTypeChange,
  onAttach,
  onUnattach,
  onDispense,
}: {
  criteria: Record<FrameCriteriaKey, string>;
  frameType: string;
  matches: FramePosLookupMatch[];
  locked: boolean;
  selectedCharge: OpticalChargeLineDraft;
  onCriteriaChange: (criteria: Record<FrameCriteriaKey, string>) => void;
  onFrameTypeChange: (frameType: string) => void;
  onAttach: (match: FramePosLookupMatch) => void;
  onUnattach: () => void;
  onDispense: () => void;
}) {
  return (
    <section className="overflow-hidden rounded border border-white/10">
      <div className="border-b border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-semibold">Frame Attach</div>
      <div className="grid gap-3 p-3 md:grid-cols-7">
        {(["upc", "barcode", "designer", "material", "category", "name"] as FrameCriteriaKey[]).map((key) => (
          <Field
            key={key}
            label={criteriaLabel(key)}
            value={criteria[key]}
            disabled={locked}
            onChange={(value) => onCriteriaChange({ ...criteria, [key]: value })}
          />
        ))}
        <Field label="Frame Type" value={frameType} disabled={locked} onChange={onFrameTypeChange} />
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-[1100px] table-fixed text-left text-xs">
          <thead className="bg-white/[0.03] text-white/55">
            <tr>
              {["UPC", "Name", "Designer", "Color Code", "Eye", "Temple", "Bridge", "On Hand", ""].map((column) => (
                <th key={column} className="border-r border-white/10 px-2 py-2 last:border-r-0">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matches.map((match) => (
              <tr key={match.catalog.canonicalUrl} className="border-t border-white/10 text-white/80">
                <ReadCell value={match.catalog.gtin14 ?? ""} />
                <ReadCell value={match.catalog.display} />
                <ReadCell value={match.catalog.manufacturer} />
                <ReadCell value={match.catalog.properties.color ?? ""} />
                <ReadCell value={match.catalog.properties.eyesize ?? ""} />
                <ReadCell value={match.catalog.properties.temple ?? ""} />
                <ReadCell value={match.catalog.properties.dbl ?? ""} />
                <ReadCell value={String(match.inventory?.qtyOnHand ?? 0)} />
                <td className="border-r border-white/10 px-2 py-2">
                  <button className="sidebar-button h-8 w-full py-1" disabled={locked} onClick={() => onAttach(match)}>
                    Attach
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selectedCharge.frame ? (
        <AttachedFramePanel frame={selectedCharge.frame} dispensed={Boolean(selectedCharge.dispensed)} onUnattach={onUnattach} onDispense={onDispense} />
      ) : null}
    </section>
  );
}

function AttachedFramePanel({
  frame,
  dispensed,
  onUnattach,
  onDispense,
}: {
  frame: AttachedFrame;
  dispensed: boolean;
  onUnattach: () => void;
  onDispense: () => void;
}) {
  const fields: Array<[string, string]> = [
    ["Brand", frame.brand],
    ["CPT V2020", "V2020"],
    ["Model", frame.model],
    ["Color", frame.color],
    ["Eye", frame.eye],
    ["Bridge", frame.bridge],
    ["A", frame.a],
    ["B", frame.b],
    ["ED", frame.ed],
    ["DBL", frame.dbl],
    ["Temple", frame.temple],
    ["Frame Type", frame.frameType],
  ];
  return (
    <div className={`border-t border-white/10 p-3 ${dispensed ? "bg-emerald-950/20" : ""}`}>
      <div className="grid gap-2 md:grid-cols-6">
        {fields.map(([label, value]) => (
          <label key={label} className="grid gap-1 text-xs text-white/60">
            <span>{label}</span>
            <input className="sidebar-input text-white/50" value={value} readOnly />
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="sidebar-button" onClick={onUnattach}>
          Unattach Frame
        </button>
        <button className="sidebar-button" disabled={dispensed || !frame.inventoryId} onClick={onDispense}>
          Dispense
        </button>
      </div>
    </div>
  );
}

function QuickAdvancePanel({
  currentStatus,
  disabled,
  onAdvance,
}: {
  currentStatus: OpticalOrderStatusCode;
  disabled: boolean;
  onAdvance: (next: OpticalOrderStatusCode) => void;
}) {
  return (
    <section className="rounded border border-white/10 p-3">
      <div className="grid grid-cols-2 gap-2">
        {QUICK_ADVANCE.map((action) => (
          <button
            key={action.label}
            className="sidebar-button"
            disabled={disabled || !canTransitionOpticalOrderStatus(currentStatus, action.status)}
            onClick={() => onAdvance(action.status)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function Field({
  label,
  value,
  type = "text",
  readOnly = false,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  type?: string;
  readOnly?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs text-white/60">
      <span>{label}</span>
      <input
        className="sidebar-input disabled:text-white/40"
        type={type}
        value={value}
        readOnly={readOnly}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs text-white/60">
      <span>{label}</span>
      <textarea
        className="sidebar-input min-h-20 resize-y"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function DisabledCell({ value }: { value: string }) {
  return (
    <td className="border-r border-white/10 bg-white/[0.03] px-2 py-2 text-white/35">
      {value}
    </td>
  );
}

function ReadCell({ value }: { value: string }) {
  return <td className="border-r border-white/10 px-2 py-2">{value}</td>;
}

function newChargeLine(procedure: string, selected: boolean): OpticalChargeLineDraft {
  return {
    id: crypto.randomUUID(),
    procedure,
    modifier: "",
    diagnosis: "",
    units: 1,
    feeCents: 0,
    taxCents: 0,
    selected,
    taxable: false,
  };
}

function updateLine(
  lines: OpticalChargeLineDraft[],
  id: string,
  patch: Partial<OpticalChargeLineDraft>,
): OpticalChargeLineDraft[] {
  return lines.map((line) => (line.id === id ? { ...line, ...patch } : line));
}

function patientBalanceCents(line: OpticalChargeLineDraft): number {
  return Math.max(0, line.feeCents + line.taxCents - (line.discount?.amountCents ?? 0));
}

function primaryOrderCode(lines: OpticalChargeLineDraft[]): string {
  return lines.find((line) => line.frame)?.procedure || lines[0]?.procedure || "V2020";
}

function visionPrescriptionReference(reference: string): string {
  return reference.startsWith("VisionPrescription/") ? reference : `VisionPrescription/${reference}`;
}

function attachedFrameFromMatch(match: FramePosLookupMatch, frameType: string): AttachedFrame {
  const properties = match.catalog.properties;
  return {
    inventoryId: match.inventory?.id,
    canonicalUrl: match.catalog.canonicalUrl,
    upc: match.catalog.gtin14 ?? "",
    brand: match.catalog.manufacturer,
    model: match.catalog.display,
    color: properties.color ?? "",
    eye: properties.eyesize ?? "",
    bridge: properties.dbl ?? "",
    a: properties.eyesize ?? "",
    b: properties["b-measurement"] ?? "",
    ed: properties.ed ?? "",
    dbl: properties.dbl ?? "",
    temple: properties.temple ?? "",
    frameType,
  };
}

function criteriaLabel(key: FrameCriteriaKey): string {
  return {
    upc: "UPC",
    barcode: "Barcode",
    designer: "Designer",
    material: "Material",
    category: "Category",
    name: "Name",
  }[key];
}

function dollarsToCents(value: string): number {
  const parsed = Number(value.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function formatMoneyInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

function initialLabOrderCapture(): LabOrderCaptureState {
  return {
    patientName: "",
    shipTo: "",
    jobType: "Rx",
    lensDesign: "",
    lensMaterial: "",
    treatments: [""],
    specialInstructions: "",
    commentsToLab: "",
    lensCpt: "",
    frameSource: "stock",
    frameTraceRef: "",
    fitting: {
      od: emptyFittingEye(),
      os: emptyFittingEye(),
    },
  };
}

function emptyFittingEye(): LabOrderEyeFittingState {
  return { distPd: "", nearPd: "", segHeight: "" };
}

function optionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function fittingEye(values: LabOrderEyeFittingState): Pick<LabOrderRxEye, "distPd" | "nearPd" | "segHeight"> {
  const result: Pick<LabOrderRxEye, "distPd" | "nearPd" | "segHeight"> = {};
  const distPd = optionalNumber(values.distPd);
  const nearPd = optionalNumber(values.nearPd);
  const segHeight = optionalNumber(values.segHeight);
  if (distPd !== undefined) result.distPd = distPd;
  if (nearPd !== undefined) result.nearPd = nearPd;
  if (segHeight !== undefined) result.segHeight = segHeight;
  return result;
}

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "lab-order";
}
