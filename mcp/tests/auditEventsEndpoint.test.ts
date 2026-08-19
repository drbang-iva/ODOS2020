import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import express from "express";
import { createAuditEventsGetHandler } from "../src/authz/audit-events-endpoint.js";
import { buildOdosAuditEventRow } from "../src/authz/odosAudit.js";

test("authenticated Staff cannot forge Admin access to the unscoped audit log", async () => {
  let deniedActor: { actorId?: string; actorRole?: string } | undefined;
  const app = express();
  app.get("/audit/events", createAuditEventsGetHandler({
    authenticate: async (authorization) => authorization === "Bearer staff-token"
      ? { staffReference: "Practitioner/staff-1", roles: ["staff"] }
      : null,
    audit: {
      queryRows: async () => [],
      record: async (_row, operation) => operation(),
      recordDenied: async (row) => { deniedActor = row; },
    },
  }));
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/audit/events`, {
      headers: {
        Authorization: "Bearer staff-token",
        "X-ODOS-Role": "admin",
      },
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "audit.read role required", actorRole: "staff" });
    assert.deepEqual(deniedActor, {
      ...deniedActor,
      actorId: "Practitioner/staff-1",
      actorRole: "staff",
    });
  } finally {
    await closeServer(server);
  }
});

test("authenticated Admin retains the unscoped access and break-glass audit view", async () => {
  let queriedFilters: Record<string, unknown> | undefined;
  const readRow = buildOdosAuditEventRow({
    eventType: "read",
    actorId: "Practitioner/provider-1",
    actorRole: "provider",
    patientId: "patient-1",
    resourceType: "Patient",
    resourceId: "patient-1",
    actionOutcome: "granted",
    breakGlass: true,
    breakGlassReason: "Synthetic emergency access",
  });
  const app = express();
  app.get("/audit/events", createAuditEventsGetHandler({
    authenticate: async () => ({ staffReference: "Practitioner/admin-1", roles: ["admin"] }),
    audit: {
      queryRows: async (filters) => {
        queriedFilters = filters as Record<string, unknown>;
        return [readRow];
      },
      record: async (_row, operation) => operation(),
      recordDenied: async () => undefined,
    },
  }));
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/audit/events?event_type=read&break_glass_only=true`,
      { headers: { Authorization: "Bearer admin-token", "X-ODOS-Role": "staff" } },
    );

    assert.equal(response.status, 200);
    const body = await response.json() as { actorRole?: string; rows?: Array<{ eventType?: string; breakGlass?: boolean }> };
    assert.equal(body.actorRole, "admin");
    assert.deepEqual(body.rows?.map((row) => [row.eventType, row.breakGlass]), [["read", true]]);
    assert.deepEqual(queriedFilters?.eventTypes, ["read"]);
    assert.equal(queriedFilters?.breakGlassOnly, true);
    assert.equal(queriedFilters?.excludeBreakGlass, undefined);
  } finally {
    await closeServer(server);
  }
});

test("authenticated chart staff receive only patient change events including document generation and print", async () => {
  let queriedFilters: Record<string, unknown> | undefined;
  const printRow = buildOdosAuditEventRow({
    eventType: "document.print.requested",
    actorId: "Practitioner/provider-1",
    actorRole: "provider",
    patientId: "patient-1",
    resourceType: "DocumentReference",
    resourceId: "letter-1",
    actionOutcome: "granted",
  });
  const app = express();
  app.get("/audit/events", createAuditEventsGetHandler({
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", roles: ["staff"] }),
    audit: {
      queryRows: async (filters) => {
        queriedFilters = filters as Record<string, unknown>;
        return [printRow];
      },
      record: async (_row, operation) => operation(),
      recordDenied: async () => undefined,
    },
  }));
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/audit/events?scope=patient-history&patient_id=patient-1&event_type=read`,
      { headers: { Authorization: "Bearer staff-token" } },
    );

    assert.equal(response.status, 200);
    const body = await response.json() as { actorRole?: string; rows?: Array<{ eventType?: string }> };
    assert.equal(body.actorRole, "staff");
    assert.deepEqual(body.rows?.map((row) => row.eventType), ["document.print.requested"]);
    assert.equal(queriedFilters?.patientId, "patient-1");
    assert.equal(queriedFilters?.excludeBreakGlass, true);
    const eventTypes = queriedFilters?.eventTypes as string[];
    for (const eventType of [
      "create",
      "update",
      "payment.charge.completed",
      "claim.submit.completed",
      "era.denial.flagged",
      "document.generate.completed",
      "document.generate.failed",
      "document.print.requested",
      "document.print.completed",
    ]) {
      assert.ok(eventTypes.includes(eventType), `${eventType} must be visible in patient History`);
    }
    assert.equal(eventTypes.includes("read"), false);
    assert.equal(eventTypes.includes("chart.opened"), false);
  } finally {
    await closeServer(server);
  }
});

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}
