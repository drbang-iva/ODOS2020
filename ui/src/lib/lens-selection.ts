import type { VisionPrescription, VisionPrescriptionLensSpecification } from "@medplum/fhirtypes";
import {
  evaluateModifierAutoTrigger,
  LENS_RETAIL_MARKUP_MULTIPLIER,
  lensProductChargeItemDefinitionCanonical,
  suggestedRetailPerPairCents,
  type CoatingOption,
  type LensProduct,
  type ModifierOption,
} from "./lens-catalog";
import type { LabOrderLensSpec } from "./optical-lab-order";
import type { OpticalChargeLineDraft } from "./optical-order";
import { resolveVCode, type ResolvedVCode, type VCodeOrderRx, type VCodeResolution } from "./v-code-resolver";

export type LensEye = "OD" | "OS";
export type LensFulfillment = "lab" | "in-house";

export interface LensRxEye {
  eye: LensEye;
  sphere?: number;
  cylinder?: number;
  add?: number;
  prism: Array<{ amount: number; base: "up" | "down" | "in" | "out" }>;
}

export interface LensOrderRx {
  od?: LensRxEye;
  os?: LensRxEye;
}

export interface LensEnvelopeResult {
  checked: boolean;
  fits: boolean;
  reason: string;
}

export interface LensModifierLine {
  id: string;
  name: string;
  lab: string;
  sourcePriceCents: number;
  chargeCents: number;
  unit: ModifierOption["unit"];
  automatic: boolean;
  confirmed: boolean;
  eye?: LensEye;
  prismTotal?: number;
  ruleLabel?: string;
  retained?: boolean;
}

export interface LensSelection {
  product: LensProduct;
  coating?: CoatingOption;
  modifiers: LensModifierLine[];
  fulfillment: LensFulfillment;
  billing: VCodeResolution;
  orderNotation?: string;
}

export interface AttachedLensModifierSnapshot {
  id: string;
  name: string;
  sourcePriceCents: number;
  chargeCents: number;
  unit: ModifierOption["unit"];
  automatic: boolean;
  eye?: LensEye;
  prismTotal?: number;
  ruleLabel?: string;
}

export interface AttachedLensSelection {
  selectionId: string;
  lab: string;
  productId: string;
  productCanonicalUrl: string;
  productName: string;
  designType: LensProduct["design"]["type"];
  material: { key: string; name: string; index: number };
  treatment: { family: string; brand: string; color?: string };
  coating?: {
    id: string;
    name: string;
    category: CoatingOption["category"];
    sourcePriceCents: number;
    chargeCents: number;
  };
  modifiers: AttachedLensModifierSnapshot[];
  fulfillment: LensFulfillment;
  wholesalePerPairCents: number;
  retailPerPairCents: number;
  billingCodes: ResolvedVCode[];
  orderNotation?: string;
}

export interface AttachedLensChargeSource {
  selectionId: string;
  productId: string;
  productCanonicalUrl: string;
  kind: "coating" | "modifier";
  sourceId: string;
  name: string;
  sourcePriceCents: number;
  chargeCents: number;
}

export interface CommittedLensSelection {
  chargeLines: OpticalChargeLineDraft[];
  labOrderLensSpec: Pick<LabOrderLensSpec, "lensDesign" | "lensMaterial" | "treatments">;
  attached: AttachedLensSelection;
}

export function lensOrderRxFromVisionPrescription(rx: VisionPrescription | null): LensOrderRx {
  if (!rx) return {};
  return {
    ...eyeFromLensSpecification(rx.lensSpecification.find((lens) => lens.eye === "right"), "OD", "od"),
    ...eyeFromLensSpecification(rx.lensSpecification.find((lens) => lens.eye === "left"), "OS", "os"),
  };
}

