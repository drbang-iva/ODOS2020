import type { OsodActorRole, OsodAuditEventRecord } from "../authz/osodAudit.js";
import { resolveBusinessActionRole, type PracticeRoleId } from "../authz/roles.js";
import { buildPaymentAuditRecord, type PaymentAuditEventType } from "./payment-audit.js";
import type { DispatchFhirClient, PaymentDispatch } from "./payment-config.js";
import { StaffRoleServiceUnavailableError } from "./payment-endpoint.js";
import type { ChargeRequest, PaymentSurface, TransactionResult } from "./payment-processor-adapter.js";

/**
 * Payment charge endpoint handler — pure orchestration, transport-free so it unit-tests without HTTP.
 *
 * This is the server-side charge boundary the browser-direct cash path never needed: a processor
 * charge (Clover/Stripe) requires the vendor secret, which lives only on osod-core. The handler
 * authenticates the caller (verified staff identity — never a body-supplied one), resolves the
 * configured adapter via the unified dispatch, runs the charge, and lands a payment.* AuditEvent.
 * Real token verification, the caller-bound FHIR client, and audit persistence are injected deps
 * implemented in the osod-core wiring (index.ts). Decision: performance-od
 * decisions/2026-07-05-odos-payment-reconciliation-seam-spec.md + the checkout-boundary follow-up.
 */

export interface AuthenticatedStaff {
  /** Practitioner / PractitionerRole reference for requestor + audit attribution. */
  staffReference: string;
  actorRole: OsodActorRole;
  roles?: readonly PracticeRoleId[];
  /** FHIR client bound to the caller (their token) so Medplum AccessPolicy governs the PR write. */
  fhir: DispatchFhirClient;
}

export interface ChargeHandlerDeps {
  /** Verify the forwarded Medplum bearer token → staff identity + bound FHIR client, or null. */
  authenticate(authHeader: string | undefined): Promise<AuthenticatedStaff | null>;
  dispatch: PaymentDispatch;
  recordAudit(row: OsodAuditEventRecord): Promise<void>;
  now?: () => string;
}

export interface ChargeHandlerResult {
  status: number;
  body: unknown;
}

export async function handlePaymentMethodsRequest(
  deps: Pick<ChargeHandlerDeps, "authenticate" | "dispatch">,
  input: { authHeader: string | undefined },
): Promise<ChargeHandlerResult> {
  let staff: AuthenticatedStaff | null;
  try {
    staff = await deps.authenticate(input.authHeader);
  } catch (error) {
    if (error instanceof StaffRoleServiceUnavailableError) {
      return { status: 503, body: { error: "Payment service temporarily unavailable." } };
    }
    throw error;
  }
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to view payment methods." } };
  }
  return { status: 200, body: { methods: deps.dispatch.methods() } };
}

interface ChargeBody {
  method: string;
  amountCents: number;
  patientReference: string;
  invoiceReference?: string;
  taskReference?: string;
  encounterReference?: string;
  description: string;
  surface: PaymentSurface;
  tender?: { code: string; display?: string };
  inClinicTerminalId?: string;
  onlinePaymentToken?: string;
  financingApplicationId?: string;
}

