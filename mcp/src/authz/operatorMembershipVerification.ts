import { Pool } from "pg";

const CLIENT_APPLICATION_RESOURCE_TYPE = ["Client", "Application"].join("");

export interface OperatorMembershipDatabase {
  query(sql: string, values: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

interface OperatorMembershipRow {
  readonly id?: string;
  readonly project?: string;
  readonly user?: string;
  readonly profile?: string;
  readonly admin?: boolean | null;
  readonly accessPolicy?: string[] | null;
  readonly content?: string;
}

export async function verifyOperatorMembershipFromPostgres(input: {
  readonly postgresUrl: string;
  readonly projectId: string;
  readonly clientId: string;
  readonly membershipId: string;
}): Promise<void> {
  assertLocalPostgresUrl(input.postgresUrl);
  const pool = new Pool({ connectionString: input.postgresUrl, max: 1 });
  try {
    await verifyOperatorMembershipRecord({ ...input, database: pool });
  } finally {
    await pool.end();
  }
}

export async function findOperatorMembershipFromPostgres(input: {
  readonly postgresUrl: string;
  readonly projectId: string;
  readonly clientId: string;
}): Promise<string> {
  assertLocalPostgresUrl(input.postgresUrl);
  const pool = new Pool({ connectionString: input.postgresUrl, max: 1 });
  try {
    return await findOperatorMembershipRecord({ ...input, database: pool });
  } finally {
    await pool.end();
  }
}

export async function findOperatorMembershipRecord(input: {
  readonly database: OperatorMembershipDatabase;
  readonly projectId: string;
  readonly clientId: string;
}): Promise<string> {
  const projectId = required(input.projectId, "operator project id");
  const expectedProfile = `${CLIENT_APPLICATION_RESOURCE_TYPE}/${required(input.clientId, "operator client id")}`;
  const result = await input.database.query(
    `SELECT id::text
       FROM "ProjectMembership"
      WHERE "projectId" = $1::uuid AND profile = $2 AND deleted = false`,
    [projectId, expectedProfile],
  );
  if (result.rows.length !== 1) {
    throw new Error("Operator ProjectMembership resolution did not find exactly one active row.");
  }
  return required((result.rows[0] as OperatorMembershipRow).id, "resolved operator membership id");
}

export async function verifyOperatorMembershipRecord(input: {
  readonly database: OperatorMembershipDatabase;
  readonly projectId: string;
  readonly clientId: string;
  readonly membershipId: string;
}): Promise<void> {
  const expectedProfile = `${CLIENT_APPLICATION_RESOURCE_TYPE}/${required(input.clientId, "operator client id")}`;
  const projectId = required(input.projectId, "operator project id");
  const membershipId = required(input.membershipId, "operator membership id");
  const result = await input.database.query(
    `SELECT id::text, project, "user", profile, admin, "accessPolicy", content
       FROM "ProjectMembership"
      WHERE id = $1::uuid AND "projectId" = $2::uuid AND deleted = false`,
    [membershipId, projectId],
  );
  if (result.rows.length !== 1) {
    throw new Error("Operator ProjectMembership database verification did not resolve exactly one active row.");
  }
  const row = result.rows[0] as OperatorMembershipRow;
  if (
    row.id !== membershipId ||
    row.project !== `Project/${projectId}` ||
    row.user !== expectedProfile ||
    row.profile !== expectedProfile ||
    row.admin === true
  ) {
    throw new Error("Operator ProjectMembership does not match the exact non-admin client and project.");
  }
  const content = parseMembershipContent(row.content);
  if (
    (row.accessPolicy?.length ?? 0) !== 0 ||
    (Array.isArray(content.access) && content.access.length > 0) ||
    hasReference(content.accessPolicy)
  ) {
    throw new Error("Operator ProjectMembership must have no access entries and no attached access policy.");
  }
}

function parseMembershipContent(value: string | undefined): Record<string, unknown> {
  if (!value) throw new Error("Operator ProjectMembership database row has no FHIR content.");
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Operator ProjectMembership database content is malformed.");
  }
  return parsed as Record<string, unknown>;
}

function hasReference(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { reference?: unknown }).reference === "string",
  );
}

function assertLocalPostgresUrl(value: string): void {
  const url = new URL(required(value, "ODOS_POSTGRES_URL"));
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]", "postgres"].includes(url.hostname)
  ) {
    throw new Error("Operator membership verification requires the local Medplum Postgres database.");
  }
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}
