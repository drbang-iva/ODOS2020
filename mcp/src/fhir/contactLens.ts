import type {
  CodeSystem,
  CodeableConcept,
  ConceptMap,
  Device,
  DeviceDefinition,
  DeviceProperty,
  Extension,
  Observation,
  Quantity,
  StructureDefinition,
  Substance,
  ValueSet,
} from "@medplum/fhirtypes";
import type { JsonPatchOperation } from "../fhir-client.js";

export const OSOD_FHIR_BASE = "https://osod.dev/fhir";
export const CONTACT_LENS_TYPE_CODE_SYSTEM = `${OSOD_FHIR_BASE}/CodeSystem/contact-lens-type`;
export const CONTACT_LENS_PARAMETER_CODE_SYSTEM = `${OSOD_FHIR_BASE}/CodeSystem/contact-lens-parameter`;
export const CONTACT_LENS_FITTING_EVENT_CODE_SYSTEM = `${OSOD_FHIR_BASE}/CodeSystem/contact-lens-fitting-event`;
export const CONTACT_LENS_CLINICAL_OBSERVATION_CODE_SYSTEM = `${OSOD_FHIR_BASE}/CodeSystem/contact-lens-clinical-observation`;
export const DRY_EYE_TREATMENT_TYPE_CODE_SYSTEM = `${OSOD_FHIR_BASE}/CodeSystem/dry-eye-treatment-type`;
export const MEIBOGRAPHY_SCORE_CODE_SYSTEM = `${OSOD_FHIR_BASE}/CodeSystem/meibography-score`;
export const DRY_EYE_QUESTIONNAIRE_INSTRUMENT_CODE_SYSTEM = `${OSOD_FHIR_BASE}/CodeSystem/dry-eye-questionnaire-instrument`;
export const CONTACT_LENS_MATERIAL_CODE_SYSTEM = `${OSOD_FHIR_BASE}/CodeSystem/contact-lens-material`;
export const CONTACT_LENS_COATING_CODE_SYSTEM = `${OSOD_FHIR_BASE}/CodeSystem/contact-lens-coating`;
export const MYOPIA_CONTROL_INTERVENTION_CODE_SYSTEM = `${OSOD_FHIR_BASE}/CodeSystem/myopia-control-intervention`;
export const ATROPINE_CONCENTRATION_UCUM_CODE_SYSTEM = `${OSOD_FHIR_BASE}/CodeSystem/atropine-concentration-ucum`;

export const CONTACT_LENS_COATING_EXTENSION_URL = `${OSOD_FHIR_BASE}/StructureDefinition/contact-lens-coating`;
export const CONCEPTMAP_LAB_ORGANIZATION_EXTENSION_URL = `${OSOD_FHIR_BASE}/StructureDefinition/conceptmap-lab-organization`;

export const DEVICE_CONTACT_LENS_PROFILE_URL = `${OSOD_FHIR_BASE}/StructureDefinition/Device-ContactLens`;
export const DEVICE_ORTHO_K_LENS_PROFILE_URL = `${OSOD_FHIR_BASE}/StructureDefinition/Device-OrthoKLens`;
export const DEVICE_CORNEAL_GP_LENS_PROFILE_URL = `${OSOD_FHIR_BASE}/StructureDefinition/Device-CornealGPLens`;
export const DEVICE_SCLERAL_LENS_PROFILE_URL = `${OSOD_FHIR_BASE}/StructureDefinition/Device-ScleralLens`;
export const DEVICE_HYBRID_LENS_PROFILE_URL = `${OSOD_FHIR_BASE}/StructureDefinition/Device-HybridLens`;
export const DEVICE_SOFT_LENS_PROFILE_URL = `${OSOD_FHIR_BASE}/StructureDefinition/Device-SoftLens`;

export const OBSERVATION_K_READINGS_PROFILE_URL = `${OSOD_FHIR_BASE}/StructureDefinition/Observation-KReadings`;
export const OBSERVATION_PACHYMETRY_PROFILE_URL = `${OSOD_FHIR_BASE}/StructureDefinition/Observation-Pachymetry`;
export const OBSERVATION_MEIBOMIAN_GLAND_SCORE_PROFILE_URL = `${OSOD_FHIR_BASE}/StructureDefinition/Observation-MeibomianGlandScore`;
export const OBSERVATION_TBUT_PROFILE_URL = `${OSOD_FHIR_BASE}/StructureDefinition/Observation-TBUT`;
export const OBSERVATION_SCHIRMER_PROFILE_URL = `${OSOD_FHIR_BASE}/StructureDefinition/Observation-Schirmer`;
export const OBSERVATION_CONTACT_LENS_FIT_FINDING_PROFILE_URL = `${OSOD_FHIR_BASE}/StructureDefinition/Observation-ContactLensFitFinding`;

export const OSOD_DEVICE_DEFINITION_IDENTIFIER_SYSTEM = `${OSOD_FHIR_BASE}/Identifier/contact-lens-device-definition`;
export const OSOD_SUBSTANCE_IDENTIFIER_SYSTEM = `${OSOD_FHIR_BASE}/Identifier/contact-lens-substance`;

export const UCUM_CODE_SYSTEM = "http://unitsofmeasure.org";
export const LOINC_CODE_SYSTEM = "http://loinc.org";

export const UCUM_UNIT_CODES = ["[diop]", "mm", "um", "ms", "%", "deg", "mJ", "nm"] as const;
export type UcumUnitCode = (typeof UCUM_UNIT_CODES)[number];

const CONTACT_LENS_TYPE_DEFINITIONS = [
  { code: "ortho-K", display: "Orthokeratology lens", family: "orthoK" },
  { code: "MiSight", display: "MiSight lens", family: "soft" },
  { code: "dual-focus-CL", display: "Dual-focus contact lens", family: "soft" },
  { code: "stock-soft", display: "Stock soft contact lens", family: "soft" },
  { code: "corneal-GP", display: "Corneal GP lens", family: "cornealGp" },
  { code: "corneal-GP-bitoric", display: "Corneal GP bitoric lens", family: "cornealGp" },
  { code: "corneal-GP-bitoric-bifocal", display: "Corneal GP bitoric bifocal lens", family: "cornealGp" },
  { code: "scleral-prolate", display: "Scleral prolate lens", family: "scleral" },
  { code: "scleral-oblate", display: "Scleral oblate lens", family: "scleral" },
  { code: "scleral-multifocal", display: "Scleral multifocal lens", family: "scleral" },
  { code: "scleral-toric-haptic", display: "Scleral toric haptic lens", family: "scleral" },
  { code: "scleral-quadrant-haptic", display: "Scleral quadrant haptic lens", family: "scleral" },
  { code: "RGP", display: "Rigid gas permeable lens", family: "cornealGp" },
  { code: "hybrid", display: "Hybrid contact lens", family: "hybrid" },
  { code: "custom-design", display: "Custom contact lens design", family: "base" },
] as const;

