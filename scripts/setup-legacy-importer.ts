#!/usr/bin/env tsx
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AccessPolicy } from "@medplum/fhirtypes";
import {
  createMigrationImporterClient,
  exchangeClientCredentials,
  type MigrationImporterClientResult,
} from "../data/medplum-adapters/migration-importer-adapter.js";
import { createOperatorScriptFhirClient } from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";
import {
  buildMigrationImporterAccessPolicy,
  MIGRATION_IMPORTER_NAME,
  MIGRATION_IMPORTER_POLICY_NAME,
  MIGRATION_IMPORTER_POLICY_TAG_SYSTEM,
} from "../mcp/src/legacy-import/access-policy.js";
import {
  findPracticeProjectId,
  readMigrationImporterPolicies,
  verifyPracticeProjectClinicianPolicy,
  type StoredPracticeClinicianPolicy,
} from "../mcp/src/legacy-import/orphan-sweep.js";
import {
  ODOS_PRACTICE_ROLE_SYSTEM,
} from "../mcp/src/authz/roles.js";
import { assertCanonicalPolicyRules } from "./grant-migrated-patient-access.js";

const DEFAULT_BASE_URL = "http://localhost:8103";
const DEFAULT_STATE_PATH = resolve(".odos/migration-importer-state.json");
const DEFAULT_CREDENTIALS_PATH = resolve(".odos/migration-importer.env");

export interface PracticeProjectResolutionDatabase {
  findPracticeProjectId(postgresUrl: string): Promise<string>;
  verifyPracticeProjectClinicianPolicy(
    postgresUrl: string,
    projectId: string,
  ): Promise<StoredPracticeClinicianPolicy>;
}

const LIVE_PRACTICE_PROJECT_DATABASE: PracticeProjectResolutionDatabase = {
  findPracticeProjectId,
  verifyPracticeProjectClinicianPolicy,
};

