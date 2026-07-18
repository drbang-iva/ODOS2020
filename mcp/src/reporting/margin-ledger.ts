import type {
  Bundle,
  ChargeItem,
  ChargeItemDefinition,
  Claim,
  ClaimResponse,
  Invoice,
  InvoiceLineItemPriceComponent,
  PaymentReconciliation,
  Resource,
  Task,
} from "@medplum/fhirtypes";
import { resolveBusinessActionRole, type PracticeRoleId } from "../authz/roles.js";
import { ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL } from "../claims/claimmd-fhir.js";
import {
  ERA_WORKLIST_CODE_SYSTEM,
  ERA_WORKLIST_STATUS_SYSTEM,
} from "../claims/era-worklist.js";
import type { FhirSearchParams, MedplumClient } from "../fhir-client.js";
import { ODOS_PAYMENT_TENDER_EXTENSION_URL } from "../fhir/odosPaymentTender.js";
import { ODOS_WHOLESALE_COST_EXTENSION_URL } from "../catalog/frame-charge-item-definition.js";
import { loadPlanProfiles, type PlanProfile } from "./plan-profiles.js";
import type { ReportingResult } from "./reporting.js";

export const MARGIN_LEDGER_GENESIS_DATE = "2026-07-15";
export const DEFAULT_MARGIN_TARGET_MULTIPLIER_MILLI = 3_000;

const PAGE_LIMIT = "1000";
const CONTACT_IDENTITY_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-contact-lens-product-identity";
const OPTICAL_LAB_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-optical-lab";

export type MarginLineState = "Estimated" | "Settled" | "Flagged";
export type MarginProductClass = "frame" | "contact" | "other";

export interface MarginDeduction {
  label: string;
  amountCents: number;
}

export interface MarginLine {
  id: string;
  chargeItemReference: string;
  productClass: MarginProductClass;
  item: string;
  vendor: string;
  planKey?: string;
  planName: string;
  saleDate: string;
  wholesaleCents: number;
  retailCents: number;
  taxCents: number;
  patientPaidCents: number;
  estimatedPlanPaidCents?: number;
  planPaidCents?: number;
  deductions: MarginDeduction[];
  estimatedMarginCents: number;
  marginCents?: number;
  multiplierMilli?: number;
  driftCents?: number;
  state: MarginLineState;
  unpricedPlanPortion: boolean;
  collectReceiptReferences: string[];
  claimReference?: string;
  claimResponseReference?: string;
  paymentReconciliationReference?: string;
  linkageTaskReference?: string;
}

export interface MarginLedger {
  period: string;
  genesisDate: typeof MARGIN_LEDGER_GENESIS_DATE;
  targetMultiplierMilli: number;
  realizedMarginCents: number;
  inFlightCents: number;
  driftCents: number;
  realizedMultiplierMilli?: number;
  settledLineCount: number;
  inFlightLineCount: number;
  lines: MarginLine[];
}

export interface MarginLedgerFhirClient extends Pick<MedplumClient, "search" | "searchUrl"> {}

export interface MarginLedgerEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    roles?: readonly PracticeRoleId[];
    fhir: MarginLedgerFhirClient;
  } | null>;
  targetMultiplierMilli?: number;
  now?: () => string;
}

export async function handleMarginLedgerRequest(
  deps: MarginLedgerEndpointDeps,
  input: { authHeader: string | undefined; period?: string },
): Promise<ReportingResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to view the margin ledger." } };
  }
  if (!resolveBusinessActionRole(staff.roles ?? [], "margin.read")) {
    return { status: 403, body: { error: "margin.read role required" } };
  }
  const period = input.period ?? (deps.now?.() ?? new Date().toISOString()).slice(0, 7);
  try {
    return {
      status: 200,
      body: await loadMarginLedger(staff.fhir, {
        period,
        targetMultiplierMilli: deps.targetMultiplierMilli,
      }),
    };
  } catch (error) {
    return {
      status: error instanceof MarginLedgerInputError ? 400 : 409,
      body: {
        error: error instanceof MarginLedgerInputError
          ? error.message
          : "Margin ledger unavailable because the complete money story could not be read safely.",
      },
    };
  }
}

