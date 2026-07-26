import type { Coverage, CoverageEligibilityResponse, VisionPrescription } from "@medplum/fhirtypes";
import { useEffect, useMemo, useState } from "react";
import { CollectPanel } from "../components/CollectPanel";
import {
  AttachedLensPanel,
  LensesOrderSurface,
  type LensesOrderSurfaceProps,
} from "../components/LensesOrderSurface";
import type { OpenChargeLine, OpticalCollectionOrder } from "../lib/collect";
import {
  buildLabOrder,
  labOrderToExport,
  renderLabOrderSheet,
  type BuildLabOrderInput,
  type LabOrderFrame,
  type LabOrderFrameOwnership,
  type LabOrderFrameSource,
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
  labOrderFrameFromAttachedFrame,
  loadConfiguredPaymentMethods,
  loadVisionPrescription,
  opticalCollectionChargeFromDraft,
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
  dispenseFrameInventoryUnit,
  frameInventoryUnitStatusLabel,
  frameSourceUsesPracticeInventory,
  loadPracticeFrameInventoryUnits,
  loadPracticeFrameVariantSettings,
  rankFramePosLookupRows,
  searchFrameCatalog,
  summarizeInventoryByVariant,
  transitionFrameInventoryUnitStatus,
  type FramePosLookupMatch,
  type FrameCatalogItem,
  type FrameInventoryUnitStatus,
  type PracticeFrameInventoryUnit,
  type PracticeFrameVariantSettings,
} from "../lib/optical-frames";
import { openPrintWindow } from "../lib/print-window";
import { advanceLabOrderTransport, cancelLabOrder, submitLabOrder } from "../lib/lab-order-transport";
import { commitLensSelection, unattachLensSelection, type LensSelection } from "../lib/lens-selection";
import {
  fetchPatientInsurance,
  fetchVisionBenefits,
  hasActiveApplicableBenefit,
} from "../lib/patient-insurance";
import { fhir } from "../lib/fhir";

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

type FrameCriteriaKey = "upc" | "barcode" | "designer" | "material" | "category" | "name";

