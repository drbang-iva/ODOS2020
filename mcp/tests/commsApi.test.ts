import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Communication, Resource } from "@medplum/fhirtypes";
import type { OdosAuditEventRecord } from "../src/authz/odosAudit.js";
import { buildMedplumAccessPolicy, getRoleDeclaration } from "../src/authz/roles.js";
import type { CommsProvider, ConversationSummary } from "../src/comms/comms-provider.js";
import { registerCommsApiRoutes, type CommsApiRouteDeps } from "../src/comms/comms-api.js";
import express from "express";

const PATIENT_REFERENCE = "Patient/synthetic-1";
const CALL_ID = `CA${"3".repeat(32)}`;
const OTHER_CALL_ID = `CA${"8".repeat(32)}`;
const RECORDING_ID = `RE${"4".repeat(32)}`;

test("communications RBAC hides message content from front desk at the FHIR policy layer", () => {
  const frontDesk = buildMedplumAccessPolicy(getRoleDeclaration("front-desk"));
  const frontDeskRule = frontDesk.resource?.find((rule) =>
    rule.resourceType === "Communication" && rule.hiddenFields?.includes("payload"));
  assert.ok(frontDeskRule);
  assert.deepEqual(frontDeskRule.hiddenFields, ["payload", "note", "text"]);
  assert.equal(frontDeskRule.criteria, "Communication?_compartment=%patient_compartment");
  assert.equal(frontDeskRule.interaction?.includes("create"), true);
  assert.equal(frontDeskRule.interaction?.includes("update"), true);
  const internalOfficeRule = frontDesk.resource?.find((rule) =>
    rule.resourceType === "Communication" && rule.criteria?.includes("internal-office"));
  assert.ok(internalOfficeRule);
  assert.equal(internalOfficeRule.interaction?.includes("update"), false);

  for (const role of ["clinician", "aesthetics-provider"] as const) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(role));
    const rule = policy.resource?.find((candidate) =>
      candidate.resourceType === "Communication" && candidate.criteria?.includes("%patient_compartment"));
    assert.ok(rule, role);
    assert.equal(rule.hiddenFields, undefined);
    assert.equal(rule.interaction?.includes("create"), true);
    assert.equal(rule.interaction?.includes("update"), true);
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

test("conversation reads use caller-bound FHIR and expose bodies only to clinical/content roles", async () => {
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
    assert.equal(fixture.adapterFhirs.length, 2);
    assert.equal(fixture.authenticatedFhirs.length, 2);
    assert.notEqual(fixture.authenticatedFhirs[0], fixture.authenticatedFhirs[1]);
    assert.equal(fixture.adapterFhirs.every((fhir, index) => fhir === fixture.authenticatedFhirs[index]), true);
  } finally {
    await fixture.close();
  }
});

test("a content-authorized GHL thread read is on-demand and never runs for the conversation list", async () => {
  const fixture = await startServer({ providerName: "ghl" });
  try {
    const list = await request(fixture.base, "/communications/conversations?patient_id=synthetic-1", "GET", undefined, "clinician");
    assert.equal(list.status, 200);
    assert.deepEqual(fixture.threadReadRequests, []);

    const desk = await request(
      fixture.base,
      "/communications/conversations?patient_id=synthetic-1&conversation_id=conversation-synthetic-1",
      "GET",
      undefined,
      "front-desk",
    );
    assert.equal(desk.status, 200);
    assert.deepEqual(fixture.threadReadRequests, []);

    const clinician = await request(
      fixture.base,
      "/communications/conversations?patient_id=synthetic-1&conversation_id=conversation-synthetic-1",
      "GET",
      undefined,
      "clinician",
    );
    assert.equal(clinician.status, 200);
    const body = await clinician.json() as { conversations: ConversationSummary[] };
    assert.deepEqual(body.conversations[0].messages, [{
      id: "ghl-thread-message-1",
      direction: "inbound",
      status: "delivered",
      occurredAt: "2026-08-03T13:00:00.000Z",
      body: "Synthetic GHL thread content",
    }]);
    assert.deepEqual(fixture.threadReadRequests, [{
      conversationId: "conversation-synthetic-1",
      includeContent: true,
    }]);
  } finally {
    await fixture.close();
  }
});

