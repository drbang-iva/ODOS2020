import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { AccessPolicy, AuditEvent, Bundle, Patient, Resource } from "@medplum/fhirtypes";
import {
  AuditEventProjectionQueue,
  InMemoryOdosAuditRepository,
  ODOS_AUDIT_EVENT_TYPES,
  assertAuditMutationAllowed,
  buildAuditEventProjection,
  buildOdosAuditEventRow,
  executePhiOperationWithAudit,
  ocrStyleAuditQuery,
} from "../src/authz/odosAudit.js";
import { createLiveOdosAuditRuntime } from "../src/authz/liveAudit.js";
import { verifyRestoreIntegrity } from "../src/authz/restoreIntegrity.js";
import { informationBlockingExceptionForDenial } from "../src/policy/ib-exception-map.js";
import { auditEventTypeForFhirWrite, type MedplumClient } from "../src/fhir-client.js";
import {
  connectMcpServer,
  createAuthenticatedFhirClient,
  loadRepoEnv,
  parseToolOutput,
} from "./integration-helpers.js";
import {
  canReviewAuditLog,
  exportAuditRowsAsCsv,
  exportAuditRowsAsJson,
  filterAuditLogRows,
  sampleAuditRows,
} from "../../ui/src/lib/audit-log.ts";

test("v0.5b audit event type ValueSet covers the required read, write, security, IB, and DR events", () => {
  const v05bRequiredEventTypes = [
    "read",
    "search",
    "history",
    "vread",
    "create",
    "update",
    "patch",
    "transaction",
    "nullify-attempt",
    "delete-attempt",
    "denied",
    "break-glass-invoked",
    "break-glass-expired",
    "login",
    "logout",
    "login-failed",
    "role-change",
    "policy-change",
    "projectmembership-lifecycle",
    "backup-started",
    "backup-completed",
    "restore-started",
    "restore-completed",
    "external-api-call",
    "preflight-block",
    "noop",
  ];
  assert.deepEqual(ODOS_AUDIT_EVENT_TYPES.slice(0, v05bRequiredEventTypes.length), v05bRequiredEventTypes);
  assert.equal(ODOS_AUDIT_EVENT_TYPES.includes("smart-token-issue"), true);
  assert.equal(ODOS_AUDIT_EVENT_TYPES.includes("smart-sandbox-register"), true);
  assert.equal(auditEventTypeForFhirWrite("AccessPolicy", "update"), "policy-change");
  assert.equal(auditEventTypeForFhirWrite("ProjectMembership", "create"), "projectmembership-lifecycle");
  assert.equal(auditEventTypeForFhirWrite("ProjectMembership", "patch"), "role-change");
});

test("v0.5b SQL migration creates append-only odos_audit_events table with required indexes and guards", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "../data/migrations/2026-04-29-v05b-odos-audit-events.sql"),
    "utf8",
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS odos_audit_events/);
  assert.match(sql, /event_time TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  assert.match(sql, /ib_actor_classification TEXT NOT NULL DEFAULT 'health-care-provider'/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS odos_audit_events_patient_time_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS odos_audit_events_actor_time_idx/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON odos_audit_events/);
  assert.match(sql, /BEFORE TRUNCATE ON odos_audit_events/);
  assert.match(sql, /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE odos_audit_events FROM PUBLIC/);
  assert.match(sql, /WHERE NOT rolsuper/);
});

test("OCR-style 90-day audit query returns structured role, outcome, and IB context without enrichment", () => {
  const patientId = "patient-x";
  const rows = seedNinetyDays(patientId);
  const result = ocrStyleAuditQuery(rows, {
    patientId,
    from: "2026-01-30T00:00:00.000Z",
    to: "2026-04-29T23:59:59.999Z",
  });

  assert.equal(result.length, 5);
  assert.ok(result.every((row) => row.actorRole));
  assert.ok(result.every((row) => row.actionOutcome === "granted" || row.ibException));
  assert.equal(result.find((row) => row.actionOutcome === "denied")?.ibException, "privacy");
  assert.equal(result.find((row) => row.breakGlass)?.breakGlassReason, "Emergency care.");
});

