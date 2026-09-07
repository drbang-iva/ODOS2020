import { randomUUID } from "node:crypto";
import type { Bundle, ChargeItem, Invoice, PaymentReconciliation } from "@medplum/fhirtypes";
import type { OdosAuditEventRecord } from "../authz/odosAudit.js";
import { resolveBusinessActionRole, type PracticeRoleId } from "../authz/roles.js";
import type { MedplumClient } from "../fhir-client.js";
import { buildOpticalInvoice } from "../fhir/opticalInvoice.js";
import { ODOS_PAYMENT_TENDER_EXTENSION_URL } from "../fhir/odosPaymentTender.js";
import { isRelativeFhirReference } from "../fhir/reference.js";
import {
  createOpticalCashOrder,
  type CreatedOpticalCashOrderIds,
} from "../optical-order-lifecycle-service.js";
import type { AssembleOpticalCashOrderInput } from "../fhir/opticalOrderComposite.js";
import { buildPaymentAuditRecord } from "./payment-audit.js";
import { StaffRoleServiceUnavailableError } from "./payment-endpoint.js";
import type { ChargeHandlerResult } from "./payment-charge-handler.js";
import {
  HL7_PAYMENT_TYPE_SYSTEM,
  INSURANCE_CHARGE_ITEM_ALLOCATION_DETAIL_CODE,
  ODOS_INSURANCE_PAYMENT_DETAIL_LEVEL_SYSTEM,
} from "./payment-reconciliation.js";
import { assertDayNotSealed, DayAlreadySealedError } from "../desk/day-seal.js";
import { ODOS_UNPRICED_CHARGE_EXTENSION_URL } from "../clinical-graph/procedure-fee-schedule.js";

export type CollectionFhirClient = Pick<MedplumClient, "read" | "search" | "executeTransaction">;

export const ODOS_COLLECTION_REQUEST_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/collection-request";

export interface CollectionAuthenticatedStaff {
  staffReference: string;
  actorRole: PracticeRoleId;
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
  openCents: number | null;
  attributedCents: number;
  ambiguityReason?: string;
  attributionWarning?: string;
  description: string;
  date: string;
  source: "optical" | "other";
  unpriced: boolean;
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
  requestId: string;
  patientReference: string;
  selectedOpenChargeLineIds: string[];
  amountCents: number;
  tender: "CASH" | "CHECK" | "CARD_MANUAL";
  opticalOrder?: OpticalOrderDraft;
}

interface CollectionCreationResult extends CreatedOpticalCashOrderIds {
  replayed: boolean;
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
  const items = openChargeLines(
    (chargeBundle.entry ?? []).flatMap((entry) => entry.resource ?? []),
    (invoiceBundle.entry ?? []).flatMap((entry) => entry.resource ?? []),
    (paymentBundle.entry ?? []).flatMap((entry) => entry.resource ?? []),
  );
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