export async function setupLegacyImporter(input: {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly statePath?: string;
  readonly credentialsPath?: string;
  readonly postgresUrl?: string;
  readonly practiceProjectId?: string;
}): Promise<{
  readonly projectId: string;
  readonly accessPolicyId: string;
  readonly clientId: string;
  readonly createdClient: boolean;
}> {
  assertLocalBaseUrl(input.baseUrl);
  const accessToken = input.accessToken;
  const fhir = createOperatorScriptFhirClient({
    baseUrl: input.baseUrl,
    accessToken,
    reason: "Operator legacy importer setup runs outside request handling.",
  });
  const postgresUrl = input.postgresUrl
    ?? "postgresql://medplum:medplum@127.0.0.1:5433/medplum";
  const projectId = await resolvePracticeProjectId(
    input.baseUrl,
    accessToken,
    fhir,
    postgresUrl,
    input.practiceProjectId,
  );
  const desired = buildMigrationImporterAccessPolicy(projectId);
  const storedPolicies = await readMigrationImporterPolicies(
    postgresUrl,
    projectId,
    MIGRATION_IMPORTER_POLICY_NAME,
  );
  if (storedPolicies.length > 1) {
    throw new Error(
      `Expected one practice ${MIGRATION_IMPORTER_POLICY_NAME} AccessPolicy; found ${storedPolicies.length}.`,
    );
  }
  const statePath = input.statePath ?? DEFAULT_STATE_PATH;
  const credentialsPath = input.credentialsPath ?? DEFAULT_CREDENTIALS_PATH;
  const existing = readExistingCredentials(statePath, credentialsPath);
  let policy = storedPolicies[0]?.policy;
  if (!policy) {
    policy = await fhir.create<AccessPolicy>(desired);
  } else if (!samePolicyDefinition(policy, desired)) {
    const current = await fhir.read<AccessPolicy>("AccessPolicy", storedPolicies[0]!.policyId);
    if (!current.id || !current.meta?.versionId) {
      throw new Error("Migration importer AccessPolicy lacks id/meta.versionId for a safe update.");
    }
    const reconciled = reconciledAccessPolicy(current, desired);
    policy = await fhir.update<AccessPolicy>(
      "AccessPolicy",
      current.id,
      {
        ...reconciled,
        meta: {
          ...reconciled.meta,
          project: projectId,
        },
      },
      { "If-Match": `W/"${current.meta.versionId}"` },
    );
  }
  const policyId = policy.id ?? storedPolicies[0]?.policyId;
  if (!policyId) throw new Error("Migration importer AccessPolicy has no id.");
  if (
    existing
    && existing.projectId === projectId
    && existing.policyId === policyId
  ) {
    await exchangeClientCredentials({
      baseUrl: input.baseUrl,
      clientId: existing.clientId,
      clientSecret: existing.clientSecret,
    });
    return {
      projectId,
      accessPolicyId: policyId,
      clientId: existing.clientId,
      createdClient: false,
    };
  }

  const created = await createMigrationImporterClient({
    baseUrl: input.baseUrl,
    projectId,
    accessToken,
    accessPolicyReference: `AccessPolicy/${policyId}`,
    name: MIGRATION_IMPORTER_NAME,
  });
  persistCredentials(created, statePath, credentialsPath, policyId, projectId);
  return {
    projectId,
    accessPolicyId: policyId,
    clientId: created.clientId,
    createdClient: true,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await setupLegacyImporter({
    baseUrl: process.env.MEDPLUM_BASE_URL ?? DEFAULT_BASE_URL,
    accessToken: requireEnv("ODOS_OPERATOR_ACCESS_TOKEN"),
    postgresUrl:
      process.env.ODOS_POSTGRES_URL
      ?? process.env.OSOD_POSTGRES_URL
      ?? "postgresql://medplum:medplum@127.0.0.1:5433/medplum",
    practiceProjectId: process.env.ODOS_PRACTICE_PROJECT_ID?.trim() || undefined,
  });
  console.log(
    `Migration importer ready: policy=${result.accessPolicyId} client=${result.clientId} `
    + `credentials=.odos/migration-importer.env created=${result.createdClient}`,
  );
}

export async function resolvePracticeProjectId(
  baseUrl: string,
  accessToken: string,
  fhir: ReturnType<typeof createOperatorScriptFhirClient>,
  postgresUrl?: string,
  practiceProjectId?: string,
  database: PracticeProjectResolutionDatabase = LIVE_PRACTICE_PROJECT_DATABASE,
): Promise<string> {
  if (practiceProjectId) {
    if (!postgresUrl) {
      throw new Error("Explicit practiceProjectId verification requires ODOS_POSTGRES_URL.");
    }
    const stored = await database.verifyPracticeProjectClinicianPolicy(
      postgresUrl,
      practiceProjectId,
    );
    assertCanonicalClinicianPolicy(stored);
    return stored.projectId;
  }
  const clinicianPolicies = (await searchAll<AccessPolicy>(fhir, "AccessPolicy", {
    "name:exact": "ODOS Clinician",
  })).filter((policy) => policy.name === "ODOS Clinician" && policy.meta?.project);
  const practiceProjects = [
    ...new Set(clinicianPolicies.map((policy) => policy.meta!.project!)),
  ];
  if (practiceProjects.length === 1) return practiceProjects[0]!;
  if (practiceProjects.length > 1) {
    throw new Error(`Expected one practice project from ODOS Clinician policy; found ${practiceProjects.length}.`);
  }
  if (postgresUrl) return database.findPracticeProjectId(postgresUrl);
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Migration importer /auth/me failed: ${response.status}.`);
  const body = (await response.json()) as { project?: { id?: string; superAdmin?: boolean } };
  if (!body.project?.id) throw new Error("Migration importer setup could not resolve the practice project.");
  if (body.project.superAdmin) {
    throw new Error("Migration importer setup found only the Super Admin project and no shipped clinician policy.");
  }
  return body.project.id;
}

export function assertCanonicalClinicianPolicy(stored: StoredPracticeClinicianPolicy): void {
  const roleTags = stored.policy.meta?.tag?.filter(
    (tag) => tag.system === ODOS_PRACTICE_ROLE_SYSTEM,
  ) ?? [];
  let canonicalRules = true;
  try {
    assertCanonicalPolicyRules(stored.policy, "provider");
  } catch {
    canonicalRules = false;
  }
  if (
    stored.policy.name !== "ODOS Clinician"
    || roleTags.length !== 1
    || roleTags[0]?.code !== "provider"
    || !canonicalRules
  ) {
    throw new Error(
      `Explicit practice project ${stored.projectId} (${stored.projectName}) `
      + `does not carry a canonical ODOS Clinician policy.`,
    );
  }
}

export function samePolicyDefinition(left: AccessPolicy, right: AccessPolicy): boolean {
  const desiredTag = right.meta?.tag?.find(
    (tag) => tag.system === MIGRATION_IMPORTER_POLICY_TAG_SYSTEM,
  );
  const matchingTags = left.meta?.tag?.filter(
    (tag) => tag.system === MIGRATION_IMPORTER_POLICY_TAG_SYSTEM,
  ) ?? [];
  return matchingTags.length === 1
    && matchingTags[0]?.code === desiredTag?.code
    && JSON.stringify(left.resource ?? []) === JSON.stringify(right.resource ?? []);
}

export function reconciledAccessPolicy(existing: AccessPolicy, desired: AccessPolicy): AccessPolicy {
  const desiredTag = desired.meta?.tag?.find(
    (tag) => tag.system === MIGRATION_IMPORTER_POLICY_TAG_SYSTEM,
  );
  return {
    ...existing,
    name: desired.name,
    meta: {
      ...existing.meta,
      tag: [
        ...(existing.meta?.tag ?? []).filter(
          (tag) => tag.system !== MIGRATION_IMPORTER_POLICY_TAG_SYSTEM,
        ),
        ...(desiredTag ? [desiredTag] : []),
      ],
    },
    resource: desired.resource,
  };
}

function readExistingCredentials(
  statePath: string,
  credentialsPath: string,
): (MigrationImporterClientResult & { projectId: string; policyId: string }) | undefined {
  if (!existsSync(statePath) || !existsSync(credentialsPath)) return undefined;
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    clientId?: string;
    projectId?: string;
    policyId?: string;
  };
  const env = parseEnv(readFileSync(credentialsPath, "utf8"));
  const clientId = env.ODOS_MIGRATION_IMPORTER_CLIENT_ID;
  const clientSecret = env.ODOS_MIGRATION_IMPORTER_CLIENT_SECRET;
  return state.clientId
    && state.clientId === clientId
    && state.projectId
    && state.policyId
    && clientSecret
    ? {
        clientId,
        clientSecret,
        projectId: state.projectId,
        policyId: state.policyId,
      }
    : undefined;
}

export function persistCredentials(
  credentials: MigrationImporterClientResult,
  statePath: string,
  credentialsPath: string,
  policyId: string,
  projectId: string,
): void {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(credentialsPath), { recursive: true, mode: 0o700 });
  const existingLines = existsSync(credentialsPath)
    ? readFileSync(credentialsPath, "utf8").split(/\r?\n/)
    : [];
  const managedKeys = new Set([
    "ODOS_MIGRATION_IMPORTER_CLIENT_ID",
    "ODOS_MIGRATION_IMPORTER_CLIENT_SECRET",
  ]);
  const preservedLines = existingLines.filter((line) => {
    const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    return !key || !managedKeys.has(key);
  });
  while (preservedLines.at(-1) === "") preservedLines.pop();
  writeFileSync(
    credentialsPath,
    [
      ...preservedLines,
      ...(preservedLines.length ? [""] : []),
      `ODOS_MIGRATION_IMPORTER_CLIENT_ID=${credentials.clientId}`,
      `ODOS_MIGRATION_IMPORTER_CLIENT_SECRET=${credentials.clientSecret}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  chmodSync(credentialsPath, 0o600);
  writeFileSync(
    statePath,
    JSON.stringify({ version: 1, projectId, policyId, clientId: credentials.clientId }, null, 2) + "\n",
    { mode: 0o600 },
  );
  chmodSync(statePath, 0o600);
}

function parseEnv(source: string): Record<string, string> {
  return Object.fromEntries(
    source
      .split(/\r?\n/)
      .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function assertLocalBaseUrl(value: string): void {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!["localhost", "127.0.0.1", "::1", "medplum-server"].includes(hostname)) {
    throw new Error("Migration importer setup is restricted to a local self-hosted Medplum.");
  }
}
