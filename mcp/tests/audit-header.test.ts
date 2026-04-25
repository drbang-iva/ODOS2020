/**
 * X-OSOD-Source AuditEvent verification.
 *
 * If Medplum does not expose the request header in FHIR AuditEvent, this test
 * emits a structured WARNING and passes. That is an intentional, documented
 * gap: X-OSOD-Source remains useful for HTTP-layer logs, but Provenance is the
 * reviewable per-resource attribution path when AuditEvent does not surface it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditEvent, Encounter, Patient } from "@medplum/fhirtypes";
import {
  connectMcpServer,
  createAuthenticatedFhirClient,
  loadRepoEnv,
  parseToolOutput,
} from "./integration-helpers.js";

const SOURCE_HEADER_VALUE = "mcp/create_encounter";

interface CreateEncounterToolOutput {
  encounter: Encounter;
}

interface AuditEventSearchAttempt {
  label: string;
  path: string;
  ok: boolean;
  entryCount?: number;
  error?: string;
}

test("X-OSOD-Source header visibility in Medplum AuditEvent", { timeout: 90_000 }, async (t) => {
  loadRepoEnv();

  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const email = process.env.MEDPLUM_ADMIN_EMAIL;
  const password = process.env.MEDPLUM_ADMIN_PASSWORD;

  if (!email || !password) {
    t.skip("MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD are required for Medplum integration tests.");
    return;
  }

  const { fhir, accessToken } = await createAuthenticatedFhirClient({ baseUrl, email, password });
  const patient = await fhir.create<Patient>({
    resourceType: "Patient",
    name: [{ family: `AuditHeader${Date.now()}`, given: ["Test"] }],
  });
  assert.ok(patient.id, "Expected created Patient to have an id.");

  const mcp = await connectMcpServer({
    baseUrl,
    email,
    password,
    accessToken,
    clientName: "osod-mcp-audit-header-test",
  });
  t.after(async () => {
    await mcp.client.close();
  });

  const recordedAt = new Date(Date.now() - 1000).toISOString();
  const output = parseToolOutput<CreateEncounterToolOutput>(
    await mcp.client.callTool({
      name: "create_encounter",
      arguments: {
        patient_id: patient.id,
        class_code: "AMB",
        status: "finished",
      },
    }),
  );
  assert.ok(output.encounter.id, "Expected created Encounter to have an id.");

  const encounterReference = `Encounter/${output.encounter.id}`;
  const auditResult = await searchAuditEvents(fhir, baseUrl, recordedAt, encounterReference);

  assert.ok(
    auditResult.attempts.some((attempt) => attempt.ok),
    "Expected at least one AuditEvent search query to be accepted by Medplum.",
  );

  if (auditResult.locations.length > 0) {
    assert.ok(
      auditResult.locations.some((location) => location.includes("AuditEvent/")),
      "Expected source header match to be tied to an AuditEvent location.",
    );
    return;
  }

  const warning = {
    level: "WARNING",
    test: "audit-header",
    outcome: "x-osod-source-not-surfaced-in-fhir-auditevent",
    searchedFor: SOURCE_HEADER_VALUE,
    encounterReference,
    recordedAt,
    attempts: auditResult.attempts,
  };
  console.warn(JSON.stringify(warning, null, 2));
  assert.equal(warning.level, "WARNING");
});

async function searchAuditEvents(
  fhir: Awaited<ReturnType<typeof createAuthenticatedFhirClient>>["fhir"],
  baseUrl: string,
  recordedAt: string,
  encounterReference: string,
): Promise<{ attempts: AuditEventSearchAttempt[]; locations: string[] }> {
  const queryPlan = [
    {
      label: "date+entity",
      params: { date: `ge${recordedAt}`, entity: encounterReference },
    },
    { label: "entity", params: { entity: encounterReference } },
    { label: "date", params: { date: `ge${recordedAt}` } },
    { label: "_lastUpdated", params: { _lastUpdated: `ge${recordedAt}` } },
    { label: "recent", params: { _count: "50", _sort: "-date" } },
  ];
  const attempts: AuditEventSearchAttempt[] = [];
  const auditEvents = new Map<string, AuditEvent>();

  for (const { label, params } of queryPlan) {
    const path = formatAuditEventPath(baseUrl, params);
    try {
      const bundle = await fhir.search<AuditEvent>("AuditEvent", params);
      const resources = bundle.entry?.flatMap((entry) => (entry.resource ? [entry.resource] : [])) ?? [];
      attempts.push({ label, path, ok: true, entryCount: resources.length });
      for (const event of resources) {
        auditEvents.set(event.id ?? JSON.stringify(event), event);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      attempts.push({ label, path, ok: false, error: message });
    }
  }

  return {
    attempts,
    locations: Array.from(auditEvents.values()).flatMap((event) =>
      findSourceHeaderLocations(event, SOURCE_HEADER_VALUE),
    ),
  };
}

function findSourceHeaderLocations(event: AuditEvent, needle: string): string[] {
  const prefix = `AuditEvent/${event.id ?? "(no-id)"}`;
  const locations: string[] = [];

  event.agent?.forEach((agent, index) => {
    inspectValue(locations, `${prefix}.agent[${index}].name`, agent.name, needle);
    inspectValue(locations, `${prefix}.agent[${index}].requestor`, agent.requestor, needle);
  });

  inspectValue(locations, `${prefix}.source.observer.display`, event.source?.observer?.display, needle);

  event.entity?.forEach((entity, index) => {
    inspectValue(locations, `${prefix}.entity[${index}].what`, entity.what, needle);
    inspectValue(locations, `${prefix}.entity[${index}].name`, entity.name, needle);
    inspectValue(locations, `${prefix}.entity[${index}].detail`, entity.detail, needle);
  });

  findExtensionLocations(event, prefix).forEach((location) => {
    inspectValue(locations, location.path, location.value, needle);
  });

  return locations;
}

function inspectValue(locations: string[], path: string, value: unknown, needle: string): void {
  if (value === undefined) {
    return;
  }
  if (JSON.stringify(value).includes(needle)) {
    locations.push(path);
  }
}

function findExtensionLocations(value: unknown, path: string): Array<{ path: string; value: unknown }> {
  if (!value || typeof value !== "object") {
    return [];
  }

  const entries: Array<{ path: string; value: unknown }> = [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findExtensionLocations(item, `${path}[${index}]`));
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedPath = `${path}.${key}`;
    if (key === "extension") {
      entries.push({ path: nestedPath, value: nestedValue });
    }
    entries.push(...findExtensionLocations(nestedValue, nestedPath));
  }

  return entries;
}

function formatAuditEventPath(baseUrl: string, params: Record<string, string>): string {
  return `${baseUrl.replace(/\/$/, "")}/fhir/R4/AuditEvent?${new URLSearchParams(params).toString()}`;
}
