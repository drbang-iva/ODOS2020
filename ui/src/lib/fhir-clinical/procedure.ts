// MIRROR of osod/mcp/src/fhir/procedure.ts. Source of truth lives in MCP. Sync manually until v0.5 monorepo refactor. Parity guarded by mcp/tests/builder-mirror-parity.test.ts.
import type { CodeableConcept, Extension, Procedure, Reference } from "@medplum/fhirtypes";

export const PROCEDURE_TARGET_BODY_STRUCTURE_EXTENSION_URL =
  "http://hl7.org/fhir/StructureDefinition/procedure-targetBodyStructure";

export const PROCEDURE_STATUS_CODES = [
  "preparation",
  "in-progress",
  "not-done",
  "on-hold",
  "stopped",
  "completed",
  "entered-in-error",
  "unknown",
] as const;

export type ProcedureStatusCode = (typeof PROCEDURE_STATUS_CODES)[number];

export interface ProcedureCodeInput {
  system: string;
  code: string;
  display?: string;
  text?: string;
}

export interface ProcedureInput {
  patientReference: string;
  status: ProcedureStatusCode;
  code: ProcedureCodeInput | CodeableConcept;
  encounterReference?: string;
  performedDateTime?: string;
  bodyStructureReference?: string;
}

export function buildProcedure(input: ProcedureInput): Procedure {
  return withProcedureTargetBodyStructure(
    {
      resourceType: "Procedure",
      status: input.status,
      code: procedureCodeConcept(input.code),
      subject: reference(input.patientReference),
      ...(input.encounterReference ? { encounter: reference(input.encounterReference) } : {}),
      ...(input.performedDateTime ? { performedDateTime: input.performedDateTime } : {}),
    },
    input.bodyStructureReference,
  );
}

export function withProcedureTargetBodyStructure(
  procedure: Procedure,
  bodyStructureReference: string | undefined,
): Procedure {
  if (!bodyStructureReference) {
    return {
      ...procedure,
      extension: procedure.extension?.filter(
        (extension) => extension.url !== PROCEDURE_TARGET_BODY_STRUCTURE_EXTENSION_URL,
      ),
    };
  }

  return {
    ...procedure,
    extension: [
      ...(procedure.extension ?? []).filter(
        (extension) => extension.url !== PROCEDURE_TARGET_BODY_STRUCTURE_EXTENSION_URL,
      ),
      procedureTargetBodyStructureExtension(bodyStructureReference),
    ],
  };
}

export function procedureTargetBodyStructureExtension(
  bodyStructureReference: string,
): Extension {
  return {
    url: PROCEDURE_TARGET_BODY_STRUCTURE_EXTENSION_URL,
    valueReference: reference(bodyStructureReference),
  };
}

export function procedureCodeConcept(input: ProcedureCodeInput | CodeableConcept): CodeableConcept {
  if (isCodeableConcept(input)) {
    return input;
  }

  return {
    coding: [
      {
        system: input.system,
        code: input.code,
        ...(input.display ? { display: input.display } : {}),
      },
    ],
    text: input.text ?? input.display ?? input.code,
  };
}

function isCodeableConcept(input: ProcedureCodeInput | CodeableConcept): input is CodeableConcept {
  return "coding" in input;
}

function reference(value: string): Reference<never> {
  return { reference: value };
}
