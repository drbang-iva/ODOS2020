import assert from "node:assert/strict";
import { test } from "node:test";
import type { VisionPrescription } from "@medplum/fhirtypes";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { LensesOrderSurface } from "../src/components/LensesOrderSurface";
import {
  BP_DIGITAL_LENS_PRODUCTS,
  COATING_OPTION_SEEDS,
  MODIFIER_OPTION_SEEDS,
  type LensProduct,
} from "../src/lib/lens-catalog";
import {
  commitLensSelection,
  filterLensProductsForRx,
  fuzzySearchLensProducts,
  lensOrderRxFromVisionPrescription,
  lensProductEnvelopeCheck,
  modifierLinesForSelection,
  type LensSelection,
} from "../src/lib/lens-selection";
import { opticalCollectionChargeFromDraft, type OpticalChargeLineDraft } from "../src/lib/optical-order";
import { resolveVCode } from "../src/lib/v-code-resolver";

const TEST_RX: VisionPrescription = {
  resourceType: "VisionPrescription",
  status: "active",
  created: "2026-07-18T00:00:00Z",
  dateWritten: "2026-07-18T00:00:00Z",
  patient: { reference: "Patient/lens-a2" },
  prescriber: { reference: "Practitioner/lens-a2" },
  lensSpecification: [
    {
      product: { text: "spectacle lens" },
      eye: "right",
      sphere: -2.25,
      cylinder: -0.75,
      add: 2,
      prism: [{ amount: 2, base: "in" }, { amount: 3.5, base: "up" }],
    },
    {
      product: { text: "spectacle lens" },
      eye: "left",
      sphere: -2,
      cylinder: -0.5,
      add: 2,
    },
  ],
};

test("Rx-envelope filtering applies every published axis to both eyes and leaves undefined axes unconstrained", () => {
  const rx = lensOrderRxFromVisionPrescription(TEST_RX);
  const inRange = boundedProduct({ addMin: 1.5, addMax: 2.5 });
  const outOfRange = boundedProduct({ addMin: 2.25, addMax: 3.5 });
  const singleVision = boundedProduct({ design: { ...boundedProduct().design, type: "single-vision" }, addMin: undefined, addMax: undefined });

  assert.equal(lensProductEnvelopeCheck(inRange, rx).fits, true);
  assert.equal(lensProductEnvelopeCheck(outOfRange, rx).fits, false);
  assert.match(lensProductEnvelopeCheck(outOfRange, rx).reason, /OD add 2 is below 2.25/);
  assert.equal(lensProductEnvelopeCheck(singleVision, rx).fits, true);
  assert.deepEqual(filterLensProductsForRx([inRange, outOfRange, singleVision], rx).map((product) => product.id), [inRange.id, singleVision.id]);
});

test("missing Rx browses all products with an explicit unchecked result", () => {
  const product = boundedProduct({ addMin: 1.5, addMax: 2.5 });
  assert.deepEqual(lensProductEnvelopeCheck(product, {}), { checked: false, fits: true, reason: "Rx not checked" });
});

test("prism modifiers sum horizontal and vertical prism per eye, use the worse eye, and honor the strict BP boundary", () => {
  const rx = lensOrderRxFromVisionPrescription(TEST_RX);
  const lines = modifierLinesForSelection(MODIFIER_OPTION_SEEDS, "bp-digital", rx);
  const prism = lines.find((line) => line.id === "bp-prism-over-four");

  assert.equal(prism?.eye, "OD");
  assert.equal(prism?.prismTotal, 5.5);
  assert.equal(prism?.chargeCents, 983);
  assert.match(prism?.ruleLabel ?? "", /Prism over 4Δ \(OD 5.5Δ\) — BP rule/);
  assert.ok(lines.some((line) => line.id === "bp-base-edging-fee" && !line.automatic));

  const exactBoundary = lensOrderRxFromVisionPrescription({
    ...TEST_RX,
    lensSpecification: TEST_RX.lensSpecification.map((lens) => lens.eye === "right"
      ? { ...lens, prism: [{ amount: 1.5, base: "in" }, { amount: 2.5, base: "up" }] }
      : lens),
  });
  assert.equal(modifierLinesForSelection(MODIFIER_OPTION_SEEDS, "bp-digital", exactBoundary).some((line) => line.id === "bp-prism-over-four"), false);
  assert.deepEqual(modifierLinesForSelection(MODIFIER_OPTION_SEEDS, "cherry-optical", rx), []);
});