export function lensProductEnvelopeCheck(product: LensProduct, rx: LensOrderRx): LensEnvelopeResult {
  if (!rx.od && !rx.os) return { checked: false, fits: true, reason: "Rx not checked" };
  if (!rx.od || !rx.os) return { checked: true, fits: false, reason: "Both OD and OS are required for envelope checking." };

  for (const [axis, minimum, maximum] of [
    ["sphere", product.sphMin, product.sphMax],
    ["cylinder", product.cylMin, product.cylMax],
    ["add", product.addMin, product.addMax],
  ] as const) {
    if (minimum === undefined && maximum === undefined) continue;
    for (const eye of [rx.od, rx.os]) {
      const rawValue = eye[axis];
      const value = axis === "add" ? rawValue : rawValue ?? 0;
      if (value === undefined) {
        return { checked: true, fits: false, reason: `${eye.eye} ${axis} is missing.` };
      }
      if (minimum !== undefined && value < minimum) {
        return { checked: true, fits: false, reason: `${eye.eye} ${axis} ${value} is below ${minimum}.` };
      }
      if (maximum !== undefined && value > maximum) {
        return { checked: true, fits: false, reason: `${eye.eye} ${axis} ${value} is above ${maximum}.` };
      }
    }
  }
  return { checked: true, fits: true, reason: "Both eyes fit the published sphere, cylinder, and add envelope." };
}

export function filterLensProductsForRx(products: readonly LensProduct[], rx: LensOrderRx): LensProduct[] {
  return products.filter((product) => product.active && lensProductEnvelopeCheck(product, rx).fits);
}

