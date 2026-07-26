const FHIR_REFERENCE = /^([A-Z][A-Za-z0-9]{0,63})\/([A-Za-z0-9\-.]{1,64})$/;

export function isRelativeFhirReference(
  reference: unknown,
  expectedResourceType?: string,
): reference is string {
  if (typeof reference !== "string") return false;
  const match = FHIR_REFERENCE.exec(reference);
  return Boolean(match && (!expectedResourceType || match[1] === expectedResourceType));
}

export function assertRelativeFhirReference(
  reference: unknown,
  expectedResourceType?: string,
  label = "FHIR reference",
): asserts reference is string {
  if (!isRelativeFhirReference(reference, expectedResourceType)) {
    const expected = expectedResourceType ? `${expectedResourceType}/<id>` : "Type/<id>";
    throw new Error(
      `${label} must be a relative ${expected} reference with a valid FHIR id; got ${JSON.stringify(reference)}.`,
    );
  }
}
