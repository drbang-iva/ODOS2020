import type { Application, Request, Response } from "express";
import { resolveBusinessActionRole, type PracticeRoleId } from "../authz/roles.js";
import type { AuthenticatedStaff, ChargeHandlerResult } from "../payments/payment-charge-handler.js";
import {
  CommercialEngineConflictError,
  CommercialEngineInputError,
  type CommercialEngineStore,
  type PackageDefinitionDraft,
} from "./ledger-store.js";
import {
  finalizeCreditBankDeposit,
  prepareCreditBankDeposit,
  spendCreditBankAtCheckout,
} from "./credit-bank-service.js";
import {
  applicablePackages,
  finalizePackageSale,
  preparePackageSale,
  redeemPackageSession,
  type PackageServiceDeps,
} from "./package-service.js";

export interface CommercialEngineRouteDeps extends PackageServiceDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<AuthenticatedStaff | null>;
}

export function registerCommercialEngineRoutes(
  app: Pick<Application, "get" | "post">,
  deps: CommercialEngineRouteDeps,
): void {
  get(app, "/commercial-engine/definitions", deps, (req) => handleDefinitions(deps, req));
  post(app, "/commercial-engine/definitions", deps, (req) => handleSaveDefinition(deps, req));
  post(app, "/commercial-engine/definitions/:id/archive", deps, (req) => handleArchiveDefinition(deps, req));
  get(app, "/commercial-engine/patients/:patientId/packages", deps, (req) => handlePatientPackages(deps, req));
  get(app, "/commercial-engine/patients/:patientId/applicable", deps, (req) => handleApplicablePackages(deps, req));
  get(app, "/commercial-engine/patients/:patientId/credit-bank", deps, (req) => handleCreditBank(deps, req));
  post(app, "/commercial-engine/sales/prepare", deps, (req) => handlePrepareSale(deps, req));
  post(app, "/commercial-engine/sales/finalize", deps, (req) => handleFinalizeSale(deps, req));
  post(app, "/commercial-engine/redemptions", deps, (req) => handleRedemption(deps, req));
  post(app, "/commercial-engine/credit-bank/deposits/prepare", deps, (req) => handlePrepareCreditBankDeposit(deps, req));
  post(app, "/commercial-engine/credit-bank/deposits/finalize", deps, (req) => handleFinalizeCreditBankDeposit(deps, req));
  post(app, "/commercial-engine/credit-bank/spends", deps, (req) => handleCreditBankSpend(deps, req));
  post(app, "/commercial-engine/packages/convert-to-credit-bank", deps, (req) => handlePackageConversion(deps, req));
  post(app, "/commercial-engine/packages/attest-cash-refund", deps, (req) => handlePackageCashRefund(deps, req));
}

async function handleDefinitions(deps: CommercialEngineRouteDeps, req: Request): Promise<ChargeHandlerResult> {
  const staff = await authenticated(deps, req);
  if (!staff) return unauthorized();
  return { status: 200, body: { definitions: await deps.store.listDefinitions({ includeArchived: req.query.includeArchived === "true" }) } };
}

async function handleSaveDefinition(deps: CommercialEngineRouteDeps, req: Request): Promise<ChargeHandlerResult> {
  const staff = await authenticated(deps, req);
  if (!staff) return unauthorized();
  if (!staff.roles?.includes("practice-admin")) return forbidden("Practice-admin role required.");
  const draft = definitionDraft(req.body);
  return { status: 200, body: { definition: await deps.store.saveDefinition(draft) } };
}

async function handleArchiveDefinition(deps: CommercialEngineRouteDeps, req: Request): Promise<ChargeHandlerResult> {
  const staff = await authenticated(deps, req);
  if (!staff) return unauthorized();
  if (!staff.roles?.includes("practice-admin")) return forbidden("Practice-admin role required.");
  const id = typeof req.params.id === "string" ? req.params.id : "";
  const definition = await deps.store.archiveDefinition(id);
  return definition ? { status: 200, body: { definition } } : { status: 404, body: { error: "Package definition not found." } };
}

async function handlePatientPackages(deps: CommercialEngineRouteDeps, req: Request): Promise<ChargeHandlerResult> {
  const staff = await authenticated(deps, req);
  if (!staff) return unauthorized();
  if (!mayReadPatientPackages(staff.roles ?? [])) return forbidden("Patient package read role required.");
  const patientId = patientIdParam(req);
  return { status: 200, body: { packages: await deps.store.listPatientPackages(patientId) } };
}

async function handleApplicablePackages(deps: CommercialEngineRouteDeps, req: Request): Promise<ChargeHandlerResult> {
  const staff = await authenticated(deps, req);
  if (!staff) return unauthorized();
  if (!mayReadPatientPackages(staff.roles ?? [])) return forbidden("Patient package read role required.");
  const patientId = patientIdParam(req);
  const codes = stringList(req.query.procedureCode);
  if (codes.length === 0) throw new CommercialEngineInputError("At least one procedureCode is required.");
  const packages = await deps.store.listPatientPackages(patientId);
  return { status: 200, body: { packages: applicablePackages(packages, codes, (deps.now?.() ?? new Date().toISOString()).slice(0, 10)) } };
}

