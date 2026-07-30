import assert from "node:assert/strict";
import { test } from "node:test";
import type { Coverage, CoverageEligibilityResponse, Task, VisionPrescription } from "@medplum/fhirtypes";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { CollectPanel } from "../src/components/CollectPanel";
import { AttachedLensPanel, LensesOrderSurface } from "../src/components/LensesOrderSurface";
import { OdosSearchPicker } from "../src/components/inputs/OdosSearchPicker";
import {
  BP_DIGITAL_LENS_PRODUCTS,
  COATING_OPTION_SEEDS,
  LENS_RETAIL_MARKUP_MULTIPLIER,
  MODIFIER_OPTION_SEEDS,
  suggestedRetailPerPairCents,
  type LensProduct,
} from "../src/lib/lens-catalog";
import {
  commitLensSelection,
  filterLensProductsForRx,
  fuzzySearchLensProducts,
  lensOrderRxFromVisionPrescription,
  lensProductEnvelopeCheck,
  modifierLinesForSelection,
  resolveLensSelectionBilling,
  type LensSelection,
} from "../src/lib/lens-selection";
import type {
  FrameCatalogItem,
  PracticeFrameInventoryLoad,
  PracticeFrameInventoryUnit,
  PracticeFrameVariantSettings,
} from "../src/lib/optical-frames";
import {
  opticalCollectionChargeFromDraft,
  type OpticalChargeLineDraft,
  type OpticalOrderStatusCode,
} from "../src/lib/optical-order";
import { resolveVCode } from "../src/lib/v-code-resolver";
import { OpticalOrder } from "../src/scenes/OpticalOrder";

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

const FRAME_CANONICAL_URL = "https://odos2020.com/catalog/frames/FIFO-100";
const FRAME_CATALOG_ITEM: FrameCatalogItem = {
  canonicalUrl: FRAME_CANONICAL_URL,
  sku: "FIFO-100",
  display: "FIFO Test Frame",
  manufacturer: "ODOS",
  properties: { color: "Blue", eyesize: "52", dbl: "18", temple: "140" },
  publicityClass: "open",
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
  assert.equal(prism?.chargeCents, 998);
  assert.equal(prism?.chargeCents, suggestedRetailPerPairCents(Math.round(1.5 * 298)));
  const wholesaleCents = 7798;
  assert.equal(
    suggestedRetailPerPairCents(wholesaleCents),
    Math.round((wholesaleCents * LENS_RETAIL_MARKUP_MULTIPLIER) / 100) * 100 - 2,
  );
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
  assert.equal(resolveVCode("V2781", rx, true).status, "unverified");
  assert.equal(resolveVCode("V21+V2781", rx, true).status, "unverified");
  assert.equal(resolveVCode("V21", { od: { sphere: 4.05 } }, true).status, "unverified");
  assert.equal(resolveVCode("V23", { od: { sphere: 0, cylinder: 2.12 } }, true).status, "unverified");
  const verifiedTrifocal = resolveVCode("V23", { od: { sphere: 0, cylinder: 2.25 } }, true);
  assert.equal(verifiedTrifocal.status, "resolved");
  if (verifiedTrifocal.status === "resolved") assert.equal(verifiedTrifocal.codes[0]?.code, "V2304");
  assert.equal(resolveVCode("V21", { od: { sphere: 8, cylinder: 2.25 } }, true).status, "unverified");
  assert.equal(resolveVCode(undefined, {}, false).status, "not-required");
});

test("BP seed billing families parse cleanly and only verified single-vision rows activate", () => {
  const singleVision = BP_DIGITAL_LENS_PRODUCTS.filter((product) => product.design.type === "single-vision");
  const progressive = BP_DIGITAL_LENS_PRODUCTS.filter((product) => product.design.type === "progressive");
  assert.ok(singleVision.length > 0);
  assert.ok(progressive.length > 0);
  assert.ok(singleVision.every((product) => product.defaultBillingCodeFamily === "V21"));
  assert.ok(progressive.every((product) => product.defaultBillingCodeFamily === undefined));
  for (const product of singleVision) {
    const resolution = resolveVCode(product.defaultBillingCodeFamily, {
      od: { sphere: -2.25, cylinder: -0.75 },
      os: { sphere: -2, cylinder: 0 },
    }, true);
    assert.equal(resolution.status, "resolved");
    if (resolution.status === "resolved") {
      assert.deepEqual(resolution.codes.map((code) => code.code), ["V2103", "V2100"]);
    }
  }
});

test("lens selection invokes the V-code resolver only for claim-bound orders", () => {
  let calls = 0;
  const resolver: typeof resolveVCode = (familyHint, rx, claimBound) => {
    calls += 1;
    return resolveVCode(familyHint, rx, claimBound);
  };
  const rx = { od: { sphere: -2.25, cylinder: -0.75 } };
  assert.equal(resolveLensSelectionBilling("V21", rx, false, resolver).status, "not-required");
  assert.equal(calls, 0);
  assert.equal(resolveLensSelectionBilling("V21", rx, true, resolver).status, "resolved");
  assert.equal(calls, 1);
});

