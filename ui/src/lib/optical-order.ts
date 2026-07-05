import type {
  Bundle,
  ChargeItem,
  DeviceRequest,
  Invoice,
  InvoiceLineItemPriceComponent,
  Task,
  VisionPrescription,
  VisionPrescriptionLensSpecification,
} from "@medplum/fhirtypes";
import { fhir } from "./fhir";
import type { LabOrderFrame } from "./optical-lab-order";
import type { RoleId } from "./roles";

export const OSOD_OPTICAL_ORDER_STATUS_SYSTEM = "https://osod.dev/fhir/CodeSystem/optical-order-status";
export const OSOD_OPTICAL_ORDER_TYPE_SYSTEM = "https://osod.dev/fhir/CodeSystem/optical-order-type";
export const OSOD_PAYMENT_TENDER_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-payment-tender";
export const OSOD_PAYMENT_TENDER_SYSTEM = "https://osod.dev/fhir/CodeSystem/payment-tender";
export const OSOD_OPTICAL_ADJUSTMENT_SYSTEM = "https://osod.dev/fhir/CodeSystem/optical-adjustment";
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
  "Sphere",
  "Cylinder",
  "Axis",
  "Dist(PD)",
  "Near(PD)",
  "Form",
  "I/O",
  "Prism",
  "U/D",
  "Prism",
  "BSize",
  "Base",
  "Lens CPT",
  "Remarks",
  "Add",
  "Seght",
  "Eye",
  "Prism Units",
  "Prism Pts",
] as const;

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

export interface RxDisplayRow {
  eye: "OD" | "OS";
  values: Record<(typeof RX_COLUMNS)[number], string>;
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
  dispensed?: boolean;
}

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
  tender?: PaymentTenderCode;
}

export interface CreatedOpticalOrderIds {
  deviceRequestId: string;
  taskId: string;
  chargeItemIds: string[];
  invoiceId: string;
}

