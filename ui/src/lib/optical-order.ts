import type {
  Invoice,
  InvoiceLineItemPriceComponent,
  Task,
  VisionPrescription,
  VisionPrescriptionLensSpecification,
} from "@medplum/fhirtypes";
import { fhir } from "./fhir";
import type { OpticalCollectionCharge } from "./collect";
import type { AttachedLensChargeSource, AttachedLensSelection } from "./lens-selection";
import type { ResolvedVCode } from "./v-code-resolver";
import type { LabOrderFrame } from "./optical-lab-order";
import { frameChargeItemDefinitionCanonical } from "./optical-pricing-catalog";

export const ODOS_OPTICAL_ORDER_STATUS_SYSTEM = "https://odos2020.com/fhir/CodeSystem/optical-order-status";
export const ODOS_OPTICAL_ORDER_TYPE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/optical-order-type";
export const ODOS_PAYMENT_TENDER_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-payment-tender";
export const ODOS_PAYMENT_TENDER_SYSTEM = "https://odos2020.com/fhir/CodeSystem/payment-tender";
export const ODOS_OPTICAL_ADJUSTMENT_SYSTEM = "https://odos2020.com/fhir/CodeSystem/optical-adjustment";
export const HCPCS_SYSTEM = "https://bluebutton.cms.gov/resources/codesystem/hcpcs";

export const OPTICAL_ORDER_STATUSES = [
  { code: "quote", display: "Quote" },
  { code: "waiting-for-pre-auth", display: "Waiting for Pre Auth" },
  { code: "at-lab", display: "At Lab" },
  { code: "lenses-on-order", display: "Lenses On Order" },
  { code: "frame-on-order", display: "Frame On Order" },
  { code: "waiting-on-patients-frame", display: "Waiting on Patients Frame" },
  { code: "notified", display: "Notified" },
  { code: "notified-left-message", display: "Notified - Left Message" },
  { code: "dispensed", display: "Dispensed" },
  { code: "complete-unable-to-notify", display: "Complete - Unable to Notify" },
  { code: "waiting-on-payment", display: "Waiting On Payment" },
  { code: "cancelled", display: "Cancelled" },
  { code: "quick-order", display: "Quick Order" },
  { code: "frame-only", display: "Frame Only" },
  { code: "gift-card-order", display: "Gift Card Order" },
  { code: "doctor-change", display: "Doctor Change" },
  { code: "vsp-ordered", display: "VSP Ordered" },
] as const;

export const OPTICAL_ORDER_TYPES = [
  { code: "rx", display: "Rx" },
  { code: "frame-only", display: "Frame Only" },
  { code: "lenses-only", display: "Lenses Only" },
  { code: "quote", display: "Quote" },
  { code: "gift-card", display: "Gift Card" },
] as const;

export const PAYMENT_TENDERS = [
  { code: "CASH", display: "Cash" },
  { code: "CHECK", display: "Check" },
  { code: "CARD_MANUAL", display: "Card — manual entry" },
] as const;

export const CHECKOUT_TENDERS = [
  ...PAYMENT_TENDERS,
  { code: "CARD_TERMINAL", display: "Card (terminal)" },
] as const;

export const OPTICAL_ADJUSTMENTS = [
  { code: "2PAIR", display: "Second Pair Discount" },
  { code: "CSDIS", display: "Customer Service Discount" },
  { code: "FAMILY", display: "Family Discount" },
  { code: "PPAY", display: "Prompt Pay Discount" },
  { code: "DEYE", display: "Eyemed Discount" },
  { code: "DVSP", display: "VSP Discount" },
] as const;

export const RX_COLUMNS = [
  { key: "sphere", label: "Sphere" },
  { key: "cylinder", label: "Cylinder" },
  { key: "axis", label: "Axis" },
  { key: "distPd", label: "Dist(PD)" },
  { key: "nearPd", label: "Near(PD)" },
  { key: "form", label: "Form" },
  { key: "horizontalBase", label: "I/O" },
  { key: "horizontalPrism", label: "Prism" },
  { key: "verticalBase", label: "U/D" },
  { key: "verticalPrism", label: "Prism" },
  { key: "bSize", label: "BSize" },
  { key: "base", label: "Base" },
  { key: "lensCpt", label: "Lens CPT" },
  { key: "remarks", label: "Remarks" },
  { key: "add", label: "Add" },
  { key: "segHt", label: "Seght" },
  { key: "eye", label: "Eye" },
  { key: "prismUnits", label: "Prism Units" },
  { key: "prismPoints", label: "Prism Pts" },
] as const;

export type RxColumnKey = (typeof RX_COLUMNS)[number]["key"];