test("OpticalOrder turns active fetched lens benefits into claim-bound V-codes on the selection", async () => {
  let resolverCalls = 0;
  const resolver: typeof resolveVCode = (familyHint, rx, claimBound) => {
    resolverCalls += 1;
    return resolveVCode(familyHint, rx, claimBound);
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <OpticalOrder
        search="?patient=Patient%2Flens-a2"
        initialVisionPrescription={TEST_RX}
        api={opticalOrderApi()}
        lensCatalog={lensCatalog(resolver)}
      />,
    );
    await flushPromises();
  });

  assert.equal(renderer.root.findByType(LensesOrderSurface).props.claimBound, true);
  await openSceneLensPicker(renderer);
  chooseSingleVision(renderer);
  assert.ok(resolverCalls > 0);
  assert.match(nodeText(renderer.root), /V2103 · OD/);
  assert.match(nodeText(renderer.root), /V2103 · OS/);
  act(() => renderer.unmount());
});

test("OpticalOrder treats either rejected benefit fetch as cash-pay without invoking the V-code resolver", async () => {
  for (const rejected of ["insurance", "benefits"] as const) {
    let resolverCalls = 0;
    const logged: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    let renderer: ReactTestRenderer | undefined;
    try {
      const failure = new Error(`${rejected} unavailable`);
      await act(async () => {
        renderer = create(
          <OpticalOrder
            search="?patient=Patient%2Flens-a2"
            api={opticalOrderApi({ rejected, failure })}
            lensCatalog={lensCatalog((familyHint, rx, claimBound) => {
              resolverCalls += 1;
              return resolveVCode(familyHint, rx, claimBound);
            })}
          />,
        );
        await flushPromises();
      });

      assert.equal(renderer.root.findByType(LensesOrderSurface).props.claimBound, false);
      await openSceneLensPicker(renderer);
      chooseSingleVision(renderer);
      assert.equal(resolverCalls, 0);
      assert.match(nodeText(renderer.root), /Cash-pay order/);
      assert.ok(logged.some(([message, cause]) =>
        message === "Optical-order benefit context unavailable; treating order as cash-pay."
        && cause === failure));
    } finally {
      if (renderer) act(() => renderer!.unmount());
      console.error = originalConsoleError;
    }
  }
});

test("OpticalOrder skips benefit fetches and V-code resolution when no patient is attached", async () => {
  let insuranceCalls = 0;
  let benefitCalls = 0;
  let resolverCalls = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <OpticalOrder
        search=""
        api={opticalOrderApi({
          fetchInsurance: async () => {
            insuranceCalls += 1;
            return { coverages: [ACTIVE_COVERAGE], relatedPeople: [] };
          },
          fetchBenefits: async () => {
            benefitCalls += 1;
            return { responses: [activeLensBenefit()] };
          },
        })}
        lensCatalog={lensCatalog((familyHint, rx, claimBound) => {
          resolverCalls += 1;
          return resolveVCode(familyHint, rx, claimBound);
        })}
      />,
    );
    await flushPromises();
  });

  assert.equal(insuranceCalls, 0);
  assert.equal(benefitCalls, 0);
  assert.equal(renderer.root.findByType(LensesOrderSurface).props.claimBound, false);
  await openSceneLensPicker(renderer);
  chooseSingleVision(renderer);
  assert.equal(resolverCalls, 0);
  act(() => renderer.unmount());
});

test("OpticalOrder charge-code pickers do not expose free-text creation", async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<OpticalOrder search="" api={opticalOrderApi()} />);
    await flushPromises();
  });
  const chargePickers = renderer.root.findAllByType(OdosSearchPicker)
    .filter((picker) => ["Procedure", "Modifier", "Diagnosis"].includes(picker.props.label));
  assert.equal(chargePickers.length, 6);
  assert.ok(chargePickers.every((picker) => picker.props.onCreate === undefined));
  act(() => renderer.unmount());
});

test("OpticalOrder reserves the FIFO unit on attach and dispenses that same physical unit", async () => {
  let inventoryLoads = 0;
  let settingsLoads = 0;
  const dispensedIds: string[] = [];
  const transitions: Array<[string, PracticeFrameInventoryUnit["status"]]> = [];
  const units: PracticeFrameInventoryUnit[] = [
    frameUnit("already-dispensed", "2026-07-01T12:00:00.000Z", "dispensed"),
    frameUnit("newer-on-hand", "2026-07-20T12:00:00.000Z", "on_hand"),
    frameUnit("oldest-on-hand", "2026-07-10T12:00:00.000Z", "on_hand"),
  ];
  const api = opticalOrderApi({
    searchFrameCatalog: async () => [FRAME_CATALOG_ITEM],
    loadInventory: async () => {
      inventoryLoads += 1;
      return { units, skippedCount: 0 };
    },
    loadSettings: async () => {
      settingsLoads += 1;
      return [{
        id: "settings-1",
        canonicalUrl: FRAME_CANONICAL_URL,
        salePriceCents: 17_900,
      }];
    },
    dispenseUnit: async (unitId) => {
      dispensedIds.push(unitId);
      return { ...units.find((unit) => unit.id === unitId)!, status: "dispensed" };
    },
    transitionUnit: async (unitId, _fromStatuses, toStatus) => {
      transitions.push([unitId, toStatus]);
      return { ...units.find((unit) => unit.id === unitId)!, status: toStatus };
    },
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<OpticalOrder search="" api={api} />);
    await flushPromises();
  });

  assert.equal(inventoryLoads, 1);
  assert.equal(settingsLoads, 1);
  assert.match(nodeText(renderer.root), /FIFO Test Frame/);
  assert.ok(renderer.root.findAllByType("td").some((cell) => nodeText(cell) === "2"));

  const nameInput = inputByLabel(renderer.root, "Name");
  for (const value of ["F", "FI", "FIF", "FIFO"]) {
    act(() => nameInput.props.onChange({ target: { value } }));
  }
  await act(async () => { await flushPromises(); });
  assert.equal(inventoryLoads, 1);
  assert.equal(settingsLoads, 1);

  await act(async () => {
    buttonByText(renderer.root, "Attach").props.onClick();
    await flushPromises();
  });
  assert.deepEqual(transitions, [["oldest-on-hand", "reserved"]]);
  assert.ok(renderer.root.findAllByType("input").some((input) => input.props.value === "179.00"));
  assert.equal(inputByLabel(renderer.root, "Inventory State").props.value, "In office — not sent");
  await act(async () => {
    buttonByText(renderer.root, "Dispense").props.onClick();
    await flushPromises();
  });

  assert.deepEqual(dispensedIds, ["oldest-on-hand"]);
  assert.equal(nodeText(buttonByText(renderer.root, "Dispensed")), "Dispensed");
  assert.equal(inputByLabel(renderer.root, "Inventory Unit").props.value, "oldest-on-hand");
  assert.ok(renderer.root.findAllByType("td").some((cell) => nodeText(cell) === "1"));
  act(() => renderer.unmount());
});