export async function loadMarginLedger(
  fhir: MarginLedgerFhirClient,
  options: { period: string; targetMultiplierMilli?: number },
): Promise<MarginLedger> {
  const range = monthRange(options.period);
  const targetMultiplierMilli = options.targetMultiplierMilli
    ?? DEFAULT_MARGIN_TARGET_MULTIPLIER_MILLI;
  assertPositiveInteger(targetMultiplierMilli, "Margin target multiplier");

  const [invoices, reconciliations, claims, responses, tasks, profiles, definitions] = await Promise.all([
    searchComplete<Invoice>(fhir, "Invoice", [
      ["date", `ge${MARGIN_LEDGER_GENESIS_DATE}`],
      ["date", `lt${range.end}`],
      ["_count", PAGE_LIMIT],
      ["_sort", "-date"],
    ]),
    searchComplete<PaymentReconciliation>(fhir, "PaymentReconciliation", [
      ["status", "active"],
      ["created", `ge${MARGIN_LEDGER_GENESIS_DATE}`],
      ["created", `lt${range.end}`],
      ["_count", PAGE_LIMIT],
      ["_sort", "-created"],
    ]),
    searchComplete<Claim>(fhir, "Claim", { _count: PAGE_LIMIT, _sort: "-created" }),
    searchComplete<ClaimResponse>(fhir, "ClaimResponse", { _count: PAGE_LIMIT, _sort: "-created" }),
    searchComplete<Task>(fhir, "Task", {
      code: `${ERA_WORKLIST_CODE_SYSTEM}|era-line-linkage`,
      _count: PAGE_LIMIT,
      _sort: "-authored-on",
    }),
    loadPlanProfiles(fhir, { activeOnly: true }),
    searchComplete<ChargeItemDefinition>(fhir, "ChargeItemDefinition", { _count: PAGE_LIMIT }),
  ]);
  const chargeItemIds = chargeItemReferences(invoices, reconciliations, claims)
    .map(referenceId)
    .filter((id): id is string => Boolean(id));
  const chargeItems = chargeItemIds.length === 0
    ? []
    : await searchComplete<ChargeItem>(fhir, "ChargeItem", {
        _id: [...new Set(chargeItemIds)].join(","),
        _count: PAGE_LIMIT,
      });

  return projectMarginLedger({
    period: options.period,
    targetMultiplierMilli,
    invoices,
    chargeItems,
    definitions,
    claims,
    responses,
    reconciliations,
    tasks,
    profiles,
  });
}