export const CHARGE_COLUMNS = [
  "Procedure",
  "M1",
  "Diag 1",
  "Insurance",
  "Plan",
  "Units",
  "Fee",
  "Est Ins",
  "Tax",
  "Est Pat Bal",
  "P(A)/R(D)",
  "Pat Open",
  "Ins Open",
  "Select/Tax",
] as const;

export type OpticalOrderStatusCode = (typeof OPTICAL_ORDER_STATUSES)[number]["code"];
export type OpticalOrderTypeCode = (typeof OPTICAL_ORDER_TYPES)[number]["code"];
export type PaymentTenderCode = (typeof PAYMENT_TENDERS)[number]["code"];
export type CheckoutTenderCode = (typeof CHECKOUT_TENDERS)[number]["code"];
export type RecordedCheckoutTenderCode = Exclude<CheckoutTenderCode, "CARD_TERMINAL">;

export interface RxDisplayRow {
  eye: "OD" | "OS";
  values: Record<RxColumnKey, string>;
}

export interface OpticalChargeLineDraft {
  id: string;
  procedure: string;
  modifier: string;
  diagnosis: string;
  units: number;
  feeCents: number;
  taxCents: number;
  selected: boolean;
  taxable: boolean;
  discount?: { code: string; amountCents: number };
  frame?: AttachedFrame;
  lens?: AttachedLensSelection;
  lensAddOn?: AttachedLensChargeSource;
  billingCodes?: ResolvedVCode[];
  dispensed?: boolean;
}

export type { AttachedLensSelection } from "./lens-selection";

export interface AttachedFrame {
  inventoryId?: string;
  canonicalUrl: string;
  upc: string;
  brand: string;
  model: string;
  color: string;
  eye: string;
  bridge: string;
  a: string;
  b: string;
  ed: string;
  dbl: string;
  temple: string;
  frameType: string;
}

export interface OpticalCashOrderDraft {
  patientReference: string;
  visionPrescriptionReference: string;
  encounterReference?: string;
  orderHcpcsCode: string;
  orderHcpcsDisplay?: string;
  businessStatus: OpticalOrderStatusCode;
  orderType: OpticalOrderTypeCode;
  charges: OpticalChargeLineDraft[];
  tender?: RecordedCheckoutTenderCode;
}

export function opticalCollectionChargeFromDraft(line: OpticalChargeLineDraft): OpticalCollectionCharge {
  const lensCanonical = line.lens?.productCanonicalUrl ?? line.lensAddOn?.productCanonicalUrl;
  return {
    id: line.id,
    code: line.procedure,
    feeCents: line.feeCents,
    taxCents: line.taxCents,
    quantity: line.units,
    discount: line.discount,
    ...(line.frame
      ? { definitionCanonical: frameChargeItemDefinitionCanonical(line.frame.canonicalUrl) }
      : lensCanonical ? { definitionCanonical: lensCanonical } : {}),
  };
}

export interface OpticalCardChargeInput {
  amountCents: number;
  patientReference: string;
  invoiceReference: string;
  taskReference: string;
}

export interface TransactionResult {
  transactionId: string;
  paymentRecord?: { resourceType: "PaymentReconciliation" | "Invoice"; id: string };
  outcome: "success" | "declined" | "pending" | "failed";
  amountChargedCents: number;
  feesCents: number;
  settlementDate?: string;
  declineCode?: string;
  declineReason?: string;
}

export function labOrderFrameFromAttachedFrame(
  frame: AttachedFrame | undefined,
  source: LabOrderFrame["source"],
): LabOrderFrame {
  return {
    ...(frame
      ? {
          brand: frame.brand,
          model: frame.model,
          color: frame.color,
          eye: frame.eye,
          bridge: frame.bridge,
          temple: frame.temple,
          a: frame.a,
          b: frame.b,
          ed: frame.ed,
          dbl: frame.dbl,
          frameType: frame.frameType,
        }
      : {}),
    source,
  };
}