test("OpticalOrder blocks lab-sheet submission when an FSRC 4 in-house frame loses its inventory assignment", async () => {
  const unit = frameUnit("unit-123", "2026-07-10T12:00:00.000Z", "on_hand");
  const transitions: Array<[string, PracticeFrameInventoryUnit["status"]]> = [];
  const api = opticalOrderApi({
    searchFrameCatalog: async () => [FRAME_CATALOG_ITEM],
    loadInventory: async () => ({ units: [unit], skippedCount: 0 }),
    transitionUnit: async (unitId, _fromStatuses, toStatus) => {
      transitions.push([unitId, toStatus]);
      return { ...unit, status: toStatus };
    },
    dispenseUnit: async () => ({ ...unit, id: undefined as never, status: "dispensed" }),
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <OpticalOrder
        search="?patient=Patient%2Flens-a2&rx=VisionPrescription%2Frx-1"
        initialVisionPrescription={TEST_RX}
        api={api}
      />,
    );
    await flushPromises();
  });

  await act(async () => {
    buttonByText(renderer.root, "Attach").props.onClick();
    await flushPromises();
  });
  assert.deepEqual(transitions, [["unit-123", "reserved"]]);
  assert.equal(inputByLabel(renderer.root, "Inventory Unit").props.value, "unit-123");

  await act(async () => {
    buttonByText(renderer.root, "Dispense").props.onClick();
    await flushPromises();
  });
  act(() => {
    selectByLabel(renderer.root, "Lab").props.onChange({ target: { value: "Cherry Optical Lab" } });
    inputByLabel(renderer.root, "Patient Name").props.onChange({ target: { value: "Maria Alvarez" } });
  });
  const printButton = buttonByText(renderer.root, "Print Lab Sheet");
  assert.equal(printButton.props.disabled, false);
  act(() => printButton.props.onClick());

  assert.match(
    nodeText(renderer.root),
    /A practice-stock frame must have a reserved inventory unit before it can be sent to the lab\./,
  );
  act(() => renderer.unmount());
});

test("OpticalOrder refreshes a conflicting reservation and requires an explicit retry", async () => {
  let inventoryLoads = 0;
  const reservedIds: string[] = [];
  const staleUnits: PracticeFrameInventoryUnit[] = [
    frameUnit("stale-oldest", "2026-07-10T12:00:00.000Z", "on_hand"),
    frameUnit("next-on-hand", "2026-07-20T12:00:00.000Z", "on_hand"),
  ];
  const refreshedUnits: PracticeFrameInventoryUnit[] = [
    { ...staleUnits[0], status: "dispensed" },
    staleUnits[1],
  ];
  const api = opticalOrderApi({
    searchFrameCatalog: async () => [FRAME_CATALOG_ITEM],
    loadInventory: async () => {
      inventoryLoads += 1;
      return { units: inventoryLoads === 1 ? staleUnits : refreshedUnits, skippedCount: 0 };
    },
    transitionUnit: async (unitId, _fromStatuses, toStatus) => {
      reservedIds.push(unitId);
      if (unitId === "stale-oldest") {
        throw new Error("Frame inventory changed on another terminal.");
      }
      return { ...refreshedUnits.find((unit) => unit.id === unitId)!, status: toStatus };
    },
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<OpticalOrder search="" api={api} />);
    await flushPromises();
  });

  await act(async () => {
    buttonByText(renderer.root, "Attach").props.onClick();
    await flushPromises();
  });

  assert.equal(inventoryLoads, 2);
  assert.deepEqual(reservedIds, ["stale-oldest"]);
  assert.match(nodeText(renderer.root), /Frame inventory changed on another terminal/);
  assert.equal(renderer.root.findAllByType("button").some((button) => nodeText(button) === "Dispense"), false);

  await act(async () => {
    buttonByText(renderer.root, "Attach").props.onClick();
    await flushPromises();
  });

  assert.deepEqual(reservedIds, ["stale-oldest", "next-on-hand"]);
  assert.equal(inputByLabel(renderer.root, "Inventory Unit").props.value, "next-on-hand");
  assert.equal(inputByLabel(renderer.root, "Inventory State").props.value, "In office — not sent");
  act(() => renderer.unmount());
});