export const CONTACT_LENS_TYPE_CODES = CONTACT_LENS_TYPE_DEFINITIONS.map(
  (definition) => definition.code,
);
export type ContactLensTypeCode = (typeof CONTACT_LENS_TYPE_CODES)[number];
type LensFamily = (typeof CONTACT_LENS_TYPE_DEFINITIONS)[number]["family"];

const PARAMETER_DEFINITIONS = [
  { code: "base-curve-mm", display: "Base curve in millimeters" },
  { code: "base-curve-diopter", display: "Base curve in diopters" },
  { code: "reverse-curve-depth-um", display: "Reverse curve depth" },
  { code: "alignment-curve-mm", display: "Alignment curve" },
  { code: "landing-zone", display: "Landing zone" },
  { code: "optic-zone-diameter-mm", display: "Optic zone diameter" },
  { code: "diameter-mm", display: "Diameter" },
  { code: "sphere-power", display: "Sphere power" },
  { code: "cylinder-power", display: "Cylinder power" },
  { code: "axis-degree", display: "Axis" },
  { code: "add-power", display: "Add power" },
  { code: "rx-note", display: "Prescription note" },
  { code: "flat-meridian-bc-back", display: "Back-surface flat meridian base curve" },
  { code: "steep-meridian-bc-back", display: "Back-surface steep meridian base curve" },
  { code: "flat-meridian-power-back", display: "Back-surface flat meridian power" },
  { code: "steep-meridian-power-back", display: "Back-surface steep meridian power" },
  { code: "flat-meridian-bc-front", display: "Front-surface flat meridian base curve" },
  { code: "steep-meridian-bc-front", display: "Front-surface steep meridian base curve" },
  { code: "flat-meridian-power-front", display: "Front-surface flat meridian power" },
  { code: "steep-meridian-power-front", display: "Front-surface steep meridian power" },
  { code: "segment-style", display: "Segment style" },
  { code: "segment-height-lower-edge-mm", display: "Segment height from lower lens edge" },
  { code: "segment-height-lower-pupil-margin-mm", display: "Segment height from lower pupil margin" },
  { code: "prism-ballast-diopter", display: "Prism ballast" },
  { code: "truncation-mm", display: "Truncation" },
  { code: "sagittal-depth-um", display: "Sagittal depth" },
  { code: "central-clearance-target-um", display: "Central clearance target" },
  { code: "limbal-clearance-um", display: "Limbal clearance" },
  { code: "transition-zone-height-um", display: "Transition zone height" },
  { code: "landing-zone-type", display: "Landing zone type" },
  { code: "landing-zone-flat-meridian", display: "Landing zone flat meridian" },
  { code: "landing-zone-steep-meridian", display: "Landing zone steep meridian" },
  { code: "landing-zone-axis-degree", display: "Landing zone axis" },
  { code: "landing-zone-superior", display: "Superior landing zone" },
  { code: "landing-zone-inferior", display: "Inferior landing zone" },
  { code: "landing-zone-nasal", display: "Nasal landing zone" },
  { code: "landing-zone-temporal", display: "Temporal landing zone" },
  { code: "multifocal-design", display: "Multifocal design" },
  { code: "near-zone-size-mm", display: "Near zone size" },
  { code: "gp-zone-base-curve-mm", display: "GP zone base curve" },
  { code: "gp-zone-diameter-mm", display: "GP zone diameter" },
  { code: "soft-skirt-curve", display: "Soft skirt curve" },
  { code: "soft-skirt-material", display: "Soft skirt material" },
  { code: "junction-vault-um", display: "Junction vault" },
  { code: "water-content-percent", display: "Water content percent" },
  { code: "replacement-schedule", display: "Replacement schedule" },
  { code: "material", display: "Material" },
  { code: "coating", display: "Coating" },
  { code: "fenestration", display: "Fenestration" },
  { code: "markings", display: "Lens markings" },
  { code: "tint", display: "Tint" },
  { code: "center-thickness-mm", display: "Center thickness" },
] as const;

export const CONTACT_LENS_PARAMETER_CODES = PARAMETER_DEFINITIONS.map(
  (definition) => definition.code,
);
export type ContactLensParameterCode = (typeof CONTACT_LENS_PARAMETER_CODES)[number];

export const CONTACT_LENS_FITTING_EVENT_CODES = [
  "initial-fit",
  "refit",
  "training",
  "remake",
  "parameter-adjustment",
  "failed-trial",
] as const;

export const CONTACT_LENS_CLINICAL_OBSERVATION_CODES = [
  "translation",
  "central-clearance-settled",
  "limbal-clearance",
  "haptic-alignment",
  "edge-compression",
  "orientation-stability",
  "wear-time-duration",
] as const;
export type ContactLensClinicalObservationCode =
  (typeof CONTACT_LENS_CLINICAL_OBSERVATION_CODES)[number];

export const CONTACT_LENS_MATERIAL_CODES = [
  "Boston-XO",
  "Boston-XO2",
  "Optimum-Extra",
  "Optimum-Infinite",
  "Menicon-Z",
  "hydrogel-generic",
  "silicone-hydrogel-generic",
] as const;
export type ContactLensMaterialCode = (typeof CONTACT_LENS_MATERIAL_CODES)[number];

export const CONTACT_LENS_COATING_CODES = ["Hydra-PEG", "Tangible", "none"] as const;
export type ContactLensCoatingCode = (typeof CONTACT_LENS_COATING_CODES)[number];

export const PARAMETER_VALUE_SET_URLS = {
  orthoK: `${OSOD_FHIR_BASE}/ValueSet/ortho-k-lens-parameters`,
  cornealGp: `${OSOD_FHIR_BASE}/ValueSet/corneal-gp-lens-parameters`,
  cornealGpBitoricBifocal: `${OSOD_FHIR_BASE}/ValueSet/corneal-gp-bitoric-bifocal-parameters`,
  scleral: `${OSOD_FHIR_BASE}/ValueSet/scleral-lens-parameters`,
  hybrid: `${OSOD_FHIR_BASE}/ValueSet/hybrid-lens-parameters`,
} as const;

const COMMON_POWER_PARAMETER_CODES = [
  "sphere-power",
  "cylinder-power",
  "axis-degree",
  "add-power",
  "rx-note",
  "diameter-mm",
  "material",
  "coating",
  "markings",
  "tint",
] as const;