test("front-desk SMS succeeds through masked FHIR responses and reaches a durable sent reservation", async () => {
  const fixture = await startServer();
  try {
    const messageRequest = {
      patientReference: PATIENT_REFERENCE,
      body: "Synthetic staff message",
      idempotencyKey: "synthetic-send-0001",
    };
    const sent = await request(fixture.base, "/communications/messages", "POST", messageRequest, "front-desk");
    assert.equal(sent.status, 200);
    assert.deepEqual(await sent.json(), { outcome: "sent", providerMessageId: "SM-synthetic" });
    assert.deepEqual(fixture.providerCalls, ["sendSms"]);
    assert.equal(fixture.persistedCommunications.length, 1);
    assert.equal(fixture.persistedCommunications[0].status, "in-progress");
    assert.equal(fixture.persistedCommunications[0].subject?.reference, PATIENT_REFERENCE);
    assert.equal(fixture.persistedCommunications[0].sender?.reference, "Practitioner/front-desk");
    assert.equal(fixture.persistedCommunications[0].recipient?.[0].reference, PATIENT_REFERENCE);
    assert.equal(fixture.persistedCommunications[0].sent, "2026-08-02T15:00:00.000Z");
    assert.equal(fixture.persistedCommunications[0].payload?.[0].contentString, "Synthetic staff message");
    assert.match(JSON.stringify(fixture.persistedCommunications[0].identifier), /SM-synthetic/);
    const retry = await request(fixture.base, "/communications/messages", "POST", messageRequest, "front-desk");
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { outcome: "sent", providerMessageId: "SM-synthetic" });
    assert.deepEqual(fixture.providerCalls, ["sendSms"]);

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

    assert.equal(fixture.grants.length, 6);
    assert.equal(fixture.grants.every((row) => row.actionOutcome === "granted"), true);
    assert.deepEqual(fixture.providerCalls, ["sendSms", "listCalls", "getCall", "initiateCall", "fetchRecording"]);
  } finally {
    await fixture.close();
  }
});

test("staff SMS requires a stable idempotency key and retries never dispatch twice", async () => {
  const fixture = await startServer();
  const body = {
    patientReference: PATIENT_REFERENCE,
    body: "Synthetic idempotent message",
    idempotencyKey: "synthetic-send-0002",
  };
  try {
    const missing = await request(fixture.base, "/communications/messages", "POST", {
      patientReference: PATIENT_REFERENCE,
      body: "Synthetic idempotent message",
    }, "front-desk");
    assert.equal(missing.status, 400);

    const first = await request(fixture.base, "/communications/messages", "POST", body, "front-desk");
    const retry = await request(fixture.base, "/communications/messages", "POST", body, "front-desk");
    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { outcome: "sent", providerMessageId: "SM-synthetic" });
    assert.deepEqual(fixture.providerCalls, ["sendSms"]);
    assert.equal(fixture.persistedCommunications.length, 1);
  } finally {
    await fixture.close();
  }
});

test("staff SMS persists the selected provider message identifier", async () => {
  const fixture = await startServer({ providerName: "ghl" });
  try {
    const sent = await request(fixture.base, "/communications/messages", "POST", {
      provider: "ghl",
      patientReference: PATIENT_REFERENCE,
      body: "Synthetic GHL staff message",
      idempotencyKey: "synthetic-ghl-send-0001",
    }, "front-desk");
    assert.equal(sent.status, 200);
    assert.equal(fixture.persistedCommunications[0].identifier?.some((identifier) =>
      identifier.system === "https://odos2020.com/fhir/NamingSystem/ghl-message-id"
      && identifier.value === "SM-synthetic"), true);
    assert.equal(fixture.persistedCommunications[0].identifier?.some((identifier) =>
      identifier.system === "https://odos2020.com/fhir/NamingSystem/twilio-message-sid"), false);
    assert.equal(fixture.persistedCommunications[0].status, "completed");
  } finally {
    await fixture.close();
  }
});

