import { randomBytes } from "node:crypto";

export const BULK_EXPORT_JOB_ID_PATTERN = /^[A-Za-z0-9_-]{16,}$/;

const PHI_SHAPED_IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /\bMRN[-_ ]?\d+/i,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b[A-Z][a-z]+[._-][A-Z][a-z]+\b/,
];

const MAX_PHI_SHAPE_RETRIES = 64;

export function generateBulkExportJobId(): string {
  for (let attempt = 0; attempt < MAX_PHI_SHAPE_RETRIES; attempt += 1) {
    const id = randomBytes(24).toString("base64url");
    try {
      assertBulkExportIdentifierIsOpaque(id);
      return id;
    } catch {
      // Random base64url can incidentally match the PHI-shape regex set
      // (notably the [A-Z][a-z]+[._-][A-Z][a-z]+ pattern). Re-roll.
      // The PHI assertion remains the canonical defense per BINDING #25;
      // the retry preserves coverage while keeping the generator deterministic-pass.
    }
  }
  throw new Error(
    "Bulk Data export identifier generator exhausted retries; PHI-shape patterns may be too aggressive against random base64url.",
  );
}

export function assertBulkExportIdentifierIsOpaque(value: string): void {
  if (!BULK_EXPORT_JOB_ID_PATTERN.test(value)) {
    throw new Error("Bulk Data export identifiers must be high-entropy URL-safe nonces.");
  }
  if (PHI_SHAPED_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error("Bulk Data export identifiers must not contain PHI-shaped substrings.");
  }
}