const PARAMETER_CODES_BY_FAMILY = {
  base: CONTACT_LENS_PARAMETER_CODES,
  soft: [
    "base-curve-mm",
    "diameter-mm",
    "sphere-power",
    "cylinder-power",
    "axis-degree",
    "add-power",
    "material",
    "water-content-percent",
    "replacement-schedule",
    "tint",
    "markings",
  ],
  orthoK: [
    "base-curve-mm",
    "base-curve-diopter",
    "reverse-curve-depth-um",
    "alignment-curve-mm",
    "landing-zone",
    "optic-zone-diameter-mm",
    "diameter-mm",
    "sphere-power",
    "material",
    "coating",
    "center-thickness-mm",
    "markings",
  ],
  cornealGp: [
    ...COMMON_POWER_PARAMETER_CODES,
    "base-curve-mm",
    "base-curve-diopter",
    "optic-zone-diameter-mm",
    "flat-meridian-bc-back",
    "steep-meridian-bc-back",
    "flat-meridian-power-back",
    "steep-meridian-power-back",
    "flat-meridian-bc-front",
    "steep-meridian-bc-front",
    "flat-meridian-power-front",
    "steep-meridian-power-front",
    "segment-style",
    "segment-height-lower-edge-mm",
    "segment-height-lower-pupil-margin-mm",
    "prism-ballast-diopter",
    "truncation-mm",
    "center-thickness-mm",
    "fenestration",
  ],
  scleral: [
    ...COMMON_POWER_PARAMETER_CODES,
    "base-curve-mm",
    "optic-zone-diameter-mm",
    "sagittal-depth-um",
    "central-clearance-target-um",
    "limbal-clearance-um",
    "transition-zone-height-um",
    "landing-zone-type",
    "landing-zone-flat-meridian",
    "landing-zone-steep-meridian",
    "landing-zone-axis-degree",
    "landing-zone-superior",
    "landing-zone-inferior",
    "landing-zone-nasal",
    "landing-zone-temporal",
    "multifocal-design",
    "near-zone-size-mm",
    "center-thickness-mm",
    "fenestration",
  ],
  hybrid: [
    ...COMMON_POWER_PARAMETER_CODES,
    "gp-zone-base-curve-mm",
    "gp-zone-diameter-mm",
    "soft-skirt-curve",
    "soft-skirt-material",
    "junction-vault-um",
    "base-curve-mm",
    "water-content-percent",
    "center-thickness-mm",
  ],
} satisfies Record<LensFamily, readonly ContactLensParameterCode[]>;

export interface ContactLensPropertyInput {
  code: ContactLensParameterCode | string;
  valueNumber?: number;
  unitCode?: UcumUnitCode;
  valueCode?: string;
  valueSystem?: string;
  valueDisplay?: string;
  valueText?: string;
}

export interface BuildLensDeviceInput {
  lensTypeCode: ContactLensTypeCode | string;
  patientReference?: string;
  definitionReference?: string;
  deviceName?: string;
  manufacturer?: string;
  modelNumber?: string;
  lotNumber?: string;
  serialNumber?: string;
  status?: Device["status"];
  properties?: ContactLensPropertyInput[];
  coatingSubstanceReference?: string;
}

export interface BuildDeviceDefinitionInput {
  catalogCode: string;
  displayName: string;
  lensTypeCode: ContactLensTypeCode | string;
  manufacturer?: string;
  organizationReference?: string;
  modelNumber?: string;
  properties?: ContactLensPropertyInput[];
  materialCodes?: ContactLensMaterialCode[];
}

export interface ConceptMapMappingInput {
  sourceCode: ContactLensParameterCode | string;
  sourceDisplay?: string;
  targetCode: string;
  targetDisplay?: string;
  equivalence?: NonNullable<
    NonNullable<NonNullable<ConceptMap["group"]>[number]["element"]>[number]["target"]
  >[number]["equivalence"];
}

export interface BuildConceptMapInput {
  labCode: string;
  labDisplay: string;
  targetUri: string;
  organizationReference?: string;
  mappings: ConceptMapMappingInput[];
}

export interface BuildSubstanceInput {
  code: ContactLensMaterialCode | ContactLensCoatingCode | string;
  display: string;
  kind: "material" | "coating";
  dk?: number;
  waterContentRange?: string;
  description?: string;
}

export interface BuildLensFitObservationInput {
  patientReference: string;
  lensDeviceReference: string;
  findingCode: ContactLensClinicalObservationCode;
  effectiveDateTime?: string;
  encounterReference?: string;
  measuringDeviceReference?: string;
  bodySite?: CodeableConcept;
  valueNumber?: number;
  unitCode?: UcumUnitCode;
  valueCode?: string;
  valueDisplay?: string;
  wearTimeMs?: number;
  derivedFromReferences?: string[];
}

export function buildLensDevice(input: BuildLensDeviceInput): Device {
  const lensTypeCode = normalizeLensTypeCode(input.lensTypeCode);
  const profiles = profileUrlsForLensType(lensTypeCode);
  const properties = (input.properties ?? []).map((property) =>
    buildLensDeviceProperty(property, lensTypeCode),
  );
  const coatingExtension = input.coatingSubstanceReference
    ? [contactLensCoatingExtension(input.coatingSubstanceReference)]
    : undefined;

  return {
    resourceType: "Device",
    status: input.status ?? "active",
    meta: { profile: profiles },
    ...(coatingExtension ? { extension: coatingExtension } : {}),
    ...(input.definitionReference
      ? { definition: { reference: normalizeReference(input.definitionReference, "DeviceDefinition") } }
      : {}),
    ...(input.manufacturer ? { manufacturer: input.manufacturer } : {}),
    ...(input.modelNumber ? { modelNumber: input.modelNumber } : {}),
    ...(input.lotNumber ? { lotNumber: input.lotNumber } : {}),
    ...(input.serialNumber ? { serialNumber: input.serialNumber } : {}),
    ...(input.deviceName
      ? { deviceName: [{ name: input.deviceName, type: "user-friendly-name" }] }
      : {}),
    type: contactLensTypeConcept(lensTypeCode),
    ...(input.patientReference
      ? { patient: { reference: normalizeReference(input.patientReference, "Patient") } }
      : {}),
    ...(properties.length ? { property: properties } : {}),
  };
}

export function buildLensDeviceProperty(
  input: ContactLensPropertyInput,
  lensTypeCode?: ContactLensTypeCode | string,
): DeviceProperty {
  const code = normalizeParameterCode(input.code);
  if (lensTypeCode) {
    assertParameterAllowed(normalizeLensTypeCode(lensTypeCode), code);
  }

  if (input.valueNumber !== undefined) {
    if (!input.unitCode) {
      throw new Error(`Lens property ${code} requires unitCode when valueNumber is supplied.`);
    }
    return {
      type: contactLensParameterConcept(code),
      valueQuantity: [ucumQuantity(input.valueNumber, input.unitCode)],
    };
  }

  if (input.valueCode || input.valueDisplay || input.valueText) {
    return {
      type: contactLensParameterConcept(code),
      valueCode: [
        {
          ...(input.valueCode
            ? {
                coding: [
                  {
                    system: input.valueSystem ?? `${CONTACT_LENS_PARAMETER_CODE_SYSTEM}/${code}`,
                    code: input.valueCode,
                    ...(input.valueDisplay ? { display: input.valueDisplay } : {}),
                  },
                ],
              }
            : {}),
          text: input.valueText ?? input.valueDisplay ?? input.valueCode,
        },
      ],
    };
  }

  throw new Error(`Lens property ${code} requires a quantity or coded/text value.`);
}

