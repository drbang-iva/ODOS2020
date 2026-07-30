import { odosConcept } from "../fhir/ophthalmology/extensions.js";
import {
  type ContactLensMaterialCode,
  type ContactLensParameterCode,
  type ContactLensTypeCode,
  type UcumUnitCode,
} from "../fhir/contactLens.js";
import {
  buildClinicalFindingDefinition,
  type ClinicalFindingDefinition,
  type ClinicalFindingOption,
  type ClinicalGraphProvenance,
} from "./glaucoma-suspect.js";

export interface ContactLensCatalogOption extends ClinicalFindingOption {
  manufacturerCode: string;
  design: "spherical" | "toric" | "multifocal" | "color";
  colorOptions?: ClinicalFindingOption[];
  mfPowerOptions?: ClinicalFindingOption[];
  baseCurveOptions: ClinicalFindingOption[];
  diameterOptions: ClinicalFindingOption[];
  frequentlyUsed?: boolean;
}

export interface SpecialtyContactLensCatalogOption extends ClinicalFindingOption {
  manufacturerCode: string;
  lensTypeCode?: ContactLensTypeCode;
}

export interface SpecialtyAdditionalFieldOption extends ClinicalFindingOption {
  localCode: string;
  parameterCode?: ContactLensParameterCode;
  unit: UcumUnitCode;
}

const USAGE_OPTIONS: ClinicalFindingOption[] = [
  option("distance", "Distance"),
  option("monovision", "Monovision"),
  option("monovision_od_distance", "Monovision OD distance"),
  option("monovision_os_distance", "Monovision OS distance"),
  option("monovision_od_near", "Monovision OD near"),
  option("monovision_os_near", "Monovision OS near"),
  option("multifocal", "Multifocal"),
];

const STATUS_OPTIONS: ClinicalFindingOption[] = [
  option("order_trial", "Order Trial"),
  option("order_trial_doctor_fit", "Order Trial and Needs Fitting by Doctor"),
  option("order_trial_staff_fit", "Order Trial and Needs Fitting by Staff"),
  option("dispensed", "Dispensed"),
  option("dispensed_patient_confirm", "Dispensed and Patient Can Confirm Fit"),
  option("dispensed_successful", "Dispensed Successful"),
  option("dispensed_unsuccessful", "Dispensed Unsuccessful"),
];

const UNDERLYING_CONDITION_OPTIONS: ClinicalFindingOption[] = [
  option("prosthesis", "Prosthesis"),
  option("balance_lens", "Balance Lens"),
  option("not_recorded", "Not Recorded"),
  option("no_lens", "No Lens"),
];

const COLORS: ClinicalFindingOption[] = [
  option("amethyst", "Amethyst"),
  option("blue", "Blue"),
  option("brilliant_blue", "Brilliant Blue"),
  option("brown", "Brown"),
  option("gemstone_green", "Gemstone Green"),
  option("gray", "Gray"),
  option("green", "Green"),
];

const MF_POWERS: ClinicalFindingOption[] = [
  option("low", "Low (up to +1.00)"),
  option("medium", "Medium (+1.50 to +2.00)"),
  option("high", "High (+2.25 and up)"),
];

const MANUFACTURERS: ClinicalFindingOption[] = [
  option("alcon", "Alcon Laboratories Inc"),
  option("bausch_lomb", "Bausch & Lomb"),
  option("cooper_vision", "Cooper Vision"),
  option("cooper_vision_private_label", "Cooper Vision - Private Label"),
  option("cooper_pearle_private_label", "Cooper-pearle Private Label"),
  option("menicon_america", "Menicon America Inc"),
  option("optical_connection", "Optical Connection Intl Corp"),
  option("vistakon", "Vistakon"),
  option("retail_private_label", "Retail Private Label"),
];

