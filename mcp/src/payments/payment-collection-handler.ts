import { randomUUID } from "node:crypto";
import type { Bundle, ChargeItem, Invoice, PaymentReconciliation } from "@medplum/fhirtypes";
import type { OdosAuditEventRecord } from "../authz/odosAudit.js";
import { resolveBusinessActionRole, type PracticeRoleId } from "../authz/roles.js";
import type { MedplumClient } from "../fhir-client.js";
import { buildOpticalInvoice } from "../fhir/opticalInvoice.js";
import { ODOS_PAYMENT_TENDER_EXTENSION_URL } from "../fhir/odosPaymentTender.js";
import {
  createOpticalCashOrder,
  type CreatedOpticalCashOrderIds,
} from "../optical-order-lifecycle-service.js";
import type { AssembleOpticalCashOrderInput } from "../fhir/opticalOrderComposite.js";
import { buildPaymentAuditRecord } from "./payment-audit.js";
import { StaffRoleServiceUnavailableError } from "./payment-endpoint.js";
import type { ChargeHandlerResult } from "./payment-charge-handler.js";
import { assertDayNotSealed, DayAlreadySealedError } from "../desk/day-seal.js";

export type CollectionFhirClient = Pick<MedplumClient, "read" | "search" | "executeTransaction">;

export interface CollectionAuthenticatedStaff {
  staffReference: string;
  actorRole: "practice-admin" | "clinician" | "front-desk" | "auditor" | "aesthetics-provider";
  roles?: readonly PracticeRoleId[];
  fhir: CollectionFhirClient;
}

export interface PaymentCollectionHandlerDeps {
  authenticate(authHeader: string | undefined): Promise<CollectionAuthenticatedStaff | null>;
  recordAudit(row: OdosAuditEventRecord): Promise<void>;
  now?: () => string;
  timeZone?: string;
}

export interface OpenChargeLine {
  id: string;
  amountCents: number;
  description: string;
  date: string;
  source: "optical" | "other";
  code?: string;
  quantity?: number;
  feeCents?: number;
  taxCents?: number;
  discount?: { code: string; amountCents: number };
  procedureReference?: string;
}

interface OpticalOrderDraft extends AssembleOpticalCashOrderInput {
  charges: Array<AssembleOpticalCashOrderInput["charges"][number] & { id: string }>;
}

interface CollectionBody {
  patientReference: string;
  selectedOpenChargeLineIds: string[];
  amountCents: number;
  tender: "CASH" | "CHECK" | "CARD_MANUAL";
  opticalOrder?: OpticalOrderDraft;
}

export async function handleOpenChargesRequest(
  deps: Pick<PaymentCollectionHandlerDeps, "authenticate">,
  input: { authHeader: string | undefined; patientReference: string | undefined },
): Promise<ChargeHandlerResult> {
  const staff = await authenticatedStaff(deps, input.authHeader);
  if ("result" in staff) return staff.result;
  const actorRole = resolveBusinessActionRole(staff.staff.roles ?? [], "payment.charge");
  if (!actorRole) return forbidden();

  const patientReference = normalizePatientReference(input.patientReference);
  if (!patientReference) {
    return { status: 400, body: { error: 'patient reference must be a local "Patient/<id>" reference.' } };
  }
  const [chargeBundle, invoiceBundle, paymentBundle] = await Promise.all([
    staff.staff.fhir.search<ChargeItem>("ChargeItem", {
      subject: patientReference,
      _count: "1000",
    }),
    staff.staff.fhir.search<Invoice>("Invoice", { subject: patientReference, _count: "1000" }),
    staff.staff.fhir.search<PaymentReconciliation>("PaymentReconciliation", { status: "active", _count: "1000" }),
  ]);
  if ([chargeBundle, invoiceBundle, paymentBundle].some((bundle) =>
    bundle.link?.some((link) => link.relation === "next"),
  )) {
    return { status: 409, body: { error: "Open-charge query exceeded one FHIR page; refusing a partial balance." } };
  }
  const settledInvoices = new Set((paymentBundle.entry ?? []).flatMap((entry) =>
    (entry.resource?.detail ?? []).flatMap((detail) => detail.request?.reference ?? []),
  ));
  const closedCharges = new Set((invoiceBundle.entry ?? []).flatMap((entry) => {
    const invoice = entry.resource;
    const paid = invoice && (
      invoice.status === "balanced" ||
      invoice.extension?.some((extension) => extension.url === ODOS_PAYMENT_TENDER_EXTENSION_URL) ||
      (invoice.id && settledInvoices.has(`Invoice/${invoice.id}`))
    );
    return paid ? (invoice.lineItem ?? []).flatMap((line) => line.chargeItemReference?.reference ?? []) : [];
  }));
  const items = (chargeBundle.entry ?? []).flatMap((entry) => {
    const chargeItem = entry.resource;
    return chargeItem?.id && chargeItem.status === "billable" && !closedCharges.has(`ChargeItem/${chargeItem.id}`)
      ? openChargeLine(chargeItem)
      : [];
  });
  return { status: 200, body: items };
}