export function buildUpdateLensDevicePropertiesPatch(
  existing: Device,
  lensTypeCode: ContactLensTypeCode | string,
  properties: ContactLensPropertyInput[],
): JsonPatchOperation[] {
  if (properties.length === 0) {
    throw new Error("update_lens_device_properties requires at least one property.");
  }

  const next = [...(existing.property ?? [])];
  for (const input of properties) {
    const property = buildLensDeviceProperty(input, lensTypeCode);
    const code = property.type.coding?.[0]?.code;
    const index = next.findIndex((candidate) => candidate.type.coding?.[0]?.code === code);
    if (index >= 0) {
      next[index] = property;
    } else {
      next.push(property);
    }
  }

  return [
    {
      op: existing.property ? "replace" : "add",
      path: "/property",
      value: next,
    },
  ];
}

export function buildDeviceDefinition(input: BuildDeviceDefinitionInput): DeviceDefinition {
  const lensTypeCode = normalizeLensTypeCode(input.lensTypeCode);

  return {
    resourceType: "DeviceDefinition",
    identifier: [
      {
        system: OSOD_DEVICE_DEFINITION_IDENTIFIER_SYSTEM,
        value: input.catalogCode,
      },
    ],
    ...(input.manufacturer ? { manufacturerString: input.manufacturer } : {}),
    ...(input.organizationReference
      ? { manufacturerReference: { reference: input.organizationReference } }
      : {}),
    deviceName: [{ name: input.displayName, type: "model-name" }],
    ...(input.modelNumber ? { modelNumber: input.modelNumber } : {}),
    type: contactLensTypeConcept(lensTypeCode),
    property: (input.properties ?? []).map((property) =>
      buildLensDeviceProperty(property, lensTypeCode),
    ),
    ...(input.materialCodes?.length
      ? {
          material: input.materialCodes.map((code) => ({
            substance: contactLensMaterialConcept(code),
          })),
        }
      : {}),
  };
}

export function buildConceptMap(input: BuildConceptMapInput): ConceptMap {
  return {
    resourceType: "ConceptMap",
    url: `${OSOD_FHIR_BASE}/ConceptMap/contact-lens-lab-${input.labCode}`,
    version: "0.4.0",
    name: `OSOD${pascalCase(input.labCode)}ContactLensParameterMap`,
    title: `${input.labDisplay} contact lens parameter aliases`,
    status: "active",
    experimental: false,
    date: "2026-04-28",
    publisher: "OSOD",
    description:
      "Maps OSOD contact-lens parameter codes to lab-specific catalog or order-entry naming.",
    sourceUri: CONTACT_LENS_PARAMETER_CODE_SYSTEM,
    targetUri: input.targetUri,
    group: [
      {
        source: CONTACT_LENS_PARAMETER_CODE_SYSTEM,
        target: input.targetUri,
        ...(input.organizationReference
          ? {
              extension: [
                {
                  url: CONCEPTMAP_LAB_ORGANIZATION_EXTENSION_URL,
                  valueReference: { reference: input.organizationReference },
                },
              ],
            }
          : {}),
        element: input.mappings.map((mapping) => ({
          code: normalizeParameterCode(mapping.sourceCode),
          ...(mapping.sourceDisplay ? { display: mapping.sourceDisplay } : {}),
          target: [
            {
              code: mapping.targetCode,
              ...(mapping.targetDisplay ? { display: mapping.targetDisplay } : {}),
              equivalence: mapping.equivalence ?? "equivalent",
            },
          ],
        })),
      },
    ],
  };
}

export function buildSubstance(input: BuildSubstanceInput): Substance {
  const system =
    input.kind === "material" ? CONTACT_LENS_MATERIAL_CODE_SYSTEM : CONTACT_LENS_COATING_CODE_SYSTEM;
  const details = [
    input.description,
    input.dk !== undefined ? `Dk ${input.dk}` : undefined,
    input.waterContentRange ? `water content ${input.waterContentRange}` : undefined,
  ].filter(Boolean);

  return {
    resourceType: "Substance",
    status: "active",
    identifier: [{ system: OSOD_SUBSTANCE_IDENTIFIER_SYSTEM, value: input.code }],
    category: [
      {
        coding: [
          {
            system: `${OSOD_FHIR_BASE}/CodeSystem/substance-category`,
            code: input.kind,
            display: input.kind === "material" ? "Contact lens material" : "Contact lens coating",
          },
        ],
      },
    ],
    code: {
      coding: [{ system, code: input.code, display: input.display }],
      text: input.display,
    },
    ...(details.length ? { description: details.join("; ") } : {}),
  };
}

export function buildLensFitObservation(input: BuildLensFitObservationInput): Observation {
  assertNoDeviceDerivedFrom(input.derivedFromReferences ?? []);

  const components = input.wearTimeMs !== undefined
    ? [
        {
          code: contactLensClinicalObservationConcept("wear-time-duration"),
          valueQuantity: ucumQuantity(input.wearTimeMs, "ms"),
        },
      ]
    : undefined;

  return {
    resourceType: "Observation",
    status: "final",
    meta: { profile: [OBSERVATION_CONTACT_LENS_FIT_FINDING_PROFILE_URL] },
    code: contactLensClinicalObservationConcept(input.findingCode),
    category: [
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "exam",
            display: "Exam",
          },
        ],
      },
    ],
    subject: { reference: normalizeReference(input.patientReference, "Patient") },
    focus: [{ reference: normalizeReference(input.lensDeviceReference, "Device") }],
    ...(input.encounterReference
      ? { encounter: { reference: normalizeReference(input.encounterReference, "Encounter") } }
      : {}),
    effectiveDateTime: input.effectiveDateTime ?? new Date().toISOString(),
    ...(input.measuringDeviceReference
      ? { device: { reference: normalizeReference(input.measuringDeviceReference, "Device") } }
      : {}),
    ...(input.bodySite ? { bodySite: input.bodySite } : {}),
    ...(input.valueNumber !== undefined
      ? { valueQuantity: ucumQuantity(input.valueNumber, input.unitCode ?? "um") }
      : {}),
    ...(input.valueCode || input.valueDisplay
      ? {
          valueCodeableConcept: {
            coding: input.valueCode
              ? [
                  {
                    system: CONTACT_LENS_CLINICAL_OBSERVATION_CODE_SYSTEM,
                    code: input.valueCode,
                    display: input.valueDisplay,
                  },
                ]
              : undefined,
            text: input.valueDisplay ?? input.valueCode,
          },
        }
      : {}),
    ...(components ? { component: components } : {}),
    ...(input.derivedFromReferences?.length
      ? { derivedFrom: input.derivedFromReferences.map((reference) => ({ reference })) }
      : {}),
  };
}

