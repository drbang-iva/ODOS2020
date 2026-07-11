import type { BuildResult, RefractionInput } from "./types.js";
import {
  applyCommonObservationFields,
  component,
  osodConcept,
  quantity,
  reference,
} from "./extensions.js";

export function buildRefractionObservation(
  input: RefractionInput & { remarks?: string },
): BuildResult<import("./types.js").Observation> {
  validateOptionalNumber("sphere", input.sphere);
  validateOptionalNumber("cylinder", input.cylinder);
  validateOptionalNumber("add", input.add);

  if (input.axis !== undefined) {
    validateOptionalNumber("axis", input.axis);
    if (input.axis < 0 || input.axis > 180) {
      throw new Error("Refraction axis must be between 0 and 180.");
    }
  }

  const components = [
    component("REFRACTION_TYPE", "Refraction type", {
      valueCodeableConcept: osodConcept(
        input.refractionType,
        input.refractionTypeDisplay ?? input.refractionType,
      ),
    }),
  ];

  if (input.blockId) {
    components.push(
      component("REFRACTION_BLOCK_ID", "Refraction block ID", {
        valueString: input.blockId,
      }),
    );
  }

  if (input.purpose) {
    components.push(
      component("PURPOSE", "Purpose", {
        valueString: input.purpose,
      }),
    );
  }

  if (input.remarks) {
    components.push(
      component("REMARKS", "Remarks", {
        valueString: input.remarks,
      }),
    );
  }

  if (input.sphere !== undefined) {
    components.push(
      component("SPHERE", "Sphere", {
        valueQuantity: quantity(input.sphere, "D", "http://unitsofmeasure.org", "[diop]"),
      }),
    );
  }

  if (input.cylinder !== undefined) {
    components.push(
      component("CYLINDER", "Cylinder", {
        valueQuantity: quantity(input.cylinder, "D", "http://unitsofmeasure.org", "[diop]"),
      }),
    );
  }

  if (input.axis !== undefined) {
    components.push(
      component("AXIS", "Axis", {
        valueQuantity: quantity(input.axis, "degrees", "http://unitsofmeasure.org", "deg"),
      }),
    );
  }

  if (input.add !== undefined) {
    components.push(
      component("ADD", "Near add", {
        valueQuantity: quantity(input.add, "D", "http://unitsofmeasure.org", "[diop]"),
      }),
    );
  }

  if (input.visualAcuity?.distance) {
    components.push(
      component("DISTANCE_VA", "Distance visual acuity", {
        valueString: input.visualAcuity.distance,
      }),
    );
  }

  if (input.visualAcuity?.near) {
    components.push(
      component("NEAR_VA", "Near visual acuity", {
        valueString: input.visualAcuity.near,
      }),
    );
  }

  if (input.visualAcuity?.distancePinhole) {
    components.push(
      component("DISTANCE_PH_VA", "Distance pinhole visual acuity", {
        valueString: input.visualAcuity.distancePinhole,
      }),
    );
  }

  if (input.prism) {
    if (input.prism.amount !== undefined) {
      validateOptionalNumber("prism.amount", input.prism.amount);
    }
    if (input.prism.amount === undefined) {
      throw new Error("Refraction prism requires amount when prism is supplied.");
    }
    components.push(
      component("PRISM", "Prism", {
        valueQuantity: quantity(input.prism.amount, "PD", "http://unitsofmeasure.org", "[diop]"),
        valueCodeableConcept: prismBaseConcept(input.prism.base),
      }),
    );
  }

  if (components.length === 1) {
    throw new Error("Refraction requires at least one structured measurement component.");
  }

  const observation = applyCommonObservationFields(
    {
      resourceType: "Observation",
      status: "preliminary",
      code: osodConcept("REFRACTION", "Refraction"),
      component: components,
      ...(input.visualAcuityWithCorrectionReference
        ? { hasMember: [reference(input.visualAcuityWithCorrectionReference)] }
        : {}),
    },
    {
      ...input,
      method: input.method ?? osodConcept(
        input.refractionType,
        input.refractionTypeDisplay ?? input.refractionType,
      ),
    },
  );

  return { resource: observation, warnings: [] };
}

function validateOptionalNumber(name: string, value: number | undefined): void {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new Error(`Refraction ${name} must be numeric.`);
  }
}

function prismBaseConcept(value: string | undefined) {
  const normalized = normalizePrismBase(value);

  return {
    coding: [
      {
        system: "http://hl7.org/fhir/vision-base-codes",
        code: normalized,
        display: normalized,
      },
    ],
    text: normalized,
  };
}

function normalizePrismBase(value: string | undefined): "up" | "down" | "in" | "out" {
  const normalized = (value ?? "").trim().toLowerCase();
  if (
    normalized === "up" ||
    normalized === "down" ||
    normalized === "in" ||
    normalized === "out"
  ) {
    return normalized;
  }
  throw new Error("Refraction prism base must be one of up, down, in, or out.");
}
