#!/usr/bin/env tsx
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Observation, Patient } from "@medplum/fhirtypes";
import { createLiveOsodAuditRuntime } from "../mcp/src/authz/liveAudit.js";
import { createMedplumClient } from "../mcp/src/fhir-client.js";

type EncounterBundleModule = {
  assertTransactionSuccess(bundle: unknown): void;
  buildEncounterStatusPatchBundle(input: {
    encounterId: string;
    recorded: string;
    operatorDisplay: string;
    ops: Array<{ op: "add" | "replace"; path: string; value: unknown }>;
  }): unknown;
  buildStartEncounterCreateBundle(input: {
    patientId: string;
    now: string;
  }): unknown;
  createdIdFromEntry(bundle: unknown, entryIndex: number, resourceType: string): string;
};

const EXPECTED_BASELINE = 8;
const encounterBundles = await import(
  new URL("../ui/src/lib/encounter-bundles.ts", import.meta.url).href
) as EncounterBundleModule;

loadRepoEnv();

const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
const postgresUrl =
  process.env.OSOD_POSTGRES_URL ?? "postgresql://medplum:medplum@127.0.0.1:5432/medplum";
const email = requireEnv("MEDPLUM_ADMIN_EMAIL", process.env.MEDPLUM_ADMIN_EMAIL ?? process.env.OSOD_ADMIN_EMAIL);
const password = requireEnv(
  "MEDPLUM_ADMIN_PASSWORD",
  process.env.MEDPLUM_ADMIN_PASSWORD ?? process.env.OSOD_ADMIN_PASSWORD,
);
const sessionId = `tier1-visit-${Date.now()}`;
const startedAt = new Date().toISOString();
const accessToken = await loginForAccessToken({ baseUrl, email, password });
const audit = createLiveOsodAuditRuntime({
  postgresUrl,
  medplumBaseUrl: baseUrl,
  medplumEmail: email,
  medplumPassword: password,
});
const fhir = createMedplumClient({
  baseUrl,
  accessToken,
  audit,
  auditContext: {
    actorId: "tier1-audit-verify",
    actorRole: "clinician",
    sessionId,
  },
});

try {
  const patient = await fhir.create<Patient>({
    resourceType: "Patient",
    active: true,
    gender: "unknown",
    name: [{ use: "official", family: `Tier1Audit${Date.now()}`, given: ["Synthetic"] }],
  });
  if (!patient.id) {
    throw new Error("Tier-1 audit verification Patient create returned no id.");
  }

  const startBundle = await fhir.executeTransaction(
    encounterBundles.buildStartEncounterCreateBundle({
      patientId: patient.id,
      now: startedAt,
    }) as never,
    { "X-OSOD-Source": "tier1-audit-verify/start_encounter" },
  );
  encounterBundles.assertTransactionSuccess(startBundle);
  const encounterId = encounterBundles.createdIdFromEntry(startBundle, 0, "Encounter");

  for (const observation of tier1VisitObservations(patient.id, encounterId)) {
    await fhir.create<Observation>(observation, { "X-OSOD-Source": "tier1-audit-verify/observation" });
  }

  const finishBundle = await fhir.executeTransaction(
    encounterBundles.buildEncounterStatusPatchBundle({
      encounterId,
      recorded: new Date().toISOString(),
      operatorDisplay: "OSOD Tier-1 audit verification",
      ops: [
        { op: "replace", path: "/status", value: "finished" },
        { op: "add", path: "/period/end", value: new Date().toISOString() },
      ],
    }) as never,
    { "X-OSOD-Source": "tier1-audit-verify/finish_encounter" },
  );
  encounterBundles.assertTransactionSuccess(finishBundle);
  await audit.drainProjectionQueue();

  const counts = readAuditCounts(sessionId);
  console.log(JSON.stringify({
    baseline: EXPECTED_BASELINE,
    sessionId,
    patient: `Patient/${patient.id}`,
    encounter: `Encounter/${encounterId}`,
    osodAuditRows: counts.osodAuditRows,
    fhirAuditEvents: counts.fhirAuditEvents,
    eventTypes: counts.eventTypes,
  }, null, 2));

  if (counts.osodAuditRows !== EXPECTED_BASELINE || counts.fhirAuditEvents !== EXPECTED_BASELINE) {
    throw new Error(
      `Tier-1 visit audit baseline mismatch: expected ${EXPECTED_BASELINE}/${EXPECTED_BASELINE}, got ${counts.osodAuditRows}/${counts.fhirAuditEvents}.`,
    );
  }
} finally {
  await audit.close();
}

