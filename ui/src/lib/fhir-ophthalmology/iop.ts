// MIRROR of osod/mcp/src/fhir/ophthalmology/iop.ts. Source of truth lives in MCP. Sync manually until v0.5 monorepo refactor. Parity guarded by mcp/tests/builder-mirror-parity.test.ts.
import type { CodeableConcept } from "@medplum/fhirtypes";
import type { BuildResult, IopInput, IopMethod } from "./types.js";
import { OSOD_OPHTHALMOLOGY_CODE_SYSTEM, SNOMED_CT_CODE_SYSTEM } from "./codeBindings.js";
import { applyCommonObservationFields, osodConcept, quantity } from "./extensions.js";

const EYECARE_IOP_METHOD_CODE_SYSTEM =
  "http://terminology.hl7.org/uv/eyecare/CodeSystem/iop-methods";

const IOP_METHOD_TO_IG_CODING: Partial<
  Record<IopMethod, { system: string; code: string; display: string }>
> = {
  GAT: {
    system: SNOMED_CT_CODE_SYSTEM,
    code: "389152008",
    display: "Goldmann applanation tonometry (procedure)",
  },
  ICARE: {
    system: EYECARE_IOP_METHOD_CODE_SYSTEM,
    code: "rebound-tonometry",
    display: "Rebound tonometry",
  },
  TONOPEN: {
    system: SNOMED_CT_CODE_SYSTEM,
    code: "252803002",
    display: "Applanation tonometry",
  },
  NCT: {
    system: SNOMED_CT_CODE_SYSTEM,
    code: "389150000",
    display: "Non-contact tonometry (procedure)",
  },
  PERKINS: {
    system: SNOMED_CT_CODE_SYSTEM,
    code: "389151001",
    display: "Perkins applanation tonometry (procedure)",
  },
};

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
        method: iopMethodConcept(input.method),
      },
    ),
    warnings,
  };
}

function iopMethodConcept(method: CodeableConcept | undefined): CodeableConcept {
  const normalizedMethod = method?.coding?.find(
    (coding) => coding.system === OSOD_OPHTHALMOLOGY_CODE_SYSTEM,
  )?.code as IopMethod | undefined;
  const igCoding = normalizedMethod ? IOP_METHOD_TO_IG_CODING[normalizedMethod] : undefined;
  const base = method ?? osodConcept("UNKNOWN", "Unknown tonometry method");

  if (!igCoding) {
    return base;
  }

  const hasIgCoding = base.coding?.some(
    (coding) => coding.system === igCoding.system && coding.code === igCoding.code,
  );

  return {
    ...base,
    coding: hasIgCoding ? base.coding : [...(base.coding ?? []), igCoding],
  };
}