export function projectMarginLedger(input: {
  period: string;
  targetMultiplierMilli?: number;
  invoices: readonly Invoice[];
  chargeItems: readonly ChargeItem[];
  definitions: readonly ChargeItemDefinition[];
  claims: readonly Claim[];
  responses: readonly ClaimResponse[];
  reconciliations: readonly PaymentReconciliation[];
  tasks: readonly Task[];
  profiles: readonly PlanProfile[];
}): MarginLedger {
  const range = monthRange(input.period);
  const targetMultiplierMilli = input.targetMultiplierMilli
    ?? DEFAULT_MARGIN_TARGET_MULTIPLIER_MILLI;
  assertPositiveInteger(targetMultiplierMilli, "Margin target multiplier");

  const definitionsByUrl = new Map(input.definitions.flatMap((definition) =>
    definition.url ? [[definition.url, definition] as const] : [],
  ));
  const chargesByReference = new Map<string, ChargeItem>(input.chargeItems.flatMap((charge) =>
    charge.id ? [[`ChargeItem/${charge.id}`, charge] as const] : [],
  ));
  const claimsByReference = new Map(input.claims.flatMap((claim) =>
    claim.id ? [[`Claim/${claim.id}`, claim] as const] : [],
  ));
  const responsesByReference = new Map(input.responses.flatMap((response) =>
    response.id ? [[`ClaimResponse/${response.id}`, response] as const] : [],
  ));
  const profilesByKey = new Map(input.profiles.map((profile) => [profile.planKey.toLocaleLowerCase(), profile]));
  const claimByCharge = new Map<string, Claim>();
  for (const claim of input.claims) {
    for (const reference of claimChargeItemReferences(claim)) claimByCharge.set(reference, claim);
  }
  const receiptByCharge = invoiceReceipts(input.invoices, input.reconciliations);
  const settlementByCharge = settlements(input.reconciliations, responsesByReference);
  const flaggedByCharge = flaggedLines(input.tasks, responsesByReference, claimsByReference);

  const candidateReferences = new Set([
    ...receiptByCharge.keys(),
    ...settlementByCharge.keys(),
    ...flaggedByCharge.keys(),
  ]);
  const lines = [...candidateReferences].flatMap((chargeReference) => {
    const charge = chargesByReference.get(chargeReference);
    const receipt = receiptByCharge.get(chargeReference);
    if (!charge || !receipt || receipt.saleDate < MARGIN_LEDGER_GENESIS_DATE) return [];
    const claim = claimByCharge.get(chargeReference);
    const settlement = settlementByCharge.get(chargeReference);
    const flagged = flaggedByCharge.get(chargeReference);
    const saleInPeriod = inRange(receipt.saleDate, range);
    const settledInPeriod = settlement ? inRange(settlement.created.slice(0, 10), range) : false;
    const flaggedInPeriod = flagged ? inRange(flagged.authoredOn.slice(0, 10), range) : false;
    if (!saleInPeriod && !settledInPeriod && !flaggedInPeriod) return [];

    const definition = charge.definitionCanonical?.map((url) => definitionsByUrl.get(url)).find(Boolean);
    if (!definition) return [];
    const wholesaleCents = extensionMoneyCents(definition, ODOS_WHOLESALE_COST_EXTENSION_URL);
    if (wholesaleCents === undefined) return [];
    const productClass = productClassFor(definition, charge);
    const planKey = claim?.insurer?.reference;
    const profile = planKey ? profilesByKey.get(planKey.toLocaleLowerCase()) : undefined;
    const estimate = expectedPlanPaidCents(productClass, charge.quantity?.value ?? 1, profile);
    const isSelfPay = !claim;
    const state: MarginLineState = flagged ? "Flagged" : settlement || isSelfPay ? "Settled" : "Estimated";
    const deductions = settlement?.deductions ?? [];
    const planPaidCents = settlement
      ? Math.max(0, settlement.grossPlanPaidCents - sum(deductions.map((deduction) => deduction.amountCents)))
      : isSelfPay ? 0 : undefined;
    const estimatedPlanPaidCents = estimate;
    const estimatedMarginCents = receipt.patientPaidCents + (estimate ?? 0) - wholesaleCents;
    const settledRevenueCents = state === "Settled"
      ? receipt.patientPaidCents + (planPaidCents ?? 0)
      : undefined;
    const marginCents = settledRevenueCents === undefined
      ? undefined
      : settledRevenueCents - wholesaleCents;
    const multiplierMilli = settledRevenueCents === undefined
      ? undefined
      : ratioMilli(settledRevenueCents, wholesaleCents);
    const driftCents = marginCents === undefined || estimate === undefined
      ? undefined
      : marginCents - estimatedMarginCents;
    const identity = definitionIdentity(definition, charge);

    return [{
      id: charge.id ?? chargeReference,
      chargeItemReference: chargeReference,
      productClass,
      item: identity.item,
      vendor: identity.vendor,
      ...(planKey ? { planKey } : {}),
      planName: profile?.displayName ?? (planKey ? referenceLabel(planKey) : "Self-pay"),
      saleDate: receipt.saleDate,
      wholesaleCents,
      retailCents: moneyCents(charge.priceOverride?.value, `${chargeReference} retail`),
      taxCents: receipt.taxCents,
      patientPaidCents: receipt.patientPaidCents,
      ...(estimatedPlanPaidCents !== undefined ? { estimatedPlanPaidCents } : {}),
      ...(state === "Settled" && planPaidCents !== undefined ? { planPaidCents } : {}),
      deductions,
      estimatedMarginCents,
      ...(state === "Settled" && marginCents !== undefined ? { marginCents } : {}),
      ...(state === "Settled" && multiplierMilli !== undefined ? { multiplierMilli } : {}),
      ...(state === "Settled" && driftCents !== undefined ? { driftCents } : {}),
      state,
      unpricedPlanPortion: !isSelfPay && estimate === undefined,
      collectReceiptReferences: receipt.invoiceReferences,
      ...(claim?.id ? { claimReference: `Claim/${claim.id}` } : {}),
      ...(settlement?.claimResponseReference ? { claimResponseReference: settlement.claimResponseReference } : {}),
      ...(settlement?.paymentReconciliationReference
        ? { paymentReconciliationReference: settlement.paymentReconciliationReference }
        : {}),
      ...(flagged ? { linkageTaskReference: flagged.taskReference } : {}),
    } satisfies MarginLine];
  }).sort((left, right) => right.saleDate.localeCompare(left.saleDate) || left.item.localeCompare(right.item));

  const settled = lines.filter((line) => line.state === "Settled");
  const inFlight = lines.filter((line) => line.state !== "Settled");
  const realizedMarginCents = sum(settled.map((line) => line.marginCents ?? 0));
  const settledRevenueCents = sum(settled.map((line) => line.patientPaidCents + (line.planPaidCents ?? 0)));
  const settledWholesaleCents = sum(settled.map((line) => line.wholesaleCents));
  return {
    period: input.period,
    genesisDate: MARGIN_LEDGER_GENESIS_DATE,
    targetMultiplierMilli,
    realizedMarginCents,
    inFlightCents: sum(inFlight.map((line) => line.estimatedMarginCents)),
    driftCents: sum(settled.map((line) => line.driftCents ?? 0)),
    ...(settledWholesaleCents > 0
      ? { realizedMultiplierMilli: ratioMilli(settledRevenueCents, settledWholesaleCents) }
      : {}),
    settledLineCount: settled.length,
    inFlightLineCount: inFlight.length,
    lines,
  };
}