function tier1VisitObservations(patientId: string, encounterId: string): Observation[] {
  const now = new Date().toISOString();
  const subject = { reference: `Patient/${patientId}` };
  const encounter = { reference: `Encounter/${encounterId}` };
  return [
    observation("Tier-1 visual acuity sample", "Distance acuity recorded for OD and OS.", subject, encounter, now),
    observation("Tier-1 refraction sample", "Refraction finding recorded for OD and OS.", subject, encounter, now),
    observation("Tier-1 intraocular pressure sample", "Pressure finding recorded for OD and OS.", subject, encounter, now),
    observation("Tier-1 anterior segment sample", "Anterior segment finding recorded.", subject, encounter, now),
    observation("Tier-1 posterior segment sample", "Posterior segment finding recorded.", subject, encounter, now),
  ];
}

function observation(
  text: string,
  valueString: string,
  subject: { reference: string },
  encounter: { reference: string },
  effectiveDateTime: string,
): Observation {
  return {
    resourceType: "Observation",
    status: "final",
    code: { text },
    subject,
    encounter,
    effectiveDateTime,
    valueString,
  };
}

function readAuditCounts(sessionId: string): {
  osodAuditRows: number;
  fhirAuditEvents: number;
  eventTypes: Record<string, number>;
} {
  const sql = `
    WITH visit_rows AS (
      SELECT id::text, event_type
      FROM osod_audit_events
      WHERE session_id = '${sessionId}'
    ),
    projected AS (
      SELECT DISTINCT ae.id
      FROM "AuditEvent" ae
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ae.content::jsonb->'entity', '[]'::jsonb)) AS entity_item(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(entity_item.value->'detail', '[]'::jsonb)) AS detail_item(value)
      JOIN visit_rows vr ON detail_item.value->>'type' = 'osod_audit_event_id'
        AND detail_item.value->>'valueString' = vr.id
      WHERE ae.deleted = false
    ),
    event_counts AS (
      SELECT COALESCE(jsonb_object_agg(event_type, count ORDER BY event_type), '{}'::jsonb) value
      FROM (
        SELECT event_type, count(*)::int
        FROM visit_rows
        GROUP BY event_type
      ) counts
    )
    SELECT jsonb_build_object(
      'osodAuditRows', (SELECT count(*) FROM visit_rows),
      'fhirAuditEvents', (SELECT count(*) FROM projected),
      'eventTypes', (SELECT value FROM event_counts)
    )::text;
  `;
  const output = execFileSync("psql", [postgresUrl, "-Atc", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const parsed = JSON.parse(output) as {
    osodAuditRows: number;
    fhirAuditEvents: number;
    eventTypes: Record<string, number>;
  };
  return parsed;
}

async function loginForAccessToken(input: {
  baseUrl: string;
  email: string;
  password: string;
}): Promise<string> {
  const base = input.baseUrl.replace(/\/$/, "");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const loginResponse = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    }),
  });
  if (!loginResponse.ok) {
    throw new Error(`Medplum login failed: ${loginResponse.status} ${await loginResponse.text()}`);
  }
  const { code } = (await loginResponse.json()) as { code: string };
  const tokenResponse = await fetch(`${base}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Medplum token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  }
  const { access_token: accessToken } = (await tokenResponse.json()) as { access_token: string };
  return accessToken;
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error(`${name} is required for Tier-1 audit verification.`);
  }
  return value.trim();
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
    if (!match || process.env[match[1]] !== undefined) {
      continue;
    }
    process.env[match[1]] = stripEnvQuotes(match[2].trim());
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
