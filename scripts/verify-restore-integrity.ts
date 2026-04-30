#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AccessPolicy,
  AuditEvent,
  Binary,
  Bundle,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import { verifyRestoreIntegrity } from "../mcp/src/authz/restoreIntegrity.js";
import { buildMedplumAccessPolicy, getRoleDeclaration } from "../mcp/src/authz/roles.js";
import { createMedplumClient } from "../mcp/src/fhir-client.js";
import type { OsodAuditEventRecord } from "../mcp/src/authz/osodAudit.js";

const manifestPath = process.argv[2];
if (!manifestPath) {
  throw new Error("Usage: tsx scripts/verify-restore-integrity.ts /backup/manifest-{timestamp}.json");
}

loadRepoEnv();

const postgresUrl = process.env.OSOD_POSTGRES_URL ?? "postgresql://medplum:medplum@127.0.0.1:5432/medplum";
const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
const email = process.env.MEDPLUM_ADMIN_EMAIL;
const password = process.env.MEDPLUM_ADMIN_PASSWORD;
const accessToken = process.env.MEDPLUM_ACCESS_TOKEN;

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  auditSnapshot?: { count: number; latestEventTime?: string; projectionQueueDrained?: boolean };
};

const medplum = await readMedplumRestoreState();
const result = verifyRestoreIntegrity({
  manifestAuditSnapshot: manifest.auditSnapshot ?? { count: 0 },
  restoredAuditRows: readRestoredAuditRows(manifest.auditSnapshot?.count ?? 0),
  provenanceSamples: medplum.provenanceSamples,
  restoredBinaries: medplum.restoredBinaries,
  auditEvents: medplum.auditEvents,
  accessPolicyRoundTripPassed: medplum.accessPolicyRoundTripPassed,
});

for (const check of result.checks) {
  console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
}

if (!result.passed) {
  process.exitCode = 1;
}

function readRestoredAuditRows(expectedCount: number): OsodAuditEventRecord[] {
  const sql = `
    SELECT COALESCE(json_agg(json_build_object(
      'id', id::text,
      'eventTime', event_time,
      'eventType', event_type,
      'actorId', actor_id,
      'actorRole', actor_role,
      'patientId', patient_id,
      'resourceType', resource_type,
      'resourceId', resource_id,
      'actionOutcome', action_outcome,
      'actionReason', action_reason,
      'policyUrl', policy_url,
      'sessionId', session_id,
      'ipAddress', ip_address::text,
      'userAgent', user_agent,
      'breakGlass', break_glass,
      'breakGlassReason', break_glass_reason,
      'ibActorClassification', ib_actor_classification,
      'ibException', ib_exception,
      'provenanceId', provenance_id,
      'auditEventId', audit_event_id,
      'createdAt', created_at
    ) ORDER BY event_time), '[]'::json)::text
    FROM osod_audit_events;
  `;
  try {
    const output = execFileSync("psql", [postgresUrl, "-Atc", sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return JSON.parse(output || "[]") as OsodAuditEventRecord[];
  } catch (error) {
    if (expectedCount === 0) {
      return [];
    }
    throw error;
  }
}

async function readMedplumRestoreState(): Promise<{
  provenanceSamples: Provenance[];
  restoredBinaries: Binary[];
  auditEvents: AuditEvent[];
  accessPolicyRoundTripPassed: boolean;
}> {
  if (!accessToken && (!email || !password)) {
    return {
      provenanceSamples: [],
      restoredBinaries: [],
      auditEvents: [],
      accessPolicyRoundTripPassed: false,
    };
  }

  const fhir = createMedplumClient({ baseUrl, accessToken });
  if (!accessToken && email && password) {
    await fhir.login(email, password);
  }

  return {
    provenanceSamples: await safeSearchResources<Provenance>(fhir, "Provenance", {
      _count: "10",
      _sort: "-_lastUpdated",
    }),
    restoredBinaries: await safeSearchResources<Binary>(fhir, "Binary", { _count: "200" }),
    auditEvents: await safeSearchResources<AuditEvent>(fhir, "AuditEvent", { _count: "1000" }),
    accessPolicyRoundTripPassed: await runAccessPolicyRoundTrip(fhir),
  };
}

async function safeSearchResources<T extends Resource>(
  fhir: ReturnType<typeof createMedplumClient>,
  resourceType: T["resourceType"],
  params: Record<string, string>,
): Promise<T[]> {
  try {
    return bundleResources(await fhir.search<T>(resourceType, params));
  } catch {
    return [];
  }
}

async function runAccessPolicyRoundTrip(fhir: ReturnType<typeof createMedplumClient>): Promise<boolean> {
  try {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration("auditor"));
    const created = await fhir.create<AccessPolicy>({
      ...policy,
      name: `osod-restore-roundtrip-${Date.now()}`,
    });
    return created.resourceType === "AccessPolicy" && Boolean(created.id);
  } catch {
    return false;
  }
}

function bundleResources<T extends Resource>(bundle: Bundle<T>): T[] {
  return bundle.entry?.map((entry) => entry.resource).filter((resource): resource is T => Boolean(resource)) ?? [];
}

function loadRepoEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = stripEnvQuotes(rawValue.trim());
  }
}

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
