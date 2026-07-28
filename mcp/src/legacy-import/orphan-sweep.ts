import { Pool } from "pg";
import type { AccessPolicy, Media } from "@medplum/fhirtypes";
import type { BinaryUploadAuth } from "../fhir/binary-upload.js";
import type {
  BinaryAttempt,
  BinaryAttemptStore,
} from "./binary-attempt-store.js";

const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5432/medplum";

export interface BinaryDatabaseReference {
  readonly table: string;
  readonly resourceId: string;
  readonly url: string;
}

export interface BinaryReferenceScanner {
  findAttachmentReferences(
    binaryIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly BinaryDatabaseReference[]>>;
  binaryMetadataExists(binaryId: string): Promise<boolean>;
  close?(): Promise<void>;
}

export interface BinarySweepResult {
  readonly attemptId: string;
  readonly binaryId?: string;
  readonly outcome:
    | "unresolved-no-binary-id"
    | "reported-referenced"
    | "candidate"
    | "disposed";
  readonly binaryMetadataExists?: boolean;
  readonly references: readonly BinaryDatabaseReference[];
  readonly reverificationError?: string;
}

export interface BinaryReferenceDatabase {
  query<T>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
  end(): Promise<void>;
}

export class PgBinaryReferenceScanner implements BinaryReferenceScanner {
  private readonly pool: BinaryReferenceDatabase;

  constructor(options: { postgresUrl?: string; pool?: BinaryReferenceDatabase } = {}) {
    this.pool = options.pool ?? new Pool({
      connectionString: options.postgresUrl ?? DEFAULT_POSTGRES_URL,
      max: 2,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
    }) as BinaryReferenceDatabase;
  }