export function contactLensTypeConcept(code: ContactLensTypeCode): CodeableConcept {
  const definition = CONTACT_LENS_TYPE_DEFINITIONS.find((item) => item.code === code);
  return {
    coding: [
      {
        system: CONTACT_LENS_TYPE_CODE_SYSTEM,
        code,
        display: definition?.display ?? code,
      },
    ],
    text: definition?.display ?? code,
  };
}

export function contactLensParameterConcept(code: ContactLensParameterCode): CodeableConcept {
  const definition = PARAMETER_DEFINITIONS.find((item) => item.code === code);
  return {
    coding: [
      {
        system: CONTACT_LENS_PARAMETER_CODE_SYSTEM,
        code,
        display: definition?.display ?? code,
      },
    ],
    text: definition?.display ?? code,
  };
}

export function contactLensClinicalObservationConcept(
  code: ContactLensClinicalObservationCode,
): CodeableConcept {
  return {
    coding: [
      {
        system: CONTACT_LENS_CLINICAL_OBSERVATION_CODE_SYSTEM,
        code,
        display: titleCase(code),
      },
    ],
    text: titleCase(code),
  };
}

export function contactLensMaterialConcept(code: ContactLensMaterialCode): CodeableConcept {
  return {
    coding: [{ system: CONTACT_LENS_MATERIAL_CODE_SYSTEM, code, display: titleCase(code) }],
    text: titleCase(code),
  };
}

export function ucumQuantity(value: number, code: UcumUnitCode): Quantity {
  if (!UCUM_UNIT_CODES.includes(code)) {
    throw new Error(`Unsupported UCUM unit code for v0.4a contact-lens measurements: ${code}.`);
  }

  return {
    value,
    system: UCUM_CODE_SYSTEM,
    code,
    unit: code,
  };
}

export function normalizeLensTypeCode(code: ContactLensTypeCode | string): ContactLensTypeCode {
  if (CONTACT_LENS_TYPE_CODES.includes(code as ContactLensTypeCode)) {
    return code as ContactLensTypeCode;
  }
  throw new Error(`Unsupported contact lens type code: ${code}.`);
}

export function normalizeParameterCode(
  code: ContactLensParameterCode | string,
): ContactLensParameterCode {
  if (CONTACT_LENS_PARAMETER_CODES.includes(code as ContactLensParameterCode)) {
    return code as ContactLensParameterCode;
  }
  throw new Error(`Unsupported contact lens parameter code: ${code}.`);
}

export function lensFamilyForType(code: ContactLensTypeCode): LensFamily {
  return CONTACT_LENS_TYPE_DEFINITIONS.find((definition) => definition.code === code)?.family ?? "base";
}

export function assertParameterAllowed(
  lensTypeCode: ContactLensTypeCode,
  parameterCode: ContactLensParameterCode,
): void {
  const allowed = PARAMETER_CODES_BY_FAMILY[lensFamilyForType(lensTypeCode)] as readonly string[];
  if (!allowed.includes(parameterCode)) {
    throw new Error(`${parameterCode} is not valid for contact lens type ${lensTypeCode}.`);
  }
}

export function profileUrlsForLensType(code: ContactLensTypeCode): string[] {
  const profileByFamily: Record<LensFamily, string | undefined> = {
    base: undefined,
    soft: DEVICE_SOFT_LENS_PROFILE_URL,
    orthoK: DEVICE_ORTHO_K_LENS_PROFILE_URL,
    cornealGp: DEVICE_CORNEAL_GP_LENS_PROFILE_URL,
    scleral: DEVICE_SCLERAL_LENS_PROFILE_URL,
    hybrid: DEVICE_HYBRID_LENS_PROFILE_URL,
  };
  const familyProfile = profileByFamily[lensFamilyForType(code)];
  return familyProfile ? [DEVICE_CONTACT_LENS_PROFILE_URL, familyProfile] : [DEVICE_CONTACT_LENS_PROFILE_URL];
}

export function buildV04CanonicalResources(): Array<StructureDefinition | CodeSystem | ValueSet> {
  return [
    ...buildV04ExtensionDefinitions(),
    ...buildV04DeviceProfiles(),
    ...buildV04ObservationProfiles(),
    ...buildV04CodeSystems(),
    ...buildV04ValueSets(),
  ];
}

export function buildV04DeviceDefinitionSeeds(): DeviceDefinition[] {
  return [
    buildDeviceDefinition({
      catalogCode: "bostonsight-fitkit-fse0",
      displayName: "BostonSight FitKit FSE0",
      lensTypeCode: "scleral-prolate",
      manufacturer: "BostonSight",
      modelNumber: "FSE0",
      properties: [
        { code: "sagittal-depth-um", valueNumber: 4200, unitCode: "um" },
        { code: "diameter-mm", valueNumber: 18.0, unitCode: "mm" },
      ],
      materialCodes: ["Boston-XO2"],
    }),
    buildDeviceDefinition({
      catalogCode: "bostonsight-fitkit-fse1",
      displayName: "BostonSight FitKit FSE1",
      lensTypeCode: "scleral-oblate",
      manufacturer: "BostonSight",
      modelNumber: "FSE1",
      properties: [
        { code: "sagittal-depth-um", valueNumber: 4400, unitCode: "um" },
        { code: "diameter-mm", valueNumber: 18.5, unitCode: "mm" },
      ],
      materialCodes: ["Boston-XO2"],
    }),
    buildDeviceDefinition({
      catalogCode: "bostonsight-fitkit-fse2",
      displayName: "BostonSight FitKit FSE2",
      lensTypeCode: "scleral-quadrant-haptic",
      manufacturer: "BostonSight",
      modelNumber: "FSE2",
      properties: [
        { code: "sagittal-depth-um", valueNumber: 4600, unitCode: "um" },
        { code: "landing-zone-type", valueCode: "quadrant", valueDisplay: "Quadrant-specific haptic" },
      ],
      materialCodes: ["Boston-XO2"],
    }),
    buildDeviceDefinition({
      catalogCode: "synergeyes-a-duette-ultrahealth",
      displayName: "SynergEyes A / Duette / UltraHealth",
      lensTypeCode: "hybrid",
      manufacturer: "SynergEyes",
      properties: [
        { code: "gp-zone-diameter-mm", valueNumber: 8.5, unitCode: "mm" },
        { code: "soft-skirt-curve", valueCode: "medium", valueDisplay: "Medium skirt" },
      ],
    }),
    buildDeviceDefinition({
      catalogCode: "wave-topography-cad",
      displayName: "Wave topography-based CAD design",
      lensTypeCode: "custom-design",
      manufacturer: "Wave Contact Lens System",
      properties: [
        { code: "base-curve-mm", valueNumber: 7.8, unitCode: "mm" },
        { code: "diameter-mm", valueNumber: 10.6, unitCode: "mm" },
      ],
    }),
    buildDeviceDefinition({
      catalogCode: "paragon-crt",
      displayName: "Paragon CRT",
      lensTypeCode: "ortho-K",
      manufacturer: "Paragon Vision Sciences",
      properties: [
        { code: "reverse-curve-depth-um", valueNumber: 525, unitCode: "um" },
        { code: "optic-zone-diameter-mm", valueNumber: 6.0, unitCode: "mm" },
      ],
    }),
    buildDeviceDefinition({
      catalogCode: "custom-color-contact-lens",
      displayName: "Custom Color Contact Lens design",
      lensTypeCode: "custom-design",
      manufacturer: "Custom Color Contact Lenses",
      properties: [
        { code: "tint", valueCode: "custom", valueDisplay: "Custom tint" },
        { code: "diameter-mm", valueNumber: 14.0, unitCode: "mm" },
      ],
    }),
    buildDeviceDefinition({
      catalogCode: "coopervision-misight",
      displayName: "CooperVision MiSight / dual-focus catalog",
      lensTypeCode: "MiSight",
      manufacturer: "CooperVision",
      properties: [
        { code: "replacement-schedule", valueCode: "daily", valueDisplay: "Daily replacement" },
        { code: "material", valueCode: "hydrogel-generic", valueDisplay: "Hydrogel" },
      ],
    }),
  ];
}

