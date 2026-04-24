import type { BuildResult, IopInput } from "./types.js";
import { applyCommonObservationFields, osodConcept, quantity } from "./extensions.js";

export function buildIopObservation(input: IopInput): BuildResult<import("./types.js").Observation> {
  if (!Number.isFinite(input.value)) {
    throw new Error("IOP value must be numeric.");
  }
  if (input.value < 0) {
    throw new Error("IOP value cannot be negative.");
  }

  const warnings: string[] = [];
  if (input.value < 3 || input.value > 80) {
    warnings.push("IOP value is outside the v0.2.2 plausibility guard range (<3 or >80 mmHg).");
  }

  return {
    resource: applyCommonObservationFields(
      {
        resourceType: "Observation",
        status: "final",
        code: osodConcept("INTRAOCULAR_PRESSURE", "Intraocular pressure"),
        valueQuantity: quantity(input.value, input.unit ?? "mmHg", "http://unitsofmeasure.org", "mm[Hg]"),
      },
      {
        ...input,
        method: input.method ?? osodConcept("UNKNOWN", "Unknown tonometry method"),
      },
    ),
    warnings,
  };
}