export async function handleRecordedTenderCollectionRequest(
  deps: PaymentCollectionHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<ChargeHandlerResult> {
  const staff = await authorizedStaff(deps, input.authHeader);
  if ("result" in staff) return staff.result;
  const parsed = parseCollectionBody(input.body);
  if ("error" in parsed) return { status: 400, body: { error: parsed.error } };
  const collectedAt = deps.now?.() ?? new Date().toISOString();

  let created: CreatedOpticalCashOrderIds;
  try {
    created = await createCollection(
      staff.staff.fhir,
      parsed.body,
      collectedAt,
      staff.staff.staffReference,
      deps.timeZone,
    );
  } catch (error) {
    if (error instanceof CollectionInputError) {
      return { status: 400, body: { error: error.message } };
    }
    if (error instanceof DayAlreadySealedError) {
      return { status: 409, body: { error: error.message } };
    }
    throw error;
  }
  await deps.recordAudit(buildPaymentAuditRecord({
    eventType: "payment.charge.completed",
    staffReference: staff.staff.staffReference,
    actorRole: staff.actorRole,
    patientReference: parsed.body.patientReference,
    paymentRecordReference: `Invoice/${created.invoiceId}`,
    purpose: "PATIENT_PAYMENT",
    adapterName: "manual-record",
    outcome: "success",
    timestamp: collectedAt,
  }));
  return {
    status: 200,
    body: {
      outcome: "success",
      amountChargedCents: parsed.body.amountCents,
      tender: parsed.body.tender,
      ...created,
    },
  };
}

async function createCollection(
  fhir: CollectionFhirClient,
  body: CollectionBody,
  collectedAt: string,
  staffReference: string,
  timeZone?: string,
): Promise<CreatedOpticalCashOrderIds> {
  await assertDayNotSealed(fhir, collectedAt, timeZone);
  if (body.opticalOrder) {
    if (body.opticalOrder.patientReference !== body.patientReference) {
      throw new CollectionInputError("The optical order patient must match patientReference.");
    }
    const charges = body.opticalOrder.charges.filter((charge) =>
      body.selectedOpenChargeLineIds.includes(charge.id),
    );
    if (charges.length !== body.selectedOpenChargeLineIds.length) {
      throw new CollectionInputError("Every selected optical charge line must exist in the submitted optical order.");
    }
    const totalCents = charges.reduce((total, charge) => total + netChargeCents(charge), 0);
    assertCollectionAmount(body.amountCents, totalCents);
    return createOpticalCashOrder(fhir, {
      ...body.opticalOrder,
      charges: charges.map(({ id: _id, ...charge }) => charge),
      tender: body.tender,
      date: collectedAt,
      staffReference,
    });
  }

  const chargeItems = await Promise.all(body.selectedOpenChargeLineIds.map((id) =>
    fhir.read<ChargeItem>("ChargeItem", id),
  ));
  const lines = chargeItems.map((chargeItem) => {
    if (!chargeItem.id || chargeItem.subject.reference !== body.patientReference) {
      throw new CollectionInputError("Every selected ChargeItem must belong to the requested patient.");
    }
    if (chargeItem.status !== "billable") {
      throw new CollectionInputError(`ChargeItem/${chargeItem.id} is not billable.`);
    }
    return { chargeItemReference: `ChargeItem/${chargeItem.id}`, amountCents: chargeAmountCents(chargeItem) };
  });
  const totalCents = lines.reduce((total, line) => total + line.amountCents, 0);
  assertCollectionAmount(body.amountCents, totalCents);
  const invoice = buildOpticalInvoice({
    patientReference: body.patientReference,
    date: collectedAt,
    staffReference,
    lineItems: lines,
    tender: body.tender,
  });
  const fullUrl = `urn:uuid:${randomUUID()}`;
  const request: Bundle = {
    resourceType: "Bundle",
    type: "transaction",
    entry: [{ fullUrl, resource: invoice, request: { method: "POST", url: "Invoice" } }],
  };
  const response = await fhir.executeTransaction(request);
  const invoiceId = response.entry?.[0]?.response?.location?.match(/^Invoice\/([^/]+)/)?.[1];
  if (!invoiceId) throw new Error("Collection transaction did not return an Invoice id.");
  return {
    deviceRequestId: "",
    taskId: "",
    invoiceId,
    chargeItemIds: chargeItems.map((chargeItem) => chargeItem.id!),
  };
}

function openChargeLine(chargeItem: ChargeItem): OpenChargeLine[] {
  if (!chargeItem.id) return [];
  const coding = chargeItem.code?.coding?.[0];
  const amountCents = chargeAmountCents(chargeItem);
  return [{
    id: chargeItem.id,
    amountCents,
    description: chargeDescription(chargeItem),
    date: chargeItem.occurrenceDateTime ?? chargeItem.enteredDate ?? "",
    source: chargeItem.supportingInformation?.some((reference) =>
      reference.reference?.startsWith("DeviceRequest/"),
    ) ? "optical" : "other",
    ...(coding?.code ? { code: coding.code } : {}),
    ...(chargeItem.quantity?.value ? { quantity: chargeItem.quantity.value } : {}),
    ...(procedureReference(chargeItem) ? { procedureReference: procedureReference(chargeItem) } : {}),
    feeCents: amountCents,
  }];
}

function procedureReference(chargeItem: ChargeItem): string | undefined {
  return chargeItem.supportingInformation
    ?.map((reference) => reference.reference)
    .find((reference): reference is string => /^Procedure\/[A-Za-z0-9.-]+$/.test(reference ?? ""));
}

function chargeAmountCents(chargeItem: ChargeItem): number {
  const value = chargeItem.priceOverride?.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`ChargeItem/${chargeItem.id ?? "(unknown)"} has no valid priceOverride.`);
  }
  const scaled = value * 100;
  const cents = Math.round(scaled);
  if (Math.abs(scaled - cents) > 0.000001 || !Number.isInteger(cents)) {
    throw new Error(`ChargeItem/${chargeItem.id ?? "(unknown)"} amount is not representable in whole cents.`);
  }
  return cents;
}