test("OpticalOrder releases the reserved unit on unattach and on ownership change", async () => {
  const units = [
    frameUnit("unit-1", "2026-07-10T12:00:00.000Z", "on_hand"),
    frameUnit("unit-2", "2026-07-20T12:00:00.000Z", "on_hand"),
  ];
  const transitions: Array<[string, PracticeFrameInventoryUnit["status"]]> = [];
  const api = opticalOrderApi({
    searchFrameCatalog: async () => [FRAME_CATALOG_ITEM],
    loadInventory: async () => ({ units, skippedCount: 0 }),
    transitionUnit: async (unitId, _fromStatuses, toStatus) => {
      transitions.push([unitId, toStatus]);
      return { ...units.find((unit) => unit.id === unitId)!, status: toStatus };
    },
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<OpticalOrder search="" api={api} />);
    await flushPromises();
  });

  await act(async () => {
    buttonByText(renderer.root, "Attach").props.onClick();
    await flushPromises();
  });
  await act(async () => {
    buttonByText(renderer.root, "Unattach Frame").props.onClick();
    await flushPromises();
  });
  assert.deepEqual(transitions, [["unit-1", "reserved"], ["unit-1", "on_hand"]]);

  await act(async () => {
    buttonByText(renderer.root, "Attach").props.onClick();
    await flushPromises();
  });
  await act(async () => {
    selectByLabel(renderer.root, "Frame Ownership").props.onChange({ target: { value: "patients-own" } });
    await flushPromises();
  });
  assert.deepEqual(transitions, [
    ["unit-1", "reserved"],
    ["unit-1", "on_hand"],
    ["unit-1", "reserved"],
    ["unit-1", "on_hand"],
  ]);
  assert.equal(nodeText(renderer.root).includes("Inventory Unit"), false);
  act(() => renderer.unmount());
});

test("OpticalOrder status changes move the attached unit without double-advancing", async () => {
  const unit = frameUnit("unit-1", "2026-07-10T12:00:00.000Z", "on_hand");
  const transitions: PracticeFrameInventoryUnit["status"][] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<OpticalOrder search="" api={opticalOrderApi({
      searchFrameCatalog: async () => [FRAME_CATALOG_ITEM],
      loadInventory: async () => ({ units: [unit], skippedCount: 0 }),
      transitionUnit: async (unitId, _fromStatuses, toStatus) => {
        assert.equal(unitId, "unit-1");
        transitions.push(toStatus);
        return { ...unit, status: toStatus };
      },
    })} />);
    await flushPromises();
  });
  await act(async () => {
    buttonByText(renderer.root, "Attach").props.onClick();
    await flushPromises();
  });
  await act(async () => {
    selectByLabel(renderer.root, "Order Status").props.onChange({ target: { value: "at-lab" } });
    await flushPromises();
  });
  await act(async () => {
    selectByLabel(renderer.root, "Order Status").props.onChange({ target: { value: "at-lab" } });
    await flushPromises();
  });
  await act(async () => {
    selectByLabel(renderer.root, "Order Status").props.onChange({ target: { value: "dispensed" } });
    await flushPromises();
  });
  assert.deepEqual(transitions, ["reserved", "at_lab", "dispensed"]);
  assert.equal(inputByLabel(renderer.root, "Inventory State").props.value, "Dispensed");
  act(() => renderer.unmount());
});

test("OpticalOrder does not advance the Task or header when the physical inventory transition fails", async () => {
  const unit = frameUnit("unit-1", "2026-07-10T12:00:00.000Z", "on_hand");
  let inventoryLoads = 0;
  const taskTransitions: OpticalOrderStatusCode[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<OpticalOrder search="" api={opticalOrderApi({
      searchFrameCatalog: async () => [FRAME_CATALOG_ITEM],
      loadInventory: async () => {
        inventoryLoads += 1;
        return {
          units: [{ ...unit, status: inventoryLoads === 1 ? "on_hand" : "reserved" }],
          skippedCount: 0,
        };
      },
      transitionUnit: async (unitId, _fromStatuses, toStatus) => {
        if (toStatus === "at_lab") throw new Error("Physical frame transition failed.");
        return { ...unit, id: unitId, status: toStatus };
      },
      transitionOrder: async (_taskId, toStatus) => {
        taskTransitions.push(toStatus);
        return { resourceType: "Task", status: "in-progress", intent: "order" };
      },
    })} />);
    await flushPromises();
  });
  await act(async () => {
    buttonByText(renderer.root, "Attach").props.onClick();
    await flushPromises();
  });
  act(() => {
    renderer.root.findByType(CollectPanel).props.onCollected({
      deviceRequestId: "order-1",
      taskId: "task-1",
      chargeItemIds: [],
      invoiceId: "invoice-1",
      outcome: "success",
      amountChargedCents: 0,
      tender: "CASH",
    });
  });

  await act(async () => {
    selectByLabel(renderer.root, "Order Status").props.onChange({ target: { value: "at-lab" } });
    await flushPromises();
  });

  assert.deepEqual(taskTransitions, []);
  assert.equal(selectByLabel(renderer.root, "Order Status").props.value, "quote");
  assert.equal(inputByLabel(renderer.root, "Inventory State").props.value, "In office — not sent");
  assert.match(nodeText(renderer.root), /Physical frame transition failed/);
  act(() => renderer.unmount());
});