const PRODUCTS: ContactLensCatalogOption[] = [
  product("precision1", "Precision1", "alcon", "spherical", ["8.3"], ["14.2"]),
  product("precision1_astigmatism", "Precision1 for Astigmatism", "alcon", "toric", ["8.5"], ["14.5"]),
  product("precision7", "Precision7", "alcon", "spherical", ["8.4"], ["14.2"]),
  product("precision7_astigmatism", "Precision7 for Astigmatism", "alcon", "toric", ["8.6"], ["14.5"]),
  product("total30_astigmatism", "TOTAL30 for Astigmatism", "alcon", "toric", ["8.6"], ["14.5"]),
  product("dailies_total1", "Dailies Total1", "alcon", "spherical", ["8.5"], ["14.1"]),
  product("dailies_total1_astigmatism", "Dailies Total1 for Astigmatism", "alcon", "toric", ["8.6"], ["14.5"]),
  product("air_optix_aqua", "Air Optix Aqua", "alcon", "spherical", ["8.6"], ["14.2"]),
  product("air_optix_aqua_multifocal", "Air Optix Aqua Multifocal", "alcon", "multifocal", ["8.6"], ["14.2"], { mfPowerOptions: MF_POWERS }),
  product("air_optix_colors", "Air Optix Colors", "alcon", "color", ["8.6"], ["14.2"], { colorOptions: COLORS }),
  product("air_optix_astigmatism", "Air Optix for Astigmatism", "alcon", "toric", ["8.7"], ["14.5"]),
  product("air_optix_night_day", "Air Optix Night & Day", "alcon", "spherical", ["8.4", "8.6"], ["13.8"]),
  product("acuvue_oasys", "Acuvue Oasys", "vistakon", "spherical", ["8.4", "8.8"], ["14.0"]),
  product("acuvue_moist_multifocal", "1-Day Acuvue Moist Multifocal", "vistakon", "multifocal", ["8.4"], ["14.3"], { mfPowerOptions: MF_POWERS }),
  product("biofinity", "Biofinity", "cooper_vision", "spherical", ["8.6"], ["14.0"]),
  product("biofinity_multifocal", "Biofinity Multifocal", "cooper_vision", "multifocal", ["8.6"], ["14.0"], { mfPowerOptions: MF_POWERS }),
  product("biofinity_toric", "Biofinity Toric", "cooper_vision", "toric", ["8.7"], ["14.5"]),
  product("proclear", "Proclear", "cooper_vision", "spherical", ["8.2", "8.6"], ["14.2"]),
  product("proclear_xr", "Proclear XR", "cooper_vision", "spherical", ["8.6"], ["14.2"]),
  product("proclear_toric_multifocal", "Proclear Toric Multifocal", "cooper_vision", "multifocal", ["8.4", "8.8"], ["14.4"], { mfPowerOptions: MF_POWERS }),
  product("clariti_1_day", "Clariti 1-Day", "cooper_vision", "spherical", ["8.6"], ["14.1"]),
  product("myday", "MyDay", "cooper_vision", "spherical", ["8.4"], ["14.2"]),
];