test("VCodeResolver resolves verified per-eye power bands and progressive add-ons without guessing gaps", () => {
  const rx = { od: { sphere: -2.25, cylinder: -0.75 }, os: { sphere: -2, cylinder: 0 } };
  const singleVision = resolveVCode("V21", rx, true);
  assert.equal(singleVision.status, "resolved");
  if (singleVision.status === "resolved") {
    assert.deepEqual(singleVision.codes.map((code) => [code.eye, code.code, code.lateralityModifier]), [
      ["OD", "V2103", "RT"],
      ["OS", "V2100", "LT"],
    ]);
  }

  const progressive = resolveVCode("V22+V2781", rx, true);
  assert.equal(progressive.status, "resolved");
  if (progressive.status === "resolved") {
    assert.deepEqual(progressive.codes.map((code) => code.code), ["V2203", "V2781", "V2200", "V2781"]);
  }
  assert.equal(resolveVCode("V21", { od: { sphere: 4.05 } }, true).status, "unverified");
  assert.equal(resolveVCode("V23", { od: { sphere: 0, cylinder: 2.12 } }, true).status, "unverified");
  const verifiedTrifocal = resolveVCode("V23", { od: { sphere: 0, cylinder: 2.25 } }, true);
  assert.equal(verifiedTrifocal.status, "resolved");
  if (verifiedTrifocal.status === "resolved") assert.equal(verifiedTrifocal.codes[0]?.code, "V2304");
  assert.equal(resolveVCode("V21", { od: { sphere: 8, cylinder: 2.25 } }, true).status, "unverified");
  assert.equal(resolveVCode(undefined, {}, false).status, "not-required");
});

test("search-first returns the same catalog row as the guided axes and leaves blocked hits visible", () => {
  const rx = lensOrderRxFromVisionPrescription(TEST_RX);
  const expected = BP_DIGITAL_LENS_PRODUCTS.find((product) =>
    product.design.productName === "Alpha Comfort"
    && product.material.index === 1.67
    && product.treatment.brand === "XTRActive",
  )!;
  const blocked = boundedProduct({ id: "blocked-search", addMin: 2.5, addMax: 3.5 });
  const results = fuzzySearchLensProducts("167 xtractive alpha", [...BP_DIGITAL_LENS_PRODUCTS, blocked], rx);

  assert.equal(results[0]?.product.id, expected.id);
  assert.equal(results[0]?.envelope.fits, true);
  const blockedResult = fuzzySearchLensProducts("alpha", [blocked], rx)[0];
  assert.equal(blockedResult?.product.id, "blocked-search");
  assert.equal(blockedResult?.envelope.fits, false);
});

test("order wiring snapshots the full selection, auto-fills the existing lab spec, and emits base plus add-on lines", () => {
  const product = structuredClone(BP_DIGITAL_LENS_PRODUCTS.find((candidate) =>
    candidate.design.productName === "Alpha Comfort"
    && candidate.material.key === "deluxe"
    && candidate.treatment.brand === "XTRActive",
  )!);
  const modifiers = modifierLinesForSelection(MODIFIER_OPTION_SEEDS, "bp-digital", lensOrderRxFromVisionPrescription(TEST_RX));
  const selection: LensSelection = {
    product,
    coating: structuredClone(COATING_OPTION_SEEDS[0]!),
    modifiers,
    fulfillment: "lab",
    billing: resolveVCode(undefined, {}, false),
  };
  const original: OpticalChargeLineDraft[] = [charge("frame", "Frame", true), charge("lenses", "Lenses", false)];
  const ids = ["selection", "coating", "prism", "edging"];
  const committed = commitLensSelection(original, selection, () => ids.shift()!);

  assert.deepEqual(committed.labOrderLensSpec, {
    lensDesign: "Alpha Comfort",
    lensMaterial: "Deluxe",
    treatments: ["XTRActive", "Ultra HMC AR"],
  });
  assert.deepEqual(committed.chargeLines.map((line) => line.procedure), [
    "Frame",
    "Lenses",
    "Ultra HMC AR",
    "Prism over 4Δ (OD 5.5Δ) — BP rule",
    "Base edging fee",
  ]);
  assert.equal(committed.chargeLines.find((line) => line.lens)?.feeCents, product.retailPerPairCents);
  assert.ok(committed.chargeLines.slice(1).every((line) => !line.taxable));
  assert.ok(committed.chargeLines.slice(1).every((line) => opticalCollectionChargeFromDraft(line).definitionCanonical === committed.attached.productCanonicalUrl));

  const snapshotRetail = committed.attached.retailPerPairCents;
  product.retailPerPairCents = 1;
  selection.coating!.pricePerPairCents = 1;
  assert.equal(committed.attached.retailPerPairCents, snapshotRetail);
  assert.notEqual(committed.chargeLines.find((line) => line.lens)?.feeCents, 1);
});

