import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { OdosAuditEventRecord } from "../src/authz/odosAudit.js";
import { buildMedplumAccessPolicy, getRoleDeclaration } from "../src/authz/roles.js";
import type { CommsProvider, ConversationSummary } from "../src/comms/comms-provider.js";
import { registerCommsApiRoutes, type CommsApiRouteDeps } from "../src/comms/comms-api.js";
import express from "express";

const PATIENT_REFERENCE = "Patient/synthetic-1";
const CALL_ID = `CA${"3".repeat(32)}`;
const RECORDING_ID = `RE${"4".repeat(32)}`;

test("communications RBAC hides message content from front desk at the FHIR policy layer", () => {
  const frontDesk = buildMedplumAccessPolicy(getRoleDeclaration("front-desk"));
  const frontDeskRule = frontDesk.resource?.find((rule) =>
    rule.resourceType === "Communication" && rule.criteria?.includes("patient-sms"));
  assert.ok(frontDeskRule);
  assert.deepEqual(frontDeskRule.hiddenFields, ["payload", "note", "text"]);
  assert.match(frontDeskRule.criteria ?? "", /patient-call/);

  for (const role of ["clinician", "aesthetics-provider"] as const) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(role));
    const rule = policy.resource?.find((candidate) =>
      candidate.resourceType === "Communication" && candidate.criteria?.includes("%patient_compartment"));
    assert.ok(rule, role);
    assert.equal(rule.hiddenFields, undefined);
  }
  const auditor = buildMedplumAccessPolicy(getRoleDeclaration("auditor"));
  assert.equal(auditor.resource?.some((rule) => rule.resourceType === "Communication"), false);
});

test("every communications endpoint rejects missing authentication and audits every authenticated wrong-role denial", async () => {
  const fixture = await startServer();
  const endpoints = [
    { method: "GET", path: "/communications/conversations" },
    { method: "POST", path: "/communications/messages", body: { patientReference: PATIENT_REFERENCE, body: "Synthetic message" } },
    { method: "GET", path: "/communications/calls" },
    { method: "GET", path: `/communications/calls/${CALL_ID}` },
    { method: "POST", path: "/communications/calls", body: { patientReference: PATIENT_REFERENCE } },
    { method: "GET", path: `/communications/recordings/${RECORDING_ID}` },
  ] as const;
  try {
    for (const endpoint of endpoints) {
      const unauthenticated = await request(fixture.base, endpoint.path, endpoint.method, endpoint.body);
      assert.equal(unauthenticated.status, 401, `${endpoint.method} ${endpoint.path}`);
      const wrongRole = await request(fixture.base, endpoint.path, endpoint.method, endpoint.body, "auditor");
      assert.equal(wrongRole.status, 403, `${endpoint.method} ${endpoint.path}`);
    }
    assert.equal(fixture.denials.length, endpoints.length);
    assert.equal(fixture.denials.every((row) => row.eventType === "denied" && row.actionOutcome === "denied"), true);
    assert.equal(fixture.providerCalls.length, 0);
  } finally {
    await fixture.close();
  }
});

test("conversation reads expose metadata to front desk but bodies only to clinical/content roles", async () => {
  const fixture = await startServer();
  try {
    const desk = await request(fixture.base, "/communications/conversations?patient_id=synthetic-1&limit=10", "GET", undefined, "front-desk");
    assert.equal(desk.status, 200);
    const deskBody = await desk.json() as { conversations: ConversationSummary[] };
    assert.equal(deskBody.conversations[0].messageCount, 1);
    assert.equal(deskBody.conversations[0].messages[0].body, undefined);

    const clinician = await request(fixture.base, "/communications/conversations?patient_id=synthetic-1&limit=10", "GET", undefined, "clinician");
    assert.equal(clinician.status, 200);
    const clinicianBody = await clinician.json() as { conversations: ConversationSummary[] };
    assert.equal(clinicianBody.conversations[0].messages[0].body, "Synthetic scheduling content");
    assert.deepEqual(fixture.listRequests.map((entry) => entry.includeContent), [false, true]);
  } finally {
    await fixture.close();
  }
});