  let created: CollectionCreationResult;
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
  if (!created.replayed) {
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
  }
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
): Promise<CollectionCreationResult> {
  if (body.opticalOrder) {
    await assertDayNotSealed(fhir, collectedAt, timeZone);
    assertPositiveCollectionAmount(body.amountCents);
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
    const created = await createOpticalCashOrder(fhir, {
      ...body.opticalOrder,
      charges: charges.map(({ id: _id, ...charge }) => charge),
      tender: body.tender,
      date: collectedAt,
      staffReference,
    });
    // M5 owns idempotency for this multi-resource optical transaction; M1b protects only recorded-tender Invoice creation.
    return { ...created, replayed: false };
  }

  const existing = await findCollectionByRequestId(fhir, body.requestId);
  if (existing) return replayedCollection(existing, body);
  await assertDayNotSealed(fhir, collectedAt, timeZone);

  const chargeItems = await Promise.all(body.selectedOpenChargeLineIds.map((id) =>
    fhir.read<ChargeItem>("ChargeItem", id),
  ));
  for (const chargeItem of chargeItems) {
    if (!chargeItem.id || chargeItem.subject.reference !== body.patientReference) {
      throw new CollectionInputError("Every selected ChargeItem must belong to the requested patient.");
    }
    if (chargeItem.status !== "billable") {
      throw new CollectionInputError(`ChargeItem/${chargeItem.id} is not billable.`);
    }
    if (isUnpricedCharge(chargeItem)) {
      throw new CollectionInputError(
        `ChargeItem/${chargeItem.id} (${chargeDescription(chargeItem)}) requires a fee schedule entry before it can be collected.`,
      );
    }
  }
  const settlements = await loadChargeSettlements(fhir, body.patientReference, chargeItems);
  const lines = chargeItems.map((chargeItem) => {
    const reference = `ChargeItem/${chargeItem.id!}`;
    const settlement = settlements.get(reference)!;
    if (settlement.ambiguityReason) {
      throw new CollectionInputError(
        `${reference} cannot be collected because its open amount is ambiguous: ${settlement.ambiguityReason}`,
      );
    }
    if (settlement.attributionWarning) {
      throw new CollectionInputError(
        `${reference} cannot be collected because its attributed amount is inconsistent: ${settlement.attributionWarning}`,
      );
    }
    if (settlement.openCents === 0) {
      throw new CollectionInputError(`${reference} has zero open amount and cannot be collected.`);
    }
    return { chargeItemReference: reference, amountCents: settlement.openCents! };
  });
  assertPositiveCollectionAmount(body.amountCents);
  const totalCents = lines.reduce((total, line) => total + line.amountCents, 0);
  assertCollectionAmount(body.amountCents, totalCents);
  const invoice: Invoice = {
    ...buildOpticalInvoice({
    patientReference: body.patientReference,
    date: collectedAt,
    staffReference,
    lineItems: lines,
    tender: body.tender,
    status: "balanced",
    }),
    identifier: [{ system: ODOS_COLLECTION_REQUEST_IDENTIFIER_SYSTEM, value: body.requestId }],
  };
  const fullUrl = `urn:uuid:${randomUUID()}`;
  const request: Bundle = {
    resourceType: "Bundle",
    type: "transaction",
    entry: [{
      fullUrl,
      resource: invoice,
      request: {
        method: "POST",
        url: "Invoice",
        // Same-request replay is atomic; different request ids can still race on one ChargeItem.
        ifNoneExist: `identifier=${ODOS_COLLECTION_REQUEST_IDENTIFIER_SYSTEM}|${body.requestId}`,
      },
    }],
  };
  const response = await fhir.executeTransaction(request);
  const transactionResponse = response.entry?.[0]?.response;
  const invoiceId = transactionResponse?.location?.match(/^Invoice\/([^/]+)/)?.[1];
  if (!invoiceId) throw new Error("Collection transaction did not return an Invoice id.");
  const replayed = transactionResponse?.status?.startsWith("200") ?? false;
  if (replayed) {
    return replayedCollection(await fhir.read<Invoice>("Invoice", invoiceId), body);
  }
  return {
    deviceRequestId: "",
    taskId: "",
    invoiceId,
    chargeItemIds: chargeItems.map((chargeItem) => chargeItem.id!),
    replayed: false,
  };
}

interface ChargeSettlement {
  attributedCents: number;
  openCents: number | null;
  ambiguityReason?: string;
  attributionWarning?: string;
}

async function findCollectionByRequestId(
  fhir: CollectionFhirClient,
  requestId: string,
): Promise<Invoice | undefined> {
  const bundle = await fhir.search<Invoice>("Invoice", {
    identifier: `${ODOS_COLLECTION_REQUEST_IDENTIFIER_SYSTEM}|${requestId}`,
    _count: "2",
  });
  if (bundle.link?.some((link) => link.relation === "next")) {
    throw new CollectionInputError(`Collection request ${requestId} matched more than one Invoice.`);
  }
  const invoices = (bundle.entry ?? []).flatMap((entry) => entry.resource ?? []);
  if (invoices.length > 1) {
    throw new CollectionInputError(`Collection request ${requestId} matched more than one Invoice.`);
  }
  return invoices[0];
}

