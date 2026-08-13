export function isFhirConflict(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: unknown }).status
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return status === 409 || status === 412 || /FHIR (409|412)\b/.test(message);
}