function chargeDescription(chargeItem: ChargeItem): string {
  const coding = chargeItem.code?.coding?.[0];
  return chargeItem.code?.text ?? coding?.display ?? coding?.code ?? "Charge";
}

function netChargeCents(charge: AssembleOpticalCashOrderInput["charges"][number]): number {
  if (!Number.isInteger(charge.feeCents) || charge.feeCents < 0) {
    throw new CollectionInputError("Optical charge feeCents must be a nonnegative integer number of cents.");
  }
  const discountCents = charge.discount?.amountCents ?? 0;
  const taxCents = charge.taxCents ?? 0;
  if (!Number.isInteger(taxCents) || taxCents < 0) {
    throw new CollectionInputError("Optical charge taxCents must be a nonnegative integer number of cents.");
  }
  if (!Number.isInteger(discountCents) || discountCents < 0 || discountCents > charge.feeCents) {
    throw new CollectionInputError("Optical charge discount must be whole cents no greater than the fee.");
  }
  return charge.feeCents + taxCents - discountCents;
}

function assertCollectionAmount(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new CollectionInputError(`amountCents must equal the selected open-charge total of ${expected} cents.`);
  }
}

function parseCollectionBody(raw: unknown): { body: CollectionBody } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "Request body must be a JSON object." };
  const body = raw as Record<string, unknown>;
  const patientReference = normalizePatientReference(body.patientReference);
  if (!patientReference) return { error: 'patientReference must be a local "Patient/<id>" reference.' };
  if (!Array.isArray(body.selectedOpenChargeLineIds) || body.selectedOpenChargeLineIds.length === 0 ||
      !body.selectedOpenChargeLineIds.every((id) => typeof id === "string" && /^[A-Za-z0-9.-]+$/.test(id)) ||
      new Set(body.selectedOpenChargeLineIds).size !== body.selectedOpenChargeLineIds.length) {
    return { error: "selectedOpenChargeLineIds must contain unique local charge-line ids." };
  }
  if (typeof body.amountCents !== "number" || !Number.isInteger(body.amountCents) || body.amountCents <= 0) {
    return { error: "amountCents must be a positive integer number of cents." };
  }
  if (body.tender !== "CASH" && body.tender !== "CHECK" && body.tender !== "CARD_MANUAL") {
    return { error: "tender must be CASH, CHECK, or CARD_MANUAL." };
  }
  if (body.opticalOrder !== undefined) {
    if (typeof body.opticalOrder !== "object" || body.opticalOrder === null ||
        !Array.isArray((body.opticalOrder as { charges?: unknown }).charges)) {
      return { error: "opticalOrder must include a charges array." };
    }
    const opticalPatient = normalizePatientReference((body.opticalOrder as { patientReference?: unknown }).patientReference);
    if (opticalPatient !== patientReference) {
      return { error: "opticalOrder.patientReference must match patientReference." };
    }
  }
  return {
    body: {
      patientReference,
      selectedOpenChargeLineIds: body.selectedOpenChargeLineIds as string[],
      amountCents: body.amountCents,
      tender: body.tender,
      ...(body.opticalOrder ? { opticalOrder: body.opticalOrder as OpticalOrderDraft } : {}),
    },
  };
}