const IVA_LABS = ["Best Price Digital Lab", "Cherry Optical Lab", "Zeiss (VISUSTORE)"] as const;
const LAB_OTHER_OPTION = "Other";
const LAB_ORDER_JOB_TYPES = ["Rx", "Frame To Come", "Frame Only", "Lenses Only"] as const;
const FRAME_SOURCE_OPTIONS: Array<{ value: LabOrderFrameSource; label: string }> = [
  { value: 0, label: "0 — Lenses Only" },
  { value: 1, label: "1 — Lab supply" },
  { value: 3, label: "3 — Frame-to-come" },
  { value: 4, label: "4 — Frame enclosed" },
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
  frameSource: LabOrderFrameSource;
  frameOwnership?: LabOrderFrameOwnership;
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

interface OpticalOrderProps {
  search?: string;
  initialVisionPrescription?: VisionPrescription;
  api?: {
    fetchPatientInsurance?: typeof fetchPatientInsurance;
    fetchVisionBenefits?: typeof fetchVisionBenefits;
    searchFrameCatalog?: typeof searchFrameCatalog;
    loadPracticeFrameInventoryUnits?: typeof loadPracticeFrameInventoryUnits;
    loadPracticeFrameVariantSettings?: typeof loadPracticeFrameVariantSettings;
    dispenseFrameInventoryUnit?: (unitId: string) => Promise<PracticeFrameInventoryUnit>;
    transitionFrameInventoryUnitStatus?: (
      unitId: string,
      fromStatuses: FrameInventoryUnitStatus | readonly FrameInventoryUnitStatus[],
      toStatus: FrameInventoryUnitStatus,
    ) => Promise<PracticeFrameInventoryUnit>;
  };
  lensCatalog?: Pick<LensesOrderSurfaceProps, "products" | "coatings" | "modifiers" | "resolver">;
}

export function OpticalOrder({
  search = window.location.search,
  initialVisionPrescription,
  api,
  lensCatalog,
}: OpticalOrderProps = {}) {
  const params = new URLSearchParams(search);
  const fetchInsurance = api?.fetchPatientInsurance ?? fetchPatientInsurance;
  const fetchBenefits = api?.fetchVisionBenefits ?? fetchVisionBenefits;
  const searchFrames = api?.searchFrameCatalog ?? searchFrameCatalog;
  const loadFrameInventoryUnits = api?.loadPracticeFrameInventoryUnits ?? loadPracticeFrameInventoryUnits;
  const loadFrameVariantSettings = api?.loadPracticeFrameVariantSettings ?? loadPracticeFrameVariantSettings;
  const dispenseFrameUnit = api?.dispenseFrameInventoryUnit ?? ((unitId: string) =>
    dispenseFrameInventoryUnit(unitId, actingPractitionerId()));
  const transitionFrameUnit = api?.transitionFrameInventoryUnitStatus ?? ((
    unitId: string,
    fromStatuses: FrameInventoryUnitStatus | readonly FrameInventoryUnitStatus[],
    toStatus: FrameInventoryUnitStatus,
  ) => transitionFrameInventoryUnitStatus(unitId, fromStatuses, toStatus, actingPractitionerId()));
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
  const [frameCatalogRows, setFrameCatalogRows] = useState<FrameCatalogItem[]>([]);
  const [frameInventoryUnits, setFrameInventoryUnits] = useState<PracticeFrameInventoryUnit[]>([]);
  const [frameVariantSettings, setFrameVariantSettings] = useState<PracticeFrameVariantSettings[]>([]);
  const [skippedFrameUnitCount, setSkippedFrameUnitCount] = useState(0);
  const [frameDispenseBusy, setFrameDispenseBusy] = useState(false);
  const [visionPrescription, setVisionPrescription] = useState<VisionPrescription | null>(initialVisionPrescription ?? null);
  const [insuranceContext, setInsuranceContext] = useState<{
    coverages: Coverage[];
    responses: CoverageEligibilityResponse[];
  }>({ coverages: [], responses: [] });
  const [rxRows, setRxRows] = useState<RxDisplayRow[]>(visionPrescriptionRows(initialVisionPrescription ?? null));
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const [labOrderReference, setLabOrderReference] = useState<string | null>(null);
  const [labTransportState, setLabTransportState] = useState<string | null>(null);
  const [labOrderBusy, setLabOrderBusy] = useState(false);
  const [lensesOpen, setLensesOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selectedCharge = chargeLines.find((line) => line.id === selectedChargeId) ?? chargeLines[0];
  const selectedLines = chargeLines.filter((line) => line.selected);
  const attachedLabFrame = chargeLines.find((line) => line.frame)?.frame;
  const attachedLenses = chargeLines.find((line) => line.lens)?.lens;
  const lensesLocked = Boolean(createdTaskId || labOrderReference);
  const claimBound = useMemo(
    () => hasActiveApplicableBenefit(
      insuranceContext.coverages,
      insuranceContext.responses,
      ["lens"],
      header.serviceDate,
    ),
    [insuranceContext, header.serviceDate],
  );
  const signedVisionPrescription = visionPrescription?.status === "active" ? visionPrescription : null;
  const frameQuery = Object.values(frameCriteria).filter(Boolean).join(" ");
  const frameInventory = useMemo(
    () => summarizeInventoryByVariant(frameInventoryUnits, frameVariantSettings, frameCatalogRows),
    [frameCatalogRows, frameInventoryUnits, frameVariantSettings],
  );
  const frameMatches = useMemo(
    () => rankFramePosLookupRows(frameCatalogRows, frameInventory, frameQuery, 12) as FramePosLookupMatch[],
    [frameCatalogRows, frameInventory, frameQuery],
  );
  const canPrintLabSheet = Boolean(
    patientReference && signedVisionPrescription && header.lab.trim() && labOrderCapture.patientName.trim(),
  );

  useEffect(() => {
    if (!patientReference) {
      setInsuranceContext({ coverages: [], responses: [] });
      return;
    }
    let cancelled = false;
    const options = {
      authorization: fhir.authHeader(),
      baseUrl: import.meta.env?.VITE_ODOS_MCP_BASE_URL?.replace(/\/$/, "") ?? "",
    };
    Promise.all([
      fetchInsurance(patientReference, options),
      fetchBenefits(patientReference, options),
    ]).then(([insurance, benefits]) => {
      if (!cancelled) {
        setInsuranceContext({ coverages: insurance.coverages, responses: benefits.responses });
      }
    }).catch((cause) => {
      if (!cancelled) {
        setInsuranceContext({ coverages: [], responses: [] });
        console.error("Optical-order benefit context unavailable; treating order as cash-pay.", cause);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchBenefits, fetchInsurance, patientReference]);

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
    Promise.all([loadFrameInventoryUnits(), loadFrameVariantSettings()])
      .then(([inventoryLoad, settings]) => {
        if (cancelled) return;
        setFrameInventoryUnits([...inventoryLoad.units]);
        setSkippedFrameUnitCount(inventoryLoad.skippedCount);
        setFrameVariantSettings(settings);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [loadFrameInventoryUnits, loadFrameVariantSettings]);

  useEffect(() => {
    let cancelled = false;
    const search = () => {
      searchFrames(frameQuery)
        .then((catalog) => {
          if (!cancelled) setFrameCatalogRows(catalog);
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    };
    if (!frameQuery) {
      search();
      return () => {
        cancelled = true;
      };
    }
    const timer = globalThis.setTimeout(search, 250);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(timer);
    };
  }, [frameQuery, searchFrames]);

  const opticalCollectCharges = useMemo<OpenChargeLine[]>(() =>
    chargeLines.filter((line) => line.selected).map((line) => ({
      id: line.id,
      amountCents: patientBalanceCents(line),
      description: line.procedure || "Optical charge",
      date: header.serviceDate,
      source: "optical",
      code: line.procedure,
      quantity: line.units,
      feeCents: line.feeCents,
      taxCents: line.taxCents,
      ...(line.discount ? { discount: line.discount } : {}),
    })), [chargeLines, header.serviceDate]);
  const opticalCollectionOrder = useMemo<OpticalCollectionOrder>(() => ({
    patientReference,
    visionPrescriptionReference: visionPrescriptionReference(rxReference),
    ...(encounterReference ? { encounterReference } : {}),
    orderHcpcsCode: primaryOrderCode(selectedLines),
    ...(primaryOrderCode(selectedLines) === "V2020" ? { orderHcpcsDisplay: "Frames, purchases" } : {}),
    businessStatus: header.orderStatus,
    orderType: header.orderType,
    charges: selectedLines.map(opticalCollectionChargeFromDraft),
  }), [patientReference, rxReference, encounterReference, selectedLines, header.orderStatus, header.orderType]);
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

  async function patchLabOrderCapture(patch: Partial<LabOrderCaptureState>) {
    if (frameDispenseBusy) return;
    const nextCapture = { ...labOrderCapture, ...patch };
    const attachedLine = chargeLines.find((line) => line.frame);
    const frame = attachedLine?.frame;
    const linkedUnit = frame?.inventoryId
      ? frameInventoryUnits.find((unit) => unit.id === frame.inventoryId)
      : undefined;
    const inventoryCase = frameSourceUsesPracticeInventory(
      nextCapture.frameSource,
      nextCapture.frameOwnership,
    );
    const shouldReserve = frameSourceUsesPracticeInventory(
      nextCapture.frameSource,
      nextCapture.frameOwnership,
    ) && header.orderType !== "frame-only" && nextCapture.jobType !== "Frame Only";
    const linkedUnitReserved = linkedUnit
      ? ["reserved", "outbound", "at_lab", "inbound"].includes(linkedUnit.status)
      : false;
    if (!frame || (
      inventoryCase === Boolean(frame.inventoryId)
      && shouldReserve === linkedUnitReserved
    )) {
      setLabOrderCapture(nextCapture);
      return;
    }

    setFrameDispenseBusy(true);
    setError(null);
    try {
      let inventoryId = frame.inventoryId;
      if (shouldReserve) {
        if (frame.inventoryId && (!linkedUnit || linkedUnit.status !== "on_hand")) {
          throw new Error(
            `Frame inventory unit ${frame.inventoryId} is no longer on hand. Refresh inventory and retry.`,
          );
        }
        inventoryId = linkedUnit?.status === "on_hand"
          ? (await mutateFrameUnit(linkedUnit.id, "on_hand", "reserved")).id
          : (await reserveFrameUnit(frame.canonicalUrl)).id;
      } else if (linkedUnitReserved && frame.inventoryId) {
        await mutateFrameUnit(frame.inventoryId, ["reserved", "outbound", "at_lab", "inbound"], "on_hand");
        if (!inventoryCase) inventoryId = undefined;
      } else if (inventoryCase && !frame.inventoryId) {
        const unit = oldestOnHandUnit(frameInventoryUnits, frame.canonicalUrl);
        if (!unit) throw new Error("No on-hand inventory unit is available for the attached frame.");
        inventoryId = unit.id;
      } else if (!inventoryCase) {
        inventoryId = undefined;
      }
      // FSRC 3 + in-house stays aggregate before receipt; a later slice links it to a Stock Order.
      setChargeLines((current) => current.map((line) =>
        line.id === attachedLine.id && line.frame
          ? { ...line, frame: { ...line.frame, inventoryId } }
          : line));
      setLabOrderCapture(nextCapture);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFrameDispenseBusy(false);
    }
  }

  async function mutateFrameUnit(
    unitId: string,
    fromStatuses: FrameInventoryUnitStatus | readonly FrameInventoryUnitStatus[],
    toStatus: FrameInventoryUnitStatus,
  ): Promise<PracticeFrameInventoryUnit> {
    try {
      const updated = await transitionFrameUnit(unitId, fromStatuses, toStatus);
      setFrameInventoryUnits((current) =>
        current.map((candidate) => candidate.id === updated.id ? updated : candidate));
      return updated;
    } catch (cause) {
      try {
        const refreshed = await loadFrameInventoryUnits();
        setFrameInventoryUnits([...refreshed.units]);
        setSkippedFrameUnitCount(refreshed.skippedCount);
      } catch (refreshCause) {
        console.warn("Frame inventory refresh after a failed transition was unsuccessful.", refreshCause);
      }
      throw cause;
    }
  }

  async function reserveFrameUnit(canonicalUrl: string): Promise<PracticeFrameInventoryUnit> {
    const unit = oldestOnHandUnit(frameInventoryUnits, canonicalUrl);
    if (!unit) {
      throw new Error("No on-hand inventory unit is available for the attached frame.");
    }
    return mutateFrameUnit(unit.id, "on_hand", "reserved");
  }

  async function transitionAttachedFrameUnit(
    fromStatuses: FrameInventoryUnitStatus | readonly FrameInventoryUnitStatus[],
    toStatus: FrameInventoryUnitStatus,
  ): Promise<PracticeFrameInventoryUnit | undefined> {
    const inventoryId = chargeLines.find((line) => line.frame?.inventoryId)?.frame?.inventoryId;
    return inventoryId ? mutateFrameUnit(inventoryId, fromStatuses, toStatus) : undefined;
  }

  async function releaseAttachedFrameUnit(): Promise<void> {
    await transitionAttachedFrameUnit(
      ["reserved", "outbound", "at_lab", "inbound"],
      "on_hand",
    );
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
    if (next === header.orderStatus) return;
    if (createdTaskId && !canTransitionOpticalOrderStatus(header.orderStatus, next)) {
      setError(`Optical order status "${header.orderStatus}" is terminal.`);
      return;
    }
    try {
      if (createdTaskId) {
        await transitionOpticalOrderStatus(createdTaskId, next);
      }
      if (next === "at-lab") {
        await transitionAttachedFrameUnit(["reserved", "outbound"], "at_lab");
      } else if (next === "dispensed") {
        await transitionAttachedFrameUnit(
          ["on_hand", "reserved", "outbound", "at_lab", "inbound"],
          "dispensed",
        );
        setChargeLines((current) => current.map((line) =>
          line.frame?.inventoryId ? { ...line, dispensed: true } : line));
      } else if (next === "cancelled") {
        await releaseAttachedFrameUnit();
      }
      setHeader((current) => ({ ...current, orderStatus: next }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
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

  async function attachFrame(match: FramePosLookupMatch) {
    if (!selectedCharge || selectedCharge.frame || frameDispenseBusy) return;
    setFrameDispenseBusy(true);
    setError(null);
    try {
      const attached = attachedFrameFromMatch(match, frameType);
      const practiceInventoryFrame = frameSourceUsesPracticeInventory(
        labOrderCapture.frameSource,
        labOrderCapture.frameOwnership,
      );
      const labBoundPracticeFrame = practiceInventoryFrame
        && header.orderType !== "frame-only"
        && labOrderCapture.jobType !== "Frame Only";
      const linkedUnit = labBoundPracticeFrame
        ? await reserveFrameUnit(attached.canonicalUrl)
        : practiceInventoryFrame
          ? oldestOnHandUnit(frameInventoryUnits, attached.canonicalUrl)
          : undefined;
      if (practiceInventoryFrame && !linkedUnit) {
        throw new Error("No on-hand inventory unit is available for the attached frame.");
      }
      setChargeLines((current) =>
        current.map((line) =>
          line.id === selectedCharge.id
            ? {
                ...line,
                procedure: "V2020",
                feeCents: match.inventory?.salePriceCents ?? line.feeCents,
                frame: { ...attached, ...(linkedUnit ? { inventoryId: linkedUnit.id } : {}) },
              }
            : line,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFrameDispenseBusy(false);
    }
  }

  function attachLenses(selection: LensSelection) {
    if (lensesLocked) return;
    const committed = commitLensSelection(chargeLines, selection);
    setChargeLines(committed.chargeLines);
    setLabOrderCapture((current) => ({
      ...current,
      lensDesign: committed.labOrderLensSpec.lensDesign,
      lensMaterial: committed.labOrderLensSpec.lensMaterial,
      treatments: [...committed.labOrderLensSpec.treatments],
    }));
    const orderLab = catalogLabToOrderLab(committed.attached.lab);
    if (IVA_LABS.includes(orderLab as (typeof IVA_LABS)[number])) {
      setLabOption(orderLab);
      setOtherLab("");
    } else {
      setLabOption(LAB_OTHER_OPTION);
      setOtherLab(orderLab);
    }
    setHeader((current) => ({ ...current, lab: orderLab }));
    setSelectedChargeId(committed.chargeLines.find((line) => line.lens)?.id ?? selectedChargeId);
    setLensesOpen(false);
  }

  function unattachLenses() {
    if (lensesLocked) return;
    setChargeLines((lines) => unattachLensSelection(lines));
    setLabOrderCapture((current) => ({
      ...current,
      lensDesign: "",
      lensMaterial: "",
      treatments: [],
    }));
  }

  async function dispenseSelectedFrame() {
    if (!selectedCharge.frame || selectedCharge.dispensed || frameDispenseBusy) return;
    const unit = selectedCharge.frame.inventoryId
      ? frameInventoryUnits.find((candidate) => candidate.id === selectedCharge.frame?.inventoryId)
      : oldestOnHandUnit(frameInventoryUnits, selectedCharge.frame.canonicalUrl);
    if (!unit) {
      setError(selectedCharge.frame.inventoryId
        ? "The reserved frame inventory unit is no longer available. Refresh inventory and retry."
        : "No on-hand inventory unit is available for the attached frame.");
      return;
    }
    setFrameDispenseBusy(true);
    setError(null);
    try {
      const updated = await dispenseFrameUnit(unit.id);
      setFrameInventoryUnits((current) =>
        current.map((candidate) => candidate.id === updated.id ? updated : candidate));
      setChargeLines((current) =>
        current.map((line) => line.id === selectedCharge.id
          ? {
              ...line,
              dispensed: true,
              frame: line.frame ? { ...line.frame, inventoryId: updated.id } : line.frame,
            }
          : line));
      setStatus(`Dispensed frame inventory unit ${updated.id}.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      try {
        const refreshed = await loadFrameInventoryUnits();
        setFrameInventoryUnits([...refreshed.units]);
        setSkippedFrameUnitCount(refreshed.skippedCount);
      } catch (refreshCause) {
        console.warn("Frame inventory refresh after a failed dispense was unsuccessful.", refreshCause);
      }
      setError(message);
    } finally {
      setFrameDispenseBusy(false);
    }
  }

  async function unattachSelectedFrame() {
    if (!selectedCharge.frame || frameDispenseBusy) return;
    setFrameDispenseBusy(true);
    setError(null);
    try {
      if (selectedCharge.frame.inventoryId) {
        await mutateFrameUnit(
          selectedCharge.frame.inventoryId,
          ["reserved", "outbound", "at_lab", "inbound"],
          "on_hand",
        );
      }
      setChargeLines((lines) => lines.map((line) =>
        line.id === selectedCharge.id ? { ...line, frame: undefined, dispensed: false } : line));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFrameDispenseBusy(false);
    }
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
      frameSource: labOrderCapture.frameSource,
      frameOwnership: labOrderCapture.frameOwnership,
      frame: labOrderCapture.frameSource === 0 || labOrderCapture.frameSource === 1
        ? undefined
        : labOrderFrameFromAttachedFrame(attachedLabFrame, legacyFrameSource(labOrderCapture.frameSource, labOrderCapture.frameOwnership)),
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

  async function sendLabOrder() {
    const input = assembleLabOrderInput();
    if (!input || !createdTaskId) return;
    setLabOrderBusy(true);
    setStatus("");
    try {
      const result = await submitLabOrder({
        order: buildLabOrder(input),
        orderTaskReference: `Task/${createdTaskId}`,
        lab: header.lab.trim(),
      });
      setLabOrderReference(result.labOrderReference);
      setLabTransportState(result.transportState);
      await transitionAttachedFrameUnit("reserved", "outbound");
      setStatus(`Lab order ${result.labOrderReference} sent to ${input.lab}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLabOrderBusy(false);
    }
  }

  async function markLabOrderReceived() {
    if (!labOrderReference) return;
    setLabOrderBusy(true);
    setError(null);
    try {
      const result = await advanceLabOrderTransport(labOrderReference, "received");
      setLabTransportState(result.transportState);
      await transitionAttachedFrameUnit(["at_lab", "outbound"], "inbound");
      setStatus(`Lab order ${labOrderReference} marked received.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLabOrderBusy(false);
    }
  }

  async function cancelActiveLabOrder() {
    if (!labOrderReference) return;
    setLabOrderBusy(true);
    setError(null);
    try {
      const result = await cancelLabOrder(labOrderReference);
      setLabTransportState(result.transportState);
      await releaseAttachedFrameUnit();
      setStatus(`Lab order ${labOrderReference} cancelled.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLabOrderBusy(false);
    }
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
                    <th key={column.key} className="border-r border-white/10 px-2 py-2 last:border-r-0">
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rxRows.map((row) => (
                  <tr key={row.eye} className="border-t border-white/10 text-white/80">
                    {RX_COLUMNS.map((column) => (
                      <td key={`${row.eye}-${column.key}`} className="border-r border-white/10 px-2 py-2 last:border-r-0">
                        {row.values[column.key]}
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
            <div className="border-t border-white/10 bg-white/[0.02] p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">Lenses</div>
                  <div className="text-xs text-white/45">Rx-aware Lens Catalog selection writes into this order's existing lens fields.</div>
                </div>
                <button className="sidebar-button" type="button" disabled={lensesLocked} onClick={() => setLensesOpen(true)}>
                  {attachedLenses ? "Change lenses" : "Add lenses"}
                </button>
              </div>
              {attachedLenses ? <AttachedLensPanel
                lens={attachedLenses}
                disabled={lensesLocked}
                onChange={() => setLensesOpen(true)}
                onUnattach={unattachLenses}
              /> : null}
            </div>
          </section>

          <div className="grid gap-4">
            <CollectPanel
              embedded
              disabled={!patientReference || !rxReference || Boolean(createdTaskId)}
              patientReference={patientReference}
              patientName={labOrderCapture.patientName.trim() || undefined}
              initialCharges={opticalCollectCharges}
              opticalOrder={opticalCollectionOrder}
              onClose={() => undefined}
              onCollected={(result) => {
                setCreatedTaskId(result.taskId);
                setHeader((current) => ({ ...current, orderNumber: result.deviceRequestId }));
                setStatus(`Order ${result.deviceRequestId} paid. Receipt ready.`);
              }}
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
              canSend={Boolean(canPrintLabSheet && createdTaskId)}
              labOrderReference={labOrderReference}
              labTransportState={labTransportState}
              busy={labOrderBusy}
              onHeaderChange={setHeader}
              onCapturePatch={patchLabOrderCapture}
              onTreatmentChange={updateTreatment}
              onAddTreatment={addTreatment}
              onRemoveTreatment={removeTreatment}
              onFittingChange={updateFitting}
              onPrint={printLabSheet}
              onDownload={downloadLabOrderJson}
              onSend={() => void sendLabOrder()}
              onMarkReceived={() => void markLabOrderReceived()}
              onCancel={() => void cancelActiveLabOrder()}
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
            onAttach={(match) => void attachFrame(match)}
            dispenseBusy={frameDispenseBusy}
            onDispense={() => void dispenseSelectedFrame()}
            inventoryUnit={selectedCharge.frame?.inventoryId
              ? frameInventoryUnits.find((unit) => unit.id === selectedCharge.frame?.inventoryId)
              : undefined}
            onUnattach={() => void unattachSelectedFrame()}
          />
          <QuickAdvancePanel
            currentStatus={header.orderStatus}
            disabled={!createdTaskId}
            onAdvance={(next) => void changeOrderStatus(next)}
          />
        </div>

        {skippedFrameUnitCount > 0 ? (
          <div role="alert" className="rounded border border-[color:var(--odos-amber)] bg-[color:var(--odos-surface)] p-3 text-sm text-[color:var(--odos-amber)]">
            Skipped {skippedFrameUnitCount} malformed frame inventory {skippedFrameUnitCount === 1 ? "unit" : "units"}. Valid inventory remains available.
          </div>
        ) : null}
        {error ? <div className="rounded border border-red-500/50 bg-red-950/30 p-3 text-sm text-red-100">{error}</div> : null}
        {status ? <div className="rounded border border-emerald-500/40 bg-emerald-950/20 p-3 text-sm text-emerald-100">{status}</div> : null}
      </div>
      <LensesOrderSurface
        open={lensesOpen && !lensesLocked}
        rx={visionPrescription}
        initialSelection={attachedLenses}
        claimBound={claimBound}
        products={lensCatalog?.products}
        coatings={lensCatalog?.coatings}
        modifiers={lensCatalog?.modifiers}
        resolver={lensCatalog?.resolver}
        onCancel={() => setLensesOpen(false)}
        onCommit={attachLenses}
      />
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

export function PaymentPanel({
  tender,
  paymentAmount,
  selectedTotalCents,
  canProcessPayment,
  canPrintReceipt,
  onTenderChange,
  onAmountChange,
  onProcess,
  onPrintReceipt,
  loadPaymentMethods = loadConfiguredPaymentMethods,
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
  loadPaymentMethods?: () => Promise<string[]>;
}) {
  const [configuredMethods, setConfiguredMethods] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    loadPaymentMethods()
      .then((methods) => {
        if (!cancelled) setConfiguredMethods(methods);
      })
      .catch(() => {
        if (!cancelled) setConfiguredMethods([]);
      });
    return () => {
      cancelled = true;
    };
  }, [loadPaymentMethods]);

  const availableTenders = CHECKOUT_TENDERS.filter(
    (entry) => entry.code !== "CARD_TERMINAL" || configuredMethods.includes("clover"),
  );

  return (
    <section className="rounded border border-white/10 p-3">
      <div className="grid gap-3 md:grid-cols-3">
        <label className="grid gap-1 text-xs text-white/60">
          <span>Tender</span>
          <select className="sidebar-input" value={tender} onChange={(event) => onTenderChange(event.target.value as CheckoutTenderCode)}>
            {availableTenders.map((entry) => (
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
  canSend,
  labOrderReference,
  labTransportState,
  busy,
  onHeaderChange,
  onCapturePatch,
  onTreatmentChange,
  onAddTreatment,
  onRemoveTreatment,
  onFittingChange,
  onPrint,
  onDownload,
  onSend,
  onMarkReceived,
  onCancel,
}: {
  header: OrderHeaderState;
  patientReference: string;
  activeRxLoaded: boolean;
  attachedFrame: AttachedFrame | undefined;
  capture: LabOrderCaptureState;
  canPrint: boolean;
  canSend: boolean;
  labOrderReference: string | null;
  labTransportState: string | null;
  busy: boolean;
  onHeaderChange: (next: OrderHeaderState) => void;
  onCapturePatch: (patch: Partial<LabOrderCaptureState>) => void;
  onTreatmentChange: (index: number, value: string) => void;
  onAddTreatment: () => void;
  onRemoveTreatment: (index: number) => void;
  onFittingChange: (eye: "od" | "os", field: keyof LabOrderEyeFittingState, value: string) => void;
  onPrint: () => void;
  onDownload: () => void;
  onSend: () => void;
  onMarkReceived: () => void;
  onCancel: () => void;
}) {
  const activeLabOrder = Boolean(
    labOrderReference && labTransportState !== "received" && labTransportState !== "cancelled",
  );
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
            onChange={(event) => {
              const frameSource = Number(event.target.value) as LabOrderFrameSource;
              onCapturePatch({
                frameSource,
                frameOwnership: frameSource === 3 || frameSource === 4 ? capture.frameOwnership ?? "in-house" : undefined,
              });
            }}
          >
            {FRAME_SOURCE_OPTIONS.map((source) => (
              <option key={source.value} value={source.value}>
                {source.label}
              </option>
            ))}
          </select>
        </label>
        {(capture.frameSource === 3 || capture.frameSource === 4) && (
          <label className="grid gap-1 text-xs text-white/60">
            <span>Frame Ownership</span>
            <select
              className="sidebar-input"
              value={capture.frameOwnership ?? "in-house"}
              onChange={(event) => onCapturePatch({ frameOwnership: event.target.value as LabOrderFrameOwnership })}
            >
              <option value="in-house">In-house</option>
              <option value="patients-own">Patient's Own Frame (POF)</option>
            </select>
          </label>
        )}
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

      <LabOrderActionButtons
        canPrint={canPrint}
        canSend={canSend}
        activeLabOrder={activeLabOrder}
        busy={busy}
        onPrint={onPrint}
        onDownload={onDownload}
        onSend={onSend}
        onMarkReceived={onMarkReceived}
        onCancel={onCancel}
      />
    </section>
  );
}

export function LabOrderActionButtons({
  canPrint,
  canSend,
  activeLabOrder,
  busy,
  onPrint,
  onDownload,
  onSend,
  onMarkReceived,
  onCancel,
}: {
  canPrint: boolean;
  canSend: boolean;
  activeLabOrder: boolean;
  busy: boolean;
  onPrint: () => void;
  onDownload: () => void;
  onSend: () => void;
  onMarkReceived: () => void;
  onCancel: () => void;
}) {
  return <>
    <div className="mt-3 grid gap-2 md:grid-cols-3">
      <button className="sidebar-button" disabled={!canPrint} onClick={onPrint}>Print Lab Sheet</button>
      <button className="sidebar-button" disabled={!canPrint} onClick={onDownload}>Download Order (JSON)</button>
      <button className="sidebar-button" disabled={!canSend || activeLabOrder || busy} onClick={onSend}>Send to Lab</button>
    </div>
    {activeLabOrder ? <div className="mt-2 grid gap-2 md:grid-cols-2">
      <button className="sidebar-button py-1" disabled={busy} onClick={onMarkReceived}>Mark Received</button>
      <button className="sidebar-button py-1" disabled={busy} onClick={onCancel}>Cancel Lab Order</button>
    </div> : null}
  </>;
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
  dispenseBusy,
  onDispense,
  inventoryUnit,
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
  dispenseBusy: boolean;
  onDispense: () => void;
  inventoryUnit?: PracticeFrameInventoryUnit;
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
                <ReadCell value={String(match.inventory?.onHandCount ?? 0)} />
                <td className="border-r border-white/10 px-2 py-2">
                  <button className="sidebar-button h-8 w-full py-1" disabled={locked || dispenseBusy} onClick={() => onAttach(match)}>
                    Attach
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selectedCharge.frame ? (
        <AttachedFramePanel
          frame={selectedCharge.frame}
          dispensed={Boolean(selectedCharge.dispensed)}
          dispenseBusy={dispenseBusy}
          inventoryUnit={inventoryUnit}
          onUnattach={onUnattach}
          onDispense={onDispense}
        />
      ) : null}
    </section>
  );
}

function AttachedFramePanel({
  frame,
  dispensed,
  dispenseBusy,
  inventoryUnit,
  onUnattach,
  onDispense,
}: {
  frame: AttachedFrame;
  dispensed: boolean;
  dispenseBusy: boolean;
  inventoryUnit?: PracticeFrameInventoryUnit;
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
    ...(frame.inventoryId ? [["Inventory Unit", frame.inventoryId] as [string, string]] : []),
    ...(inventoryUnit ? [["Inventory State", frameInventoryUnitStatusLabel(inventoryUnit.status)] as [string, string]] : []),
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
        <button className="sidebar-button" disabled={dispenseBusy} onClick={onUnattach}>
          Unattach Frame
        </button>
        <button className="sidebar-button" disabled={dispensed || dispenseBusy || !frame.inventoryId} onClick={onDispense}>
          {dispensed ? "Dispensed" : dispenseBusy ? "Dispensing…" : "Dispense"}
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

function oldestOnHandUnit(
  units: readonly PracticeFrameInventoryUnit[],
  canonicalUrl: string,
): PracticeFrameInventoryUnit | undefined {
  return units
    .filter((unit) => unit.canonicalUrl === canonicalUrl && unit.status === "on_hand")
    .sort((left, right) =>
      left.receivedAt.localeCompare(right.receivedAt) || left.id.localeCompare(right.id))[0];
}

function actingPractitionerId(): string {
  const actorId = fhir.practitionerId();
  if (!actorId) throw new Error("The signed-in session has no acting Practitioner profile.");
  return actorId;
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

function catalogLabToOrderLab(lab: string): string {
  if (lab === "bp-digital") return "Best Price Digital Lab";
  if (lab === "cherry-optical") return "Cherry Optical Lab";
  return lab.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
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
    frameSource: 4,
    frameOwnership: "in-house",
    frameTraceRef: "",
    fitting: {
      od: emptyFittingEye(),
      os: emptyFittingEye(),
    },
  };
}

function legacyFrameSource(
  frameSource: LabOrderFrameSource,
  ownership: LabOrderFrameOwnership | undefined,
): LabOrderFrame["source"] {
  if (frameSource === 3) return "frame-to-come";
  return ownership === "patients-own" ? "patient-own" : "stock";
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