  async findAttachmentReferences(
    binaryIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly BinaryDatabaseReference[]>> {
    const uniqueIds = [...new Set(binaryIds)];
    for (const binaryId of uniqueIds) assertUuid(binaryId);
    const references = new Map<string, BinaryDatabaseReference[]>(
      uniqueIds.map((binaryId) => [binaryId, []]),
    );
    if (uniqueIds.length === 0) return references;
    const tables = await this.pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'content'
        AND table_name ~ '^[A-Z]'
      ORDER BY table_name
    `);
    const patterns = uniqueIds.map((binaryId) => `%${binaryId}%`);
    for (const { table_name: table } of tables.rows) {
      const rows = await this.pool.query<{ id: string; content: string }>(`
        SELECT id::text, content
        FROM ${quoteIdentifier(table)}
        WHERE content LIKE ANY($1::text[])
      `, [patterns]);
      for (const row of rows.rows) {
        const content = JSON.parse(row.content) as unknown;
        for (const match of findBinaryAttachmentUrls(content, new Set(uniqueIds))) {
          references.get(match.binaryId)!.push({
            table,
            resourceId: row.id,
            url: match.url,
          });
        }
      }
    }
    return references;
  }

  async binaryMetadataExists(binaryId: string): Promise<boolean> {
    assertUuid(binaryId);
    const result = await this.pool.query(
      `SELECT 1 FROM "Binary" WHERE id = $1 AND deleted = false`,
      [binaryId],
    );
    return Boolean(result.rowCount);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function readStoredMedia(
  postgresUrl: string,
  mediaId: string,
): Promise<Media> {
  const pool = new Pool({
    connectionString: postgresUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  });
  try {
    const result = await pool.query<{ content: string }>(
      `SELECT content FROM "Media" WHERE id = $1 AND deleted = false`,
      [mediaId],
    );
    if (!result.rows[0]) throw new Error("Stored Media row is missing.");
    return JSON.parse(result.rows[0].content) as Media;
  } finally {
    await pool.end();
  }
}

export async function readLegacyAcceptancePatientCounts(
  postgresUrl: string,
  projectId: string,
): Promise<{ total: number; nonSynthetic: number }> {
  const pool = new Pool({
    connectionString: postgresUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  });
  try {
    const result = await pool.query<{ total: string; non_synthetic: string }>(`
      SELECT
        count(*)::text AS total,
        count(*) FILTER (
          WHERE NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              COALESCE(content::jsonb #> '{meta,tag}', '[]'::jsonb)
            ) AS tag
            WHERE tag->>'system' = 'https://odos2020.com/tags/test'
              AND tag->>'code' = 'legacy-import-m0'
          )
        )::text AS non_synthetic
      FROM "Patient"
      WHERE deleted = false
        AND "projectId" = $1
    `, [projectId]);
    return {
      total: Number(result.rows[0]?.total ?? 0),
      nonSynthetic: Number(result.rows[0]?.non_synthetic ?? 0),
    };
  } finally {
    await pool.end();
  }
}

export async function findPracticeProjectId(
  postgresUrl: string,
): Promise<string> {
  return (await findPracticeClinicianPolicy(postgresUrl)).projectId;
}

export async function findPracticeClinicianPolicy(
  postgresUrl: string,
): Promise<{ projectId: string; policyId: string }> {
  const pool = new Pool({
    connectionString: postgresUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  });
  try {
    const result = await pool.query<{ project_id: string; policy_id: string }>(`
      SELECT "projectId"::text AS project_id, id::text AS policy_id
      FROM "AccessPolicy"
      WHERE deleted = false
        AND content::jsonb->>'name' = 'ODOS Clinician'
    `);
    if (result.rows.length !== 1) {
      throw new Error(
        `Expected one practice project from stored ODOS Clinician policy; found ${result.rows.length}.`,
      );
    }
    return {
      projectId: result.rows[0]!.project_id,
      policyId: result.rows[0]!.policy_id,
    };
  } finally {
    await pool.end();
  }
}

export async function readMigrationImporterPolicies(
  postgresUrl: string,
  projectId: string,
  policyName: string,
): Promise<Array<{ policyId: string; policy: AccessPolicy }>> {
  const pool = new Pool({
    connectionString: postgresUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  });
  try {
    const result = await pool.query<{ policy_id: string; content: string }>(`
      SELECT id::text AS policy_id, content
      FROM "AccessPolicy"
      WHERE deleted = false
        AND "projectId" = $1
        AND content::jsonb->>'name' = $2
      ORDER BY id
    `, [projectId, policyName]);
    return result.rows.map((row) => ({
      policyId: row.policy_id,
      policy: JSON.parse(row.content) as AccessPolicy,
    }));
  } finally {
    await pool.end();
  }
}

export async function sweepLegacyImportBinaries(input: {
  readonly attempts: BinaryAttemptStore;
  readonly scanner: BinaryReferenceScanner;
  readonly auth: BinaryUploadAuth;
  readonly execute?: boolean;
  readonly binaryIds?: readonly string[];
}): Promise<BinarySweepResult[]> {
  const selectedIds = input.binaryIds ? new Set(input.binaryIds) : undefined;
  const openAttempts = (await input.attempts.listOpen()).filter(
    (attempt) => !selectedIds || (attempt.binaryId && selectedIds.has(attempt.binaryId)),
  );
  const referenceMap = await input.scanner.findAttachmentReferences(
    openAttempts.flatMap((attempt) => attempt.binaryId ? [attempt.binaryId] : []),
  );
  const results: BinarySweepResult[] = [];
  for (const attempt of openAttempts) {
    results.push(await inspectAttempt(
      attempt,
      attempt.binaryId ? referenceMap.get(attempt.binaryId) ?? [] : [],
      input,
    ));
  }
  return results;
}

async function inspectAttempt(
  attempt: BinaryAttempt,
  references: readonly BinaryDatabaseReference[],
  input: {
    readonly attempts: BinaryAttemptStore;
    readonly scanner: BinaryReferenceScanner;
    readonly auth: BinaryUploadAuth;
    readonly execute?: boolean;
  },
): Promise<BinarySweepResult> {
  if (!attempt.binaryId) {
    return {
      attemptId: attempt.attemptId,
      outcome: "unresolved-no-binary-id",
      references: [],
    };
  }
  const binaryMetadataExists = await input.scanner.binaryMetadataExists(attempt.binaryId);
  if (references.length > 0) {
    return {
      attemptId: attempt.attemptId,
      binaryId: attempt.binaryId,
      outcome: "reported-referenced",
      binaryMetadataExists,
      references,
    };
  }
  if (!input.execute) {
    return {
      attemptId: attempt.attemptId,
      binaryId: attempt.binaryId,
      outcome: "candidate",
      binaryMetadataExists,
      references: [],
    };
  }
  let finalReferences: readonly BinaryDatabaseReference[];
  try {
    finalReferences =
      (await input.scanner.findAttachmentReferences([attempt.binaryId])).get(attempt.binaryId)
      ?? [];
  } catch (error) {
    return {
      attemptId: attempt.attemptId,
      binaryId: attempt.binaryId,
      outcome: "reported-referenced",
      binaryMetadataExists,
      references: [],
      reverificationError: error instanceof Error ? error.message : String(error),
    };
  }
  if (finalReferences.length > 0) {
    return {
      attemptId: attempt.attemptId,
      binaryId: attempt.binaryId,
      outcome: "reported-referenced",
      binaryMetadataExists,
      references: finalReferences,
    };
  }
  if (binaryMetadataExists) {
    await deleteBinary(attempt.binaryId, input.auth);
  }
  await input.attempts.resolveDisposed(
    attempt.attemptId,
    binaryMetadataExists
      ? "Operator sweep deleted unreferenced Binary metadata and storage."
      : "Operator sweep confirmed Binary metadata was already absent.",
  );
  return {
    attemptId: attempt.attemptId,
    binaryId: attempt.binaryId,
    outcome: "disposed",
    binaryMetadataExists,
    references: [],
  };
}

async function deleteBinary(binaryId: string, auth: BinaryUploadAuth): Promise<void> {
  const response = await (auth.fetch ?? fetch)(
    `${auth.baseUrl.replace(/\/$/, "")}/fhir/R4/Binary/${binaryId}`,
    {
      method: "DELETE",
      headers: {
        Accept: "application/fhir+json",
        Authorization: `Bearer ${auth.accessToken}`,
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Binary/${binaryId} disposal failed: ${response.status} ${response.statusText}: `
      + `${(await response.text()).slice(0, 2_000)}`,
    );
  }
}