test("staff SMS, calls, and recording retrieval use provider capabilities and return audited results", async () => {
  const fixture = await startServer();
  try {
    const sent = await request(fixture.base, "/communications/messages", "POST", {
      patientReference: PATIENT_REFERENCE,
      body: "Synthetic staff message",
    }, "front-desk");
    assert.equal(sent.status, 200);
    assert.deepEqual(await sent.json(), { outcome: "sent", providerMessageId: "SM-synthetic" });

    const calls = await request(fixture.base, "/communications/calls?limit=12", "GET", undefined, "front-desk");
    assert.equal(calls.status, 200);
    assert.equal((await calls.json() as { calls: unknown[] }).calls.length, 1);

    const call = await request(fixture.base, `/communications/calls/${CALL_ID}`, "GET", undefined, "front-desk");
    assert.equal(call.status, 200);
    assert.equal((await call.json() as { call: { id: string } }).call.id, CALL_ID);

    const initiated = await request(fixture.base, "/communications/calls", "POST", {
      patientReference: PATIENT_REFERENCE,
    }, "front-desk");
    assert.equal(initiated.status, 201);
    assert.deepEqual(await initiated.json(), { callId: CALL_ID });

    const recording = await request(fixture.base, `/communications/recordings/${RECORDING_ID}`, "GET", undefined, "clinician");
    assert.equal(recording.status, 200);
    assert.equal(recording.headers.get("content-type"), "audio/mpeg");
    assert.deepEqual([...new Uint8Array(await recording.arrayBuffer())], [1, 2, 3]);

    assert.equal(fixture.grants.length, 5);
    assert.equal(fixture.grants.every((row) => row.actionOutcome === "granted"), true);
    assert.deepEqual(fixture.providerCalls, ["sendSms", "listCalls", "getCall", "initiateCall", "fetchRecording"]);
  } finally {
    await fixture.close();
  }
});

test("recording retrieval degrades cleanly when media authentication is not acknowledged", async () => {
  const fixture = await startServer({ recordingEnabled: false });
  try {
    const response = await request(fixture.base, `/communications/recordings/${RECORDING_ID}`, "GET", undefined, "clinician");
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Recording retrieval is not enabled for this communications provider." });
  } finally {
    await fixture.close();
  }
});

async function startServer(options: { recordingEnabled?: boolean } = {}) {
  const providerCalls: string[] = [];
  const listRequests: Array<{ includeContent?: boolean }> = [];
  const grants: OdosAuditEventRecord[] = [];
  const denials: OdosAuditEventRecord[] = [];
  const conversation: ConversationSummary = {
    id: PATIENT_REFERENCE,
    patientReference: PATIENT_REFERENCE,
    updatedAt: "2026-08-02T15:00:00.000Z",
    messageCount: 1,
    messages: [{
      id: "comm-1",
      direction: "inbound",
      status: "completed",
      occurredAt: "2026-08-02T15:00:00.000Z",
      from: "+18645550199",
      to: "+18645550100",
      body: "Synthetic scheduling content",
    }],
  };
  const provider: CommsProvider = {
    name: "twilio",
    capabilities: { sms: true, calls: true, email: false, contacts: false, conversations: true, reviews: false },
    async listConversations(request) {
      listRequests.push(request ?? {});
      return [structuredClone(conversation)];
    },
    async sendSms() {
      providerCalls.push("sendSms");
      return { outcome: "sent", providerMessageId: "SM-synthetic" };
    },
    async listCalls() {
      providerCalls.push("listCalls");
      return [{ id: CALL_ID, from: "+18645550199", to: "+18645550100", status: "completed", direction: "inbound" }];
    },
    async getCall(id) {
      providerCalls.push("getCall");
      return { id, from: "+18645550199", to: "+18645550100", status: "completed", direction: "inbound" };
    },
    async initiateCall() {
      providerCalls.push("initiateCall");
      return { callId: CALL_ID };
    },
    ...(options.recordingEnabled === false ? {} : {
      async fetchRecording() {
        providerCalls.push("fetchRecording");
        return { id: RECORDING_ID, callId: CALL_ID, status: "completed", contentType: "audio/mpeg", audio: Uint8Array.from([1, 2, 3]) };
      },
    }),
  };
  const deps: CommsApiRouteDeps = {
    authenticateService: async () => undefined,
    authenticate: async (header) => {
      const role = header?.replace("Bearer ", "");
      if (!role || !["practice-admin", "clinician", "front-desk", "auditor", "aesthetics-provider"].includes(role)) return null;
      return {
        staffReference: `Practitioner/${role}`,
        actorRole: role as never,
        roles: [role as never],
        fhir: {} as never,
      };
    },
    dispatch: {
      providers: () => ["twilio"],
      getAdapter: () => provider,
      initialize: async () => undefined,
    },
    audit: {
      async record(row, operation) {
        grants.push(row);
        return operation();
      },
      async recordDenied(row) {
        denials.push(row);
      },
    },
    now: () => "2026-08-02T15:00:00.000Z",
  };
  const app = express();
  app.use(express.json());
  registerCommsApiRoutes(app, deps);
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    providerCalls,
    listRequests,
    grants,
    denials,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

function request(base: string, path: string, method: string, body?: unknown, role?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(role ? {
        authorization: `Bearer ${role}`,
        "x-odos-actor-role": role,
        "x-odos-actor-id": role,
      } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