type Settlement = {
  grossPlanPaidCents: number;
  deductions: MarginDeduction[];
  created: string;
  claimResponseReference?: string;
  paymentReconciliationReference?: string;
};

function settlements(
  reconciliations: readonly PaymentReconciliation[],
  responsesByReference: ReadonlyMap<string, ClaimResponse>,
): Map<string, Settlement> {
  const rows = new Map<string, Settlement>();
  for (const reconciliation of reconciliations) {
    const created = reconciliation.created;
    if (!created) continue;
    for (const detail of reconciliation.detail ?? []) {
      const chargeReference = detail.request?.reference;
      if (!/^ChargeItem\/[A-Za-z0-9.-]+$/.test(chargeReference ?? "") || !detail.amount) continue;
      const responseReference = detail.response?.reference;
      const response = responseReference ? responsesByReference.get(responseReference) : undefined;
      const deductions = response ? deductionsForCharge(response, chargeReference!) : [];
      const current = rows.get(chargeReference!);
      rows.set(chargeReference!, {
        grossPlanPaidCents: (current?.grossPlanPaidCents ?? 0)
          + moneyCents(detail.amount.value, `${chargeReference} plan payment`),
        deductions: [...(current?.deductions ?? []), ...deductions],
        created: current && current.created > created ? current.created : created,
        ...(responseReference ? { claimResponseReference: responseReference } : {}),
        ...(reconciliation.id
          ? { paymentReconciliationReference: `PaymentReconciliation/${reconciliation.id}` }
          : {}),
      });
    }
  }
  return rows;
}

function deductionsForCharge(response: ClaimResponse, chargeReference: string): MarginDeduction[] {
  return (response.item ?? []).flatMap((item) => {
    const ownsCharge = item.extension?.some((extension) =>
      extension.url === ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL
      && extension.valueReference?.reference === chargeReference,
    );
    if (!ownsCharge) return [];
    return item.adjudication.flatMap((entry) => {
      const text = entry.category.text?.trim() ?? "";
      if (!/^adjustment\s+/i.test(text) || /^adjustment\s+PR(?:\s|$)/i.test(text) || !entry.amount) return [];
      const amountCents = moneyCents(entry.amount.value, `${chargeReference} ${text}`);
      return amountCents > 0 ? [{ label: deductionLabel(text), amountCents }] : [];
    });
  });
}