test("denied AccessPolicy compartment isolation writes privacy IB exception and FHIR AuditEvent outcome=8", () => {
  const row = buildOdosAuditEventRow({
    eventType: "denied",
    actorId: "clinician-1",
    actorRole: "provider",
    patientId: "patient-outside-compartment",
    resourceType: "Patient",
    resourceId: "patient-outside-compartment",
    actionOutcome: "denied",
    actionReason: "access-policy-compartment-isolation",
    policyUrl: "AccessPolicy/odos-clinician",
  });
  const auditEvent = buildAuditEventProjection(row);

  assert.equal(row.ibActorClassification, "health-care-provider");
  assert.equal(row.ibException, "privacy");
  assert.equal(auditEvent.outcome, "8");
  assert.equal(auditEvent.outcomeDesc, "access-policy-compartment-isolation");
  assert.equal(auditEvent.entity?.some((entity) => entity.detail?.[0]?.valueString === "privacy"), true);
});

test("AuditEvent projection field placement uses agent.role, agent.who, agent.policy, outcome, and entity", () => {
  const row = buildOdosAuditEventRow({
    eventType: "read",
    actorId: "doctor-1",
    actorRole: "provider",
    patientId: "patient-x",
    resourceType: "Observation",
    resourceId: "obs-1",
    actionOutcome: "granted",
    policyUrl: "AccessPolicy/odos-clinician",
  });
  const auditEvent = buildAuditEventProjection(row);

  assert.equal(auditEvent.type.system, "http://terminology.hl7.org/CodeSystem/audit-event-type");
  assert.equal(auditEvent.subtype?.[0]?.code, "read");
  assert.equal(auditEvent.agent[0].role?.[0]?.coding?.[0]?.code, "provider");
  assert.equal(auditEvent.agent[0].who?.reference, "Practitioner/doctor-1");
  assert.equal(auditEvent.agent[0].policy?.[0], "AccessPolicy/odos-clinician");
  assert.equal(auditEvent.source.observer?.reference, "Device/odos-instance");
  assert.equal(auditEvent.entity?.some((entity) => entity.what?.reference === "Patient/patient-x"), true);
  assert.equal(auditEvent.entity?.some((entity) => entity.what?.reference === "Observation/obs-1"), true);
});

test("originating PHI operation rolls back when odos_audit_events insert fails", async () => {
  let operationCalled = false;
  await assert.rejects(
    () =>
      executePhiOperationWithAudit({
        auditRow: buildOdosAuditEventRow({
          eventType: "read",
          patientId: "patient-x",
          actionOutcome: "granted",
        }),
        insertAuditRow: () => {
          throw new Error("database unreachable");
        },
        operation: () => {
          operationCalled = true;
        },
      }),
    /audit substrate unavailable/,
  );
  assert.equal(operationCalled, false);
});

test("FHIR AuditEvent projection failure leaves DB row and queues retry without rolling back PHI operation", async () => {
  const repository = new InMemoryOdosAuditRepository();
  const queue = new AuditEventProjectionQueue();
  let operationCalled = false;
  const row = buildOdosAuditEventRow({
    eventType: "read",
    patientId: "patient-x",
    actionOutcome: "granted",
  });

  await executePhiOperationWithAudit({
    auditRow: row,
    insertAuditRow: (auditRow) => repository.insert(auditRow),
    operation: () => {
      operationCalled = true;
      return "ok";
    },
    projectionQueue: queue,
    projectAuditEvent: () => {
      throw new Error("Medplum unreachable");
    },
  });

  assert.equal(operationCalled, true);
  assert.equal(repository.rows.length, 1);
  assert.equal(queue.pending.length, 1);
  assert.equal(queue.pending[0].attempts, 1);
  assert.match(queue.pending[0].lastError ?? "", /Medplum unreachable/);
});