test("OpticalOrder never mutates inventory for a patient's-own frame", async () => {
  const units = [frameUnit("unit-1", "2026-07-10T12:00:00.000Z", "on_hand")];
  let transitions = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<OpticalOrder search="" api={opticalOrderApi({
      searchFrameCatalog: async () => [FRAME_CATALOG_ITEM],
      loadInventory: async () => ({ units, skippedCount: 0 }),
      transitionUnit: async () => {
        transitions += 1;
        throw new Error("Patient-owned frames must not touch inventory");
      },
    })} />);
    await flushPromises();
  });
  await act(async () => {
    selectByLabel(renderer.root, "Frame Ownership").props.onChange({ target: { value: "patients-own" } });
    await flushPromises();
  });
  await act(async () => {
    buttonByText(renderer.root, "Attach").props.onClick();
    await flushPromises();
  });

  assert.equal(transitions, 0);
  assert.equal(nodeText(renderer.root).includes("Inventory Unit"), false);
  assert.equal(buttonByText(renderer.root, "Dispense").props.disabled, true);
  act(() => renderer.unmount());
});

test("OpticalOrder reserves Frame Only stock, dispenses the same unit, and refuses a post-dispense unattach", async () => {
  const units = [
    frameUnit("oldest-on-hand", "2026-07-10T12:00:00.000Z", "on_hand"),
    frameUnit("newer-on-hand", "2026-07-20T12:00:00.000Z", "on_hand"),
  ];
  const transitions: string[] = [];
  const dispensed: string[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<OpticalOrder search="" api={opticalOrderApi({
      searchFrameCatalog: async () => [FRAME_CATALOG_ITEM],
      loadInventory: async () => ({ units, skippedCount: 0 }),
      transitionUnit: async (unitId, _fromStatuses, toStatus) => {
        transitions.push(unitId);
        return { ...units.find((unit) => unit.id === unitId)!, status: toStatus };
      },
      dispenseUnit: async (unitId) => {
        dispensed.push(unitId);
        return { ...units.find((unit) => unit.id === unitId)!, status: "dispensed" };
      },
    })} />);
    await flushPromises();
  });
  act(() => selectByLabel(renderer.root, "Order Type").props.onChange({ target: { value: "frame-only" } }));
  await act(async () => {
    buttonByText(renderer.root, "Attach").props.onClick();
    await flushPromises();
  });
  assert.equal(inputByLabel(renderer.root, "Inventory Unit").props.value, "oldest-on-hand");
  assert.equal(inputByLabel(renderer.root, "Inventory State").props.value, "In office — not sent");
  await act(async () => {
    buttonByText(renderer.root, "Dispense").props.onClick();
    await flushPromises();
  });
  assert.deepEqual(transitions, ["oldest-on-hand"]);
  assert.deepEqual(dispensed, ["oldest-on-hand"]);
  assert.equal(inputByLabel(renderer.root, "Inventory State").props.value, "Dispensed");
  await act(async () => {
    buttonByText(renderer.root, "Unattach Frame").props.onClick();
    await flushPromises();
  });
  assert.match(nodeText(renderer.root), /already dispensed and cannot be returned/);
  assert.equal(inputByLabel(renderer.root, "Inventory Unit").props.value, "oldest-on-hand");
  act(() => renderer.unmount());
});

test("OpticalOrder preserves unrelated capture edits while an inventory release is pending", async () => {
  const unit = frameUnit("unit-1", "2026-07-10T12:00:00.000Z", "on_hand");
  let finishRelease!: () => void;
  const release = new Promise<void>((resolve) => { finishRelease = resolve; });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<OpticalOrder search="" api={opticalOrderApi({
      searchFrameCatalog: async () => [FRAME_CATALOG_ITEM],
      loadInventory: async () => ({ units: [unit], skippedCount: 0 }),
      transitionUnit: async (unitId, _fromStatuses, toStatus) => {
        if (toStatus === "on_hand") await release;
        return { ...unit, id: unitId, status: toStatus };
      },
    })} />);
    await flushPromises();
  });
  await act(async () => {
    buttonByText(renderer.root, "Attach").props.onClick();
    await flushPromises();
  });

  act(() => {
    selectByLabel(renderer.root, "Frame Ownership").props.onChange({ target: { value: "patients-own" } });
  });
  const treatment = buttonByText(renderer.root, "Add Treatment").parent!.findAllByType("input")[0]!;
  act(() => treatment.props.onChange({ target: { value: "AR coating" } }));
  await act(async () => {
    finishRelease();
    await flushPromises();
  });

  const currentTreatment = buttonByText(renderer.root, "Add Treatment").parent!.findAllByType("input")[0]!;
  assert.equal(currentTreatment.props.value, "AR coating");
  assert.equal(nodeText(renderer.root).includes("Inventory Unit"), false);
  act(() => renderer.unmount());
});

test("OpticalOrder refuses a practice-stock attach when no on-hand unit exists", async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<OpticalOrder search="" api={opticalOrderApi({
      searchFrameCatalog: async () => [FRAME_CATALOG_ITEM],
      loadInventory: async () => ({ units: [], skippedCount: 0 }),
    })} />);
    await flushPromises();
  });
  await act(async () => {
    buttonByText(renderer.root, "Attach").props.onClick();
    await flushPromises();
  });
  assert.match(nodeText(renderer.root), /No on-hand inventory unit is available/);
  assert.equal(nodeText(renderer.root).includes("Inventory Unit"), false);
  act(() => renderer.unmount());
});

