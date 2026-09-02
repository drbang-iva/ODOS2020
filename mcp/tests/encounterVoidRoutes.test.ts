import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Bundle, OperationOutcome } from "@medplum/fhirtypes";
import express from "express";
import { registerEncounterVoidRoutes } from "../src/clinical-graph/encounter-void-routes.js";
import { AUTH, cvf, fixture, type MemoryFhir } from "./encounterVoidFixture.js";

// ---------------------------------------------------------------------------
// The void route at its real boundary: the bytes Express sends, and the arguments the
// route hands its logger. Everything below drives the registered route over HTTP through the
// same in-memory FHIR fake the endpoint suites use, with Medplum's NON-strict transaction
// behaviour (no `transaction-bundles` feature): a refused entry comes back inside the
// transaction-response and every other entry is applied.
//
// Strings tagged SENTINEL stand in for clinical detail an OperationOutcome or a resource id
// may carry. They must reach the log and must never reach the response body.
// ---------------------------------------------------------------------------

const OUTCOME_SENTINEL = "SENTINEL-CLINICAL-DETAIL Observation.status preliminary -> entered-in-error refused";
const REFUSED_ID = "obs-refused-SENTINEL-ID";
const REFUSED_URL = `Observation/${REFUSED_ID}`;
const OK_ID = "obs-ok";

function outcome(code: string, diagnostics: string): OperationOutcome {
  return { resourceType: "OperationOutcome", issue: [{ severity: "error", code, details: { text: "Forbidden" }, diagnostics }] };
}

test("PHI boundary at the HTTP seam: the serialized response carries no resource id and no outcome text; the log carries both", async () => {
  const server = await voidServer({
    refuse: (entry) => entry.request?.url === REFUSED_URL ? { status: "403 Forbidden", outcome: outcome("forbidden", OUTCOME_SENTINEL) } : undefined,
  });
  try {
    const response = await postVoid(server.baseUrl, { scope: "encounter" });
    const text = await response.text();

    assert.equal(response.status, 502, text);
    assert.ok(!text.includes("SENTINEL"), `response body leaks server-only detail: ${text}`);
    assert.ok(!text.includes(REFUSED_ID), `response body leaks a resource id: ${text}`);
    const body = JSON.parse(text) as Record<string, unknown>;
    const refusedIndex = server.fhir.transactions[0]!.entry!.findIndex((entry) => entry.request?.url === REFUSED_URL);
    assert.ok(refusedIndex >= 0, "the refused entry was part of the transaction");
    assert.equal(body.code, "void-transaction-failed");
    assert.equal(body.failedEntryIndex, refusedIndex);
    assert.equal(body.failedResourceType, "Observation");
    assert.equal(body.failedStatus, 403);
    assert.equal(body.failedCount, 1);

    // …and the server log has everything the response may not carry.
    const logged = server.logged();
    assert.ok(logged.includes(OUTCOME_SENTINEL), `log is missing the outcome text: ${logged}`);
    assert.ok(logged.includes(REFUSED_URL), `log is missing the refused entry's url: ${logged}`);
    assert.ok(logged.includes(`entry ${refusedIndex} of`), `log is missing the entry index: ${logged}`);
    assert.ok(logged.includes("Encounter/e1"), `log is missing the encounter: ${logged}`);
  } finally {
    await server.close();
  }
});

test("APPLIED-PARTIAL is distinguished from APPLIED-NONE in what the client receives", async () => {
  const partial = await voidServer({
    refuse: (entry) => entry.request?.url === REFUSED_URL ? { status: "403 Forbidden", outcome: outcome("forbidden", "refused") } : undefined,
  });
  try {
    const body = await (await postVoid(partial.baseUrl, { scope: "encounter" })).json() as Record<string, unknown>;
    const changes = partial.fhir.transactions[0]!.entry!.filter((entry) => entry.request?.method !== "POST").length;
    assert.equal(body.outcome, "applied-partial");
    assert.equal(body.changeCount, changes);
    assert.equal(body.appliedCount, changes - 1, "every durable write but the refused one was applied");
    assert.match(String(body.error), /only partly applied/);
    assert.match(String(body.error), new RegExp(`${changes - 1} of ${changes} changes were saved`));
    assert.doesNotMatch(String(body.error), /Nothing was cleared/);
    // The stack really did apply the rest: this is the state the message describes.
    assert.equal(partial.fhir.get<{ status?: string }>("Observation", OK_ID).status, "entered-in-error");
    assert.equal(partial.fhir.get<{ status?: string }>("Observation", REFUSED_ID).status, "final");
  } finally {
    await partial.close();
  }

  const none = await voidServer({ refuse: () => ({ status: "403 Forbidden", outcome: outcome("forbidden", "refused") }) });
  try {
    const body = await (await postVoid(none.baseUrl, { scope: "encounter" })).json() as Record<string, unknown>;
    assert.equal(body.outcome, "applied-none");
    assert.equal(body.appliedCount, 0);
    assert.match(String(body.error), /^Nothing was cleared/);
    assert.doesNotMatch(String(body.error), /partly/);
    assert.equal(none.fhir.get<{ status?: string }>("Observation", OK_ID).status, "final");
  } finally {
    await none.close();
  }
});