test("append-only defenses reject UPDATE, DELETE, and TRUNCATE via permission and trigger guard", () => {
  assert.throws(
    () => assertAuditMutationAllowed({ operation: "UPDATE", dbRole: "app" }),
    /permission denied/,
  );
  assert.throws(
    () => assertAuditMutationAllowed({ operation: "DELETE", dbRole: "backup" }),
    /permission denied/,
  );
  assert.throws(
    () => assertAuditMutationAllowed({ operation: "UPDATE", dbRole: "superuser" }),
    /trigger guard/,
  );
  assert.throws(
    () => assertAuditMutationAllowed({ operation: "TRUNCATE", dbRole: "superuser" }),
    /trigger guard/,
  );
});

test("Information Blocking denial map classifies v0.5b denial reasons", () => {
  assert.equal(informationBlockingExceptionForDenial("access-policy-compartment-isolation"), "privacy");
  assert.equal(informationBlockingExceptionForDenial("break-glass-expired"), "security");
  assert.equal(informationBlockingExceptionForDenial("rate-limit"), "health-IT-performance");
});

test("audit UI model is auditor/practice-admin gated and exports OCR query rows as CSV and JSON", () => {
  const rows = sampleAuditRows();
  const filtered = filterAuditLogRows(rows, {
    patientId: "patient-x",
    from: "2026-01-30T00:00:00.000Z",
    to: "2026-04-29T23:59:59.999Z",
    eventTypes: [],
    breakGlassOnly: false,
  });

  assert.equal(canReviewAuditLog("admin"), true);
  assert.equal(canReviewAuditLog("admin"), true);
  assert.equal(canReviewAuditLog("provider"), false);
  assert.equal(canReviewAuditLog("provider"), false);
  assert.equal(canReviewAuditLog("unknown"), false);
  assert.match(
    exportAuditRowsAsCsv(filtered),
    /id,eventTime,eventType,actorId,actorRole,patientId,resourceType,resourceId,actionOutcome,actionReason,policyUrl,sessionId,ipAddress,userAgent,breakGlass,breakGlassReason,ibActorClassification,ibException,provenanceId,auditEventId,createdAt/,
  );
  assert.match(exportAuditRowsAsCsv(filtered), /denied/);
  assert.match(exportAuditRowsAsJson(filtered), /"ibException": "privacy"/);
});

test("restore integrity suite passes all five v0.5b post-restore checks", () => {
  const row = buildOdosAuditEventRow({
    eventType: "read",
    eventTime: "2026-04-29T12:00:00.000Z",
    patientId: "patient-x",
    actionOutcome: "granted",
  });
  const result = verifyRestoreIntegrity({
    manifestAuditSnapshot: {
      count: 1,
      latestEventTime: "2026-04-29T12:00:00.000Z",
      projectionQueueDrained: true,
    },
    restoredAuditRows: [row],
    provenanceSamples: [
      {
        resourceType: "Provenance",
        target: [{ reference: "Observation/obs-1" }],
        recorded: "2026-04-29T12:00:00.000Z",
        agent: [{ who: { display: "ODOS" } }],
        signature: [{ type: [{ system: "urn:iso-astm:E1762-95:2013", code: "1.2.840.10065.1.12.1.5" }], when: "2026-04-29T12:00:00.000Z", who: { reference: "Practitioner/doctor-1" }, data: "c2ln" }],
      },
    ],
    restoredBinaries: [
      { resourceType: "Binary", contentType: "image/jpeg", securityContext: { reference: "Patient/patient-x" } },
    ],
    auditEvents: [buildAuditEventProjection(row)],
    accessPolicyRoundTripPassed: true,
  });

  assert.equal(result.passed, true);
  assert.equal(result.checks.length, 5);
});