export function buildSoftContactLensFindingDefinitionStub(
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition {
  return buildClinicalFindingDefinition({
    id: "finding-def-soft-contact-lens",
    stableKey: "soft_contact_lens",
    display: "Soft contact lens prescription",
    sectionKey: "soft-contact-lens",
    anatomyTarget: "eye",
    valueSchema: {
      valueKind: "soft-contact-lens-panel",
      fields: {
        usage: selectField("Usage", USAGE_OPTIONS),
        status: selectField("Status", STATUS_OPTIONS),
        binocularPdDistance: decimalField("Binocular PD Dist", 35, 90, 2, "mm"),
        binocularPdNear: decimalField("Binocular PD Near", 35, 90, 2, "mm"),
        underlyingCondition: selectField("Underlying Condition", UNDERLYING_CONDITION_OPTIONS),
        manufacturer: selectField("Manufacturer", MANUFACTURERS),
        product: { ...selectField("Product", PRODUCTS), cascadeFrom: "manufacturer", optionMetadata: ["manufacturerCode", "design", "baseCurveOptions", "diameterOptions", "colorOptions", "mfPowerOptions", "frequentlyUsed"] },
        baseCurve: decimalField("Base Curve", 5, 12, 2, "mm"),
        diameter: decimalField("Diameter", 10, 20, 2, "mm"),
        sphere: powerField("Sphere", -30, 30),
        cylinder: powerField("Cylinder", -8, 0),
        axis: { display: "Axis", type: "integer-select", minimum: 0, maximum: 180, step: 1, unit: "degrees" },
        add: powerField("Add", 0, 4),
        colorMfPower: { display: "Color/MF-PWR", type: "product-cascade-select", editable: true, cascadeFrom: "product" },
        distanceVisualAcuity: { display: "Dist VA", type: "visual-acuity-select" },
        nearVisualAcuity: { display: "Near VA", type: "visual-acuity-select" },
        distancePinholeVisualAcuity: { display: "Dist PH", type: "visual-acuity-select" },
        startDate: { display: "Start Date", type: "date" },
        expirationDate: { display: "Expiration Date", type: "date" },
        other: { display: "Other", type: "string", maximumLength: 500 },
        manualEntry: { display: "Manual Entry", type: "boolean" },
        overRefractionSphere: powerField("Over-Refraction Sphere", -20, 20),
        overRefractionCylinder: powerField("Over-Refraction Cylinder", -8, 0),
        overRefractionAxis: { display: "Over-Refraction Axis", type: "integer-select", minimum: 0, maximum: 180, step: 1, unit: "degrees" },
        overRefractionDistanceVisualAcuity: { display: "Over-Refraction Dist VA", type: "visual-acuity-select" },
        overRefractionNearVisualAcuity: { display: "Over-Refraction Near VA", type: "visual-acuity-select" },
        ouDistanceVisualAcuity: { display: "OU Dist VA", type: "visual-acuity-select" },
        ouNearVisualAcuity: { display: "OU Near VA", type: "visual-acuity-select" },
        remarks: { display: "Remarks", type: "string", maximumLength: 2000 },
        assessmentRegimen: { display: "Assessment and CL Regimen", type: "string", maximumLength: 2000 },
        notes: { display: "Notes", type: "string", maximumLength: 2000 },
      },
    },
    normalSemantics: { diagnosisSuggestions: false },
    sourceStatus: "verified-seed",
    fhirObservationCode: odosConcept("soft_contact_lens", "Soft contact lens prescription"),
    notBillReady: true,
    active: true,
    provenance,
  });
}

const SPECIALTY_MANUFACTURERS: ClinicalFindingOption[] = [
  option("art_optical", "Art Optical"),
  option("blanchard", "Blanchard"),
  option("paragon_crt", "Paragon CRT"),
  option("wave_contact_lens_system", "Wave Contact Lens System"),
];

const SPECIALTY_PRODUCTS: SpecialtyContactLensCatalogOption[] = [
  specialtyProduct("ampleye", "Ampleye", "art_optical", "scleral-prolate"),
  specialtyProduct("renovation", "Renovation", "art_optical", "corneal-GP"),
  specialtyProduct("clasikcn", "CLASIKcn", "art_optical", "corneal-GP"),
  specialtyProduct("so2clear_progressive", "So2Clear Progressive", "art_optical", "corneal-GP-bitoric-bifocal"),
  specialtyProduct("intelliwave", "Intelliwave", "art_optical", "corneal-GP"),
  specialtyProduct("onefit", "Onefit", "blanchard", "scleral-prolate"),
  specialtyProduct("onefit_med", "Onefit Med", "blanchard", "scleral-prolate"),
  specialtyProduct("reclaim_hd", "Reclaim HD", "blanchard", "corneal-GP-bitoric-bifocal"),
  specialtyProduct("msd", "MSD", "blanchard", "scleral-prolate"),
  specialtyProduct("paragon_crt", "Paragon CRT", "paragon_crt", "ortho-K"),
  specialtyProduct("wave_ortho_k", "Wave Ortho-K", "wave_contact_lens_system", "ortho-K"),
];

const SPECIALTY_LENS_TYPES = [
  lensType("ortho-K", "Corneal Reshaping / Ortho-K"),
  lensType("scleral-prolate", "Scleral - Prolate"),
  lensType("scleral-oblate", "Scleral - Oblate"),
  lensType("scleral-multifocal", "Scleral - Multifocal"),
  lensType("scleral-toric-haptic", "Scleral - Toric Haptic"),
  lensType("scleral-quadrant-haptic", "Scleral - Quadrant Haptic"),
  lensType("corneal-GP", "GP / Corneal"),
  lensType("corneal-GP-bitoric", "GP / Corneal Bitoric"),
  lensType("corneal-GP-bitoric-bifocal", "GP / Corneal Bitoric Bifocal"),
  lensType("RGP", "Rigid Gas Permeable"),
  lensType("hybrid", "Hybrid"),
  lensType("custom-design", "Custom"),
];

const SPECIALTY_MATERIALS: ClinicalFindingOption[] = [
  materialOption("Boston-XO2", "Boston XO2"),
  materialOption("Boston-ES", "Boston ES"),
  materialOption("Fluoroperm", "Fluoroperm"),
];

const SPECIALTY_ADDITIONAL_FIELDS: SpecialtyAdditionalFieldOption[] = [
  additionalField("hvid", "HVID", "SPECIALTY_HVID_MM", "mm"),
  additionalField("skirt", "Skirt", "SPECIALTY_SKIRT", "mm", "soft-skirt-curve"),
  additionalField("sag", "SAG", "SPECIALTY_SAG", "um", "sagittal-depth-um"),
  additionalField("oad", "OAD", "SPECIALTY_OAD_MM", "mm"),
  additionalField("pcr", "PCR", "SPECIALTY_PCR_MM", "mm"),
  additionalField("pcw", "PCW", "SPECIALTY_PCW_MM", "mm"),
  additionalField("radius_2", "Radius 2", "SPECIALTY_RADIUS_2_MM", "mm"),
  additionalField("radius_3", "Radius 3", "SPECIALTY_RADIUS_3_MM", "mm"),
  additionalField("width_2", "Width 2", "SPECIALTY_WIDTH_2_MM", "mm"),
  additionalField("prism", "Prism", "SPECIALTY_PRISM_D", "[diop]"),
  additionalField("base_curve_2", "Base Curve 2", "SPECIALTY_BASE_CURVE_2_MM", "mm"),
  additionalField("segment_height", "Segment Height", "SPECIALTY_SEGMENT_HEIGHT", "mm", "segment-height-lower-edge-mm"),
  additionalField("sphere_2", "Sphere 2", "SPECIALTY_SPHERE_2_D", "[diop]"),
  additionalField("cylinder_2", "Cylinder 2", "SPECIALTY_CYLINDER_2_D", "[diop]"),
  additionalField("axis_2", "Axis 2", "SPECIALTY_AXIS_2_DEG", "deg"),
  additionalField("center_thickness", "Center Thickness", "SPECIALTY_CENTER_THICKNESS", "mm", "center-thickness-mm"),
  additionalField("edge_thickness", "Edge Thickness", "SPECIALTY_EDGE_THICKNESS_MM", "mm"),
];

export function buildSpecialtyContactLensFindingDefinitionStub(
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition {
  return buildClinicalFindingDefinition({
    id: "finding-def-specialty-contact-lens",
    stableKey: "specialty_contact_lens",
    display: "Specialty contact lens prescription",
    sectionKey: "specialty-contact-lens",
    anatomyTarget: "eye",
    valueSchema: {
      valueKind: "specialty-contact-lens-panel",
      fields: {
        usage: selectField("Usage", USAGE_OPTIONS),
        status: selectField("Status", STATUS_OPTIONS),
        underlyingCondition: selectField("Underlying Condition", UNDERLYING_CONDITION_OPTIONS),
        manufacturer: selectField("Manufacturer", SPECIALTY_MANUFACTURERS),
        product: {
          ...selectField("Product", SPECIALTY_PRODUCTS),
          cascadeFrom: "manufacturer",
          optionMetadata: ["manufacturerCode", "lensTypeCode"],
          manualEntryFeedsCatalog: true,
        },
        lensType: selectField("Lens Type", SPECIALTY_LENS_TYPES),
        material: selectField("Material", SPECIALTY_MATERIALS),
        baseCurve: decimalField("Base Curve", 3, 15, 2, "mm"),
        diameter: decimalField("Diameter", 5, 30, 2, "mm"),
        sphere: powerField("Sphere", -30, 30),
        cylinder: powerField("Cylinder", -8, 0),
        axis: { display: "Axis", type: "integer-select", minimum: 0, maximum: 180, step: 1, unit: "degrees" },
        add: powerField("Add", 0, 4),
        distanceVisualAcuity: { display: "Dist VA", type: "visual-acuity-select" },
        nearVisualAcuity: { display: "Near VA", type: "visual-acuity-select" },
        distancePinholeVisualAcuity: { display: "Dist PH", type: "visual-acuity-select" },
        other: { display: "Other", type: "string", maximumLength: 500 },
        manualEntry: { display: "Manual Entry", type: "boolean" },
        additionalFields: {
          display: "Additional Fields",
          type: "visible-hidden-field-picker",
          editable: true,
          options: SPECIALTY_ADDITIONAL_FIELDS,
          visibleCodes: [],
          // Slice D generalizes this fixed pool to operator-created fields.
          allowCreate: false,
        },
        overRefractionSphere: powerField("Over-Refraction Sphere", -20, 20),
        overRefractionCylinder: powerField("Over-Refraction Cylinder", -8, 0),
        overRefractionAxis: { display: "Over-Refraction Axis", type: "integer-select", minimum: 0, maximum: 180, step: 1, unit: "degrees" },
        overRefractionDistanceVisualAcuity: { display: "Over-Refraction Dist VA", type: "visual-acuity-select" },
        overRefractionNearVisualAcuity: { display: "Over-Refraction Near VA", type: "visual-acuity-select" },
        remarks: { display: "Remarks", type: "string", maximumLength: 2000 },
      },
    },
    normalSemantics: { diagnosisSuggestions: false },
    sourceStatus: "verified-seed",
    fhirObservationCode: odosConcept("specialty_contact_lens", "Specialty contact lens prescription"),
    notBillReady: true,
    active: true,
    provenance,
  });
}

function product(
  code: string,
  display: string,
  manufacturerCode: string,
  design: ContactLensCatalogOption["design"],
  baseCurves: string[],
  diameters: string[],
  metadata: Pick<ContactLensCatalogOption, "colorOptions" | "mfPowerOptions"> = {},
): ContactLensCatalogOption {
  return {
    code,
    display,
    manufacturerCode,
    design,
    baseCurveOptions: parameterOptions(baseCurves),
    diameterOptions: parameterOptions(diameters),
    active: true,
    ...metadata,
  };
}

function parameterOptions(values: string[]): ClinicalFindingOption[] {
  return values.map((value) => option(value, value));
}

function specialtyProduct(
  code: string,
  display: string,
  manufacturerCode: string,
  lensTypeCode?: ContactLensTypeCode,
): SpecialtyContactLensCatalogOption {
  return { code, display, manufacturerCode, lensTypeCode, active: true };
}

function lensType(code: ContactLensTypeCode, display: string): ClinicalFindingOption {
  return option(code, display);
}

function materialOption(code: ContactLensMaterialCode, display: string): ClinicalFindingOption {
  return option(code, display);
}

function additionalField(
  code: string,
  display: string,
  localCode: string,
  unit: UcumUnitCode,
  parameterCode?: ContactLensParameterCode,
): SpecialtyAdditionalFieldOption {
  return { code, display, localCode, parameterCode, unit, active: true };
}

function option(code: string, display: string): ClinicalFindingOption {
  return { code, display, active: true };
}

function selectField(display: string, options: ClinicalFindingOption[]) {
  return { display, type: "single-select", editable: true, options };
}

function powerField(display: string, minimum: number, maximum: number) {
  return { display, type: "quarter-diopter-select", minimum, maximum, step: 0.25, unit: "D" };
}

export function decimalField(display: string, minimum: number, maximum: number, precision: number, unit: string) {
  return { display, type: "decimal-input", minimum, maximum, precision, unit };
}