function replayedCollection(invoice: Invoice, body: CollectionBody): CollectionCreationResult {
  const invoiceReference = `Invoice/${invoice.id ?? "(unknown)"}`;
  const chargeItemIds = (invoice.lineItem ?? []).flatMap((line) => {
    const match = line.chargeItemReference?.reference?.match(/^ChargeItem\/([A-Za-z0-9.-]+)$/);
    return match ? [match[1]] : [];
  });
  const sameChargeItems = [...chargeItemIds].sort().join("\n")
    === [...body.selectedOpenChargeLineIds].sort().join("\n");
  const sameTender = invoice.extension?.some((extension) =>
    extension.url === ODOS_PAYMENT_TENDER_EXTENSION_URL
    && extension.valueCodeableConcept?.coding?.some((coding) => coding.code === body.tender),
  ) ?? false;
  if (
    !invoice.id
    || invoice.subject?.reference !== body.patientReference
    || !sameChargeItems
    || optionalMoneyCents(invoice.totalNet?.value, invoice.totalNet?.currency, `${invoiceReference} totalNet`)
      !== body.amountCents
    || !sameTender
  ) {
    throw new CollectionInputError(`requestId ${body.requestId} was already used for a different collection.`);
  }
  return {
    deviceRequestId: "",
    taskId: "",
    invoiceId: invoice.id,
    chargeItemIds,
    replayed: true,
  };
}

async function loadChargeSettlements(
  fhir: CollectionFhirClient,
  patientReference: string,
  chargeItems: ChargeItem[],
): Promise<Map<string, ChargeSettlement>> {
  const [invoiceBundle, paymentBundle] = await Promise.all([
    fhir.search<Invoice>("Invoice", { subject: patientReference, _count: "1000" }),
    fhir.search<PaymentReconciliation>("PaymentReconciliation", { status: "active", _count: "1000" }),
  ]);
  if ([invoiceBundle, paymentBundle].some((bundle) => bundle.link?.some((link) => link.relation === "next"))) {
    throw new CollectionInputError("Open-charge query exceeded one FHIR page; refusing a partial balance.");
  }
  return chargeSettlements(
    chargeItems,
    (invoiceBundle.entry ?? []).flatMap((entry) => entry.resource ?? []),
    (paymentBundle.entry ?? []).flatMap((entry) => entry.resource ?? []),
  );
}

function openChargeLines(
  chargeItems: ChargeItem[],
  invoices: Invoice[],
  payments: PaymentReconciliation[],
): OpenChargeLine[] {
  const settlements = chargeSettlements(chargeItems, invoices, payments);
  return chargeItems.flatMap((chargeItem) => {
    if (!chargeItem.id || chargeItem.status !== "billable") return [];
    const settlement = settlements.get(`ChargeItem/${chargeItem.id}`)!;
    return settlement.openCents !== 0 || settlement.ambiguityReason || settlement.attributionWarning || isUnpricedCharge(chargeItem)
      ? openChargeLine(chargeItem, settlement)
      : [];
  });
}