test("new SMS uses transactional routing while a reply preserves its explicit thread provider", async () => {
  const fixture = await startServer({
    providers: ["twilio", "ghl"],
    channelRoutes: { voice: "twilio", "transactional-sms": "ghl" },
  });
  try {
    const first = await request(fixture.base, "/communications/messages", "POST", {
      patientReference: PATIENT_REFERENCE,
      body: "Synthetic new conversation",
      idempotencyKey: "synthetic-route-new-0001",
    }, "front-desk");
    assert.equal(first.status, 200);

    const reply = await request(fixture.base, "/communications/messages", "POST", {
      provider: "twilio",
      patientReference: PATIENT_REFERENCE,
      body: "Synthetic thread reply",
      idempotencyKey: "synthetic-route-reply-0001",
    }, "front-desk");
    assert.equal(reply.status, 200);

    const calls = await request(fixture.base, "/communications/calls?limit=1", "GET", undefined, "front-desk");
    assert.equal(calls.status, 200);
    assert.deepEqual(fixture.adapterProviders, ["ghl", "twilio", "twilio"]);
  } finally {
    await fixture.close();
  }
});

test("an unassigned channel role is reported as unavailable without resolving an adapter", async () => {
  const fixture = await startServer({ providers: ["twilio"], channelRoutes: {} });
  try {
    const response = await request(fixture.base, "/communications/messages", "POST", {
      patientReference: PATIENT_REFERENCE,
      body: "Synthetic unavailable route",
      idempotencyKey: "synthetic-route-none-0001",
    }, "front-desk");
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'Communications role "transactional-sms" is not configured for this practice.',
    });
    assert.deepEqual(fixture.adapterProviders, []);
  } finally {
    await fixture.close();
  }
});

test("a post-send FHIR failure leaves a durable unknown outcome and blocks duplicate dispatch", async () => {
  const fixture = await startServer({ failSmsCompletion: true });
  const body = {
    patientReference: PATIENT_REFERENCE,
    body: "Synthetic uncertain message",
    idempotencyKey: "synthetic-send-0003",
  };
  try {
    const first = await request(fixture.base, "/communications/messages", "POST", body, "front-desk");
    assert.equal(first.status, 502);
    const retry = await request(fixture.base, "/communications/messages", "POST", body, "front-desk");
    assert.equal(retry.status, 409);
    assert.deepEqual(fixture.providerCalls, ["sendSms"]);
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

test("recording retrieval requires a persisted call visible to the caller's FHIR policy", async () => {
  const fixture = await startServer({ recordingVisible: false });
  try {
    const response = await request(fixture.base, `/communications/recordings/${RECORDING_ID}`, "GET", undefined, "clinician");
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Recording not found." });
    assert.deepEqual(fixture.providerCalls, []);
    assert.equal(fixture.grants.length, 0);
    assert.equal(fixture.denials.length, 1);
    assert.equal(fixture.denials[0].actionOutcome, "denied");
    assert.equal(fixture.denials[0].eventType, "read");
  } finally {
    await fixture.close();
  }
});

test("call history and detail require persisted calls visible to the caller's FHIR policy", async () => {
  const fixture = await startServer({ callVisible: false });
  try {
    const list = await request(fixture.base, "/communications/calls?limit=12", "GET", undefined, "clinician");
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { calls: [] });

    const detail = await request(fixture.base, `/communications/calls/${CALL_ID}`, "GET", undefined, "clinician");
    assert.equal(detail.status, 404);
    assert.deepEqual(await detail.json(), { error: "Call not found." });
    assert.deepEqual(fixture.providerCalls, []);
  } finally {
    await fixture.close();
  }
});

test("call history applies the requested limit after filtering the provider window by visible calls", async () => {
  const fixture = await startServer();
  try {
    const response = await request(fixture.base, "/communications/calls?limit=1", "GET", undefined, "clinician");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { calls: Array<{ id: string }> }).calls.map((call) => call.id), [CALL_ID]);
    assert.deepEqual(fixture.callListRequests, [{ limit: 1_000 }]);
  } finally {
    await fixture.close();
  }
});