async function handleCreditBank(deps: CommercialEngineRouteDeps, req: Request): Promise<ChargeHandlerResult> {
  const staff = await authenticated(deps, req);
  if (!staff) return unauthorized();
  if (!mayReadPatientPackages(staff.roles ?? [])) return forbidden("Patient Credit Bank read role required.");
  return { status: 200, body: { creditBank: await deps.store.getCreditBank(patientIdParam(req)) } };
}

async function handlePrepareSale(deps: CommercialEngineRouteDeps, req: Request): Promise<ChargeHandlerResult> {
  const staff = await paymentStaff(deps, req);
  if ("status" in staff) return staff;
  const body = record(req.body);
  const result = await preparePackageSale(deps, staff.fhir, {
    patientReference: requiredString(body.patientReference, "patientReference"),
    definitionId: requiredString(body.definitionId, "definitionId"),
    staffReference: staff.staffReference,
  });
  return { status: 200, body: { invoiceReference: `Invoice/${result.invoice.id}`, definition: result.definition } };
}

async function handleFinalizeSale(deps: CommercialEngineRouteDeps, req: Request): Promise<ChargeHandlerResult> {
  const staff = await paymentStaff(deps, req);
  if ("status" in staff) return staff;
  const body = record(req.body);
  const packageInstance = await finalizePackageSale(deps, staff.fhir, {
    patientReference: requiredString(body.patientReference, "patientReference"),
    definitionId: requiredString(body.definitionId, "definitionId"),
    invoiceReference: requiredString(body.invoiceReference, "invoiceReference"),
    staffReference: staff.staffReference,
  });
  return { status: 200, body: { package: packageInstance } };
}

async function handleRedemption(deps: CommercialEngineRouteDeps, req: Request): Promise<ChargeHandlerResult> {
  const staff = await paymentStaff(deps, req);
  if ("status" in staff) return staff;
  const body = record(req.body);
  const result = await redeemPackageSession(deps, staff.fhir, {
    patientReference: requiredString(body.patientReference, "patientReference"),
    packageInstanceId: requiredString(body.packageInstanceId, "packageInstanceId"),
    procedureReference: requiredString(body.procedureReference, "procedureReference"),
    chargeItemReference: requiredString(body.chargeItemReference, "chargeItemReference"),
    staffReference: staff.staffReference,
  });
  return { status: 200, body: result };
}

async function handlePrepareCreditBankDeposit(
  deps: CommercialEngineRouteDeps,
  req: Request,
): Promise<ChargeHandlerResult> {
  const staff = await paymentStaff(deps, req);
  if ("status" in staff) return staff;
  const body = record(req.body);
  const bonusCents = optionalNumber(body.bonusCents, "bonusCents") ?? 0;
  if (bonusCents > 0 && !staff.roles?.includes("practice-admin")) {
    return forbidden("Practice-admin role required for promotional bonus credit.");
  }
  const invoice = await prepareCreditBankDeposit(deps, staff.fhir, {
    patientReference: requiredString(body.patientReference, "patientReference"),
    depositCents: requiredNumber(body.depositCents, "depositCents"),
    bonusCents,
    ...(typeof body.bonusReason === "string" ? { bonusReason: body.bonusReason } : {}),
    staffReference: staff.staffReference,
  });
  return { status: 200, body: { invoiceReference: `Invoice/${invoice.id}` } };
}

async function handleFinalizeCreditBankDeposit(
  deps: CommercialEngineRouteDeps,
  req: Request,
): Promise<ChargeHandlerResult> {
  const staff = await paymentStaff(deps, req);
  if ("status" in staff) return staff;
  const body = record(req.body);
  const creditBank = await finalizeCreditBankDeposit(deps, staff.fhir, {
    patientReference: requiredString(body.patientReference, "patientReference"),
    invoiceReference: requiredString(body.invoiceReference, "invoiceReference"),
    staffReference: staff.staffReference,
    allowBonus: Boolean(staff.roles?.includes("practice-admin")),
  });
  return { status: 200, body: { creditBank } };
}

async function handleCreditBankSpend(deps: CommercialEngineRouteDeps, req: Request): Promise<ChargeHandlerResult> {
  const staff = await paymentStaff(deps, req);
  if ("status" in staff) return staff;
  const body = record(req.body);
  const result = await spendCreditBankAtCheckout(deps, staff.fhir, {
    patientReference: requiredString(body.patientReference, "patientReference"),
    chargeItemReference: requiredString(body.chargeItemReference, "chargeItemReference"),
    staffReference: staff.staffReference,
  });
  return { status: 200, body: result };
}