export async function handleChargeRequest(
  deps: ChargeHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<ChargeHandlerResult> {
  let staff: AuthenticatedStaff | null;
  try {
    staff = await deps.authenticate(input.authHeader);
  } catch (error) {
    if (error instanceof StaffRoleServiceUnavailableError) {
      return { status: 503, body: { error: "Payment service temporarily unavailable." } };
    }
    throw error;
  }
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to take a payment." } };
  }
  const actorRole = resolveBusinessActionRole(staff.roles ?? [], "payment.charge");
  if (!actorRole) {
    return { status: 403, body: { error: "payment.charge role required" } };
  }
  staff = { ...staff, actorRole };

  const parsed = parseChargeBody(input.body);
  if ("error" in parsed) {
    return { status: 400, body: { error: parsed.error } };
  }
  const body = parsed.body;

  let adapter;
  try {
    adapter = deps.dispatch.getAdapter(body.method, staff.fhir);
  } catch (error) {
    return { status: 400, body: { error: messageOf(error) } };
  }

  const chargeRequest: ChargeRequest = {
    amountCents: body.amountCents,
    currency: "USD",
    patientReference: body.patientReference,
    ...(body.invoiceReference ? { invoiceReference: body.invoiceReference } : {}),
    ...(body.taskReference ? { taskReference: body.taskReference } : {}),
    ...(body.encounterReference ? { encounterReference: body.encounterReference } : {}),
    // The verified caller is the payer of record — a body-supplied staffReference is ignored.
    staffReference: staff.staffReference,
    description: body.description,
    surface: body.surface,
    ...(body.tender ? { tender: body.tender } : {}),
    ...(body.inClinicTerminalId ? { inClinicTerminalId: body.inClinicTerminalId } : {}),
    ...(body.onlinePaymentToken ? { onlinePaymentToken: body.onlinePaymentToken } : {}),
    ...(body.financingApplicationId ? { financingApplicationId: body.financingApplicationId } : {}),
  };

  let result: TransactionResult;
  try {
    result = await adapter.charge(chargeRequest);
  } catch (error) {
    await audit(
      deps,
      staff,
      body,
      "payment.charge.failed",
      "failure",
      body.invoiceReference ?? body.patientReference,
      messageOf(error),
    );
    return { status: 502, body: { error: `Payment charge failed: ${messageOf(error)}` } };
  }

  const succeeded = result.outcome === "success" || result.outcome === "pending";
  const paymentRecordReference = result.paymentRecord
    ? `${result.paymentRecord.resourceType}/${result.paymentRecord.id}`
    : body.invoiceReference ?? body.patientReference;
  await audit(
    deps,
    staff,
    body,
    succeeded ? "payment.charge.completed" : "payment.charge.failed",
    succeeded ? "success" : "failure",
    paymentRecordReference,
    result.declineReason,
  );

  return { status: 200, body: result };
}

async function audit(
  deps: ChargeHandlerDeps,
  staff: AuthenticatedStaff,
  body: ChargeBody,
  eventType: PaymentAuditEventType,
  outcome: "success" | "failure",
  paymentRecordReference: string,
  declineReason?: string,
): Promise<void> {
  const now = deps.now?.();
  await deps.recordAudit(
    buildPaymentAuditRecord({
      eventType,
      staffReference: staff.staffReference,
      actorRole: staff.actorRole,
      patientReference: body.patientReference,
      paymentRecordReference,
      purpose: "PATIENT_PAYMENT",
      adapterName: body.method,
      outcome,
      ...(declineReason ? { declineReason } : {}),
      ...(now ? { timestamp: now } : {}),
    }),
  );
}

function parseChargeBody(raw: unknown): { body: ChargeBody } | { error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: "Request body must be a JSON object." };
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.method !== "string" || b.method.length === 0) {
    return { error: "A payment method is required." };
  }
  if (typeof b.amountCents !== "number" || !Number.isInteger(b.amountCents) || b.amountCents <= 0) {
    return { error: "amountCents must be a positive integer number of cents." };
  }
  if (b.invoiceReference !== undefined && (
    typeof b.invoiceReference !== "string" || !/^Invoice\/[^/]+$/.test(b.invoiceReference)
  )) {
    return { error: 'invoiceReference must be a local "Invoice/<id>" reference when supplied.' };
  }
  if (typeof b.patientReference !== "string" || !/^Patient\/[^/]+$/.test(b.patientReference)) {
    return { error: 'patientReference must be a local "Patient/<id>" reference.' };
  }
  if (typeof b.description !== "string" || b.description.length === 0) {
    return { error: "description is required." };
  }
  if (typeof b.surface !== "string") {
    return { error: "surface is required." };
  }
  return { body: b as unknown as ChargeBody };
}

export function staffMayCharge(roles: readonly PracticeRoleId[]): boolean {
  return resolveBusinessActionRole(roles, "payment.charge") !== undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