export async function loadVisionPrescription(reference: string): Promise<VisionPrescription> {
  const id = reference.replace(/^VisionPrescription\//, "").trim();
  return fhir.read<VisionPrescription>("VisionPrescription", id);
}

export async function findLatestActiveVisionPrescription(
  patientId: string,
): Promise<VisionPrescription | null> {
  const patientReference = patientId.startsWith("Patient/") ? patientId : `Patient/${patientId}`;
  const bundle = await fhir.search<VisionPrescription>("VisionPrescription", {
    patient: patientReference,
    status: "active",
    _count: "20",
    _sort: "-datewritten",
  });
  return (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .find((resource): resource is VisionPrescription =>
      resource?.resourceType === "VisionPrescription" &&
      resource.status === "active" &&
      resource.patient?.reference === patientReference &&
      Boolean(resource.id)
    ) ?? null;
}

export function opticalOrderPath(patientId: string, prescriptionId: string): string {
  const patientReference = patientId.startsWith("Patient/") ? patientId : `Patient/${patientId}`;
  const prescriptionReference = prescriptionId.startsWith("VisionPrescription/")
    ? prescriptionId
    : `VisionPrescription/${prescriptionId}`;
  const params = new URLSearchParams({ patient: patientReference, rx: prescriptionReference });
  return `/dispensary/orders?${params}`;
}

export function visionPrescriptionRows(rx: VisionPrescription | null): RxDisplayRow[] {
  return ["OD", "OS"].map((eye) => {
    const lens = rx?.lensSpecification.find((candidate) =>
      eye === "OD" ? candidate.eye === "right" : candidate.eye === "left",
    );
    return {
      eye: eye as "OD" | "OS",
      values: rxValues(lens, eye as "OD" | "OS"),
    };
  });
}

export function canTransitionOpticalOrderStatus(from: string, to: string): boolean {
  assertOpticalOrderStatus(from);
  assertOpticalOrderStatus(to);
  return from === to || from !== "cancelled";
}

export async function chargeOpticalCardPayment(
  input: OpticalCardChargeInput,
  deps: { authHeader?: () => string | undefined; fetchImpl?: typeof fetch } = {},
): Promise<TransactionResult> {
  const authHeader = (deps.authHeader ?? fhir.authHeader)();
  if (!authHeader) {
    throw new Error("A signed-in FHIR session is required before taking a card payment.");
  }
  // The server derives the caller's role from the verified token (decision 2026-07-05 §3);
  // the UI sends no role — the presentation role toggle is not authorization.
  const response = await (deps.fetchImpl ?? fetch)("/payments/charge", {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      method: "clover",
      amountCents: input.amountCents,
      patientReference: input.patientReference,
      invoiceReference: input.invoiceReference,
      taskReference: input.taskReference,
      description: "Optical order card payment",
      surface: "in-clinic-pos",
    }),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(paymentErrorMessage(response, body));
  }
  return body as TransactionResult;
}

export async function loadConfiguredPaymentMethods(
  deps: { authHeader?: () => string | undefined; fetchImpl?: typeof fetch } = {},
): Promise<string[]> {
  const authHeader = (deps.authHeader ?? fhir.authHeader)();
  if (!authHeader) {
    throw new Error("A signed-in FHIR session is required to load payment methods.");
  }
  const response = await (deps.fetchImpl ?? fetch)("/payments/methods", {
    headers: {
      Authorization: authHeader,
      Accept: "application/json",
    },
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(paymentErrorMessage(response, body));
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { methods?: unknown }).methods) ||
    !(body as { methods: unknown[] }).methods.every((method) => typeof method === "string")
  ) {
    throw new Error("Payment methods response is invalid.");
  }
  return (body as { methods: string[] }).methods;
}

export function invoiceTotalNetCents(invoice: Invoice): number {
  const totalNet = invoice.totalNet?.value;
  if (typeof totalNet !== "number" || !Number.isFinite(totalNet)) {
    throw new Error("Card payment requires an Invoice.totalNet amount.");
  }
  return Math.round(totalNet * 100);
}

export async function transitionOpticalOrderStatus(
  taskId: string,
  toStatus: OpticalOrderStatusCode,
): Promise<Task> {
  const current = await fhir.read<Task>("Task", taskId);
  const fromStatus = currentOpticalBusinessStatus(current);
  if (!canTransitionOpticalOrderStatus(fromStatus, toStatus)) {
    throw new Error(`Optical order status "${fromStatus}" is terminal; cannot transition to "${toStatus}".`);
  }
  return fhir.patch<Task>(
    "Task",
    taskId,
    [
      { op: "replace", path: "/businessStatus", value: opticalOrderStatusConcept(toStatus) },
      { op: "replace", path: "/status", value: fhirTaskStatusForOpticalStatus(toStatus) },
    ],
    "optical.order-status",
    current.meta?.versionId,
  );
}

export function buildOpticalInvoice(input: OpticalCashOrderDraft, chargeItemReferences: string[]): Invoice {
  let grossCents = 0;
  let netCents = 0;
  return {
    resourceType: "Invoice",
    status: "issued",
    subject: { reference: input.patientReference },
    ...(input.tender !== undefined ? { extension: [paymentTenderExtension(input.tender)] } : {}),
    lineItem: input.charges.map((line, index) => {
      grossCents += line.feeCents;
      netCents += line.feeCents - (line.discount?.amountCents ?? 0);
      return {
        sequence: index + 1,
        chargeItemReference: { reference: chargeItemReferences[index] },
        priceComponent: linePriceComponents(line),
      };
    }),
    totalGross: { value: grossCents / 100, currency: "USD" },
    totalNet: { value: netCents / 100, currency: "USD" },
  };
}

