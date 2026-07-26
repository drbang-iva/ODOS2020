const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;
const RESOURCE_TYPE = /^[A-Z][A-Za-z0-9]{0,63}$/;

export interface RelativeFhirReference {
  resourceType: string;
  id: string;
}

export function parseRelativeFhirReference(
  reference: unknown,
  expectedResourceType?: string,
): RelativeFhirReference | undefined {
  if (typeof reference !== "string") return undefined;
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator !== reference.lastIndexOf("/")) return undefined;
  const resourceType = reference.slice(0, separator);
  const id = reference.slice(separator + 1);
  if (!RESOURCE_TYPE.test(resourceType) || !FHIR_ID.test(id)) return undefined;
  if (expectedResourceType && resourceType !== expectedResourceType) return undefined;
  return { resourceType, id };
}

export function isRelativeFhirReference(
  reference: unknown,
  expectedResourceType?: string,
): reference is string {
  return parseRelativeFhirReference(reference, expectedResourceType) !== undefined;
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
