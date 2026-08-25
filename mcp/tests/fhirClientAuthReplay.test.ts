import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy, Bundle, ChargeItemDefinition, OperationOutcome, Patient, ProjectMembership } from "@medplum/fhirtypes";
import type { OdosAuditEventRecord } from "../src/authz/odosAudit.js";
import {
  createMedplumClient,
  createOperatorScriptFhirClient,
  type MedplumClient,
} from "../src/fhir-client.js";
import { searchProjectAll } from "../src/fhir-search.js";
import { TEST_FHIR_AUDIT_CONTEXT, TEST_FHIR_AUDIT_RECORDER } from "./fhirAuditTestStub.js";

test("operator-script FHIR client leaves Medplum extended mode off by default", async () => {
  const originalFetch = globalThis.fetch;
  let extendedHeader: string | null | undefined;
  globalThis.fetch = async (_input, init) => {
    extendedHeader = new Headers(init?.headers).get("X-Medplum");
    return Response.json({ resourceType: "Patient", id: "p1" });
  };
  try {
    const client = createOperatorScriptFhirClient({
      baseUrl: "http://medplum.test",
      accessToken: "operator-token",
      reason: "Test the operator-script client default header behavior.",
    });

    await client.read<Patient>("Patient", "p1");

    assert.equal(extendedHeader, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed FHIR requests name the method and safe path without exposing the resource id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Forbidden", {
    status: 403,
    statusText: "Forbidden",
  });
  try {
    const client = createOperatorScriptFhirClient({
      baseUrl: "http://medplum.test",
      accessToken: "operator-token",
      reason: "Test safe FHIR failure context.",
    });

    await assert.rejects(
      client.read<Patient>("Patient", "patient-sensitive-123"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /FHIR GET \/fhir\/R4\/Patient\/:id \[Patient\] 403 Forbidden: Forbidden/);
        assert.doesNotMatch(error.message, /patient-sensitive-123|operator-token/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("project-scoped search uses Medplum extended mode and cannot be widened by caller parameters", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let extendedHeader: string | null | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    extendedHeader = new Headers(init?.headers).get("X-Medplum");
    return Response.json({ resourceType: "Bundle", type: "searchset" });
  };
  try {
    const client = createMedplumClient({
      baseUrl: "http://medplum.test",
      accessToken: "service-token",
      audit: TEST_FHIR_AUDIT_RECORDER,
      auditContext: TEST_FHIR_AUDIT_CONTEXT,
    });

    await client.searchProject<AccessPolicy>("AccessPolicy", "practice-1", {
      "name:exact": "ODOS Provider + Staff",
      _project: "wrong-project",
    });

    const url = new URL(requestedUrl);
    assert.equal(url.pathname, "/fhir/R4/AccessPolicy");
    assert.equal(url.searchParams.get("name:exact"), "ODOS Provider + Staff");
    assert.equal(url.searchParams.get("_project"), "practice-1");
    assert.equal(extendedHeader, "extended");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("project-scoped search preserves its project boundary and extended mode across pagination", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; extendedHeader: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, extendedHeader: new Headers(init?.headers).get("X-Medplum") });
    if (requests.length === 1) {
      return Response.json({
        resourceType: "Bundle",
        type: "searchset",
        link: [{
          relation: "next",
          url: "http://medplum.test/fhir/R4/AccessPolicy?_project=practice-1&_cursor=next",
        }],
      });
    }
    return Response.json({ resourceType: "Bundle", type: "searchset" });
  };
  try {
    const client = createMedplumClient({
      baseUrl: "http://medplum.test",
      accessToken: "service-token",
      audit: TEST_FHIR_AUDIT_RECORDER,
      auditContext: TEST_FHIR_AUDIT_CONTEXT,
    });

    assert.deepEqual(
      await searchProjectAll<AccessPolicy>(client, "AccessPolicy", "practice-1", {
        "name:exact": "ODOS Provider + Staff",
      }),
      [],
    );
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(({ extendedHeader }) => extendedHeader), ["extended", "extended"]);
    assert.deepEqual(
      requests.map(({ url }) => new URL(url).searchParams.get("_project")),
      ["practice-1", "practice-1"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("project-scoped pagination rejects a next link that changes projects", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    resourceType: "Bundle",
    type: "searchset",
    link: [{
      relation: "next",
      url: "http://medplum.test/fhir/R4/AccessPolicy?_project=other-practice&_cursor=next",
    }],
  });
  try {
    const client = createMedplumClient({
      baseUrl: "http://medplum.test",
      accessToken: "service-token",
      audit: TEST_FHIR_AUDIT_RECORDER,
      auditContext: TEST_FHIR_AUDIT_CONTEXT,
    });

    await assert.rejects(
      searchProjectAll<AccessPolicy>(client, "AccessPolicy", "practice-1"),
      /changed or removed the project boundary/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FHIR client forces one re-login and replays a 401 once for every service operation", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization?: string }> = [];
  const oldToken = jwt({ exp: 4_102_444_800, jti: "old" });
  const freshToken = jwt({ exp: 4_102_444_800, jti: "fresh" });
  let fhirAttempts = 0;
  let tokenExchanges = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") ?? undefined });
    if (url.endsWith("/auth/login")) return Response.json({ code: "login-code" });
    if (url.endsWith("/oauth2/token")) {
      tokenExchanges += 1;
      return Response.json({ access_token: tokenExchanges === 1 ? oldToken : freshToken });
    }
    fhirAttempts += 1;
    if (fhirAttempts === 1) return new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });
    return Response.json({ resourceType: "Patient", id: "p1" }, { headers: { "Content-Type": "application/fhir+json" } });
  };
  try {
    const client: MedplumClient = createMedplumClient({
      baseUrl: "http://medplum.test",
      now: () => Date.parse("2026-07-12T00:00:00Z"),
      audit: TEST_FHIR_AUDIT_RECORDER,
      auditContext: TEST_FHIR_AUDIT_CONTEXT,
    });
    await client.login("service@example.test", "test-password");
    const patient = await client.read<Patient>("Patient", "p1");
    assert.equal(patient.id, "p1");
    assert.equal(tokenExchanges, 2);
    assert.equal(fhirAttempts, 2);
    assert.equal(calls.at(-1)?.authorization, `Bearer ${freshToken}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FHIR client proactively re-authenticates within five minutes of token expiry", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.parse("2026-07-12T00:00:00Z");
  const freshToken = jwt({ exp: Math.floor(now / 1000) + 3600 });
  const expiringToken = jwt({ exp: Math.floor(now / 1000) + 299 });
  const authorizations: Array<string | undefined> = [];
  let tokenExchanges = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/auth/login")) return Response.json({ code: "login-code" });
    if (url.endsWith("/oauth2/token")) {
      tokenExchanges += 1;
      return Response.json({ access_token: tokenExchanges === 1 ? expiringToken : freshToken });
    }
    authorizations.push(new Headers(init?.headers).get("authorization") ?? undefined);
    return Response.json({ resourceType: "Patient", id: "p1" });
  };
  try {
    const client: MedplumClient = createMedplumClient({
      baseUrl: "http://medplum.test",
      now: () => now,
      audit: TEST_FHIR_AUDIT_RECORDER,
      auditContext: TEST_FHIR_AUDIT_CONTEXT,
    });
    await client.login("service@example.test", "test-password");
    await client.read<Patient>("Patient", "p1");
    assert.equal(tokenExchanges, 2);
    assert.deepEqual(authorizations, [`Bearer ${freshToken}`]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FHIR conditional create reports 201 as created and 200 as an existing match", async () => {
  const originalFetch = globalThis.fetch;
  const statuses = [201, 200];
  globalThis.fetch = async () => Response.json({
    resourceType: "ChargeItemDefinition",
    id: "definition-1",
    url: "https://odos2020.com/test",
    version: "1",
    status: "active",
  }, { status: statuses.shift() });
  try {
    const client = createMedplumClient({
      baseUrl: "http://medplum.test",
      accessToken: "practice-admin-token",
      audit: TEST_FHIR_AUDIT_RECORDER,
      auditContext: TEST_FHIR_AUDIT_CONTEXT,
    });
    const definition: ChargeItemDefinition = {
      resourceType: "ChargeItemDefinition",
      url: "https://odos2020.com/test",
      version: "1",
      status: "active",
    };
    const created = await client.createWithOutcome(definition, { "If-None-Exist": "identifier=system|key" });
    const matched = await client.createWithOutcome(definition, { "If-None-Exist": "identifier=system|key" });
    assert.equal(created.created, true);
    assert.equal(matched.created, false);
    assert.equal(created.resource.id, "definition-1");
    assert.equal(matched.resource.id, "definition-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("practitioner invite recovers the created membership when Medplum returns an email-delivery OperationOutcome", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const emailOutcome: OperationOutcome = {
    resourceType: "OperationOutcome",
    id: "ok",
    issue: [{
      severity: "error",
      code: "exception",
      details: { text: "Could not send email. Make sure you have AWS SES set up." },
      diagnostics: "Error sending email: Could not load credentials from any providers",
    }],
    extension: [{
      url: "https://medplum.com/fhir/StructureDefinition/tracing",
      extension: [
        { url: "requestId", valueId: "11111111-1111-4111-8111-111111111111" },
        { url: "traceId", valueId: "22222222-2222-4222-8222-222222222222" },
      ],
    }],
  };
  const membership: ProjectMembership = {
    resourceType: "ProjectMembership",
    id: "membership-created-before-email-failure",
    meta: { versionId: "1" },
    project: { reference: "Project/practice-1" },
    user: { reference: "User/invitee-1" },
    profile: { reference: "Practitioner/invitee-1" },
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/admin/projects/practice-1/invite")) {
      return Response.json(emailOutcome);
    }
    if (url.includes("/fhir/R4/Practitioner?")) {
      const search = new URL(url).searchParams;
      assert.equal(search.get("email"), "new.clinician@example.test");
      return Response.json({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: {
          resourceType: "Practitioner",
          id: "invitee-1",
          telecom: [{ system: "email", value: "new.clinician@example.test" }],
        } }],
      });
    }
    if (url.includes("/fhir/R4/ProjectMembership?")) {
      const search = new URL(url).searchParams;
      assert.equal(search.get("profile"), "Practitioner/invitee-1");
      assert.equal(search.get("project"), "Project/practice-1");
      return Response.json({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: membership }],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const client = createMedplumClient({
      baseUrl: "http://medplum.test",
      accessToken: "practice-admin-token",
      audit: TEST_FHIR_AUDIT_RECORDER,
      auditContext: TEST_FHIR_AUDIT_CONTEXT,
    });
    const result = await client.invitePractitioner("practice-1", {
      resourceType: "Practitioner",
      email: "new.clinician@example.test",
      firstName: "New",
      lastName: "Clinician",
      sendEmail: true,
    });
    assert.equal(result.id, "membership-created-before-email-failure");
    assert.equal(result.meta?.versionId, "1");
    assert.deepEqual(calls.map((call) => call.split(" ", 1)[0]), ["POST", "GET", "GET"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("practitioner invite rejects an unrecognized successful response instead of casting it as a membership", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    membership: {
      resourceType: "ProjectMembership",
      id: "unexpected-wrapper-membership",
      meta: { versionId: "1" },
    },
  });
  try {
    const client = createMedplumClient({
      baseUrl: "http://medplum.test",
      accessToken: "practice-admin-token",
      audit: TEST_FHIR_AUDIT_RECORDER,
      auditContext: TEST_FHIR_AUDIT_CONTEXT,
    });
    await assert.rejects(
      client.invitePractitioner("practice-1", {
        resourceType: "Practitioner",
        email: "new.clinician@example.test",
        firstName: "New",
        lastName: "Clinician",
        sendEmail: true,
      }),
      /Medplum practitioner invite returned an unrecognized successful response/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FHIR transaction can disable staff-token compensation without weakening the default", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method: string; authorization?: string }> = [];
  globalThis.fetch = async (_input, init) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      authorization: new Headers(init?.headers).get("authorization") ?? undefined,
    });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return Response.json(mixedTransactionResponse());
  };
  try {
    const client = createMedplumClient({
      baseUrl: "http://medplum.test",
      accessToken: "ordinary-clinician-token",
      audit: TEST_FHIR_AUDIT_RECORDER,
      auditContext: TEST_FHIR_AUDIT_CONTEXT,
    });

    await client.executeTransaction(transactionRequest(), {}, { autoRollbackCreatedEntries: false });

    assert.deepEqual(calls, [{ method: "POST", authorization: "Bearer ordinary-clinician-token" }]);

    calls.length = 0;
    await client.executeTransaction(transactionRequest());
    assert.deepEqual(calls.map((call) => call.method), ["POST", "DELETE"]);
    assert.equal(calls[1]?.authorization, "Bearer ordinary-clinician-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("service transaction actor override emits one human-attributed audit row", async () => {
  const originalFetch = globalThis.fetch;
  const auditRows: OdosAuditEventRecord[] = [];
  globalThis.fetch = async () => Response.json({
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [{ response: { status: "201 Created", location: "Condition/condition-1" } }],
  });
  try {
    const client = createMedplumClient({
      baseUrl: "http://medplum.test",
      accessToken: "service-token",
      audit: {
        record: async (row, operation) => {
          auditRows.push(row);
          return operation();
        },
        recordDenied: async () => undefined,
      },
      auditContext: { actorId: "odos-mcp", actorRole: "system" },
    });

    await client.executeTransactionAsActor(
      transactionRequest(),
      {
        actorReference: "Practitioner/staff-1",
        actorRole: "staff",
        actionReason: "patients.register service transaction",
      },
      {},
      { autoRollbackCreatedEntries: false },
    );

    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0]?.eventType, "transaction");
    assert.equal(auditRows[0]?.actorId, "staff-1");
    assert.equal(auditRows[0]?.actorRole, "staff");
    assert.equal(auditRows[0]?.resourceType, "Condition");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function transactionRequest(): Bundle {
  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: [{
      fullUrl: "urn:uuid:00000000-0000-4000-8000-000000000001",
      resource: { resourceType: "Condition" } as never,
      request: { method: "POST", url: "Condition" },
    }],
  };
}

function mixedTransactionResponse(): Bundle {
  return {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [{
      resource: { resourceType: "Condition", id: "created-condition" } as never,
      response: { status: "201 Created", location: "Condition/created-condition" },
    }, {
      response: { status: "412 Precondition Failed" },
    }],
  };
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}