test("OpticalOrder surfaces the malformed-unit skip count without blocking frame search", async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<OpticalOrder search="" api={opticalOrderApi({
      searchFrameCatalog: async () => [FRAME_CATALOG_ITEM],
      loadInventory: async () => ({ units: [], skippedCount: 2 }),
    })} />);
    await flushPromises();
  });

  assert.match(renderer.root.findByProps({ role: "alert" }).children.join(""), /Skipped 2 malformed frame inventory units/);
  assert.match(nodeText(renderer.root), /FIFO Test Frame/);
  act(() => renderer.unmount());
});

test("OpticalOrder ignores benefit responses that resolve after unmount", async () => {
  let resolveInsurance!: (value: { coverages: Coverage[]; relatedPeople: [] }) => void;
  let resolveBenefits!: (value: { responses: CoverageEligibilityResponse[] }) => void;
  const insurance = new Promise<{ coverages: Coverage[]; relatedPeople: [] }>((resolve) => { resolveInsurance = resolve; });
  const benefits = new Promise<{ responses: CoverageEligibilityResponse[] }>((resolve) => { resolveBenefits = resolve; });
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <OpticalOrder
          search="?patient=Patient%2Flens-a2"
          api={opticalOrderApi({
            fetchInsurance: async () => insurance,
            fetchBenefits: async () => benefits,
          })}
          lensCatalog={lensCatalog(resolveVCode)}
        />,
      );
      await Promise.resolve();
    });
    act(() => renderer!.unmount());
    await act(async () => {
      resolveInsurance({ coverages: [ACTIVE_COVERAGE], relatedPeople: [] });
      resolveBenefits({ responses: [activeLensBenefit()] });
      await flushPromises();
    });
    assert.equal(
      logged.some((args) => args.some((value) => typeof value === "string" && /state update|unmounted component|not wrapped in act/i.test(value))),
      false,
    );
  } finally {
    if (renderer) act(() => renderer!.unmount());
    console.error = originalConsoleError;
  }
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

test("search-first filters Rx-incompatible lenses before applying the result limit", async () => {
  const blocked = Array.from({ length: 8 }, (_, index) => boundedProduct({
    id: `blocked-${index}`,
    addMin: 2.5,
    addMax: 3.5,
    retailPerPairCents: 10_000 + index,
  }));
  const fitting = boundedProduct({
    id: "fitting-after-blocked",
    addMin: 1.5,
    addMax: 2.5,
    retailPerPairCents: 99_999,
  });
  assert.equal(
    fuzzySearchLensProducts("alpha", [...blocked, fitting], lensOrderRxFromVisionPrescription(TEST_RX))
      .some(({ product }) => product.id === fitting.id),
    false,
  );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <LensesOrderSurface
        open
        rx={TEST_RX}
        products={[...blocked, fitting]}
        coatings={[]}
        modifiers={[]}
        onCancel={() => undefined}
        onCommit={() => undefined}
      />,
    );
    await flushPromises();
  });
  const results = await renderer.root.findByType(OdosSearchPicker).props.search(
    "alpha",
    new AbortController().signal,
  );
  assert.deepEqual(results.map((option: { value: string }) => option.value), [fitting.id]);
  act(() => renderer.unmount());
});

test("order wiring snapshots the full selection, auto-fills the existing lab spec, and emits base plus add-on lines", () => {
  const product = structuredClone(BP_DIGITAL_LENS_PRODUCTS.find((candidate) =>
    candidate.design.productName === "Alpha Comfort"
    && candidate.material.key === "deluxe"
    && candidate.treatment.brand === "XTRActive",
  )!);
  product.resource = {
    resourceType: "ChargeItemDefinition",
    status: "active",
    url: "https://example.test/custom-lens-canonical",
  };
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
  assert.equal(committed.attached.productCanonicalUrl, product.resource.url);
  assert.equal(
    committed.attached.wholesalePerPairCents,
    product.wholesalePerPairCents
      + selection.coating!.pricePerPairCents
      + modifiers.reduce((sum, modifier) => sum + modifier.sourcePriceCents, 0),
  );
  assert.ok(committed.chargeLines.slice(1).every((line) => !line.taxable));
  assert.ok(committed.chargeLines.slice(1).every((line) => opticalCollectionChargeFromDraft(line).definitionCanonical === committed.attached.productCanonicalUrl));

  const snapshotRetail = committed.attached.retailPerPairCents;
  product.retailPerPairCents = 1;
  selection.coating!.pricePerPairCents = 1;
  assert.equal(committed.attached.retailPerPairCents, snapshotRetail);
  assert.notEqual(committed.chargeLines.find((line) => line.lens)?.feeCents, 1);
});

test("commit boundary rejects unverified billing before creating charge identifiers", () => {
  let idCalls = 0;
  const selection: LensSelection = {
    product: structuredClone(BP_DIGITAL_LENS_PRODUCTS[0]!),
    modifiers: [],
    fulfillment: "lab",
    billing: resolveVCode(undefined, { od: { sphere: 0 } }, true),
  };
  assert.throws(
    () => commitLensSelection([charge("lenses", "Lenses", false)], selection, () => {
      idCalls += 1;
      return "should-not-be-created";
    }),
    /UNVERIFIED/,
  );
  assert.equal(idCalls, 0);
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

test("claim-bound BP single-vision selection resolves the seeded V21 family per eye", async () => {
  let committed: LensSelection | undefined;
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
        onCommit={(selection) => { committed = selection; }}
      />,
    );
  });

  clickButton(renderer!, "Single Vision");
  clickButton(renderer!, "BP Digital SV");
  clickButton(renderer!, "Poly");
  clickButton(renderer!, "Clear");

  const add = buttonByText(renderer!.root, "Add to order");
  assert.equal(add.props.disabled, false);
  act(() => add.props.onClick());
  assert.equal(committed?.billing.status, "resolved");
  if (committed?.billing.status === "resolved") {
    assert.deepEqual(committed.billing.codes.map((code) => [code.code, code.lateralityModifier]), [
      ["V2103", "RT"],
      ["V2103", "LT"],
    ]);
  }
});