async function authenticatedStaff(
  deps: Pick<PaymentCollectionHandlerDeps, "authenticate">,
  authHeader: string | undefined,
): Promise<{ staff: CollectionAuthenticatedStaff } | { result: ChargeHandlerResult }> {
  try {
    const staff = await deps.authenticate(authHeader);
    return staff
      ? { staff }
      : { result: { status: 401, body: { error: "Authentication required to collect a payment." } } };
  } catch (error) {
    if (error instanceof StaffRoleServiceUnavailableError) {
      return { result: { status: 503, body: { error: "Payment service temporarily unavailable." } } };
    }
    throw error;
  }
}

async function authorizedStaff(
  deps: PaymentCollectionHandlerDeps,
  authHeader: string | undefined,
): Promise<{ staff: CollectionAuthenticatedStaff; actorRole: "practice-admin" | "front-desk" } | { result: ChargeHandlerResult }> {
  const authenticated = await authenticatedStaff(deps, authHeader);
  if ("result" in authenticated) return authenticated;
  const actorRole = resolveBusinessActionRole(authenticated.staff.roles ?? [], "payment.charge");
  if (actorRole !== "practice-admin" && actorRole !== "front-desk") return { result: forbidden() };
  return { staff: authenticated.staff, actorRole };
}

function forbidden(): ChargeHandlerResult {
  return { status: 403, body: { error: "payment.charge role required" } };
}

function normalizePatientReference(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const reference = value.startsWith("Patient/") ? value : `Patient/${value}`;
  return /^Patient\/[A-Za-z0-9.-]+$/.test(reference) ? reference : undefined;
}

class CollectionInputError extends Error {}
