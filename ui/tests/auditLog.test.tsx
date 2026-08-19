import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  defaultAuditDateRange,
  fetchAuditLogRows,
  fetchPatientHistory,
  sampleAuditRows,
} from "../src/lib/audit-log";
import { AuditLog } from "../src/scenes/AuditLog";

test("audit log requests use the authenticated session and return the server-resolved role", async () => {
  let request: { url: string; headers: Record<string, string> } | undefined;
  const row = sampleAuditRows()[0]!;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    request = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
    };
    return new Response(JSON.stringify({ actorRole: "admin", rows: [row] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const response = await fetchAuditLogRows(
    {
      ...defaultAuditDateRange(new Date("2026-08-18T12:00:00.000Z")),
      eventTypes: [],
      breakGlassOnly: false,
    },
    { authorization: "Bearer verified-session", fetchImpl },
  );

  assert.equal(request?.headers.Authorization, "Bearer verified-session");
  assert.equal("X-ODOS-Role" in (request?.headers ?? {}), false);
  assert.equal("X-ODOS-Actor-Id" in (request?.headers ?? {}), false);
  assert.equal(response.actorRole, "admin");
  assert.deepEqual(response.rows.map((auditRow) => auditRow.id), [row.id]);
});

test("a denied audit response still carries the authenticated role for display", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({
    error: "audit.read role required",
    actorRole: "staff",
  }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch;

  await assert.rejects(
    () => fetchAuditLogRows({
      ...defaultAuditDateRange(new Date("2026-08-18T12:00:00.000Z")),
      eventTypes: [],
      breakGlassOnly: false,
    }, { fetchImpl }),
    (error: unknown) => {
      assert.equal((error as { actorRole?: string }).actorRole, "staff");
      assert.match((error as Error).message, /403/);
      return true;
    },
  );
});

test("patient History requests the authenticated patient-scoped change view", async () => {
  let request: { url: string; headers: Record<string, string> } | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: String(url), headers: init?.headers as Record<string, string> };
    return new Response(JSON.stringify({ actorRole: "staff", rows: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const response = await fetchPatientHistory("patient/with spaces", {
    authorization: "Bearer verified-session",
    fetchImpl,
  });

  const url = new URL(request!.url, "http://odos.test");
  assert.equal(url.searchParams.get("scope"), "patient-history");
  assert.equal(url.searchParams.get("patient_id"), "patient/with spaces");
  assert.equal(request?.headers.Authorization, "Bearer verified-session");
  assert.equal(response.actorRole, "staff");
  assert.deepEqual(response.rows, []);
});

test("Audit Log displays the authenticated role returned by the server instead of the URL role", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let requests = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search: "?role=provider" } },
  });
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(JSON.stringify({ actorRole: "admin", rows: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<AuditLog />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const text = renderer.root.findAllByType("p").map((node) => node.children.join("")).join(" ");
    assert.equal(requests, 1);
    assert.match(text, /Role: admin/);
    assert.equal(renderer.root.findAll((node) => node.children.join("") === "Audit log unavailable").length, 0);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});