function flaggedLines(
  tasks: readonly Task[],
  responsesByReference: ReadonlyMap<string, ClaimResponse>,
  claimsByReference: ReadonlyMap<string, Claim>,
): Map<string, { taskReference: string; authoredOn: string }> {
  const rows = new Map<string, { taskReference: string; authoredOn: string }>();
  for (const task of tasks) {
    const code = task.code?.coding?.find((coding) => coding.system === ERA_WORKLIST_CODE_SYSTEM)?.code;
    const status = task.businessStatus?.coding?.find((coding) => coding.system === ERA_WORKLIST_STATUS_SYSTEM)?.code;
    if (code !== "era-line-linkage" || !["new", "in-review"].includes(status ?? "")) continue;
    const response = task.focus?.reference ? responsesByReference.get(task.focus.reference) : undefined;
    const claim = response?.request?.reference ? claimsByReference.get(response.request.reference) : undefined;
    if (!claim || !task.id) continue;
    for (const reference of claimChargeItemReferences(claim)) {
      rows.set(reference, {
        taskReference: `Task/${task.id}`,
        authoredOn: task.authoredOn ?? task.meta?.lastUpdated ?? MARGIN_LEDGER_GENESIS_DATE,
      });
    }
  }
  return rows;
}

function invoiceReceipts(
  invoices: readonly Invoice[],
  reconciliations: readonly PaymentReconciliation[],
): Map<string, {
  saleDate: string;
  taxCents: number;
  patientPaidCents: number;
  invoiceReferences: string[];
}> {
  const rows = new Map<string, { saleDate: string; taxCents: number; patientPaidCents: number; invoiceReferences: string[] }>();
  const settledInvoices = new Set(reconciliations.flatMap((payment) =>
    payment.detail?.flatMap((detail) => /^Invoice\/[A-Za-z0-9.-]+$/.test(detail.request?.reference ?? "")
      ? [detail.request!.reference!]
      : []) ?? [],
  ));
  for (const invoice of invoices) {
    if (!invoice.date) continue;
    const collected = invoice.status === "balanced"
      || invoice.extension?.some((extension) => extension.url === ODOS_PAYMENT_TENDER_EXTENSION_URL)
      || (invoice.id && settledInvoices.has(`Invoice/${invoice.id}`));
    if (!collected) continue;
    for (const line of invoice.lineItem ?? []) {
      const reference = line.chargeItemReference?.reference;
      if (!/^ChargeItem\/[A-Za-z0-9.-]+$/.test(reference ?? "")) continue;
      const baseCents = componentCents(line.priceComponent, "base");
      const discountCents = componentCents(line.priceComponent, "discount");
      const taxCents = componentCents(line.priceComponent, "tax");
      const current = rows.get(reference!);
      rows.set(reference!, {
        saleDate: current && current.saleDate < invoice.date ? current.saleDate : invoice.date,
        taxCents: (current?.taxCents ?? 0) + taxCents,
        patientPaidCents: (current?.patientPaidCents ?? 0) + baseCents - discountCents,
        invoiceReferences: [
          ...(current?.invoiceReferences ?? []),
          ...(invoice.id ? [`Invoice/${invoice.id}`] : []),
        ],
      });
    }
  }
  return rows;
}

function componentCents(
  components: InvoiceLineItemPriceComponent[] | undefined,
  type: "base" | "discount" | "tax",
): number {
  return sum((components ?? []).flatMap((component) =>
    component.type === type && component.amount
      ? [moneyCents(component.amount.value, `Invoice ${type}`)]
      : [],
  ));
}

function claimChargeItemReferences(claim: Claim): string[] {
  return (claim.item ?? []).flatMap((item) => item.extension?.flatMap((extension) =>
    extension.url === ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL
      && /^ChargeItem\/[A-Za-z0-9.-]+$/.test(extension.valueReference?.reference ?? "")
      ? [extension.valueReference!.reference!]
      : [],
  ) ?? []);
}

function chargeItemReferences(
  invoices: readonly Invoice[],
  reconciliations: readonly PaymentReconciliation[],
  claims: readonly Claim[],
): string[] {
  return [
    ...invoices.flatMap((invoice) => invoice.lineItem?.flatMap((line) => line.chargeItemReference?.reference ?? []) ?? []),
    ...reconciliations.flatMap((payment) => payment.detail?.flatMap((detail) => detail.request?.reference ?? []) ?? []),
    ...claims.flatMap(claimChargeItemReferences),
  ].filter((reference) => /^ChargeItem\/[A-Za-z0-9.-]+$/.test(reference));
}

function expectedPlanPaidCents(
  productClass: MarginProductClass,
  quantity: number,
  profile: PlanProfile | undefined,
): number | undefined {
  if (!profile) return undefined;
  const units = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  if (productClass === "contact") {
    return profile.contactLensPerBoxCents === undefined
      ? undefined
      : profile.contactLensPerBoxCents * units;
  }
  const productCents = productClass === "frame"
    ? profile.frameAllowanceCents
    : profile.lensBaseReimbursementCents;
  if (productCents === undefined && profile.dispensingFeeCents === undefined) return undefined;
  return (productCents ?? 0) + (profile.dispensingFeeCents ?? 0);
}