function chargeSettlements(
  chargeItems: ChargeItem[],
  invoices: Invoice[],
  payments: PaymentReconciliation[],
): Map<string, ChargeSettlement> {
  const attributedByCharge = new Map<string, number>();
  const ambiguityByCharge = new Map<string, string>();

  for (const payment of payments) {
    if (payment.status !== "active") continue;
    for (const detail of payment.detail ?? []) {
      if (!detailHasCode(
        detail,
        ODOS_INSURANCE_PAYMENT_DETAIL_LEVEL_SYSTEM,
        INSURANCE_CHARGE_ITEM_ALLOCATION_DETAIL_CODE,
      )) continue;
      const reference = detail.request?.reference;
      if (!reference) continue;
      addCents(
        attributedByCharge,
        reference,
        moneyCents(detail.amount?.value, detail.amount?.currency, `${paymentReference(payment)} ChargeItem allocation`),
      );
    }
  }

  for (const invoice of invoices) {
    if (!invoice.id) continue;
    const invoiceReference = `Invoice/${invoice.id}`;
    const allocatedCents = payments.filter((payment) => payment.status === "active").reduce(
      (total, payment) => total + (payment.detail ?? []).reduce(
        (paymentTotal, detail) => detail.request?.reference === invoiceReference && detailHasCode(
          detail,
          HL7_PAYMENT_TYPE_SYSTEM,
          "payment",
        )
          ? paymentTotal + moneyCents(
            detail.amount?.value,
            detail.amount?.currency,
            `${paymentReference(payment)} ${invoiceReference} allocation`,
          )
          : paymentTotal,
        0,
      ),
      0,
    );
    const totalNetCents = optionalMoneyCents(
      invoice.totalNet?.value,
      invoice.totalNet?.currency,
      `${invoiceReference} totalNet`,
    );
    const hasTenderMarker = invoice.extension?.some(
      (extension) => extension.url === ODOS_PAYMENT_TENDER_EXTENSION_URL,
    ) ?? false;
    const fullySettled = invoice.status === "balanced"
      || (totalNetCents !== undefined && allocatedCents === totalNetCents);

    if (fullySettled) {
      for (const line of invoice.lineItem ?? []) {
        const chargeReference = line.chargeItemReference?.reference;
        if (!chargeReference) continue;
        addCents(attributedByCharge, chargeReference, invoiceLineCents(line, invoiceReference));
      }
      continue;
    }
    if (allocatedCents !== 0 || hasTenderMarker) {
      for (const line of invoice.lineItem ?? []) {
        const chargeReference = line.chargeItemReference?.reference;
        if (!chargeReference) continue;
        // Match statements.ts:300: when payment attribution is ambiguous, refuse rather than inventing a split.
        ambiguityByCharge.set(
          chargeReference,
          allocatedCents !== 0
            ? `${invoiceReference} has a partial ${allocatedCents}-cent allocation against ${totalNetCents ?? "unknown"} net cents; the charge-level open amount is ambiguous.`
            : `${invoiceReference} is issued with a tender marker but no persisted tender amount; the charge-level open amount is ambiguous.`,
        );
      }
    }
  }

  return new Map(chargeItems.flatMap((chargeItem) => {
    if (!chargeItem.id || chargeItem.status !== "billable") return [];
    const reference = `ChargeItem/${chargeItem.id}`;
    const amountCents = chargeAmountCents(chargeItem);
    const attributedCents = attributedByCharge.get(reference) ?? 0;
    const ambiguityReason = ambiguityByCharge.get(reference);
    const attributionWarning = attributedCents > amountCents
      ? `${reference} has ${attributedCents} attributed cents against its ${amountCents}-cent charge amount.`
      : attributedCents < 0
        ? `${reference} has ${attributedCents} net attributed cents; reversing allocations exceed recorded positive allocations.`
        : undefined;
    const settlement: ChargeSettlement = {
      attributedCents,
      openCents: ambiguityReason ? null : Math.min(amountCents, Math.max(0, amountCents - attributedCents)),
      ...(ambiguityReason ? { ambiguityReason } : {}),
      ...(attributionWarning ? { attributionWarning } : {}),
    };
    return [[reference, settlement] as const];
  }));
}

function openChargeLine(chargeItem: ChargeItem, settlement: ChargeSettlement): OpenChargeLine[] {
  if (!chargeItem.id) return [];
  const coding = chargeItem.code?.coding?.[0];
  const amountCents = chargeAmountCents(chargeItem);
  return [{
    id: chargeItem.id,
    amountCents,
    ...settlement,
    description: chargeDescription(chargeItem),
    date: chargeItem.occurrenceDateTime ?? chargeItem.enteredDate ?? "",
    source: chargeItem.supportingInformation?.some((reference) =>
      reference.reference?.startsWith("DeviceRequest/"),
    ) ? "optical" : "other",
    unpriced: isUnpricedCharge(chargeItem),
    ...(coding?.code ? { code: coding.code } : {}),
    ...(chargeItem.quantity?.value ? { quantity: chargeItem.quantity.value } : {}),
    ...(procedureReference(chargeItem) ? { procedureReference: procedureReference(chargeItem) } : {}),
    feeCents: amountCents,
  }];
}

function addCents(target: Map<string, number>, reference: string, amountCents: number): void {
  target.set(reference, (target.get(reference) ?? 0) + amountCents);
}

