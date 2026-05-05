import { randomBytes } from "node:crypto";

export const BULK_EXPORT_JOB_ID_PATTERN = /^[A-Za-z0-9_-]{16,}$/;

const PHI_SHAPED_IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /\bMRN[-_ ]?\d+/i,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b[A-Z][a-z]+[._-][A-Z][a-z]+\b/,
];

export function generateBulkExportJobId(): string {
  const id = randomBytes(24).toString("base64url");
  assertBulkExportIdentifierIsOpaque(id);
  return id;
}

export function assertBulkExportIdentifierIsOpaque(value: string): void {
  if (!BULK_EXPORT_JOB_ID_PATTERN.test(value)) {
    throw new Error("Bulk Data export identifiers must be high-entropy URL-safe nonces.");
  }
  if (PHI_SHAPED_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error("Bulk Data export identifiers must not contain PHI-shaped substrings.");
  }
}