test(
  "live MCP audit worker records actual read, write, and audit-only boundary denial with AuditEvent projection",
  { timeout: 120_000 },
  async (t) => {
    loadRepoEnv();
    const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
    const email = process.env.MEDPLUM_ADMIN_EMAIL;
    const password = process.env.MEDPLUM_ADMIN_PASSWORD;
    if (!email || !password) {
      t.skip("MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD are required for the live audit worker integration fixture.");
      return;
    }

    const { fhir, accessToken } = await createAuthenticatedFhirClient({ baseUrl, email, password });
    const audit = createLiveOdosAuditRuntime({
      postgresUrl: process.env.ODOS_POSTGRES_URL,
      medplumBaseUrl: baseUrl,
      medplumEmail: email,
      medplumPassword: password,
    });
    t.after(async () => {
      await audit.close();
    });

    const patient = await fhir.create<Patient>({
      resourceType: "Patient",
      active: true,
      gender: "unknown",
      name: [{ use: "official", family: `AuditWorker${Date.now()}`, given: ["Live"] }],
    });
    assert.ok(patient.id);

    const adminMcp = await connectMcpServer({
      baseUrl,
      email,
      password,
      accessToken,
      clientName: "odos-mcp-v05b-live-audit-admin",
    });
    t.after(async () => {
      await adminMcp.client.close();
    });

    parseToolOutput<Patient>(
      await adminMcp.client.callTool({
        name: "get_patient",
        arguments: { patient_id: patient.id },
      }),
    );
    parseToolOutput<{ patient: Patient }>(
      await adminMcp.client.callTool({
        name: "update_patient",
        arguments: { patient_id: patient.id, active: false },
      }),
    );

    const auditOnlyBoundaryToken = await createAuditOnlyBoundaryClientToken({ baseUrl, accessToken, fhir });
    const auditOnlyBoundaryMcp = await connectMcpServer({
      baseUrl,
      email,
      password,
      accessToken: auditOnlyBoundaryToken,
      clientName: "odos-mcp-v05b-live-audit-only-boundary-denial",
    });
    t.after(async () => {
      await auditOnlyBoundaryMcp.client.close();
    });

    const denied = await auditOnlyBoundaryMcp.client.callTool({
      name: "get_patient",
      arguments: { patient_id: patient.id },
    });
    assert.equal(denied.isError, true);

    const rows = await audit.queryRows({
      patientId: patient.id,
      actorId: "odos-mcp",
      eventTypes: ["read", "patch", "denied"],
      limit: 50,
    });
    assert.ok(rows.some((row) => row.eventType === "read" && row.resourceType === "Patient"));
    assert.ok(rows.some((row) => row.eventType === "patch" && row.resourceType === "Patient"));
    const deniedRow = rows.find((row) => row.eventType === "denied");
    assert.equal(deniedRow?.ibException, "privacy");

    const auditEvents = bundleResources(
      await fhir.search<AuditEvent>("AuditEvent", { _count: "1000", _sort: "-_lastUpdated" }),
    );
    for (const row of rows.filter((candidate) => candidate.eventType !== "denied").slice(0, 2)) {
      assert.ok(
        auditEvents.some((auditEvent) => auditEventHasOdosRowId(auditEvent, row.id)),
        `Expected projected AuditEvent for odos_audit_events row ${row.id}`,
      );
    }
  },
);

function seedNinetyDays(patientId: string) {
  return [
    buildOdosAuditEventRow({
      eventType: "read",
      eventTime: "2026-04-28T12:00:00.000Z",
      actorId: "doctor-1",
      actorRole: "provider",
      patientId,
      resourceType: "Patient",
      resourceId: patientId,
      actionOutcome: "granted",
      policyUrl: "AccessPolicy/odos-clinician",
    }),
    buildOdosAuditEventRow({
      eventType: "search",
      eventTime: "2026-04-20T12:00:00.000Z",
      actorId: "front-1",
      actorRole: "staff",
      patientId,
      resourceType: "Encounter",
      actionOutcome: "granted",
      policyUrl: "AccessPolicy/odos-front-desk",
    }),
    buildOdosAuditEventRow({
      eventType: "update",
      eventTime: "2026-04-05T12:00:00.000Z",
      actorId: "doctor-1",
      actorRole: "provider",
      patientId,
      resourceType: "Observation",
      resourceId: "obs-1",
      actionOutcome: "granted",
      provenanceId: "Provenance/prov-1",
    }),
    buildOdosAuditEventRow({
      eventType: "denied",
      eventTime: "2026-03-15T12:00:00.000Z",
      actorId: "doctor-2",
      actorRole: "provider",
      patientId,
      resourceType: "Patient",
      resourceId: patientId,
      actionOutcome: "denied",
      actionReason: "access-policy-compartment-isolation",
    }),
    buildOdosAuditEventRow({
      eventType: "break-glass-invoked",
      eventTime: "2026-02-10T12:00:00.000Z",
      actorId: "doctor-3",
      actorRole: "provider",
      patientId,
      resourceType: "Encounter",
      resourceId: "enc-emergency",
      actionOutcome: "granted",
      breakGlass: true,
      breakGlassReason: "Emergency care.",
    }),
    buildOdosAuditEventRow({
      eventType: "read",
      eventTime: "2025-12-01T12:00:00.000Z",
      actorId: "doctor-1",
      actorRole: "provider",
      patientId,
      actionOutcome: "granted",
    }),
  ];
}