function productClassFor(definition: ChargeItemDefinition, charge: ChargeItem): MarginProductClass {
  if (definition.extension?.some((extension) => extension.url === CONTACT_IDENTITY_EXTENSION_URL)) return "contact";
  if (definition.derivedFromUri?.some((url) => url.includes("/frames/"))) return "frame";
  const code = charge.code.coding?.[0]?.code ?? "";
  return code.startsWith("V20") ? "frame" : code.startsWith("V25") ? "contact" : "other";
}

function definitionIdentity(
  definition: ChargeItemDefinition,
  charge: ChargeItem,
): { item: string; vendor: string } {
  const contact = definition.extension?.find((extension) => extension.url === CONTACT_IDENTITY_EXTENSION_URL)?.extension;
  const productDisplay = contact?.find((extension) => extension.url === "product-display")?.valueString;
  const manufacturerDisplay = contact?.find((extension) => extension.url === "manufacturer-display")?.valueString;
  const lab = definition.extension?.find((extension) => extension.url === OPTICAL_LAB_EXTENSION_URL)?.valueString;
  const derived = definition.derivedFromUri?.[0];
  return {
    item: productDisplay ?? charge.code.text ?? charge.code.coding?.[0]?.display ?? canonicalLabel(derived) ?? "Optical line",
    vendor: manufacturerDisplay ?? lab ?? "Unassigned",
  };
}

function extensionMoneyCents(definition: ChargeItemDefinition, url: string): number | undefined {
  const money = definition.extension?.find((extension) => extension.url === url)?.valueMoney;
  return money ? moneyCents(money.value, `${definition.url ?? "ChargeItemDefinition"} wholesale`) : undefined;
}

async function searchComplete<T extends Resource>(
  fhir: MarginLedgerFhirClient,
  resourceType: T["resourceType"],
  params: FhirSearchParams,
): Promise<T[]> {
  const bundle = await fhir.search<T>(resourceType, params);
  if (bundle.link?.some((link) => link.relation === "next")) {
    throw new Error(`${resourceType} results exceed the margin ledger read limit.`);
  }
  return bundleResources(bundle);
}

function bundleResources<T extends Resource>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function monthRange(period: string): { start: string; end: string } {
  const match = period.match(/^(\d{4})-(\d{2})$/);
  if (!match) throw new MarginLedgerInputError("Margin ledger period must use YYYY-MM.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new MarginLedgerInputError("Margin ledger period must be a real calendar month.");
  const next = new Date(Date.UTC(year, month, 1));
  return { start: `${period}-01`, end: next.toISOString().slice(0, 10) };
}

function inRange(date: string, range: { start: string; end: string }): boolean {
  return date >= range.start && date < range.end;
}

function moneyCents(value: number | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} is not a nonnegative USD amount.`);
  }
  const scaled = value * 100;
  const cents = Math.round(scaled);
  if (Math.abs(scaled - cents) > 0.000001) throw new Error(`${label} does not resolve to whole cents.`);
  return cents;
}

function ratioMilli(numerator: number, denominator: number): number | undefined {
  return denominator > 0 ? Math.round((numerator * 1_000) / denominator) : undefined;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new MarginLedgerInputError(`${label} must be a positive integer.`);
}

function referenceId(reference: string): string | undefined {
  return reference.match(/^ChargeItem\/([A-Za-z0-9.-]+)$/)?.[1];
}

function referenceLabel(reference: string): string {
  return reference.split("/").at(-1) ?? reference;
}

function canonicalLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const tail = value.split("/").at(-1);
  if (!tail) return undefined;
  try { return decodeURIComponent(tail).replaceAll(/[-_]+/g, " "); } catch { return tail; }
}

function deductionLabel(text: string): string {
  const [, group, code] = text.match(/^adjustment\s+([^\s]+)(?:\s+(.+))?/i) ?? [];
  const token = [group, code].filter(Boolean).join("-");
  return token ? `ERA adjustment (${token})` : "ERA adjustment";
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

class MarginLedgerInputError extends Error {}