export interface OpticalCardChargeInput {
  amountCents: number;
  patientReference: string;
  invoiceReference: string;
  taskReference: string;
  role: RoleId;
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

export async function createOpticalCashOrder(input: OpticalCashOrderDraft): Promise<CreatedOpticalOrderIds> {
  const requestBundle = assembleOpticalCashOrder(input);
  const responseBundle = await fhir.executeTransaction(requestBundle, "optical.cash-order");
  const created = createdIdsByRequestResourceType(requestBundle, responseBundle);
  return {
    deviceRequestId: oneCreatedId(created, "DeviceRequest"),
    taskId: oneCreatedId(created, "Task"),
    chargeItemIds: created.get("ChargeItem") ?? [],
    invoiceId: oneCreatedId(created, "Invoice"),
  };
}

export async function chargeOpticalCardPayment(
  input: OpticalCardChargeInput,
  deps: { authHeader?: () => string | undefined; fetchImpl?: typeof fetch } = {},
): Promise<TransactionResult> {
  const authHeader = (deps.authHeader ?? fhir.authHeader)();
  if (!authHeader) {
    throw new Error("A signed-in FHIR session is required before taking a card payment.");
  }
  const response = await (deps.fetchImpl ?? fetch)("/payments/charge", {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "X-OSOD-Role": input.role,
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

function assembleOpticalCashOrder(input: OpticalCashOrderDraft): Bundle {
  if (!input.charges.length) {
    throw new Error("A cash optical order requires at least one charge line.");
  }
  const deviceRequestUrn = `urn:uuid:${crypto.randomUUID()}`;
  const taskUrn = `urn:uuid:${crypto.randomUUID()}`;
  const chargeUrns = input.charges.map(() => `urn:uuid:${crypto.randomUUID()}`);
  const invoiceUrn = `urn:uuid:${crypto.randomUUID()}`;
  const charges = input.charges.map((line) => buildOpticalChargeItem(input, line, deviceRequestUrn));
  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      entry(deviceRequestUrn, buildSpectacleOrderDeviceRequest(input)),
      entry(taskUrn, buildOpticalOrderTask(input, deviceRequestUrn)),
      ...charges.map((charge, index) => entry(chargeUrns[index], charge)),
      entry(invoiceUrn, buildOpticalInvoice(input, chargeUrns)),
    ],
  };
}

function buildSpectacleOrderDeviceRequest(input: OpticalCashOrderDraft): DeviceRequest {
  return {
    resourceType: "DeviceRequest",
    status: "active",
    intent: "order",
    codeCodeableConcept: {
      coding: [
        {
          system: HCPCS_SYSTEM,
          code: input.orderHcpcsCode,
          ...(input.orderHcpcsDisplay ? { display: input.orderHcpcsDisplay } : {}),
        },
      ],
    },
    subject: { reference: input.patientReference },
    basedOn: [{ reference: input.visionPrescriptionReference }],
  };
}

function buildOpticalOrderTask(input: OpticalCashOrderDraft, deviceRequestReference: string): Task {
  return {
    resourceType: "Task",
    status: "in-progress",
    intent: "order",
    code: opticalOrderTypeConcept(input.orderType),
    focus: { reference: deviceRequestReference },
    for: { reference: input.patientReference },
    businessStatus: opticalOrderStatusConcept(input.businessStatus),
  };
}

function buildOpticalChargeItem(
  order: OpticalCashOrderDraft,
  line: OpticalChargeLineDraft,
  deviceRequestReference: string,
): ChargeItem {
  return {
    resourceType: "ChargeItem",
    status: "billable",
    code: {
      coding: [
        {
          system: HCPCS_SYSTEM,
          code: line.procedure,
        },
      ],
    },
    subject: { reference: order.patientReference },
    ...(order.encounterReference ? { context: { reference: order.encounterReference } } : {}),
    quantity: { value: line.units },
    priceOverride: { value: line.feeCents / 100, currency: "USD" },
    supportingInformation: [{ reference: deviceRequestReference }],
  };
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
            system: OSOD_OPTICAL_ADJUSTMENT_SYSTEM,
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

function entry(fullUrl: string, resource: DeviceRequest | Task | ChargeItem | Invoice) {
  return {
    fullUrl,
    resource,
    request: { method: "POST" as const, url: resource.resourceType },
  };
}

function rxValues(
  lens: VisionPrescriptionLensSpecification | undefined,
  eye: "OD" | "OS",
): Record<(typeof RX_COLUMNS)[number], string> {
  const firstPrism = lens?.prism?.[0];
  return {
    Sphere: formatNumber(lens?.sphere),
    Cylinder: formatNumber(lens?.cylinder),
    Axis: formatNumber(lens?.axis),
    "Dist(PD)": "",
    "Near(PD)": "",
    Form: lens?.product.text ?? "",
    "I/O": firstPrism?.base === "in" || firstPrism?.base === "out" ? firstPrism.base.toUpperCase() : "",
    Prism: formatNumber(firstPrism?.amount),
    "U/D": firstPrism?.base === "up" || firstPrism?.base === "down" ? firstPrism.base.toUpperCase() : "",
    BSize: "",
    Base: firstPrism?.base ?? "",
    "Lens CPT": "",
    Remarks: lens?.note?.map((note) => note.text).filter(Boolean).join("; ") ?? "",
    Add: formatNumber(lens?.add),
    Seght: "",
    Eye: eye,
    "Prism Units": firstPrism?.amount === undefined ? "" : "PD",
    "Prism Pts": formatNumber(firstPrism?.amount),
  };
}

function opticalOrderStatusConcept(code: OpticalOrderStatusCode) {
  const status = OPTICAL_ORDER_STATUSES.find((candidate) => candidate.code === code);
  if (!status) {
    throw new Error(`Unknown optical order status "${code}".`);
  }
  return {
    coding: [{ system: OSOD_OPTICAL_ORDER_STATUS_SYSTEM, code: status.code, display: status.display }],
    text: status.display,
  };
}

function opticalOrderTypeConcept(code: OpticalOrderTypeCode) {
  const type = OPTICAL_ORDER_TYPES.find((candidate) => candidate.code === code);
  if (!type) {
    throw new Error(`Unknown optical order type "${code}".`);
  }
  return {
    coding: [{ system: OSOD_OPTICAL_ORDER_TYPE_SYSTEM, code: type.code, display: type.display }],
    text: type.display,
  };
}

function paymentTenderExtension(code: PaymentTenderCode) {
  const tender = PAYMENT_TENDERS.find((candidate) => candidate.code === code);
  if (!tender) {
    throw new Error(`Unknown payment tender "${code}".`);
  }
  return {
    url: OSOD_PAYMENT_TENDER_EXTENSION_URL,
    valueCodeableConcept: {
      coding: [{ system: OSOD_PAYMENT_TENDER_SYSTEM, code: tender.code, display: tender.display }],
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
    (coding) => coding.system === OSOD_OPTICAL_ORDER_STATUS_SYSTEM,
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

function createdIdsByRequestResourceType(
  requestBundle: Bundle,
  responseBundle: Bundle,
): Map<string, string[]> {
  const byType = new Map<string, string[]>();
  const requestEntries = requestBundle.entry ?? [];
  const responseEntries = responseBundle.entry ?? [];
  requestEntries.forEach((requestEntry, index) => {
    const resourceType = requestEntry.resource?.resourceType;
    const id = responseEntries[index]?.response?.location?.match(/^[A-Za-z]+\/([^/]+)/)?.[1];
    if (!resourceType || !id) return;
    const ids = byType.get(resourceType) ?? [];
    ids.push(id);
    byType.set(resourceType, ids);
  });
  return byType;
}

function oneCreatedId(created: Map<string, string[]>, resourceType: string): string {
  const ids = created.get(resourceType) ?? [];
  if (ids.length !== 1) {
    throw new Error(`Expected exactly one created ${resourceType}; got ${ids.length}.`);
  }
  return ids[0];
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}