async function createAuditOnlyBoundaryClientToken(input: {
  baseUrl: string;
  accessToken: string;
  fhir: MedplumClient;
}): Promise<string> {
  const meRes = await fetch(`${input.baseUrl.replace(/\/$/, "")}/auth/me`, {
    headers: { Authorization: `Bearer ${input.accessToken}` },
  });
  assert.ok(meRes.ok, `GET /auth/me failed: ${meRes.status}`);
  const me = (await meRes.json()) as { project?: { id?: string } };
  assert.ok(me.project?.id, "Could not resolve project id from /auth/me.");

  // This test-local boundary is intentionally not a named product role; see performance-od/decisions/2026-08-28-odos-auditor-fixture-fossil-verdict.md.
  const policy = buildAuditOnlyBoundaryPolicy(`ODOS v0.5b Audit-Only Boundary Denial ${Date.now()}`);
  const createdPolicy = await input.fhir.create<AccessPolicy>(policy);
  assert.ok(createdPolicy.id);

  const adminClientRes = await fetch(
    `${input.baseUrl.replace(/\/$/, "")}/admin/projects/${me.project.id}/client`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `v0.5b-live-audit-denial-${Date.now()}`,
        description: "v0.5b live audit-only boundary denial integration fixture",
        accessPolicy: { reference: `AccessPolicy/${createdPolicy.id}` },
      }),
    },
  );
  const adminClientBody = await adminClientRes.text();
  assert.ok(
    adminClientRes.ok,
    `POST /admin/projects/${me.project.id}/client failed: ${adminClientRes.status} ${adminClientBody}`,
  );
  const clientApp = JSON.parse(adminClientBody) as { id: string; secret: string };

  const tokenRes = await fetch(`${input.baseUrl.replace(/\/$/, "")}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientApp.id,
      client_secret: clientApp.secret,
    }),
  });
  assert.ok(tokenRes.ok, `client_credentials grant failed: ${tokenRes.status}`);
  const { access_token: clientToken } = (await tokenRes.json()) as { access_token: string };
  return clientToken;
}

function buildAuditOnlyBoundaryPolicy(name: string): AccessPolicy {
  const readInteractions = ["read", "search", "history", "vread"] as const;
  return {
    resourceType: "AccessPolicy",
    name,
    resource: [
      { resourceType: "AuditEvent", interaction: [...readInteractions] },
      { resourceType: "Provenance", interaction: [...readInteractions] },
      {
        resourceType: "Basic",
        interaction: [...readInteractions],
        criteria: "Basic?code=https://odos2020.com/fhir/CodeSystem/appearance-config|odos-appearance-config",
      },
    ],
  };
}

function bundleResources<T extends Resource>(bundle: Bundle<T>): T[] {
  return bundle.entry?.map((entry) => entry.resource).filter((resource): resource is T => Boolean(resource)) ?? [];
}

function auditEventHasOdosRowId(auditEvent: AuditEvent, rowId: string): boolean {
  return (
    auditEvent.entity?.some((entity) =>
      entity.detail?.some(
        (detail) => detail.type === "odos_audit_event_id" && detail.valueString === rowId,
      ),
    ) ?? false
  );
}
