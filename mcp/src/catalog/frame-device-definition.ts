import type { CodeableConcept, DeviceDefinition, DeviceDefinitionProperty } from "@medplum/fhirtypes";
import {
  FRAME_PROPERTY_CODE_SYSTEM,
  FRAMES_DATA_SKU_SYSTEM,
  GS1_GTIN_SYSTEM,
  OSOD_FRAME_DEVICE_TYPE_CODE,
  SNOMED_SYSTEM,
  UCUM_SYSTEM,
  assertFiniteNumber,
  frameCanonicalUrl,
  type FrameCatalogRow,
} from "./frame-types.js";

export interface FrameDeviceDefinitionInput {
  readonly catalogRow: FrameCatalogRow;
}

export function buildFrameDeviceDefinition(input: FrameDeviceDefinitionInput): DeviceDefinition {
  const c = input.catalogRow;
  const property = [
    quantityProperty("eyesize", c.eyesizeMm, "mm"),
    quantityProperty("dbl", c.dblMm, "mm"),
    quantityProperty("temple", c.templeMm, "mm"),
    quantityProperty("b-measurement", c.bMm, "mm"),
    quantityProperty("ed", c.edMm, "mm"),
    quantityProperty("weight", c.weightGrams, "g"),
    codeProperty("shape", c.frameShape),
    codeProperty("material", c.materialCode),
  ].filter((entry): entry is DeviceDefinitionProperty => Boolean(entry));

  return {
    resourceType: "DeviceDefinition",
    url: frameCanonicalUrl(c.skuId),
    version: [c.sourceVersion],
    identifier: [
      { system: FRAMES_DATA_SKU_SYSTEM, value: c.skuId },
      ...(c.gtin14 ? [{ system: GS1_GTIN_SYSTEM, value: c.gtin14 }] : []),
    ],
    manufacturerString: c.manufacturerName,
    deviceName: [
      { name: `${c.brandName} ${c.modelName} ${c.colorName}`, type: "user-friendly-name" },
      { name: c.modelName, type: "model-name" },
    ],
    modelNumber: c.modelName,
    type: {
      coding: [
        {
          system: SNOMED_SYSTEM,
          code: OSOD_FRAME_DEVICE_TYPE_CODE,
          display: "Spectacle frame",
        },
      ],
    },
    property,
  };
}

function quantityProperty(
  code: string,
  value: number | null,
  unit: "mm" | "g",
): DeviceDefinitionProperty | undefined {
  if (value === null) {
    return undefined;
  }
  return {
    type: propertyConcept(code),
    valueQuantity: [
      {
        value: assertFiniteNumber(value, `DeviceDefinition.property.${code}`),
        unit,
        system: UCUM_SYSTEM,
        code: unit,
      },
    ],
  };
}

function codeProperty(code: string, value: string | null): DeviceDefinitionProperty | undefined {
  if (!value) {
    return undefined;
  }
  return {
    type: propertyConcept(code),
    valueCode: [{ text: value, coding: [{ system: FRAME_PROPERTY_CODE_SYSTEM, code: value }] }],
  };
}

function propertyConcept(code: string): CodeableConcept {
  return { coding: [{ system: FRAME_PROPERTY_CODE_SYSTEM, code }] };
}