export function buildV04SubstanceSeeds(): Substance[] {
  return [
    buildSubstance({ code: "Boston-XO", display: "Boston XO", kind: "material", dk: 100, description: "GP lens material; Dk source verified in v0.4 ledger." }),
    buildSubstance({ code: "Boston-XO2", display: "Boston XO2", kind: "material", dk: 141, description: "GP lens material; Dk source verified in v0.4 ledger." }),
    buildSubstance({ code: "Optimum-Extra", display: "Optimum Extra", kind: "material", dk: 100, description: "GP lens material; Dk source verified in v0.4 ledger." }),
    buildSubstance({ code: "Optimum-Infinite", display: "Optimum Infinite", kind: "material", dk: 200.4, description: "GP lens material; Dk source verified in v0.4 ledger." }),
    buildSubstance({ code: "Menicon-Z", display: "Menicon Z", kind: "material", dk: 163, description: "GP lens material; Dk source verified in v0.4 ledger." }),
    buildSubstance({ code: "hydrogel-generic", display: "Hydrogel generic", kind: "material", waterContentRange: "30-80%" }),
    buildSubstance({ code: "silicone-hydrogel-generic", display: "Silicone hydrogel generic", kind: "material", waterContentRange: "24-74%" }),
    buildSubstance({ code: "Hydra-PEG", display: "Hydra-PEG", kind: "coating", description: "Tangible Hydra-PEG contact lens coating." }),
    buildSubstance({ code: "Tangible", display: "Tangible other coating", kind: "coating", description: "Other Tangible contact lens coating." }),
  ];
}

function buildV04CodeSystems(): CodeSystem[] {
  return [
    codeSystem("contact-lens-type", "OSOD contact lens types", CONTACT_LENS_TYPE_DEFINITIONS),
    codeSystem("contact-lens-parameter", "OSOD contact lens parameters", PARAMETER_DEFINITIONS),
    codeSystem(
      "contact-lens-fitting-event",
      "OSOD contact lens fitting events",
      CONTACT_LENS_FITTING_EVENT_CODES.map((code) => ({ code, display: titleCase(code) })),
    ),
    codeSystem(
      "contact-lens-clinical-observation",
      "OSOD contact lens clinical observations",
      CONTACT_LENS_CLINICAL_OBSERVATION_CODES.map((code) => ({ code, display: titleCase(code) })),
    ),
    codeSystem("contact-lens-material", "OSOD contact lens materials", CONTACT_LENS_MATERIAL_CODES.map((code) => ({ code, display: titleCase(code) }))),
    codeSystem("contact-lens-coating", "OSOD contact lens coatings", CONTACT_LENS_COATING_CODES.map((code) => ({ code, display: titleCase(code) }))),
    codeSystem("dry-eye-treatment-type", "OSOD dry-eye treatment types", [
      {
        code: "IPL",
        display: "Intense pulsed light",
        designation: [
          { language: "en", value: "Lumenis IPL" },
          { language: "en", value: "OptiLight IPL" },
        ],
      },
      { code: "LLLT", display: "Low-level light therapy" },
      { code: "RF", display: "Radiofrequency treatment" },
      { code: "heat-mask", display: "Heat mask" },
      { code: "lid-debridement", display: "Lid debridement" },
      { code: "blepharoexfoliation", display: "Blepharoexfoliation" },
      { code: "scleral-lens-rehab", display: "Scleral lens rehabilitation" },
      { code: "artificial-tears", display: "Artificial tears" },
      { code: "prescription-anti-inflammatory", display: "Prescription anti-inflammatory" },
      { code: "omega-3", display: "Omega-3 supplement" },
    ]),
    codeSystem("meibography-score", "OSOD meibography scores", [
      { code: "meiboscore-0", display: "Meiboscore 0" },
      { code: "meiboscore-1", display: "Meiboscore 1" },
      { code: "meiboscore-2", display: "Meiboscore 2" },
      { code: "meiboscore-3", display: "Meiboscore 3" },
      { code: "meiboscore-gland", display: "Meiboscore gland-level score" },
      { code: "meiboscore-total-lid", display: "Meiboscore total per lid, 0-9" },
      { code: "arita-0", display: "Arita 0" },
      { code: "arita-1", display: "Arita 1" },
      { code: "arita-2", display: "Arita 2" },
      { code: "arita-3", display: "Arita 3" },
      { code: "arita-gland", display: "Arita gland-level score" },
      { code: "arita-total-lid", display: "Arita total per lid, 0-15" },
    ]),
    codeSystem("dry-eye-questionnaire-instrument", "OSOD dry-eye questionnaire instruments", [
      { code: "OSDI", display: "Ocular Surface Disease Index" },
      { code: "SPEED", display: "Standard Patient Evaluation of Eye Dryness" },
      { code: "DEQ-5", display: "Dry Eye Questionnaire 5" },
      { code: "McMonnies", display: "McMonnies Dry Eye Questionnaire" },
      { code: "OSDI-summary-score", display: "OSDI summary score" },
      { code: "SPEED-summary-score", display: "SPEED summary score" },
      { code: "DEQ-5-summary-score", display: "DEQ-5 summary score" },
      { code: "McMonnies-summary-score", display: "McMonnies summary score" },
    ]),
    codeSystem("myopia-control-intervention", "OSOD myopia control interventions", [
      { code: "ortho-K", display: "Orthokeratology" },
      { code: "atropine", display: "Atropine" },
      { code: "dual-focus-soft-lens", display: "Dual-focus soft contact lens" },
      { code: "spectacle-lens", display: "Spectacle lens" },
    ]),
    codeSystem("atropine-concentration-ucum", "OSOD atropine concentration UCUM codes", [
      { code: "%", display: "Percent concentration" },
    ]),
  ];
}

