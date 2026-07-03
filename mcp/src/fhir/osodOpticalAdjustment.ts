/**
 * Local ODOS vocabulary for self-pay line adjustments (discounts) on a cash optical order.
 *
 * Source: Foxfire "Adjustment Code" dropdown (unified transaction-code table), harvested from live
 * Foxfire 2026-07-03 — the Category=DS (patient discount) rows, verbatim. Bound to
 * Invoice.lineItem.priceComponent.code (type=discount). See Slice-3 spec §5.
 *
 * The full dropdown also carries patient adjustments/refunds (WO/PRTN/REFP — categories ADJ/REF, a
 * distinct transaction semantics, not line discounts) and insurance adjustments (IADJ — Slice-2+);
 * those are intentionally NOT in this discount vocabulary. DEYE/DVSP are plan-linked (apply when a
 * vision plan is present → really Slice-2 relevance) but remain patient-responsibility discounts, so
 * they are retained here for completeness.
 *
 * The vocabulary is PRACTICE-EXTENSIBLE — Foxfire lets a practice add custom transaction codes — so
 * consumers accept unknown codes verbatim (there is no hard assertion); known codes get a display.
 */
export const OSOD_OPTICAL_ADJUSTMENT_SYSTEM = "https://osod.dev/fhir/CodeSystem/optical-adjustment";

export const OPTICAL_ADJUSTMENTS = [
  { code: "2PAIR", display: "Second Pair Discount", planLinked: false },
  { code: "CSDIS", display: "Customer Service Discount", planLinked: false },
  { code: "FAMILY", display: "Family Discount", planLinked: false },
  { code: "PPAY", display: "Prompt Pay Discount", planLinked: false },
  { code: "DEYE", display: "Eyemed Discount", planLinked: true },
  { code: "DVSP", display: "VSP Discount", planLinked: true },
] as const;

export type OpticalAdjustmentCode = (typeof OPTICAL_ADJUSTMENTS)[number]["code"];

const ADJUSTMENT_BY_CODE = new Map<string, (typeof OPTICAL_ADJUSTMENTS)[number]>(
  OPTICAL_ADJUSTMENTS.map((adjustment) => [adjustment.code, adjustment]),
);

/** Corpus-verbatim display for a known adjustment code, or undefined for a practice-custom code. */
export function opticalAdjustmentDisplay(code: string): string | undefined {
  return ADJUSTMENT_BY_CODE.get(code)?.display;
}