async function startServer(options: {
  recordingEnabled?: boolean;
  recordingVisible?: boolean;
  callVisible?: boolean;
  failSmsCompletion?: boolean;
  providerName?: "twilio" | "ghl";
  providers?: Array<"twilio" | "ghl">;
  channelRoutes?: Partial<Record<"voice" | "transactional-sms" | "marketing-sms" | "email", string>>;
} = {}) {
  const providerCalls: string[] = [];
  const adapterProviders: string[] = [];
  const callListRequests: Array<{ limit?: number }> = [];
  const listRequests: Array<{ includeContent?: boolean }> = [];
  const threadReadRequests: Array<{ conversationId: string; includeContent?: boolean }> = [];
  const grants: OdosAuditEventRecord[] = [];
  const denials: OdosAuditEventRecord[] = [];
  const persistedCommunications: Communication[] = [];
  const authenticatedFhirs: unknown[] = [];
  const adapterFhirs: unknown[] = [];
  const conversation: ConversationSummary = {
    id: "conversation-synthetic-1",
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
    name: options.providerName ?? "twilio",
    messageIdentifierSystem: options.providerName === "ghl"
      ? "https://odos2020.com/fhir/NamingSystem/ghl-message-id"
      : "https://odos2020.com/fhir/NamingSystem/twilio-message-sid",
    capabilities: { sms: true, calls: true, email: false, contacts: false, conversations: true, reviews: false },
    async listConversations(request) {
      listRequests.push(request ?? {});
      return [structuredClone(conversation)];
    },
    async getConversationMessages(conversationId, request) {
      threadReadRequests.push({ conversationId, ...request });
      return [{
        id: "ghl-thread-message-1",
        direction: "inbound",
        status: "delivered",
        occurredAt: "2026-08-03T13:00:00.000Z",
        ...(request?.includeContent ? { body: "Synthetic GHL thread content" } : {}),
      }];
    },
    async sendSms() {
      providerCalls.push("sendSms");
      return { outcome: "sent", providerMessageId: "SM-synthetic" };
    },
    async listCalls(request = {}) {
      providerCalls.push("listCalls");
      callListRequests.push(request);
      return [
        { id: OTHER_CALL_ID, from: "+18645550198", to: "+18645550100", status: "completed", direction: "inbound" as const },
        { id: CALL_ID, from: "+18645550199", to: "+18645550100", status: "completed", direction: "inbound" as const },
      ].slice(0, request.limit);
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
      const accessPolicy = buildMedplumAccessPolicy(getRoleDeclaration(role as never));
      const communicationRule = accessPolicy.resource?.find((rule) =>
        rule.resourceType === "Communication" && rule.criteria?.includes("_compartment"));
      const communicationUpdateAllowed = accessPolicy.resource?.some((rule) =>
        (rule.resourceType === "Communication" || rule.resourceType === "*")
        && (rule.interaction?.includes("update") || rule.interaction?.includes("*"))) === true;
      const hiddenFields = communicationRule?.hiddenFields ?? [];
      const callerView = <T extends Resource>(resource: T): T => {
        const view = structuredClone(resource);
        if (view.resourceType === "Communication") {
          const fields = view as unknown as Record<string, unknown>;
          for (const field of hiddenFields) delete fields[field];
        }
        return view;
      };
      const callerFhir = {
        async read() {
          throw new Error("Unexpected FHIR read in communications API test.");
        },
        async search(_resourceType: string, params: Record<string, string> = {}) {
          if (params.category) {
            return {
              resourceType: "Bundle",
              type: "searchset",
              entry: options.callVisible === false ? [] : [{
                resource: {
                  resourceType: "Communication",
                  id: "call-communication-1",
                  status: "completed",
                  subject: { reference: PATIENT_REFERENCE },
                  identifier: [{
                    system: "https://odos2020.com/fhir/NamingSystem/twilio-call-sid",
                    value: CALL_ID,
                  }],
                },
              }],
            };
          }
          if (
            params.identifier?.startsWith("https://odos2020.com/fhir/NamingSystem/twilio-message-sid|")
            || params.identifier?.startsWith("https://odos2020.com/fhir/NamingSystem/ghl-message-id|")
          ) {
            const system = params.identifier.slice(0, params.identifier.lastIndexOf("|"));
            const value = params.identifier.slice(params.identifier.lastIndexOf("|") + 1);
            return {
              resourceType: "Bundle",
              type: "searchset",
              entry: persistedCommunications
                .filter((communication) => communication.identifier?.some((identifier) =>
                  identifier.system === system
                  && identifier.value === value))
                .map((resource) => ({ resource: callerView(resource) })),
            };
          }
          if (params.identifier?.startsWith("https://odos2020.com/fhir/NamingSystem/comms-staff-send|")) {
            const value = params.identifier.slice(params.identifier.lastIndexOf("|") + 1);
            return {
              resourceType: "Bundle",
              type: "searchset",
              entry: persistedCommunications
                .filter((communication) => communication.identifier?.some((identifier) =>
                  identifier.system === "https://odos2020.com/fhir/NamingSystem/comms-staff-send"
                  && identifier.value === value))
                .map((resource) => ({ resource: callerView(resource) })),
            };
          }
          if (params.identifier?.startsWith("https://odos2020.com/fhir/NamingSystem/twilio-call-sid|")) {
            return {
              resourceType: "Bundle",
              type: "searchset",
              entry: options.callVisible === false ? [] : [{
                resource: {
                  resourceType: "Communication",
                  id: "call-communication-1",
                  status: "completed",
                  subject: { reference: PATIENT_REFERENCE },
                  identifier: [{
                    system: "https://odos2020.com/fhir/NamingSystem/twilio-call-sid",
                    value: CALL_ID,
                  }],
                },
              }],
            };
          }
          return {
            resourceType: "Bundle",
            type: "searchset",
            entry: options.recordingVisible === false ? [] : [{
              resource: {
                resourceType: "Communication",
                id: "call-communication-1",
                status: "completed",
                subject: { reference: PATIENT_REFERENCE },
                identifier: [{
                  system: "https://odos2020.com/fhir/NamingSystem/twilio-recording-sid",
                  value: RECORDING_ID,
                }],
              },
            }],
          };
        },
        async searchUrl() {
          throw new Error("Unexpected FHIR pagination in communications API test.");
        },
        async create<T extends Resource>(resource: T): Promise<T> {
          const persisted = {
            ...resource,
            id: `persisted-${persistedCommunications.length + 1}`,
            meta: { ...resource.meta, versionId: "1" },
          } as T;
          if (persisted.resourceType === "Communication") {
            persistedCommunications.push(structuredClone(persisted as Communication));
          }
          return callerView(persisted);
        },
        async update<T extends Resource>(_resourceType: T["resourceType"], id: string, resource: T): Promise<T> {
          const index = persistedCommunications.findIndex((candidate) => candidate.id === id);
          if (
            resource.resourceType === "Communication"
            && !communicationUpdateAllowed
          ) {
            throw Object.assign(new Error("Synthetic AccessPolicy denied Communication update"), { status: 403 });
          }
          if (
            options.failSmsCompletion
            && resource.resourceType === "Communication"
            && resource.identifier?.some((identifier) =>
              identifier.system === "https://odos2020.com/fhir/NamingSystem/twilio-message-sid")
          ) {
            options.failSmsCompletion = false;
            throw Object.assign(new Error("Synthetic FHIR outage"), { status: 503 });
          }
          const restored = structuredClone(resource);
          if (restored.resourceType === "Communication" && index >= 0) {
            const fields = restored as unknown as Record<string, unknown>;
            const storedFields = persistedCommunications[index] as unknown as Record<string, unknown>;
            for (const field of hiddenFields) {
              if (fields[field] === undefined && storedFields[field] !== undefined) {
                fields[field] = structuredClone(storedFields[field]);
              }
            }
          }
          const persisted = {
            ...restored,
            id,
            meta: { ...resource.meta, versionId: String(Number(persistedCommunications[index]?.meta?.versionId ?? "0") + 1) },
          } as T;
          if (persisted.resourceType === "Communication" && index >= 0) {
            persistedCommunications[index] = structuredClone(persisted as Communication);
          }
          return callerView(persisted);
        },
      } as never;
      authenticatedFhirs.push(callerFhir);
      return {
        staffReference: `Practitioner/${role}`,
        actorRole: role as never,
        roles: [role as never],
        fhir: callerFhir,
      };
    },
    dispatch: {
      providers: () => options.providers ?? [options.providerName ?? "twilio"],
      providerFor: (role) => options.channelRoutes === undefined
        ? options.providerName ?? "twilio"
        : options.channelRoutes[role],
      getAdapter: (providerName, callerFhir) => {
        adapterProviders.push(providerName);
        adapterFhirs.push(callerFhir);
        return {
          ...provider,
          name: providerName,
          messageIdentifierSystem: providerName === "ghl"
            ? "https://odos2020.com/fhir/NamingSystem/ghl-message-id"
            : "https://odos2020.com/fhir/NamingSystem/twilio-message-sid",
        };
      },
      initialize: async () => undefined,
    },
    audit: {
      async record(row, operation) {
        const result = await operation();
        grants.push(row);
        return result;
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
    adapterProviders,
    callListRequests,
    listRequests,
    threadReadRequests,
    grants,
    denials,
    persistedCommunications,
    authenticatedFhirs,
    adapterFhirs,
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