function buildV04ValueSets(): ValueSet[] {
  return [
    parameterValueSet("ortho-k-lens-parameters", "Ortho-K lens parameters", PARAMETER_CODES_BY_FAMILY.orthoK),
    parameterValueSet("corneal-gp-lens-parameters", "Corneal GP lens parameters", PARAMETER_CODES_BY_FAMILY.cornealGp),
    parameterValueSet(
      "corneal-gp-bitoric-bifocal-parameters",
      "Corneal GP bitoric bifocal lens parameters",
      PARAMETER_CODES_BY_FAMILY.cornealGp,
    ),
    parameterValueSet("scleral-lens-parameters", "Scleral lens parameters", PARAMETER_CODES_BY_FAMILY.scleral),
    parameterValueSet("hybrid-lens-parameters", "Hybrid lens parameters", PARAMETER_CODES_BY_FAMILY.hybrid),
  ];
}

function buildV04DeviceProfiles(): StructureDefinition[] {
  return [
    deviceProfile("Device-ContactLens", "OSOD Device - Contact Lens", "Device", undefined),
    deviceProfile("Device-OrthoKLens", "OSOD Device - Ortho-K Lens", "Device", PARAMETER_VALUE_SET_URLS.orthoK, DEVICE_CONTACT_LENS_PROFILE_URL),
    deviceProfile("Device-CornealGPLens", "OSOD Device - Corneal GP Lens", "Device", PARAMETER_VALUE_SET_URLS.cornealGp, DEVICE_CONTACT_LENS_PROFILE_URL),
    deviceProfile("Device-ScleralLens", "OSOD Device - Scleral Lens", "Device", PARAMETER_VALUE_SET_URLS.scleral, DEVICE_CONTACT_LENS_PROFILE_URL),
    deviceProfile("Device-HybridLens", "OSOD Device - Hybrid Lens", "Device", PARAMETER_VALUE_SET_URLS.hybrid, DEVICE_CONTACT_LENS_PROFILE_URL),
    deviceProfile("Device-SoftLens", "OSOD Device - Soft Lens", "Device", undefined, DEVICE_CONTACT_LENS_PROFILE_URL),
  ];
}

function buildV04ObservationProfiles(): StructureDefinition[] {
  return [
    observationProfile("Observation-KReadings", "OSOD Observation - K Readings", "Keratometry panel with K readings and axis components."),
    observationProfile("Observation-Pachymetry", "OSOD Observation - Pachymetry", "Central corneal thickness observation."),
    observationProfile("Observation-MeibomianGlandScore", "OSOD Observation - Meibomian Gland Score", "Meiboscore/Arita scoring observation."),
    observationProfile("Observation-TBUT", "OSOD Observation - TBUT", "Tear film break-up time observation."),
    observationProfile("Observation-Schirmer", "OSOD Observation - Schirmer", "Schirmer tear test observation."),
    observationProfile("Observation-ContactLensFitFinding", "OSOD Observation - Contact Lens Fit Finding", "Fit finding about a contact lens Device.", {
      focusMin: 1,
      componentMin: 0,
    }),
  ];
}

function buildV04ExtensionDefinitions(): StructureDefinition[] {
  return [
    {
      resourceType: "StructureDefinition",
      url: CONTACT_LENS_COATING_EXTENSION_URL,
      version: "0.4.0",
      name: "OSODContactLensCoating",
      title: "OSOD Contact Lens Coating",
      status: "draft",
      publisher: "OSOD",
      description: "Links a contact lens Device to its coating Substance.",
      fhirVersion: "4.0.1",
      kind: "complex-type",
      abstract: false,
      type: "Extension",
      baseDefinition: "http://hl7.org/fhir/StructureDefinition/Extension",
      derivation: "constraint",
      context: [{ type: "element", expression: "Device" }],
      differential: {
        element: withElementBase([
          { id: "Extension", path: "Extension", min: 0, max: "1", definition: "Contact lens coating extension." },
          { id: "Extension.url", path: "Extension.url", min: 1, max: "1", definition: "Canonical extension URL.", fixedUri: CONTACT_LENS_COATING_EXTENSION_URL },
          {
            id: "Extension.value[x]",
            path: "Extension.value[x]",
            min: 1,
            max: "1",
            definition: "The coating Substance applied to the contact lens.",
            type: [{ code: "Reference", targetProfile: ["http://hl7.org/fhir/StructureDefinition/Substance"] }],
          },
        ]),
      },
      snapshot: {
        element: withElementBase([
          { id: "Extension", path: "Extension", min: 0, max: "1", definition: "Contact lens coating extension." },
          { id: "Extension.url", path: "Extension.url", min: 1, max: "1", definition: "Canonical extension URL.", fixedUri: CONTACT_LENS_COATING_EXTENSION_URL },
          {
            id: "Extension.value[x]",
            path: "Extension.value[x]",
            min: 1,
            max: "1",
            definition: "The coating Substance applied to the contact lens.",
            type: [{ code: "Reference", targetProfile: ["http://hl7.org/fhir/StructureDefinition/Substance"] }],
          },
        ]),
      },
    },
    {
      resourceType: "StructureDefinition",
      url: CONCEPTMAP_LAB_ORGANIZATION_EXTENSION_URL,
      version: "0.4.0",
      name: "OSODConceptMapLabOrganization",
      title: "OSOD ConceptMap Lab Organization",
      status: "draft",
      publisher: "OSOD",
      description: "Binds a ConceptMap group to the lab Organization whose aliases it represents.",
      fhirVersion: "4.0.1",
      kind: "complex-type",
      abstract: false,
      type: "Extension",
      baseDefinition: "http://hl7.org/fhir/StructureDefinition/Extension",
      derivation: "constraint",
      context: [{ type: "element", expression: "ConceptMap.group" }],
      differential: {
        element: withElementBase([
          { id: "Extension", path: "Extension", min: 0, max: "1", definition: "ConceptMap lab organization extension." },
          { id: "Extension.url", path: "Extension.url", min: 1, max: "1", definition: "Canonical extension URL.", fixedUri: CONCEPTMAP_LAB_ORGANIZATION_EXTENSION_URL },
          {
            id: "Extension.value[x]",
            path: "Extension.value[x]",
            min: 1,
            max: "1",
            definition: "The Organization whose lab-specific aliases this group represents.",
            type: [{ code: "Reference", targetProfile: ["http://hl7.org/fhir/StructureDefinition/Organization"] }],
          },
        ]),
      },
      snapshot: {
        element: withElementBase([
          { id: "Extension", path: "Extension", min: 0, max: "1", definition: "ConceptMap lab organization extension." },
          { id: "Extension.url", path: "Extension.url", min: 1, max: "1", definition: "Canonical extension URL.", fixedUri: CONCEPTMAP_LAB_ORGANIZATION_EXTENSION_URL },
          {
            id: "Extension.value[x]",
            path: "Extension.value[x]",
            min: 1,
            max: "1",
            definition: "The Organization whose lab-specific aliases this group represents.",
            type: [{ code: "Reference", targetProfile: ["http://hl7.org/fhir/StructureDefinition/Organization"] }],
          },
        ]),
      },
    },
  ];
}