test("changing an attached selection preserves no coating, deselected modifiers, and locked mutation controls", async () => {
  const product = structuredClone(BP_DIGITAL_LENS_PRODUCTS.find((candidate) =>
    candidate.design.productName === "Alpha Comfort"
    && candidate.material.key === "poly"
    && candidate.treatment.brand === "Clear",
  )!);
  const attached = commitLensSelection(
    [charge("lenses", "Lenses", false)],
    { product, modifiers: [], fulfillment: "lab", billing: resolveVCode(undefined, {}, false) },
    () => "attached-without-addons",
  ).attached;
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <LensesOrderSurface
        open
        rx={TEST_RX}
        initialSelection={attached}
        products={BP_DIGITAL_LENS_PRODUCTS}
        coatings={COATING_OPTION_SEEDS}
        modifiers={MODIFIER_OPTION_SEEDS}
        onCancel={() => undefined}
        onCommit={() => undefined}
      />,
    );
  });

  assert.ok(renderer!.root.findAllByProps({ className: "lenses-coating is-selected" })
    .some((node) => nodeText(node).startsWith("●None")));
  assert.ok(renderer!.root.findAllByProps({ type: "checkbox" }).every((input) => input.props.checked === false));

  let changed = false;
  let unattached = false;
  let panel: ReturnType<typeof create>;
  act(() => {
    panel = create(<AttachedLensPanel
      lens={attached}
      disabled
      onChange={() => { changed = true; }}
      onUnattach={() => { unattached = true; }}
    />);
  });
  const lockedButtons = panel!.root.findAllByType("button");
  assert.ok(lockedButtons.every((button) => button.props.disabled === true));
  assert.equal(changed, false);
  assert.equal(unattached, false);
});

test("changing a selection retains inactive referenced coating and modifier snapshots", async () => {
  const product = structuredClone(BP_DIGITAL_LENS_PRODUCTS.find((candidate) =>
    candidate.design.productName === "Alpha Comfort"
    && candidate.material.key === "poly"
    && candidate.treatment.brand === "Clear",
  )!);
  const modifier = modifierLinesForSelection(
    MODIFIER_OPTION_SEEDS,
    "bp-digital",
    lensOrderRxFromVisionPrescription(TEST_RX),
  )[0]!;
  const attached = commitLensSelection(
    [charge("lenses", "Lenses", false)],
    {
      product,
      coating: structuredClone(COATING_OPTION_SEEDS[0]!),
      modifiers: [modifier],
      fulfillment: "lab",
      billing: resolveVCode(undefined, {}, false),
    },
    () => crypto.randomUUID(),
  ).attached;
  let recommitted: LensSelection | undefined;
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <LensesOrderSurface
        open
        rx={TEST_RX}
        initialSelection={attached}
        products={BP_DIGITAL_LENS_PRODUCTS}
        coatings={COATING_OPTION_SEEDS.filter((coating) => coating.id !== attached.coating?.id)}
        modifiers={[]}
        onCancel={() => undefined}
        onCommit={(selection) => { recommitted = selection; }}
      />,
    );
  });

  assert.match(nodeText(renderer!.root), /retained · no longer active/);
  const retainedModifier = renderer!.root.findAllByProps({ type: "checkbox" })
    .find((input) => input.props.disabled === true);
  assert.equal(retainedModifier?.props.checked, true);
  act(() => buttonByText(renderer!.root, "Add to order").props.onClick());
  assert.equal(recommitted?.coating?.id, attached.coating?.id);
  assert.deepEqual(recommitted?.modifiers.map((line) => line.id), [modifier.id]);
});

test("changing Rx drops an active automatic modifier whose trigger no longer matches", async () => {
  const product = structuredClone(BP_DIGITAL_LENS_PRODUCTS.find((candidate) =>
    candidate.design.productName === "Alpha Comfort"
    && candidate.material.key === "poly"
    && candidate.treatment.brand === "Clear",
  )!);
  const triggered = modifierLinesForSelection(
    MODIFIER_OPTION_SEEDS,
    "bp-digital",
    lensOrderRxFromVisionPrescription(TEST_RX),
  ).filter((modifier) => modifier.automatic);
  const attached = commitLensSelection(
    [charge("lenses", "Lenses", false)],
    { product, modifiers: triggered, fulfillment: "lab", billing: resolveVCode(undefined, {}, false) },
    () => crypto.randomUUID(),
  ).attached;
  const boundaryRx: VisionPrescription = {
    ...TEST_RX,
    lensSpecification: TEST_RX.lensSpecification.map((lens) => lens.eye === "right"
      ? { ...lens, prism: [{ amount: 4, base: "in" }] }
      : lens),
  };
  let recommitted: LensSelection | undefined;
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <LensesOrderSurface
        open
        rx={boundaryRx}
        initialSelection={attached}
        products={BP_DIGITAL_LENS_PRODUCTS}
        coatings={COATING_OPTION_SEEDS}
        modifiers={MODIFIER_OPTION_SEEDS}
        onCancel={() => undefined}
        onCommit={(selection) => { recommitted = selection; }}
      />,
    );
  });

  assert.doesNotMatch(nodeText(renderer!.root), /Prism over 4Δ/);
  act(() => buttonByText(renderer!.root, "Add to order").props.onClick());
  assert.deepEqual(recommitted?.modifiers.filter((modifier) => modifier.confirmed), []);
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