async function handlePackageConversion(deps: CommercialEngineRouteDeps, req: Request): Promise<ChargeHandlerResult> {
  const staff = await practiceAdmin(deps, req);
  if ("status" in staff) return staff;
  const body = record(req.body);
  const patientReference = requiredString(body.patientReference, "patientReference");
  const result = await deps.store.convertPackageToCreditBank({
    packageInstanceId: requiredString(body.packageInstanceId, "packageInstanceId"),
    patientFhirId: localPatientId(patientReference),
    actorUserId: staff.staffReference,
    reason: requiredString(body.reason, "reason"),
    convertedAt: deps.now?.() ?? new Date().toISOString(),
  });
  return { status: 200, body: result };
}

async function handlePackageCashRefund(deps: CommercialEngineRouteDeps, req: Request): Promise<ChargeHandlerResult> {
  const staff = await practiceAdmin(deps, req);
  if ("status" in staff) return staff;
  const body = record(req.body);
  const patientReference = requiredString(body.patientReference, "patientReference");
  const result = await deps.store.attestPackageCashRefund({
    packageInstanceId: requiredString(body.packageInstanceId, "packageInstanceId"),
    patientFhirId: localPatientId(patientReference),
    actorUserId: staff.staffReference,
    reason: requiredString(body.reason, "reason"),
    externalReference: requiredString(body.externalReference, "externalReference"),
    refundedAt: deps.now?.() ?? new Date().toISOString(),
  });
  return { status: 200, body: result };
}

async function paymentStaff(
  deps: CommercialEngineRouteDeps,
  req: Request,
): Promise<AuthenticatedStaff | ChargeHandlerResult> {
  const staff = await authenticated(deps, req);
  if (!staff) return unauthorized();
  if (!resolveBusinessActionRole(staff.roles ?? [], "payment.charge")) return forbidden("payment.charge role required");
  return staff;
}

async function practiceAdmin(
  deps: CommercialEngineRouteDeps,
  req: Request,
): Promise<AuthenticatedStaff | ChargeHandlerResult> {
  const staff = await authenticated(deps, req);
  if (!staff) return unauthorized();
  if (!staff.roles?.includes("practice-admin")) return forbidden("Practice-admin role required.");
  return staff;
}

async function authenticated(deps: CommercialEngineRouteDeps, req: Request): Promise<AuthenticatedStaff | null> {
  return deps.authenticate(req.header("authorization"));
}

function mayReadPatientPackages(roles: readonly PracticeRoleId[]): boolean {
  return Boolean(resolveBusinessActionRole(roles, "chart.read") || resolveBusinessActionRole(roles, "payment.charge"));
}

function definitionDraft(value: unknown): PackageDefinitionDraft {
  const body = record(value);
  return {
    ...(typeof body.id === "string" && body.id ? { id: body.id } : {}),
    name: requiredString(body.name, "name"),
    eligibleProcedureTypeCodes: stringList(body.eligibleProcedureTypeCodes),
    sessionCount: requiredNumber(body.sessionCount, "sessionCount"),
    priceCents: requiredNumber(body.priceCents, "priceCents"),
    expiryDays: requiredNumber(body.expiryDays ?? 365, "expiryDays"),
    refundPolicy: requiredString(body.refundPolicy ?? "non_refundable", "refundPolicy") as PackageDefinitionDraft["refundPolicy"],
  };
}

function patientIdParam(req: Request): string {
  const patientId = typeof req.params.patientId === "string" ? req.params.patientId : "";
  if (!/^[A-Za-z0-9.-]+$/.test(patientId)) throw new CommercialEngineInputError("Patient id is invalid.");
  return patientId;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CommercialEngineInputError("Request body must be a JSON object.");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CommercialEngineInputError(`${label} is required.`);
  return value.trim();
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number") throw new CommercialEngineInputError(`${label} must be a number.`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return requiredNumber(value, label);
}

function localPatientId(reference: string): string {
  const match = reference.match(/^Patient\/([A-Za-z0-9.-]+)$/);
  if (!match) throw new CommercialEngineInputError("patientReference is invalid.");
  return match[1];
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function unauthorized(): ChargeHandlerResult {
  return { status: 401, body: { error: "Authentication required." } };
}

function forbidden(error: string): ChargeHandlerResult {
  return { status: 403, body: { error } };
}

function get(
  app: Pick<Application, "get">,
  path: string,
  deps: CommercialEngineRouteDeps,
  dispatch: (req: Request) => Promise<ChargeHandlerResult>,
): void {
  app.get(path, async (req, res) => route(path, deps, req, res, dispatch));
}

function post(
  app: Pick<Application, "post">,
  path: string,
  deps: CommercialEngineRouteDeps,
  dispatch: (req: Request) => Promise<ChargeHandlerResult>,
): void {
  app.post(path, async (req, res) => route(path, deps, req, res, dispatch));
}

async function route(
  path: string,
  deps: CommercialEngineRouteDeps,
  req: Request,
  res: Response,
  dispatch: (req: Request) => Promise<ChargeHandlerResult>,
): Promise<void> {
  try {
    await deps.authenticateService();
    const result = await dispatch(req);
    res.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof CommercialEngineInputError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof CommercialEngineConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error(`odos-mcp: ${path} failed:`, error);
    if (!res.headersSent) res.status(500).json({ error: "commercial engine route failed" });
  }
}
