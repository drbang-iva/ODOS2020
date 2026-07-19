# Lens Catalog import v1

The Lens Catalog imports deterministic JSON. A lab sheet is transformed outside ODOS into this contract, then pasted into **Settings → Lens Catalog → Import review**. PDF parsing and OCR are not part of v1.

Nothing changes in the catalog when the file is parsed. ODOS validates and materializes the file, shows the complete review, and writes only after one explicit **Approve** action.

## Document contract

```json
{
  "schemaVersion": 1,
  "lab": "bp-digital",
  "importBatch": "bp-digital-2025-01",
  "sourceRef": "BP Digital 2025 price list",
  "effectiveDate": "2025",
  "declaredBaseCellCount": 1,
  "declaredMaterializedRowCount": 2,
  "baseCells": [
    {
      "designType": "progressive",
      "productName": "Alpha Comfort",
      "minFitHeight": 14,
      "compensatedRx": true,
      "optimization": "balanced",
      "onSite": true,
      "priceLevel": "L1",
      "materialKey": "poly",
      "materialIndex": 1.586,
      "wholesalePrice": { "cents": 7798, "unit": "pair" },
      "rxEnvelope": {
        "sphMin": -8,
        "sphMax": 6,
        "cylMin": -4,
        "cylMax": 0,
        "addMin": 0.75,
        "addMax": 3.5
      },
      "sourceRef": "BP Digital 2025 price list p.3"
    }
  ],
  "treatmentAdders": [
    {
      "treatmentFamily": "photochromic",
      "treatmentBrand": "Transitions GEN8",
      "color": "gray",
      "adderPrice": { "cents": 6000, "unit": "pair" },
      "appliesTo": {
        "productNames": ["Alpha Comfort"],
        "materialKeys": ["poly"],
        "designTypes": ["progressive"]
      },
      "sourceRef": "BP Digital 2025 price list p.3"
    }
  ]
}
```

All money is integer cents. Every `wholesalePrice` and `adderPrice` must be an object with `cents` and the explicit unit `pair`; bare numbers and missing units are rejected. A base wholesale price must be 1–500,000 cents. A treatment add-on must be 0–250,000 cents, and the materialized full-cell wholesale must remain within 1–500,000 cents.

`effectiveDate` is a FHIR date (`YYYY`, `YYYY-MM`, or `YYYY-MM-DD`). The root `importBatch`, `sourceRef`, and `effectiveDate` form the provenance triple written to every approved row. A base cell or treatment add-on may provide a more precise `sourceRef`; when both parts of a materialized price use different references, ODOS retains both.

`declaredBaseCellCount` is the expected number of source base cells. `declaredMaterializedRowCount` is the expected number of final combinations, including the clear row emitted for every base cell. Both actual counts are shown as “parsed N of M”; a mismatch blocks approval.

## Canonical fields

Each base cell carries one lens line and material cell:

- Required: `designType`, `productName`, `materialKey`, `materialIndex`, `wholesalePrice`.
- Optional design attributes: `minFitHeight`, `compensatedRx`, `optimization` (`balanced`, `distance`, `near`, or `office`), `onSite`, and `priceLevel`.
- Optional Rx bounds: `sphMin`, `sphMax`, `cylMin`, `cylMax`, `addMin`, and `addMax` inside `rxEnvelope`.
- Optional `defaultBillingCodeFamily` may be supplied only from separately verified billing-code work. Import does not infer medical codes.

`designType` must match the Lens Catalog design vocabulary. `materialKey` and `materialIndex` must resolve as the same canonical material. Unknown or contradictory values become **UNPARSED**; they are never coerced.

Each treatment add-on carries `treatmentFamily`, `treatmentBrand`, optional `color`, an explicit `adderPrice`, and optional selectors under `appliesTo`. Selectors are exact arrays of `productNames`, `materialKeys`, and/or `designTypes`. Omitting a selector applies the add-on to every parsed base cell. An add-on that matches nothing is **UNPARSED**.

## Materialization and review

Every base cell emits a full-price `clear` combination. Each matching treatment add-on emits another full-price combination:

`materialized wholesale = base-cell wholesale + treatment add-on`

The add-on is an import input only. ODOS never stores it as an additive pricing layer. For example, Alpha Comfort / Poly / Clear at 7,798 cents plus Transitions GEN8 at 6,000 cents produces one Alpha Comfort / Poly / Transitions GEN8 catalog row at 13,798 cents.

The review classifies changes as **NEW**, **CHANGED**, **DISCONTINUED**, or **UNPARSED**. Existing active rows for the imported lab that are absent from the file become DISCONTINUED and are saved with `active: false`; they are never deleted. Identical rows are counted as unchanged and omitted from the actionable diff.

Suggested retail is configurable per design category as a multiplier or flat-cent adder, followed by `.98`, nearest-dollar, or nearest-cent rounding. The default is the shared Lens Catalog multiplier with `.98` rounding. NEW rows receive the suggestion. Every matched row keeps its existing retail value—including manual operator overrides—unless staff explicitly edits that value in the review.

Any file error or UNPARSED row disables Approve. Re-importing the identical approved file creates no actionable diff and no duplicate rows.
