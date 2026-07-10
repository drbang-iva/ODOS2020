import { osodConcept } from "../fhir/ophthalmology/extensions.js";
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
  frequentlyUsed?: boolean;
}

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
  product("precision1", "Precision1", "alcon", "spherical"),
  product("precision1_astigmatism", "Precision1 for Astigmatism", "alcon", "toric"),
  product("precision7", "Precision7", "alcon", "spherical"),
  product("precision7_astigmatism", "Precision7 for Astigmatism", "alcon", "toric"),
  product("total30_astigmatism", "TOTAL30 for Astigmatism", "alcon", "toric"),
  product("dailies_total1", "Dailies Total1", "alcon", "spherical"),
  product("dailies_total1_astigmatism", "Dailies Total1 for Astigmatism", "alcon", "toric"),
  product("air_optix_aqua", "Air Optix Aqua", "alcon", "spherical"),
  product("air_optix_aqua_multifocal", "Air Optix Aqua Multifocal", "alcon", "multifocal", { mfPowerOptions: MF_POWERS }),
  product("air_optix_colors", "Air Optix Colors", "alcon", "color", { colorOptions: COLORS }),
  product("air_optix_astigmatism", "Air Optix for Astigmatism", "alcon", "toric"),
  product("air_optix_night_day", "Air Optix Night & Day", "alcon", "spherical"),
  product("acuvue_oasys", "Acuvue Oasys", "vistakon", "spherical"),
  product("acuvue_moist_multifocal", "1-Day Acuvue Moist Multifocal", "vistakon", "multifocal", { mfPowerOptions: MF_POWERS }),
  product("biofinity", "Biofinity", "cooper_vision", "spherical"),
  product("biofinity_multifocal", "Biofinity Multifocal", "cooper_vision", "multifocal", { mfPowerOptions: MF_POWERS }),
  product("biofinity_toric", "Biofinity Toric", "cooper_vision", "toric"),
  product("proclear", "Proclear", "cooper_vision", "spherical"),
  product("proclear_xr", "Proclear XR", "cooper_vision", "spherical"),
  product("proclear_toric_multifocal", "Proclear Toric Multifocal", "cooper_vision", "multifocal", { mfPowerOptions: MF_POWERS }),
  product("clariti_1_day", "Clariti 1-Day", "cooper_vision", "spherical"),
  product("myday", "MyDay", "cooper_vision", "spherical"),
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
        usage: selectField("Usage", [
          option("distance", "Distance"),
          option("monovision", "Monovision"),
          option("monovision_od_distance", "Monovision OD distance"),
          option("monovision_os_distance", "Monovision OS distance"),
          option("monovision_od_near", "Monovision OD near"),
          option("monovision_os_near", "Monovision OS near"),
          option("multifocal", "Multifocal"),
        ]),
        status: selectField("Status", [
          option("order_trial", "Order Trial"),
          option("order_trial_doctor_fit", "Order Trial and Needs Fitting by Doctor"),
          option("order_trial_staff_fit", "Order Trial and Needs Fitting by Staff"),
          option("dispensed", "Dispensed"),
          option("dispensed_patient_confirm", "Dispensed and Patient Can Confirm Fit"),
          option("dispensed_successful", "Dispensed Successful"),
          option("dispensed_unsuccessful", "Dispensed Unsuccessful"),
        ]),
        binocularPdDistance: decimalField("Binocular PD Dist", 35, 90, 2, "mm"),
        binocularPdNear: decimalField("Binocular PD Near", 35, 90, 2, "mm"),
        underlyingCondition: selectField("Underlying Condition", [
          option("prosthesis", "Prosthesis"),
          option("balance_lens", "Balance Lens"),
          option("not_recorded", "Not Recorded"),
          option("no_lens", "No Lens"),
        ]),
        manufacturer: selectField("Manufacturer", MANUFACTURERS),
        product: { ...selectField("Product", PRODUCTS), cascadeFrom: "manufacturer", optionMetadata: ["manufacturerCode", "design", "colorOptions", "mfPowerOptions", "frequentlyUsed"] },
        baseCurve: decimalField("Base Curve", 5, 12, 2, "mm"),
        diameter: decimalField("Diameter", 10, 20, 2, "mm"),
        sphere: powerField("Sphere", -30, 30),
        cylinder: powerField("Cylinder", -20, 0),
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
        overRefractionCylinder: powerField("Over-Refraction Cylinder", -20, 0),
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
    fhirObservationCode: osodConcept("soft_contact_lens", "Soft contact lens prescription"),
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
  metadata: Pick<ContactLensCatalogOption, "colorOptions" | "mfPowerOptions"> = {},
): ContactLensCatalogOption {
  return { code, display, manufacturerCode, design, active: true, ...metadata };
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

function decimalField(display: string, minimum: number, maximum: number, precision: number, unit: string) {
  return { display, type: "decimal-input", minimum, maximum, precision, unit };
}
