import type { Binary } from "@medplum/fhirtypes";
import type { JsonPatchOperation } from "../fhir-client.js";

export const SECURITY_CONTEXT_HEADER = "X-Security-Context";
export const BINARY_PARSER_GUARD_HEADER = "X-OSOD-Binary-Parser";
export const BINARY_PARSER_GUARD_VALUE = "security-context-v1";

export const BINARY_SECURITY_CONTEXT_ANCHOR_TYPES = [
  "Patient",
  "DocumentReference",
  "DiagnosticReport",
  "Encounter",
  "Media",
] as const;

export type BinarySecurityContextAnchorType =
  (typeof BINARY_SECURITY_CONTEXT_ANCHOR_TYPES)[number];

export type BinaryWriteSource =
  | "parser-plugin"
  | "raw-upload-header"
  | "medplum-create-media"
  | "agent-direct-fhir";

export interface BinaryCreateContext {
  source: BinaryWriteSource;
  headers?: Record<string, string | undefined>;
  anchorReference?: string;
  allowedPatientCompartments?: string[];
}

export interface BinaryPatchContext {
  operations: JsonPatchOperation[];
}

export function prepareBinaryForParserCreate(
  binary: Binary,
  context: BinaryCreateContext,
): Binary {
  if (context.source === "agent-direct-fhir") {
    throw mandate8BinaryBoundaryError();
  }

  const securityContextReference =
    binary.securityContext?.reference ??
    context.anchorReference ??
    securityContextHeaderValue(context.headers);

  assertValidSecurityContextReference(securityContextReference);
  assertAllowedPatientCompartment(securityContextReference, context.allowedPatientCompartments);

  return {
    ...binary,
    securityContext: { reference: securityContextReference },
  };
}

export function assertBinaryCreateThroughParser(
  binary: Binary,
  extraHeaders: Record<string, string> = {},
): void {
  if (extraHeaders[BINARY_PARSER_GUARD_HEADER] !== BINARY_PARSER_GUARD_VALUE) {
    throw mandate8BinaryBoundaryError();
  }
  assertValidSecurityContextReference(binary.securityContext?.reference);
}

export function assertBinaryPatchAllowed(context: BinaryPatchContext): void {
  const mutatingSecurityContext = context.operations.find((operation) =>
    operation.path === "/securityContext" ||
    operation.path.startsWith("/securityContext/"),
  );
  if (mutatingSecurityContext) {
    throw new Error(
      "Binary.securityContext is immutable: PATCH cannot drop or rewrite the securityContext anchor.",
    );
  }
}

export function parserBinaryHeaders(securityContextReference: string): Record<string, string> {
  assertValidSecurityContextReference(securityContextReference);
  return {
    [SECURITY_CONTEXT_HEADER]: securityContextReference,
    [BINARY_PARSER_GUARD_HEADER]: BINARY_PARSER_GUARD_VALUE,
  };
}

export function assertValidSecurityContextReference(
  reference: string | undefined,
): asserts reference is string {
  if (!reference) {
    throw new Error(
      "Binary.securityContext is required: parser plugin must supply Patient, DocumentReference, DiagnosticReport, Encounter, or Media anchor.",
    );
  }

  const [resourceType, id, extra] = reference.split("/");
  if (!resourceType || !id || extra !== undefined) {
    throw new Error(
      `Binary.securityContext must be a FHIR reference like Patient/<id>; received "${reference}".`,
    );
  }

  if (!BINARY_SECURITY_CONTEXT_ANCHOR_TYPES.includes(resourceType as BinarySecurityContextAnchorType)) {
    throw new Error(
      `Binary.securityContext anchor ${resourceType} is not allowed for OSOD parser uploads.`,
    );
  }
}

function assertAllowedPatientCompartment(
  securityContextReference: string,
  allowedPatientCompartments: string[] | undefined,
): void {
  if (!allowedPatientCompartments?.length || !securityContextReference.startsWith("Patient/")) {
    return;
  }

  if (!allowedPatientCompartments.includes(securityContextReference)) {
    throw new Error(
      `Binary.securityContext ${securityContextReference} is outside the caller's patient compartment.`,
    );
  }
}

function securityContextHeaderValue(
  headers: Record<string, string | undefined> | undefined,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const header = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === SECURITY_CONTEXT_HEADER.toLowerCase(),
  );
  return header?.[1];
}

function mandate8BinaryBoundaryError(): Error {
  return new Error(
    "Mandate 8 boundary: MCP agents cannot POST Binary directly; Binary writes must pass through the parser plugin with Binary.securityContext.",
  );
}
