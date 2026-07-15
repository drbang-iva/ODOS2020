import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChargeItem } from "@medplum/fhirtypes";
import { buildFrameChargeItemDefinition } from "../src/catalog/frame-charge-item-definition.js";
import { assembleOpticalCashOrder } from "../src/fhir/opticalOrderComposite.js";
import {
  opticalCollectionChargeFromDraft,
  type OpticalChargeLineDraft,
} from "../../ui/src/lib/optical-order.js";
import { frameChargeItemDefinitionCanonical } from "../../ui/src/lib/optical-pricing-catalog.js";

test("catalog-attached frame identity reaches the checkout transaction ChargeItem definitionCanonical", () => {
  const catalogCanonicalUrl = "https://osod.dev/catalog/frames/frame-900";
  const draft: OpticalChargeLineDraft = {
    id: "frame-line",
    procedure: "V2020",
    modifier: "",
    diagnosis: "",
    units: 1,
    feeCents: 24_400,
    taxCents: 0,
    selected: true,
    taxable: false,
    frame: {
      inventoryId: "inventory-1",
      canonicalUrl: catalogCanonicalUrl,
      upc: "",
      brand: "Synthetic",
      model: "Frame 900",
      color: "Black",
      eye: "50",
      bridge: "18",
      a: "50",
      b: "40",
      ed: "52",
      dbl: "18",
      temple: "140",
      frameType: "Full rim",
    },
  };
  const { id: _id, ...charge } = opticalCollectionChargeFromDraft(draft);
  const bundle = assembleOpticalCashOrder({
    patientReference: "Patient/patient-1",
    visionPrescriptionReference: "VisionPrescription/rx-1",
    orderHcpcsCode: "V2020",
    charges: [charge],
    tender: "CASH",
  });
  const persistedCharge = bundle.entry?.find(
    (entry) => entry.resource?.resourceType === "ChargeItem",
  )?.resource as ChargeItem | undefined;
  const definition = buildFrameChargeItemDefinition({
    practiceId: "osod-practice",
    catalogCanonicalUrl,
    practiceSalePriceCents: 24_400,
    wholesaleCostCents: 10_000,
    hcpcsBaseCode: "V2020",
  });

  assert.equal(frameChargeItemDefinitionCanonical(catalogCanonicalUrl), definition.url);
  assert.deepEqual(persistedCharge?.definitionCanonical, [definition.url]);
});