export function fuzzySearchLensProducts(
  query: string,
  products: readonly LensProduct[],
  rx: LensOrderRx,
  limit = 8,
): Array<{ product: LensProduct; envelope: LensEnvelopeResult }> {
  const tokens = searchable(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  return products
    .map((product) => {
      const text = searchable([
        product.design.productName,
        product.material.name,
        product.material.index,
        product.treatment.family,
        product.treatment.brand,
        product.treatment.color,
        product.lab,
      ].filter((value) => value !== undefined).join(" "));
      const matched = tokens.every((token) => text.includes(token));
      const score = tokens.reduce((total, token) => total + (text.startsWith(token) ? 3 : text.includes(token) ? 1 : 0), 0);
      return { product, envelope: lensProductEnvelopeCheck(product, rx), matched, score };
    })
    .filter((entry) => entry.matched)
    .sort((a, b) => b.score - a.score || a.product.retailPerPairCents - b.product.retailPerPairCents)
    .slice(0, limit)
    .map(({ product, envelope }) => ({ product, envelope }));
}

export function modifierLinesForSelection(
  modifiers: readonly ModifierOption[],
  lab: string,
  rx: LensOrderRx,
  frameMounting?: string,
): LensModifierLine[] {
  const prism = worseEyePrism(rx);
  const context = {
    ...(prism ? { rxPrismTotal: prism.total } : {}),
    ...(frameMounting ? { frameMounting } : {}),
  };
  return modifiers
    .filter((modifier) => modifier.active && modifier.lab === lab)
    .flatMap((modifier) => {
      const automatic = Boolean(modifier.autoTrigger);
      if (automatic && !evaluateModifierAutoTrigger(modifier.autoTrigger, context)) return [];
      const prismDriven = modifier.autoTrigger?.field === "rxPrismTotal" && prism;
      const chargeCents = modifierChargeCents(modifier, prismDriven ? prism.total : undefined);
      const sourcePriceCents = modifierSourceCostCents(modifier, prismDriven ? prism.total : undefined);
      const threshold = typeof modifier.autoTrigger?.value === "number" ? modifier.autoTrigger.value : undefined;
      return [{
        id: modifier.id,
        name: modifier.name,
        lab: modifier.lab,
        sourcePriceCents,
        chargeCents,
        unit: modifier.unit,
        automatic,
        confirmed: true,
        ...(prismDriven ? { eye: prism.eye, prismTotal: prism.total } : {}),
        ...(prismDriven && threshold !== undefined
          ? { ruleLabel: `${modifier.name.replace(/\s*\(per diopter\)$/i, "")} (${prism.eye} ${formatDelta(prism.total)}) — ${labLabel(lab)} rule` }
          : {}),
      }];
    });
}

export function worseEyePrism(rx: LensOrderRx): { eye: LensEye; total: number } | undefined {
  const totals = [rx.od, rx.os]
    .filter((eye): eye is LensRxEye => eye !== undefined)
    .map((eye) => ({ eye: eye.eye, total: eye.prism.reduce((sum, entry) => sum + Math.abs(entry.amount), 0) }));
  if (totals.length === 0) return undefined;
  return totals.sort((a, b) => b.total - a.total || (a.eye === "OD" ? -1 : 1))[0];
}

export function checkStockMatch(): undefined {
  return undefined;
}

export function commitLensSelection(
  lines: readonly OpticalChargeLineDraft[],
  selection: LensSelection,
  createId: () => string = () => crypto.randomUUID(),
): CommittedLensSelection {
  if (selection.billing.status === "unverified") throw new Error(selection.billing.reason);
  const baseIndex = lines.findIndex((line) => line.lens || (!line.lensAddOn && line.procedure === "Lenses"));
  if (baseIndex < 0) throw new Error("The optical order is missing its Lenses charge line.");

  const previousSelectionId = lines[baseIndex]?.lens?.selectionId;
  const selectionId = createId();
  const confirmedModifiers = selection.modifiers.filter((modifier) => modifier.confirmed);
  const coatingChargeCents = selection.coating ? addOnRetailCents(selection.coating.pricePerPairCents) : 0;
  const billingCodes = selection.billing.status === "resolved" ? selection.billing.codes.map((code) => ({ ...code })) : [];
  const productCanonicalUrl = selection.product.resource?.url
    ?? lensProductChargeItemDefinitionCanonical(selection.product.id);
  const attached: AttachedLensSelection = {
    selectionId,
    lab: selection.product.lab,
    productId: selection.product.id,
    productCanonicalUrl,
    productName: selection.product.design.productName,
    designType: selection.product.design.type,
    material: {
      key: selection.product.material.key,
      name: selection.product.material.name,
      index: selection.product.material.index,
    },
    treatment: { ...selection.product.treatment },
    ...(selection.coating ? {
      coating: {
        id: selection.coating.id,
        name: selection.coating.name,
        category: selection.coating.category,
        sourcePriceCents: selection.coating.pricePerPairCents,
        chargeCents: coatingChargeCents,
      },
    } : {}),
    modifiers: confirmedModifiers.map((modifier) => ({
      id: modifier.id,
      name: modifier.name,
      sourcePriceCents: modifier.sourcePriceCents,
      chargeCents: modifier.chargeCents,
      unit: modifier.unit,
      automatic: modifier.automatic,
      ...(modifier.eye ? { eye: modifier.eye } : {}),
      ...(modifier.prismTotal !== undefined ? { prismTotal: modifier.prismTotal } : {}),
      ...(modifier.ruleLabel ? { ruleLabel: modifier.ruleLabel } : {}),
    })),
    fulfillment: selection.fulfillment,
    wholesalePerPairCents: selection.product.wholesalePerPairCents
      + (selection.coating?.pricePerPairCents ?? 0)
      + confirmedModifiers.reduce((sum, modifier) => sum + modifier.sourcePriceCents, 0),
    retailPerPairCents: selection.product.retailPerPairCents + coatingChargeCents
      + confirmedModifiers.reduce((sum, modifier) => sum + modifier.chargeCents, 0),
    billingCodes,
    ...(selection.orderNotation ? { orderNotation: selection.orderNotation } : {}),
  };

  const survivingLines = lines.filter((line) => !previousSelectionId || line.lensAddOn?.selectionId !== previousSelectionId);
  const currentBaseIndex = survivingLines.findIndex((line) => line.id === lines[baseIndex]?.id);
  const baseLine = survivingLines[currentBaseIndex]!;
  const firstBaseCode = billingCodes.find((code) => code.kind === "base")?.code;
  const updatedBase: OpticalChargeLineDraft = {
    ...baseLine,
    procedure: firstBaseCode ?? "Lenses",
    feeCents: selection.product.retailPerPairCents,
    taxCents: 0,
    taxable: false,
    selected: true,
    lens: attached,
    lensAddOn: undefined,
    billingCodes,
  };
  const chargeLines = [...survivingLines];
  chargeLines[currentBaseIndex] = updatedBase;

  if (selection.coating && coatingChargeCents > 0) {
    chargeLines.push(addOnLine(
      createId(),
      selection.coating.name,
      coatingChargeCents,
      attached,
      "coating",
      selection.coating.id,
      selection.coating.pricePerPairCents,
    ));
  }
  for (const modifier of confirmedModifiers) {
    chargeLines.push(addOnLine(
      createId(),
      modifier.ruleLabel ?? modifier.name,
      modifier.chargeCents,
      attached,
      "modifier",
      modifier.id,
      modifier.sourcePriceCents,
    ));
  }

  return { chargeLines, labOrderLensSpec: lensSelectionToLabOrderSpec(selection), attached };
}

export function unattachLensSelection(lines: readonly OpticalChargeLineDraft[]): OpticalChargeLineDraft[] {
  const attached = lines.find((line) => line.lens)?.lens;
  if (!attached) return lines.map((line) => ({ ...line }));
  return lines
    .filter((line) => line.lensAddOn?.selectionId !== attached.selectionId)
    .map((line) => line.lens?.selectionId === attached.selectionId
      ? {
          ...line,
          procedure: "Lenses",
          feeCents: 0,
          taxCents: 0,
          selected: false,
          lens: undefined,
          billingCodes: undefined,
        }
      : { ...line });
}

export function lensSelectionToLabOrderSpec(
  selection: LensSelection,
): Pick<LabOrderLensSpec, "lensDesign" | "lensMaterial" | "treatments"> {
  const treatment = [selection.product.treatment.brand, selection.product.treatment.color].filter(Boolean).join(" ");
  return {
    lensDesign: selection.product.design.productName,
    lensMaterial: selection.product.material.name,
    treatments: [treatment, selection.coating?.name].filter((value): value is string => Boolean(value)),
  };
}

export function resolveLensSelectionBilling(
  familyHint: string | undefined,
  rx: VCodeOrderRx,
  claimBound: boolean,
  resolver: typeof resolveVCode = resolveVCode,
): VCodeResolution {
  if (!claimBound) {
    return { status: "not-required", codes: [], reason: "Cash-pay order — HCPCS resolution is not required." };
  }
  return resolver(familyHint, rx, true);
}

function modifierChargeCents(modifier: ModifierOption, actual: number | undefined): number {
  if (modifier.unit === "perDiopter") {
    const threshold = typeof modifier.autoTrigger?.value === "number" ? modifier.autoTrigger.value : 0;
    const billable = Math.max(0, (actual ?? 0) - threshold);
    // Per-diopter cent rounding deliberately differs from catalog dollar-minus-2; reconciliation is a pricing decision.
    return Math.round(billable * modifier.priceCents * LENS_RETAIL_MARKUP_MULTIPLIER);
  }
  return addOnRetailCents(modifier.priceCents);
}

function modifierSourceCostCents(modifier: ModifierOption, actual: number | undefined): number {
  if (modifier.unit !== "perDiopter") return modifier.priceCents;
  const threshold = typeof modifier.autoTrigger?.value === "number" ? modifier.autoTrigger.value : 0;
  return Math.round(Math.max(0, (actual ?? 0) - threshold) * modifier.priceCents);
}

function addOnRetailCents(sourcePriceCents: number): number {
  return sourcePriceCents === 0 ? 0 : suggestedRetailPerPairCents(sourcePriceCents);
}

function addOnLine(
  id: string,
  procedure: string,
  feeCents: number,
  attached: AttachedLensSelection,
  kind: AttachedLensChargeSource["kind"],
  sourceId: string,
  sourcePriceCents: number,
): OpticalChargeLineDraft {
  return {
    id,
    procedure,
    modifier: "",
    diagnosis: "",
    units: 1,
    feeCents,
    taxCents: 0,
    selected: true,
    taxable: false,
    lensAddOn: {
      selectionId: attached.selectionId,
      productId: attached.productId,
      productCanonicalUrl: attached.productCanonicalUrl,
      kind,
      sourceId,
      name: procedure,
      sourcePriceCents,
      chargeCents: feeCents,
    },
  };
}

function eyeFromLensSpecification(
  lens: VisionPrescriptionLensSpecification | undefined,
  eye: LensEye,
  key: "od" | "os",
): Partial<LensOrderRx> {
  if (!lens) return {};
  return {
    [key]: {
      eye,
      sphere: lens.sphere,
      cylinder: lens.cylinder,
      add: lens.add,
      prism: (lens.prism ?? []).map((entry) => ({ amount: entry.amount, base: entry.base })),
    },
  };
}

function searchable(value: string): string {
  return value.toLowerCase().replace(/\./g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function formatDelta(value: number): string {
  return `${Number.isInteger(value) ? value.toFixed(1) : value}Δ`;
}

function labLabel(lab: string): string {
  return lab === "bp-digital" ? "BP" : lab.replace(/-/g, " ");
}