function findBinaryAttachmentUrls(
  value: unknown,
  targetIds: ReadonlySet<string>,
): Array<{ binaryId: string; url: string }> {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => findBinaryAttachmentUrls(entry, targetIds));
  }
  if (!value || typeof value !== "object") return [];
  const matches: Array<{ binaryId: string; url: string }> = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === "url" && typeof child === "string") {
      const parsedId = binaryIdFromReferenceUrl(child);
      if (parsedId && targetIds.has(parsedId)) {
        matches.push({ binaryId: parsedId, url: child });
      } else if (!parsedId) {
        for (const binaryId of targetIds) {
          if (child.includes(binaryId)) {
            matches.push({ binaryId, url: child });
          }
        }
      }
    }
    matches.push(...findBinaryAttachmentUrls(child, targetIds));
  }
  return matches;
}

export function binaryIdFromReferenceUrl(value: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(value, "https://odos.invalid").pathname;
  } catch {
    return undefined;
  }
  const parts = pathname.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const binaryIndex = parts.lastIndexOf("Binary");
  if (binaryIndex < 0 || !parts[binaryIndex + 1]) return undefined;
  const suffix = parts.slice(binaryIndex + 2);
  if (
    suffix.length !== 0
    && !(suffix.length === 2 && suffix[0] === "_history" && Boolean(suffix[1]))
  ) {
    return undefined;
  }
  return parts[binaryIndex + 1];
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Expected Binary UUID; received ${value}.`);
  }
}