function detailHasCode(
  detail: NonNullable<PaymentReconciliation["detail"]>[number],
  system: string,
  code: string,
): boolean {
  return detail.type.coding?.some((coding) => coding.system === system && coding.code === code) ?? false;
}

function invoiceLineCents(
  line: NonNullable<Invoice["lineItem"]>[number],
  invoiceReference: string,
): number {
  return (line.priceComponent ?? []).reduce((total, component) => {
    const cents = moneyCents(
      component.amount?.value,
      component.amount?.currency,
      `${invoiceReference} ${component.type} line amount`,
    );
    if (component.type === "informational") return total;
    return component.type === "discount" || component.type === "deduction"
      ? total - cents
      : total + cents;
  }, 0);
}

function optionalMoneyCents(
  value: number | undefined,
  currency: string | undefined,
  label: string,
): number | undefined {
  return value === undefined ? undefined : moneyCents(value, currency, label);
}

function moneyCents(value: number | undefined, currency: string | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (currency && currency !== "USD")) {
    throw new Error(`${label} must be a finite USD amount.`);
  }
  const scaled = value * 100;
  const cents = Math.round(scaled);
  if (Math.abs(scaled - cents) > 0.000001 || !Number.isInteger(cents)) {
    throw new Error(`${label} must resolve to whole cents.`);
  }
  return cents;
}

function paymentReference(payment: PaymentReconciliation): string {
  return `PaymentReconciliation/${payment.id ?? "(unknown)"}`;
}

function isUnpricedCharge(chargeItem: ChargeItem): boolean {
  return chargeItem.extension?.some((extension) =>
    extension.url === ODOS_UNPRICED_CHARGE_EXTENSION_URL && extension.valueBoolean === true,
  ) ?? false;
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

function assertPositiveCollectionAmount(amountCents: number): void {
  if (amountCents <= 0) {
    throw new CollectionInputError("amountCents must be a positive integer number of cents.");
  }
}

function parseCollectionBody(raw: unknown): { body: CollectionBody } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "Request body must be a JSON object." };
  const body = raw as Record<string, unknown>;
  if (typeof body.requestId !== "string" || !isUuid(body.requestId)) {
    return { error: "requestId must be a client-supplied UUID." };
  }
  const patientReference = normalizePatientReference(body.patientReference);
  if (!patientReference) return { error: 'patientReference must be a local "Patient/<id>" reference.' };
  if (!Array.isArray(body.selectedOpenChargeLineIds) || body.selectedOpenChargeLineIds.length === 0 ||
      !body.selectedOpenChargeLineIds.every((id) => typeof id === "string" && /^[A-Za-z0-9.-]+$/.test(id)) ||
      new Set(body.selectedOpenChargeLineIds).size !== body.selectedOpenChargeLineIds.length) {
    return { error: "selectedOpenChargeLineIds must contain unique local charge-line ids." };
  }
  if (typeof body.amountCents !== "number" || !Number.isInteger(body.amountCents) || body.amountCents < 0) {
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
      requestId: body.requestId,
      patientReference,
      selectedOpenChargeLineIds: body.selectedOpenChargeLineIds as string[],
      amountCents: body.amountCents,
      tender: body.tender,
      ...(body.opticalOrder ? {
        opticalOrder: { ...body.opticalOrder as OpticalOrderDraft, patientReference },
      } : {}),
    },
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
): Promise<{ staff: CollectionAuthenticatedStaff; actorRole: PracticeRoleId } | { result: ChargeHandlerResult }> {
  const authenticated = await authenticatedStaff(deps, authHeader);
  if ("result" in authenticated) return authenticated;
  const actorRole = resolveBusinessActionRole(authenticated.staff.roles ?? [], "payment.charge");
  if (!actorRole) return { result: forbidden() };
  return { staff: authenticated.staff, actorRole };
}

function forbidden(): ChargeHandlerResult {
  return { status: 403, body: { error: "payment.charge role required" } };
}

function normalizePatientReference(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const reference = value.startsWith("Patient/") ? value : `Patient/${value}`;
  return isRelativeFhirReference(reference, "Patient") ? reference : undefined;
}

class CollectionInputError extends Error {}