test("guided BP path reaches a complete selection in four decisions with lab and coating pre-set", async () => {
  let committed: LensSelection | undefined;
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <LensesOrderSurface
        open
        rx={TEST_RX}
        products={BP_DIGITAL_LENS_PRODUCTS}
        coatings={COATING_OPTION_SEEDS}
        modifiers={MODIFIER_OPTION_SEEDS}
        onCancel={() => undefined}
        onCommit={(selection) => { committed = selection; }}
      />,
    );
  });

  clickButton(renderer!, "Progressive");
  clickButton(renderer!, "Alpha Comfort");
  clickButton(renderer!, "Poly");
  clickButton(renderer!, "Clear");

  const clickText = nodeText(renderer!.root.findByProps({ className: "lenses-click-count" }));
  assert.match(clickText, /Selection clicks: 4/);
  const add = buttonByText(renderer!.root, "Add to order");
  assert.equal(add.props.disabled, false);
  act(() => add.props.onClick());
  assert.equal(committed?.product.design.productName, "Alpha Comfort");
  assert.equal(committed?.coating?.id, "bp-ultra-hmc-ar");
});

test("claim-bound selection remains blocked when its catalog row has no verified billing family", async () => {
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <LensesOrderSurface
        open
        claimBound
        rx={TEST_RX}
        products={BP_DIGITAL_LENS_PRODUCTS}
        coatings={COATING_OPTION_SEEDS}
        modifiers={MODIFIER_OPTION_SEEDS}
        onCancel={() => undefined}
        onCommit={() => assert.fail("Unverified claim-bound selection must not commit")}
      />,
    );
  });

  clickButton(renderer!, "Progressive");
  clickButton(renderer!, "Alpha Comfort");
  clickButton(renderer!, "Poly");
  clickButton(renderer!, "Clear");

  assert.equal(buttonByText(renderer!.root, "Add to order").props.disabled, true);
  assert.match(nodeText(renderer!.root.findByProps({ className: "lenses-billing is-unverified" })), /UNVERIFIED/);
});

function boundedProduct(patch: Partial<LensProduct> = {}): LensProduct {
  return {
    ...structuredClone(BP_DIGITAL_LENS_PRODUCTS[0]!),
    id: patch.id ?? `bounded-${Math.random()}`,
    sphMin: -8,
    sphMax: 6,
    cylMin: -4,
    cylMax: 0,
    addMin: 1.5,
    addMax: 2.5,
    ...patch,
  };
}

function charge(id: string, procedure: string, selected: boolean): OpticalChargeLineDraft {
  return { id, procedure, modifier: "", diagnosis: "", units: 1, feeCents: 0, taxCents: 0, selected, taxable: false };
}

function clickButton(renderer: ReturnType<typeof create>, text: string) {
  const button = buttonByText(renderer.root, text);
  act(() => button.props.onClick());
}

function buttonByText(root: ReactTestInstance, text: string): ReactTestInstance {
  const exact = root.findAllByType("button").filter((button) => nodeText(button) === text);
  const matches = exact.length ? exact : root.findAllByType("button").filter((button) => nodeText(button).startsWith(text));
  assert.equal(matches.length, 1, `Expected one button named ${text}, found ${matches.length}`);
  return matches[0]!;
}

function nodeText(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : nodeText(child)).join("");
}
