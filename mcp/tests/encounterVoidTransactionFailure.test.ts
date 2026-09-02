import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, OperationOutcome } from "@medplum/fhirtypes";
import {
  VoidTransactionError,
  assertSuccessfulTransaction,
  handleEncounterVoidRequest,
} from "../src/clinical-graph/encounter-void-endpoint.js";
import { AUTH, cvf, fixture } from "./encounterVoidFixture.js";

// ---------------------------------------------------------------------------
// The void error must carry its own evidence.
//
// Medplum answers a transaction one of two ways. Without the `transaction-bundles` project
// feature (ODOS never sets it) a refused entry comes back INSIDE a 200 transaction-response
// with its own status and OperationOutcome; with the feature on, the whole request is refused
// with one HTTP status. Both must name what was refused. The 2026-09-02 walkthrough failed
// on the first shape and the endpoint threw away everything but the status code.
//
// Every string below tagged SENTINEL stands in for clinical detail an OperationOutcome may
// carry. It must reach the server log and must never reach the HTTP response body.
// ---------------------------------------------------------------------------

const OUTCOME_SENTINEL = "SENTINEL-CLINICAL-DETAIL Observation.status preliminary -> entered-in-error refused";

function forbidden(diagnostics: string): OperationOutcome {
  return {
    resourceType: "OperationOutcome",
    issue: [{ severity: "error", code: "forbidden", details: { text: "Forbidden" }, diagnostics }],
  };
}

function request(): Bundle {
  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      { request: { method: "PUT", url: "Observation/obs-first-SENTINEL-ID" } },
      { request: { method: "POST", url: "Provenance" } },
      { request: { method: "PUT", url: "Observation/obs-refused-SENTINEL-ID" } },
      { request: { method: "PUT", url: "Encounter/e1" } },
    ],
  };
}

function ok(status: string): NonNullable<Bundle["entry"]>[number] {
  return { response: { status } };
}

test("a refused entry is identified by index, request method + url, status, and outcome text, with the failing count", () => {
  const response: Bundle = {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [
      ok("200 OK"),
      ok("201 Created"),
      { response: { status: "403 Forbidden", outcome: forbidden(OUTCOME_SENTINEL) } },
      { response: { status: "403 Forbidden", outcome: forbidden("second refusal") } },
    ],
  };

  const error = captureThrow(() => assertSuccessfulTransaction(request(), response));

  assert.ok(error instanceof VoidTransactionError, `expected VoidTransactionError, got ${String(error)}`);
  assert.equal(error.diagnostics.kind, "entry-failed");
  if (error.diagnostics.kind !== "entry-failed") return;
  assert.equal(error.diagnostics.entryCount, 4);
  assert.equal(error.diagnostics.failedCount, 2, "both refused entries are counted, not just the first");
  assert.deepEqual(error.diagnostics.firstFailure, {
    index: 2,
    method: "PUT",
    url: "Observation/obs-refused-SENTINEL-ID",
    status: 403,
    outcome: `Forbidden: ${OUTCOME_SENTINEL} (forbidden)`,
  });
  assert.equal(error.diagnostics.failures.length, 2);
  assert.equal(error.diagnostics.failures[1]?.index, 3);
  // The one log line: everything a reader needs to close the case without a second investigation.
  assert.match(error.message, /entry 2 of 4/);
  assert.match(error.message, /PUT Observation\/obs-refused-SENTINEL-ID/);
  assert.match(error.message, /403/);
  assert.match(error.message, /2 of 4 entries failed/);
  assert.ok(error.message.includes(OUTCOME_SENTINEL), "the outcome text is in the log line");
  // `status` mirrors the first refusal so the endpoint's existing conflict detection keeps working.
  assert.equal(error.status, 403);
});

test("PHI boundary: the client body carries index, resource type, status, and a stable code, never ids or outcome text", () => {
  const response: Bundle = {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [ok("200 OK"), ok("201 Created"), { response: { status: "403 Forbidden", outcome: forbidden(OUTCOME_SENTINEL) } }, ok("200 OK")],
  };

  const error = captureThrow(() => assertSuccessfulTransaction(request(), response));
  assert.ok(error instanceof VoidTransactionError);

  assert.deepEqual(error.clientBody, {
    error: "Void transaction failed at entry 2 of 4 (PUT Observation, HTTP 403); 1 of 4 entries failed.",
    code: "void-transaction-failed",
    failedEntryIndex: 2,
    failedResourceType: "Observation",
    failedStatus: 403,
    failedCount: 1,
    entryCount: 4,
  });
  const serialized = JSON.stringify(error.clientBody);
  assert.ok(!serialized.includes("SENTINEL"), `client body leaks server-only detail: ${serialized}`);
  assert.ok(!serialized.includes("obs-refused"), `client body leaks a resource id: ${serialized}`);
  // …while the server-side detail keeps all of it.
  const logged = `${error.message} ${JSON.stringify(error.diagnostics)}`;
  assert.ok(logged.includes(OUTCOME_SENTINEL));
  assert.ok(logged.includes("Observation/obs-refused-SENTINEL-ID"));
});

test("an incomplete transaction response reports entries sent vs returned and what came back instead", () => {
  const response: Bundle = { resourceType: "Bundle", type: "batch-response", entry: [ok("200 OK")] };

  const error = captureThrow(() => assertSuccessfulTransaction(request(), response));

  assert.ok(error instanceof VoidTransactionError, `expected VoidTransactionError, got ${String(error)}`);
  assert.deepEqual(error.diagnostics, {
    kind: "incomplete-response",
    entryCount: 4,
    returnedEntries: 1,
    responseType: "Bundle/batch-response",
  });
  assert.match(error.message, /sent 4 entries/);
  assert.match(error.message, /received 1/);
  assert.match(error.message, /Bundle\/batch-response/);
  assert.deepEqual(error.clientBody, {
    error: "Void did not return a complete transaction response: sent 4 entries, received 1 (Bundle/batch-response).",
    code: "void-transaction-incomplete",
    entryCount: 4,
    returnedEntries: 1,
  });
  assert.equal(error.status, undefined, "no entry status to mirror");
});

