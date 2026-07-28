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
  findAttachmentReferences(binaryId: string): Promise<BinaryDatabaseReference[]>;
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
}

export class PgBinaryReferenceScanner implements BinaryReferenceScanner {
  private readonly pool: Pool;

  constructor(options: { postgresUrl?: string; pool?: Pool } = {}) {
    this.pool = options.pool ?? new Pool({
      connectionString: options.postgresUrl ?? DEFAULT_POSTGRES_URL,
      max: 2,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
    });
  }

  async findAttachmentReferences(binaryId: string): Promise<BinaryDatabaseReference[]> {
    assertUuid(binaryId);
    const tables = await this.pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'content'
        AND table_name ~ '^[A-Z]'
      ORDER BY table_name
    `);
    const target = `Binary/${binaryId}`;
    const references: BinaryDatabaseReference[] = [];
    for (const { table_name: table } of tables.rows) {
      const rows = await this.pool.query<{ id: string; content: string }>(`
        SELECT id::text, content
        FROM ${quoteIdentifier(table)}
        WHERE content LIKE $1
      `, [`%${target}%`]);
      for (const row of rows.rows) {
        const content = JSON.parse(row.content) as unknown;
        if (containsExactUrl(content, target)) {
          references.push({ table, resourceId: row.id, url: target });
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
}): Promise<BinarySweepResult[]> {
  const openAttempts = await input.attempts.listOpen();
  const results: BinarySweepResult[] = [];
  for (const attempt of openAttempts) {
    results.push(await inspectAttempt(attempt, input));
  }
  return results;
}

async function inspectAttempt(
  attempt: BinaryAttempt,
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
  const references = await input.scanner.findAttachmentReferences(attempt.binaryId);
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
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Binary/${binaryId} disposal failed: ${response.status} ${response.statusText}: `
      + `${(await response.text()).slice(0, 2_000)}`,
    );
  }
}

function containsExactUrl(value: unknown, target: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsExactUrl(entry, target));
  }
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "url" && child === target) return true;
    if (containsExactUrl(child, target)) return true;
  }
  return false;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Expected Binary UUID; received ${value}.`);
  }
}
