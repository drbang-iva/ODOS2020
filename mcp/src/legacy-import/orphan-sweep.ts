import { Pool } from "pg";
import type { AccessPolicy, Media } from "@medplum/fhirtypes";
import type { BinaryUploadAuth } from "../fhir/binary-upload.js";
import type {
  BinaryAttempt,
  BinaryAttemptStore,
} from "./binary-attempt-store.js";
import { binaryIdFromReferenceUrl } from "./binary-reference.js";

const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5433/medplum";

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

export interface StoredPracticeClinicianPolicy {
  readonly projectId: string;
  readonly projectName: string;
  readonly policyId: string;
  readonly policy: AccessPolicy;
}

export interface StoredClinicianPolicyCandidate {
  readonly policyId: string;
  readonly policy: string;
  readonly membershipReferenceCount: number;
}

export async function findPracticeClinicianPolicy(
  postgresUrl: string,
): Promise<StoredPracticeClinicianPolicy> {
  return withLegacyImportPool(postgresUrl, async (pool) => {
    const result = await pool.query<{
      project_id: string;
      project_name: string | null;
      policy_id: string;
      policy: string;
    }>(`
      SELECT
        policy."projectId"::text AS project_id,
        project.content::jsonb->>'name' AS project_name,
        policy.id::text AS policy_id,
        policy.content AS policy
      FROM "AccessPolicy" AS policy
      INNER JOIN "Project" AS project
        ON project.id = policy."projectId"
        AND project.deleted = false
      WHERE policy.deleted = false
        AND policy.content::jsonb->>'name' = 'ODOS Clinician'
      ORDER BY policy."projectId", policy.id
    `);
    if (result.rows.length !== 1) {
      const candidates = result.rows.length
        ? result.rows.map((row) =>
            `${row.project_id} (${row.project_name?.trim() || "unnamed project"})`
          ).join(", ")
        : "none";
      throw new Error(
        "Legacy importer discovery assumes one ODOS practice project per database; "
        + `found ${result.rows.length} ODOS Clinician policy candidates: ${candidates}. `
        + "Pass an explicit practiceProjectId when the database hosts multiple practices.",
      );
    }
    return {
      projectId: result.rows[0]!.project_id,
      projectName: result.rows[0]!.project_name?.trim() || "unnamed project",
      policyId: result.rows[0]!.policy_id,
      policy: JSON.parse(result.rows[0]!.policy) as AccessPolicy,
    };
  });
}

export async function verifyPracticeProjectClinicianPolicy(
  postgresUrl: string,
  projectId: string,
): Promise<StoredPracticeClinicianPolicy> {
  return withLegacyImportPool(postgresUrl, async (pool) => {
    const projects = await pool.query<{
      project_id: string;
      project_name: string | null;
    }>(`
      SELECT id::text AS project_id, content::jsonb->>'name' AS project_name
      FROM "Project"
      WHERE deleted = false
        AND id::text = $1
    `, [projectId]);
    if (projects.rows.length !== 1) {
      throw new Error(`Explicit practice project ${projectId} does not exist.`);
    }
    const project = projects.rows[0]!;
    const policies = await pool.query<{
      policy_id: string;
      policy: string;
      membership_reference_count: string;
    }>(`
      SELECT
        policy.id::text AS policy_id,
        policy.content AS policy,
        count(membership.id)::text AS membership_reference_count
      FROM "AccessPolicy" AS policy
      LEFT JOIN "ProjectMembership" AS membership
        ON membership.deleted = false
        AND (
          membership.content::jsonb #>> '{accessPolicy,reference}'
            = 'AccessPolicy/' || policy.id::text
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              COALESCE(membership.content::jsonb->'access', '[]'::jsonb)
            ) AS access
            WHERE access #>> '{policy,reference}'
              = 'AccessPolicy/' || policy.id::text
          )
        )
      WHERE policy.deleted = false
        AND policy."projectId"::text = $1
        AND policy.content::jsonb->>'name' = 'ODOS Clinician'
      GROUP BY policy.id, policy.content
      ORDER BY policy.id
    `, [projectId]);
    if (policies.rows.length !== 1) {
      const candidates = policies.rows.map((policy) => ({
        policyId: policy.policy_id,
        policy: policy.policy,
        membershipReferenceCount: Number(policy.membership_reference_count),
      }));
      throw new Error(
        `Explicit practice project ${projectId} `
        + `(${project.project_name?.trim() || "unnamed project"}) must carry exactly one `
        + `ODOS Clinician policy; found ${policies.rows.length}. `
        + describeStoredClinicianPolicyConflict(candidates),
      );
    }
    return {
      projectId: project.project_id,
      projectName: project.project_name?.trim() || "unnamed project",
      policyId: policies.rows[0]!.policy_id,
      policy: JSON.parse(policies.rows[0]!.policy) as AccessPolicy,
    };
  });
}

export function describeStoredClinicianPolicyConflict(
  candidates: readonly StoredClinicianPolicyCandidate[],
): string {
  const definitionsIdentical = candidates.length < 2
    ? "not applicable"
    : candidates.every(
      (candidate) =>
        comparablePolicyDefinition(candidate.policy)
        === comparablePolicyDefinition(candidates[0]!.policy),
    )
      ? "yes"
      : "no";
  const references = candidates.length
    ? candidates
      .map((candidate) => `${candidate.policyId}=${candidate.membershipReferenceCount}`)
      .join(", ")
    : "none";
  const unreferenced = candidates
    .filter((candidate) => candidate.membershipReferenceCount === 0)
    .map((candidate) => candidate.policyId);
  return `Policy definitions identical: ${definitionsIdentical}. `
    + `ProjectMembership references by policy: ${references}. `
    + `Policies with zero ProjectMembership references: ${unreferenced.join(", ") || "none"}.`;
}

function comparablePolicyDefinition(source: string): string {
  const policy = JSON.parse(source) as Record<string, unknown>;
  delete policy.id;
  if (policy.meta && typeof policy.meta === "object" && !Array.isArray(policy.meta)) {
    const meta = { ...(policy.meta as Record<string, unknown>) };
    delete meta.versionId;
    delete meta.lastUpdated;
    policy.meta = meta;
  }
  return stableJson(policy);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function withLegacyImportPool<T>(
  postgresUrl: string,
  callback: (pool: Pool) => Promise<T>,
): Promise<T> {
  const pool = new Pool({
    connectionString: postgresUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  });
  try {
    return await callback(pool);
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

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Expected Binary UUID; received ${value}.`);
  }
}