function linePriceComponents(line: OpticalChargeLineDraft): InvoiceLineItemPriceComponent[] {
  const components: InvoiceLineItemPriceComponent[] = [
    { type: "base", amount: { value: line.feeCents / 100, currency: "USD" } },
  ];
  if (line.discount) {
    components.push({
      type: "discount",
      code: {
        coding: [
          {
            system: ODOS_OPTICAL_ADJUSTMENT_SYSTEM,
            code: line.discount.code,
            ...(opticalAdjustmentDisplay(line.discount.code)
              ? { display: opticalAdjustmentDisplay(line.discount.code) }
              : {}),
          },
        ],
      },
      amount: { value: line.discount.amountCents / 100, currency: "USD" },
    });
  }
  return components;
}

function rxValues(
  lens: VisionPrescriptionLensSpecification | undefined,
  eye: "OD" | "OS",
): Record<RxColumnKey, string> {
  const prisms = lens?.prism ?? [];
  const horizontalPrism = prisms.find((prism) => prism.base === "in" || prism.base === "out");
  const verticalPrism = prisms.find((prism) => prism.base === "up" || prism.base === "down");
  return {
    sphere: formatNumber(lens?.sphere),
    cylinder: formatNumber(lens?.cylinder),
    axis: formatNumber(lens?.axis),
    distPd: "",
    nearPd: "",
    form: lens?.product.text ?? "",
    horizontalBase: horizontalPrism?.base.toUpperCase() ?? "",
    horizontalPrism: formatNumber(horizontalPrism?.amount),
    verticalBase: verticalPrism?.base.toUpperCase() ?? "",
    verticalPrism: formatNumber(verticalPrism?.amount),
    bSize: "",
    base: [horizontalPrism, verticalPrism].flatMap((prism) => prism?.base ?? []).join(" / "),
    lensCpt: "",
    remarks: lens?.note?.map((note) => note.text).filter(Boolean).join("; ") ?? "",
    add: formatNumber(lens?.add),
    segHt: "",
    eye,
    prismUnits: prisms.length ? "PD" : "",
    prismPoints: "",
  };
}

function opticalOrderStatusConcept(code: OpticalOrderStatusCode) {
  const status = OPTICAL_ORDER_STATUSES.find((candidate) => candidate.code === code);
  if (!status) {
    throw new Error(`Unknown optical order status "${code}".`);
  }
  return {
    coding: [{ system: ODOS_OPTICAL_ORDER_STATUS_SYSTEM, code: status.code, display: status.display }],
    text: status.display,
  };
}

function paymentTenderExtension(code: RecordedCheckoutTenderCode) {
  const tender = CHECKOUT_TENDERS.find((candidate) => candidate.code === code);
  if (!tender) {
    throw new Error(`Unknown payment tender "${code}".`);
  }
  return {
    url: ODOS_PAYMENT_TENDER_EXTENSION_URL,
    valueCodeableConcept: {
      coding: [{ system: ODOS_PAYMENT_TENDER_SYSTEM, code: tender.code, display: tender.display }],
      text: tender.display,
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text };
  }
}

function paymentErrorMessage(response: Response, body: unknown): string {
  const message =
    typeof body === "object" && body !== null && "error" in body
      ? String((body as { error: unknown }).error)
      : response.statusText;
  return `Payment charge failed: ${response.status} ${message}`;
}

function opticalAdjustmentDisplay(code: string): string | undefined {
  return OPTICAL_ADJUSTMENTS.find((adjustment) => adjustment.code === code)?.display;
}

function currentOpticalBusinessStatus(task: Task): OpticalOrderStatusCode {
  const code = task.businessStatus?.coding?.find(
    (coding) => coding.system === ODOS_OPTICAL_ORDER_STATUS_SYSTEM,
  )?.code;
  assertOpticalOrderStatus(code ?? "");
  return code as OpticalOrderStatusCode;
}

function assertOpticalOrderStatus(code: string): asserts code is OpticalOrderStatusCode {
  if (!OPTICAL_ORDER_STATUSES.some((status) => status.code === code)) {
    throw new Error(`Unknown optical order status "${code}".`);
  }
}

function fhirTaskStatusForOpticalStatus(status: OpticalOrderStatusCode): Task["status"] {
  if (status === "cancelled") return "cancelled";
  if (status === "dispensed") return "completed";
  return "in-progress";
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}