test("a non-Bundle response body is named by its resourceType", () => {
  const notABundle = { resourceType: "OperationOutcome", issue: [] } as unknown as Bundle;
  const error = captureThrow(() => assertSuccessfulTransaction(request(), notABundle));
  assert.ok(error instanceof VoidTransactionError);
  assert.equal(error.diagnostics.kind, "incomplete-response");
  if (error.diagnostics.kind !== "incomplete-response") return;
  assert.equal(error.diagnostics.responseType, "OperationOutcome");
  assert.equal(error.diagnostics.returnedEntries, 0);
});

test("a clean transaction-response passes", () => {
  const response: Bundle = {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [ok("200 OK"), ok("201 Created"), ok("200 OK"), ok("200 OK")],
  };
  assert.doesNotThrow(() => assertSuccessfulTransaction(request(), response));
});

// ---------------------------------------------------------------------------
// Through the endpoint
// ---------------------------------------------------------------------------

test("the endpoint surfaces a refused entry as a VoidTransactionError the route can log and answer from", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("o1", "OD"));
  fhir.executeTransaction = async (bundle: Bundle): Promise<Bundle> => ({
    resourceType: "Bundle",
    type: "transaction-response",
    entry: (bundle.entry ?? []).map((entry, index) =>
      index === 0
        ? { response: { status: "403 Forbidden", outcome: forbidden(OUTCOME_SENTINEL) } }
        : ok(entry.request?.method === "POST" ? "201 Created" : "200 OK")
    ),
  });

  await assert.rejects(
    handleEncounterVoidRequest(deps, {
      authHeader: AUTH,
      params: { encounterId: "e1" },
      body: { scope: "observation", observationReference: "Observation/o1" },
    }),
    (error: unknown) => {
      assert.ok(error instanceof VoidTransactionError, `expected VoidTransactionError, got ${String(error)}`);
      assert.equal(error.diagnostics.kind, "entry-failed");
      if (error.diagnostics.kind !== "entry-failed") return false;
      assert.equal(error.diagnostics.firstFailure.url, "Observation/o1");
      assert.equal(error.diagnostics.firstFailure.method, "PUT");
      assert.equal(error.clientBody.failedResourceType, "Observation");
      assert.equal(error.clientBody.failedEntryIndex, 0);
      return true;
    },
  );
});

test("a per-entry 412 inside the transaction-response is a concurrent edit, not a route failure", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("o1", "OD"));
  fhir.executeTransaction = async (bundle: Bundle): Promise<Bundle> => ({
    resourceType: "Bundle",
    type: "transaction-response",
    entry: (bundle.entry ?? []).map((entry, index) =>
      index === 0
        ? { response: { status: "412 Precondition Failed", outcome: forbidden("version mismatch") } }
        : ok(entry.request?.method === "POST" ? "201 Created" : "200 OK")
    ),
  });

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "observation", observationReference: "Observation/o1" },
  });

  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal((result.body as { code?: string }).code, "concurrent-edit");
});

test("a request the FHIR server refuses outright is reported with its status, the upstream detail, and what was sent", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("o1", "OD"));
  fhir.executeTransaction = async (): Promise<Bundle> => {
    throw Object.assign(new Error(`FHIR POST /fhir/R4 [Bundle] 403 Forbidden: ${OUTCOME_SENTINEL}`), { status: 403 });
  };

  await assert.rejects(
    handleEncounterVoidRequest(deps, {
      authHeader: AUTH,
      params: { encounterId: "e1" },
      body: { scope: "observation", observationReference: "Observation/o1" },
    }),
    (error: unknown) => {
      assert.ok(error instanceof VoidTransactionError, `expected VoidTransactionError, got ${String(error)}`);
      assert.equal(error.diagnostics.kind, "request-rejected");
      if (error.diagnostics.kind !== "request-rejected") return false;
      assert.equal(error.diagnostics.status, 403);
      assert.ok(error.diagnostics.detail.includes(OUTCOME_SENTINEL));
      // Observation PUT + its Provenance POST + Encounter PUT + the Undo ledger row.
      assert.equal(error.diagnostics.entryCount, 4);
      assert.deepEqual(error.diagnostics.entries[0], { index: 0, method: "PUT", url: "Observation/o1" });
      assert.deepEqual(error.clientBody, {
        error: "Void transaction rejected by the FHIR server (HTTP 403) before any entry was answered; 4 entries were sent.",
        code: "void-transaction-rejected",
        failedStatus: 403,
        entryCount: 4,
      });
      assert.ok(!JSON.stringify(error.clientBody).includes("SENTINEL"));
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test("an outright 412 from the FHIR server is still a concurrent edit", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("o1", "OD"));
  fhir.executeTransaction = async (): Promise<Bundle> => {
    throw Object.assign(new Error("FHIR POST /fhir/R4 [Bundle] 412 Precondition Failed: version mismatch"), { status: 412 });
  };

  const result = await handleEncounterVoidRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { scope: "observation", observationReference: "Observation/o1" },
  });

  assert.equal(result.status, 409, JSON.stringify(result.body));
});

function captureThrow(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail("expected a throw");
}