test("a per-entry 412 keeps its entry-level detail and is not reported as a plain concurrent-edit retry", async () => {
  const server = await voidServer({
    refuse: (entry) => entry.request?.url === REFUSED_URL ? { status: "412 Precondition Failed", outcome: outcome("conflict", "version mismatch") } : undefined,
  });
  try {
    const response = await postVoid(server.baseUrl, { scope: "encounter" });
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 502, JSON.stringify(body));
    assert.notEqual(body.code, "concurrent-edit");
    assert.equal(body.code, "void-transaction-failed");
    assert.equal(body.failedStatus, 412);
    assert.equal(body.failedResourceType, "Observation");
    assert.equal(body.outcome, "applied-partial");
    assert.doesNotMatch(String(body.error), /reapply/i, "reload-and-reapply is only safe when nothing applied");
    assert.match(String(body.error), /only partly applied/);
    assert.ok(server.logged().includes("HTTP 412"), "the 412 is logged with its entry detail");
  } finally {
    await server.close();
  }
});

test("a statusless failure is reported as INDETERMINATE, never as a rejection before the server", async () => {
  const server = await voidServer({ transaction: async () => { throw new Error("fetch failed: socket hang up"); } });
  try {
    const response = await postVoid(server.baseUrl, { scope: "encounter" });
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 502, JSON.stringify(body));
    assert.equal(body.code, "void-transaction-unanswered");
    assert.equal(body.outcome, "indeterminate");
    assert.match(String(body.error), /Could not confirm what this clear saved/);
    assert.match(String(body.error), /may have been applied/);
    assert.doesNotMatch(String(body.error), /rejected|before the FHIR server answered|Nothing was cleared/);
    assert.ok(server.logged().includes("socket hang up"), "the transport detail is logged");
  } finally {
    await server.close();
  }
});

test("an HTTP 5xx from the record server is INDETERMINATE; a 4xx before processing is APPLIED-NONE", async () => {
  const failing = await voidServer({ transaction: async () => { throw Object.assign(new Error("FHIR POST 503 Service Unavailable: overloaded"), { status: 503 }); } });
  try {
    const body = await (await postVoid(failing.baseUrl, { scope: "encounter" })).json() as Record<string, unknown>;
    assert.equal(body.code, "void-transaction-rejected");
    assert.equal(body.outcome, "indeterminate");
    assert.equal(body.httpStatus, 503);
    assert.match(String(body.error), /Could not confirm what this clear saved/);
  } finally {
    await failing.close();
  }

  const refusing = await voidServer({ transaction: async () => { throw Object.assign(new Error("FHIR POST 400 Bad Request: too many entries"), { status: 400 }); } });
  try {
    const body = await (await postVoid(refusing.baseUrl, { scope: "encounter" })).json() as Record<string, unknown>;
    assert.equal(body.code, "void-transaction-rejected");
    assert.equal(body.outcome, "applied-none");
    assert.equal(body.httpStatus, 400);
    assert.match(String(body.error), /^Nothing was cleared/);
  } finally {
    await refusing.close();
  }
});

test("an outright 412 from the record server is still the atomic concurrent-edit answer", async () => {
  const server = await voidServer({ transaction: async () => { throw Object.assign(new Error("FHIR POST 412 Precondition Failed"), { status: 412 }); } });
  try {
    const response = await postVoid(server.baseUrl, { scope: "encounter" });
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.code, "concurrent-edit");
  } finally {
    await server.close();
  }
});

test("a clean void passes through the route as 200 with the endpoint's summary", async () => {
  const server = await voidServer({});
  try {
    const response = await postVoid(server.baseUrl, { scope: "encounter" });
    const body = await response.json() as { count: number };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.count, 2);
    assert.equal(server.logged(), "");
  } finally {
    await server.close();
  }
});

test("an unexpected route error still answers the generic 500 and logs the error", async () => {
  const server = await voidServer({ routeDepsError: new Error("finding definitions unavailable SENTINEL") });
  try {
    const response = await postVoid(server.baseUrl, { scope: "encounter" });
    const text = await response.text();
    assert.equal(response.status, 500, text);
    assert.deepEqual(JSON.parse(text), { error: "encounter void route failed" });
    assert.ok(server.logged().includes("finding definitions unavailable SENTINEL"));
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Harness — the same shape as the other route suites: express + an ephemeral listener + fetch.
// ---------------------------------------------------------------------------

async function voidServer(options: {
  refuse?: MemoryFhir["refuse"];
  transaction?: (bundle: Bundle) => Promise<Bundle>;
  routeDepsError?: Error;
}) {
  const { deps, fhir } = fixture();
  fhir.add(cvf(REFUSED_ID, "OD"));
  fhir.add(cvf(OK_ID, "OS"));
  if (options.refuse) fhir.refuse = options.refuse;
  if (options.transaction) fhir.executeTransaction = options.transaction;
  const logs: unknown[][] = [];
  const app = express();
  app.use(express.json());
  registerEncounterVoidRoutes(
    app,
    async () => undefined,
    async () => {
      if (options.routeDepsError) throw options.routeDepsError;
      return deps;
    },
    { log: (...args: unknown[]) => { logs.push(args); } },
  );
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    fhir,
    logged: () => logs.map((args) => args.map((arg) =>
      typeof arg === "string" ? arg : arg instanceof Error ? `${arg.name}: ${arg.message}` : JSON.stringify(arg)
    ).join(" ")).join("\n"),
    close: () => new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())),
  };
}

function postVoid(baseUrl: string, body: unknown, authorization: string = AUTH): Promise<Response> {
  return fetch(`${baseUrl}/clinical-graph/encounters/e1/void`, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
