import type {
  Observation,
  ObservationComponent,
  VisionPrescription,
  VisionPrescriptionLensSpecification,
  VisionPrescriptionLensSpecificationPrism,
} from "@medplum/fhirtypes";
import { OSOD_OPHTHALMOLOGY_CODE_SYSTEM } from "./codeBindings.js";
import { OSOD_EXTENSION_URLS, reference } from "./extensions.js";
import type { EyeLaterality } from "./types.js";

export interface VisionPrescriptionInput {
  refractionObservation: Observation;
  patientReference: string;
  prescriberReference: string;
  dateWritten?: string;
  lensType?: string;
}

export function buildVisionPrescription(input: VisionPrescriptionInput): VisionPrescription {
  assertFinalRx(input.refractionObservation);

  const eyes = lateralityFromObservation(input.refractionObservation);
  const lensSpecification = eyes.map((eye) =>
    buildLensSpecification(input.refractionObservation, eye, input.lensType),
  );

  return {
    resourceType: "VisionPrescription",
    status: "active",
    created: new Date().toISOString(),
    patient: reference(input.patientReference),
    ...(input.refractionObservation.encounter
      ? { encounter: input.refractionObservation.encounter }
      : {}),
    dateWritten: input.dateWritten ?? new Date().toISOString(),
    prescriber: reference(input.prescriberReference),
    lensSpecification,
  };
}

function buildLensSpecification(
  refractionObservation: Observation,
  eye: "right" | "left",
  lensType = "eyeglasses",
): VisionPrescriptionLensSpecification {
  const prism = prismComponent(refractionObservation);

  return {
    product: { text: lensType },
    eye,
    ...(numberComponent(refractionObservation, "SPHERE") !== undefined
      ? { sphere: numberComponent(refractionObservation, "SPHERE") }
      : {}),
    ...(numberComponent(refractionObservation, "CYLINDER") !== undefined
      ? { cylinder: numberComponent(refractionObservation, "CYLINDER") }
      : {}),
    ...(numberComponent(refractionObservation, "AXIS") !== undefined
      ? { axis: numberComponent(refractionObservation, "AXIS") }
      : {}),
    ...(numberComponent(refractionObservation, "ADD") !== undefined
      ? { add: numberComponent(refractionObservation, "ADD") }
      : {}),
    ...(prism ? { prism: [prism] } : {}),
  };
}

function assertFinalRx(refractionObservation: Observation): void {
  const refractionType = component(refractionObservation, "REFRACTION_TYPE");
  const typeCode = refractionType?.valueCodeableConcept?.coding?.find(
    (coding) => coding.system === OSOD_OPHTHALMOLOGY_CODE_SYSTEM,
  )?.code;

  if (typeCode !== "FINAL_RX") {
    throw new Error("VisionPrescription requires a FINAL_RX-tagged Refraction Observation.");
  }
}

function lateralityFromObservation(observation: Observation): Array<"right" | "left"> {
  const eye = observation.extension?.find((extension) => extension.url === OSOD_EXTENSION_URLS.eyeLaterality)
    ?.valueCodeableConcept?.coding?.find((coding) => coding.system === OSOD_OPHTHALMOLOGY_CODE_SYSTEM)
    ?.code as EyeLaterality | undefined;

  if (eye === "OD") return ["right"];
  if (eye === "OS") return ["left"];
  if (eye === "OU") return ["right", "left"];
  throw new Error("VisionPrescription requires OD, OS, or OU eye laterality on the Refraction Observation.");
}

function numberComponent(observation: Observation, code: string): number | undefined {
  return component(observation, code)?.valueQuantity?.value;
}

function prismComponent(
  observation: Observation,
): VisionPrescriptionLensSpecificationPrism | undefined {
  const prism = component(observation, "PRISM");
  const amount = prism?.valueQuantity?.value;
  const base = prism?.valueCodeableConcept?.coding?.find(
    (coding) => coding.system === "http://hl7.org/fhir/vision-base-codes",
  )?.code;

  if (amount === undefined && base === undefined) {
    return undefined;
  }
  if (amount === undefined || !isPrismBase(base)) {
    throw new Error("Prism component requires amount and base to build VisionPrescription.");
  }

  return { amount, base };
}

function component(observation: Observation, code: string): ObservationComponent | undefined {
  return observation.component?.find((candidate) =>
    candidate.code.coding?.some(
      (coding) => coding.system === OSOD_OPHTHALMOLOGY_CODE_SYSTEM && coding.code === code,
    ),
  );
}

function isPrismBase(value: string | undefined): value is "up" | "down" | "in" | "out" {
  return value === "up" || value === "down" || value === "in" || value === "out";
}