const ACTIVE_COVERAGE: Coverage = {
  resourceType: "Coverage",
  id: "lens-coverage",
  status: "active",
  beneficiary: { reference: "Patient/lens-a2" },
  payor: [{ reference: "Organization/vision-plan" }],
  period: { start: "2026-01-01", end: "2027-12-31" },
};

function activeLensBenefit(): CoverageEligibilityResponse {
  return {
    resourceType: "CoverageEligibilityResponse",
    status: "active",
    purpose: ["benefits"],
    patient: { reference: "Patient/lens-a2" },
    created: "2026-07-18T12:00:00Z",
    request: { reference: "CoverageEligibilityRequest/lens-request" },
    outcome: "complete",
    insurer: { reference: "Organization/vision-plan" },
    insurance: [{
      coverage: { reference: "Coverage/lens-coverage" },
      inforce: true,
      benefitPeriod: { start: "2026-01-01", end: "2027-12-31" },
      item: [{ category: { text: "Lens" }, name: "lens", excluded: false }],
    }],
  };
}

function opticalOrderApi(options: {
  rejected?: "insurance" | "benefits";
  failure?: Error;
  fetchInsurance?: () => Promise<{ coverages: Coverage[]; relatedPeople: [] }>;
  fetchBenefits?: () => Promise<{ responses: CoverageEligibilityResponse[] }>;
  searchFrameCatalog?: () => Promise<FrameCatalogItem[]>;
  loadInventory?: () => Promise<PracticeFrameInventoryLoad>;
  loadSettings?: () => Promise<PracticeFrameVariantSettings[]>;
  dispenseUnit?: (unitId: string) => Promise<PracticeFrameInventoryUnit>;
  transitionUnit?: (
    unitId: string,
    fromStatuses: PracticeFrameInventoryUnit["status"] | readonly PracticeFrameInventoryUnit["status"][],
    toStatus: PracticeFrameInventoryUnit["status"],
  ) => Promise<PracticeFrameInventoryUnit>;
  transitionOrder?: (taskId: string, toStatus: OpticalOrderStatusCode) => Promise<Task>;
} = {}) {
  const failure = options.failure ?? new Error("benefit context unavailable");
  return {
    fetchPatientInsurance: options.fetchInsurance ?? (async () => {
      if (options.rejected === "insurance") throw failure;
      return { coverages: [ACTIVE_COVERAGE], relatedPeople: [] };
    }),
    fetchVisionBenefits: options.fetchBenefits ?? (async () => {
      if (options.rejected === "benefits") throw failure;
      return { responses: [activeLensBenefit()] };
    }),
    searchFrameCatalog: options.searchFrameCatalog ?? (async () => []),
    loadPracticeFrameInventoryUnits: options.loadInventory ?? (async () => ({ units: [], skippedCount: 0 })),
    loadPracticeFrameVariantSettings: options.loadSettings ?? (async () => []),
    dispenseFrameInventoryUnit: options.dispenseUnit ?? (async () => {
      throw new Error("Unexpected frame dispense");
    }),
    transitionFrameInventoryUnitStatus: options.transitionUnit ?? (async (unitId, _fromStatuses, toStatus) =>
      frameUnit(unitId, "2026-07-10T12:00:00.000Z", toStatus)),
    transitionOpticalOrderStatus: options.transitionOrder,
  };
}

function lensCatalog(resolver: typeof resolveVCode) {
  return {
    products: BP_DIGITAL_LENS_PRODUCTS,
    coatings: COATING_OPTION_SEEDS,
    modifiers: MODIFIER_OPTION_SEEDS,
    resolver,
  };
}

async function openSceneLensPicker(renderer: ReactTestRenderer): Promise<void> {
  act(() => buttonByText(renderer.root, "Add lenses").props.onClick());
  await act(async () => { await flushPromises(); });
}

function chooseSingleVision(renderer: ReactTestRenderer): void {
  clickButton(renderer, "Single Vision");
  clickButton(renderer, "BP Digital SV");
  clickButton(renderer, "Poly");
  clickButton(renderer, "Clear");
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function charge(id: string, procedure: string, selected: boolean): OpticalChargeLineDraft {
  return { id, procedure, modifier: "", diagnosis: "", units: 1, feeCents: 0, taxCents: 0, selected, taxable: false };
}

function frameUnit(
  id: string,
  receivedAt: string,
  status: PracticeFrameInventoryUnit["status"],
): PracticeFrameInventoryUnit {
  return { id, canonicalUrl: FRAME_CANONICAL_URL, receivedAt, status };
}

function inputByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const matches = root.findAllByType("label").filter((candidate) =>
    candidate.findAllByType("span").some((span) => nodeText(span) === label));
  assert.equal(matches.length, 1, `Expected one input labeled ${label}, found ${matches.length}`);
  return matches[0]!.findByType("input");
}

function selectByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const matches = root.findAllByType("label").filter((candidate) =>
    candidate.findAllByType("span").some((span) => nodeText(span) === label));
  assert.equal(matches.length, 1, `Expected one select labeled ${label}, found ${matches.length}`);
  return matches[0]!.findByType("select");
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