function deviceProfile(
  id: string,
  title: string,
  type: string,
  parameterValueSet?: string,
  baseDefinition = "http://hl7.org/fhir/StructureDefinition/Device",
): StructureDefinition {
  const url = `${OSOD_FHIR_BASE}/StructureDefinition/${id}`;
  const element = withElementBase([
    { id: type, path: type, min: 0, max: "*", definition: `${title} resource.` },
    { id: `${type}.type`, path: `${type}.type`, min: 1, max: "1", definition: "Contact lens type." },
    { id: `${type}.property`, path: `${type}.property`, min: 0, max: "*", definition: "Contact lens geometry and configuration properties." },
    {
      id: `${type}.property.type`,
      path: `${type}.property.type`,
      min: 1,
      max: "1",
      definition: "Property code from the OSOD contact-lens parameter code system.",
      binding: parameterValueSet
        ? { strength: "required" as const, valueSet: parameterValueSet }
        : { strength: "extensible" as const, valueSet: `${OSOD_FHIR_BASE}/ValueSet/contact-lens-parameters` },
    },
  ]);
  return {
    resourceType: "StructureDefinition",
    url,
    version: "0.4.0",
    name: `OSOD${id.replace(/[^A-Za-z0-9]/g, "")}`,
    title,
    status: "draft",
    publisher: "OSOD",
    description: `${title} profile for v0.4a contact lens foundation.`,
    fhirVersion: "4.0.1",
    kind: "resource",
    abstract: false,
    type,
    baseDefinition,
    derivation: "constraint",
    differential: { element },
    snapshot: { element },
  };
}

function observationProfile(
  id: string,
  title: string,
  description: string,
  options: { focusMin?: number; componentMin?: number } = {},
): StructureDefinition {
  const url = `${OSOD_FHIR_BASE}/StructureDefinition/${id}`;
  const element = withElementBase([
    { id: "Observation", path: "Observation", min: 0, max: "*", definition: `${title} resource.` },
    { id: "Observation.subject", path: "Observation.subject", min: 1, max: "1", definition: "Patient subject for the clinical observation." },
    { id: "Observation.code", path: "Observation.code", min: 1, max: "1", definition: "Clinical observable code." },
    ...(options.focusMin !== undefined
      ? [{ id: "Observation.focus", path: "Observation.focus", min: options.focusMin, max: "*", definition: "Additional resource that the observation is about." }]
      : []),
    ...(options.componentMin !== undefined
      ? [{ id: "Observation.component", path: "Observation.component", min: options.componentMin, max: "*", definition: "Component observations in a grouped measurement." }]
      : []),
  ]);
  return {
    resourceType: "StructureDefinition",
    url,
    version: "0.4.0",
    name: `OSOD${id.replace(/[^A-Za-z0-9]/g, "")}`,
    title,
    status: "draft",
    publisher: "OSOD",
    description,
    fhirVersion: "4.0.1",
    kind: "resource",
    abstract: false,
    type: "Observation",
    baseDefinition: "http://hl7.org/fhir/StructureDefinition/Observation",
    derivation: "constraint",
    differential: { element },
    snapshot: { element },
  };
}

function codeSystem(
  id: string,
  title: string,
  concepts: ReadonlyArray<{
    code: string;
    display?: string;
    designation?: NonNullable<CodeSystem["concept"]>[number]["designation"];
  }>,
): CodeSystem {
  return {
    resourceType: "CodeSystem",
    url: `${OSOD_FHIR_BASE}/CodeSystem/${id}`,
    version: "0.4.0",
    name: `OSOD${pascalCase(id)}CodeSystem`,
    title,
    status: "active",
    experimental: false,
    date: "2026-04-28",
    publisher: "OSOD",
    content: "complete",
    concept: concepts.map((concept) => ({
      code: concept.code,
      display: concept.display ?? titleCase(concept.code),
      ...(concept.designation?.length ? { designation: concept.designation } : {}),
    })),
  };
}

function parameterValueSet(
  id: string,
  title: string,
  codes: readonly ContactLensParameterCode[],
): ValueSet {
  return {
    resourceType: "ValueSet",
    url: `${OSOD_FHIR_BASE}/ValueSet/${id}`,
    version: "0.4.0",
    name: `OSOD${pascalCase(id)}ValueSet`,
    title,
    status: "active",
    experimental: false,
    date: "2026-04-28",
    publisher: "OSOD",
    compose: {
      include: [
        {
          system: CONTACT_LENS_PARAMETER_CODE_SYSTEM,
          concept: codes.map((code) => ({
            code,
            display: PARAMETER_DEFINITIONS.find((definition) => definition.code === code)?.display,
          })),
        },
      ],
    },
  };
}

function contactLensCoatingExtension(substanceReference: string): Extension {
  return {
    url: CONTACT_LENS_COATING_EXTENSION_URL,
    valueReference: { reference: normalizeReference(substanceReference, "Substance") },
  };
}

function normalizeReference(value: string, resourceType: string): string {
  return value.startsWith(`${resourceType}/`) ? value : `${resourceType}/${value}`;
}

function assertNoDeviceDerivedFrom(references: string[]): void {
  const invalid = references.find((reference) => reference.startsWith("Device/"));
  if (invalid) {
    throw new Error(`Observation source reference ${invalid} is not valid for derivedFrom.`);
  }
}

function withElementBase<
  T extends Array<NonNullable<StructureDefinition["snapshot"]>["element"][number]>,
>(elements: T): T {
  return elements.map((element) => ({
    ...element,
    base: {
      path: element.path,
      min: element.min ?? 0,
      max: element.max ?? "1",
    },
  })) as T;
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bGp\b/g, "GP")
    .replace(/\bDk\b/g, "Dk");
}

function pascalCase(value: string): string {
  return titleCase(value).replace(/[^A-Za-z0-9]/g, "");
}
