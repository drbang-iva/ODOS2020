import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, OperationOutcome } from "@medplum/fhirtypes";
import {
  VoidTransactionError,
  assertSuccessfulTransaction,
  classifyVoidTransactionFailure,
  handleEncounterVoidRequest,
} from "../src/clinical-graph/encounter-void-endpoint.js";
import { AUTH, cvf, fixture } from "./encounterVoidFixture.js";

// ---------------------------------------------------------------------------
// The void error must carry its own evidence, and must only claim what it can know.
//
// Medplum answers a transaction one of two ways. Without the `transaction-bundles` project
// feature (ODOS never sets it) a refused entry comes back INSIDE a 200 transaction-response
// with its own status and OperationOutcome while every other entry is applied. With the
// feature on, the whole request is refused with one HTTP status. Neither shape is atomic
// from the caller's point of view unless the server says so, hence the outcome taxonomy:
//
//   applied-none     refused, and the response shows nothing durable was applied
//   applied-partial  refused, and at least one durable write WAS accepted
//   indeterminate    no usable answer — transport loss, parse failure, 5xx — unknown state
//
// These are the intermediate-value tests. The real boundary — the bytes Express sends and
// the arguments the route logs — is guarded in encounterVoidRoutes.test.ts.
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

function refused(status: string, diagnostics: string): NonNullable<Bundle["entry"]>[number] {
  return { response: { status, outcome: forbidden(diagnostics) } };
}

test("a refused entry is identified by index, request method + url, status, and outcome text, with the failing count", () => {
  const response: Bundle = {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [ok("200 OK"), ok("201 Created"), refused("403 Forbidden", OUTCOME_SENTINEL), refused("403 Forbidden", "second refusal")],
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
  // What WAS applied is part of the evidence: the first PUT went through, the create too.
  assert.deepEqual(error.diagnostics.accepted, [
    { index: 0, method: "PUT", url: "Observation/obs-first-SENTINEL-ID" },
    { index: 1, method: "POST", url: "Provenance" },
  ]);
  assert.equal(error.diagnostics.changeCount, 3, "three durable writes (the PUTs); the create is rolled back by the client");
  assert.equal(error.diagnostics.appliedCount, 1);
  assert.equal(error.diagnostics.acceptedCreates, 1);
  assert.equal(error.diagnostics.outcome, "applied-partial");
  // The one log line: everything a reader needs to close the case without a second investigation.
  assert.match(error.message, /entry 2 of 4/);
  assert.match(error.message, /PUT Observation\/obs-refused-SENTINEL-ID/);
  assert.match(error.message, /HTTP 403/);
  assert.match(error.message, /2 of 4 entries refused/);
  assert.match(error.message, /1 of 3 changes applied/);
  assert.ok(error.message.includes(OUTCOME_SENTINEL), "the outcome text is in the log line");
  // No mirrored `status`: a per-entry 409/412 must never be swallowed by the conflict shortcut.
  assert.equal((error as { status?: unknown }).status, undefined);
});

test("all entries refused is APPLIED-NONE; one accepted durable write is APPLIED-PARTIAL", () => {
  const none = captureThrow(() => assertSuccessfulTransaction(request(), {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [refused("403 Forbidden", "a"), refused("403 Forbidden", "b"), refused("403 Forbidden", "c"), refused("403 Forbidden", "d")],
  }));
  assert.ok(none instanceof VoidTransactionError);
  assert.equal(none.diagnostics.outcome, "applied-none");
  assert.equal(none.clientBody.outcome, "applied-none");
  assert.match(none.clientBody.error, /^Nothing was cleared/);
  assert.match(none.clientBody.error, /Reload and try again/);

  // Only the create was accepted: the client rolls creates back, so no durable write applied.
  const createOnly = captureThrow(() => assertSuccessfulTransaction(request(), {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [refused("403 Forbidden", "a"), ok("201 Created"), refused("403 Forbidden", "c"), refused("403 Forbidden", "d")],
  }));
  assert.ok(createOnly instanceof VoidTransactionError);
  assert.equal(createOnly.diagnostics.outcome, "applied-none");
  if (createOnly.diagnostics.kind === "entry-failed") assert.equal(createOnly.diagnostics.acceptedCreates, 1);

  const partial = captureThrow(() => assertSuccessfulTransaction(request(), {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [refused("403 Forbidden", "a"), refused("403 Forbidden", "b"), refused("403 Forbidden", "c"), ok("200 OK")],
  }));
  assert.ok(partial instanceof VoidTransactionError);
  assert.equal(partial.diagnostics.outcome, "applied-partial");
  assert.match(partial.clientBody.error, /only partly applied/);
  assert.match(partial.clientBody.error, /1 of 3 changes were saved/);
  assert.doesNotMatch(partial.clientBody.error, /Reload and try again|reapply/);
});

test("PHI boundary (intermediate value): the client body carries index, resource type, status, counts, and a stable code — never ids or outcome text", () => {
  const response: Bundle = {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [ok("200 OK"), ok("201 Created"), refused("403 Forbidden", OUTCOME_SENTINEL), ok("200 OK")],
  };

  const error = captureThrow(() => assertSuccessfulTransaction(request(), response));
  assert.ok(error instanceof VoidTransactionError);

  assert.deepEqual(error.clientBody, {
    error: "This clear only partly applied: 2 of 3 changes were saved before the record server refused entry 2 of 4 " +
      "(PUT Observation, HTTP 403); 1 of 4 entries refused. Review the chart before continuing. " +
      "Undo, where offered, restores only what was actually cleared.",
    code: "void-transaction-failed",
    outcome: "applied-partial",
    failedEntryIndex: 2,
    failedResourceType: "Observation",
    failedStatus: 403,
    failedCount: 1,
    unknownCount: 0,
    appliedCount: 2,
    changeCount: 3,
    entryCount: 4,
  });
  const serialized = JSON.stringify(error.clientBody);
  assert.ok(!serialized.includes("SENTINEL"), `client body leaks server-only detail: ${serialized}`);
  assert.ok(!serialized.includes("obs-refused"), `client body leaks a resource id: ${serialized}`);
  const logged = `${error.message} ${JSON.stringify(error.diagnostics)}`;
  assert.ok(logged.includes(OUTCOME_SENTINEL));
  assert.ok(logged.includes("Observation/obs-refused-SENTINEL-ID"));
});

test("an incomplete transaction response is INDETERMINATE and reports entries sent vs returned and what came back instead", () => {
  const response: Bundle = { resourceType: "Bundle", type: "batch-response", entry: [ok("200 OK")] };

  const error = captureThrow(() => assertSuccessfulTransaction(request(), response));

  assert.ok(error instanceof VoidTransactionError, `expected VoidTransactionError, got ${String(error)}`);
  assert.deepEqual(error.diagnostics, {
    kind: "incomplete-response",
    outcome: "indeterminate",
    entryCount: 4,
    returnedEntries: 1,
    responseType: "Bundle/batch-response",
  });
  assert.match(error.message, /sent 4 entries/);
  assert.match(error.message, /received 1/);
  assert.match(error.message, /Bundle\/batch-response/);
  assert.deepEqual(error.clientBody, {
    error: "Could not confirm what this clear saved: the record server's answer was not a usable transaction response " +
      "(sent 4 entries, received 1, Bundle/batch-response). Some or all of it may have been applied. " +
      "Review the chart before continuing; do not repeat the clear blindly.",
    code: "void-transaction-incomplete",
    outcome: "indeterminate",
    entryCount: 4,
    returnedEntries: 1,
  });
});

test("a non-Bundle response body is named by its resourceType", () => {
  const notABundle = { resourceType: "OperationOutcome", issue: [] } as unknown as Bundle;
  const error = captureThrow(() => assertSuccessfulTransaction(request(), notABundle));
  assert.ok(error instanceof VoidTransactionError);
  assert.equal(error.diagnostics.kind, "incomplete-response");
  if (error.diagnostics.kind !== "incomplete-response") return;
  assert.equal(error.diagnostics.responseType, "OperationOutcome");
  assert.equal(error.diagnostics.returnedEntries, 0);
  assert.equal(error.diagnostics.outcome, "indeterminate");
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
  fhir.refuse = (entry) => entry.request?.url === "Observation/o1" ? { status: "403 Forbidden", outcome: forbidden(OUTCOME_SENTINEL) } : undefined;

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
      assert.equal(error.clientBody.code, "void-transaction-failed");
      if (error.clientBody.code !== "void-transaction-failed") return false;
      assert.equal(error.clientBody.failedResourceType, "Observation");
      assert.equal(error.clientBody.failedEntryIndex, 0);
      // The Encounter and the ledger row went through: partial, and the message says so.
      assert.equal(error.clientBody.outcome, "applied-partial");
      return true;
    },
  );
  assert.equal(fhir.get<{ status?: string }>("Observation", "o1").status, "final", "the refused row is untouched");
});

test("a per-entry 412 inside the transaction-response keeps its detail — it is NOT collapsed into the concurrent-edit 409", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("o1", "OD"));
  fhir.refuse = (entry) => entry.request?.url === "Observation/o1" ? { status: "412 Precondition Failed", outcome: forbidden("version mismatch") } : undefined;

  await assert.rejects(
    handleEncounterVoidRequest(deps, {
      authHeader: AUTH,
      params: { encounterId: "e1" },
      body: { scope: "observation", observationReference: "Observation/o1" },
    }),
    (error: unknown) => {
      assert.ok(error instanceof VoidTransactionError, `expected VoidTransactionError, got ${String(error)}`);
      assert.equal(error.clientBody.code, "void-transaction-failed");
      if (error.clientBody.code !== "void-transaction-failed") return false;
      assert.equal(error.clientBody.failedStatus, 412);
      assert.equal(error.clientBody.outcome, "applied-partial");
      assert.doesNotMatch(error.clientBody.error, /reapply/i);
      return true;
    },
  );
});

test("a request the FHIR server refuses outright with an unverified 4xx is INDETERMINATE and names what was sent", async () => {
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
      assert.equal(error.diagnostics.kind, "http-rejected");
      if (error.diagnostics.kind !== "http-rejected") return false;
      assert.equal(error.diagnostics.status, 403);
      assert.equal(error.diagnostics.outcome, "indeterminate", "a 403 for the whole request was never exercised on this stack");
      assert.ok(error.diagnostics.detail.includes(OUTCOME_SENTINEL));
      // Observation PUT + its Provenance POST + Encounter PUT + the Undo ledger row.
      assert.equal(error.diagnostics.entryCount, 4);
      assert.deepEqual(error.diagnostics.entries[0], { index: 0, method: "PUT", url: "Observation/o1" });
      assert.deepEqual(error.clientBody, {
        error: "Could not confirm what this clear saved: the record server refused the whole request (HTTP 403) without confirming " +
          "what had already been saved; 4 entries were sent and some or all may have been applied. " +
          "Review the chart before continuing; do not repeat the clear blindly.",
        code: "void-transaction-rejected",
        outcome: "indeterminate",
        httpStatus: 403,
        entryCount: 4,
      });
      assert.ok(!JSON.stringify(error.clientBody).includes("SENTINEL"));
      return true;
    },
  );
});

test("a 5xx from the FHIR server is INDETERMINATE: the request may have been applied before it failed", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("o1", "OD"));
  fhir.executeTransaction = async (): Promise<Bundle> => {
    throw Object.assign(new Error("FHIR POST /fhir/R4 [Bundle] 503 Service Unavailable: overloaded"), { status: 503 });
  };

  await assert.rejects(
    handleEncounterVoidRequest(deps, { authHeader: AUTH, params: { encounterId: "e1" }, body: { scope: "observation", observationReference: "Observation/o1" } }),
    (error: unknown) => {
      assert.ok(error instanceof VoidTransactionError);
      assert.equal(error.diagnostics.kind, "http-rejected");
      assert.equal(error.diagnostics.outcome, "indeterminate");
      assert.deepEqual(error.clientBody, {
        error: "Could not confirm what this clear saved: the record server failed while handling it (HTTP 503); 4 entries were sent " +
          "and some or all may have been applied. Review the chart before continuing; do not repeat the clear blindly.",
        code: "void-transaction-rejected",
        outcome: "indeterminate",
        httpStatus: 503,
        entryCount: 4,
      });
      return true;
    },
  );
});

test("a statusless failure (transport loss, parse failure) is INDETERMINATE — not a rejection before the server", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("o1", "OD"));
  fhir.executeTransaction = async (): Promise<Bundle> => { throw new Error("fetch failed: socket hang up"); };

  await assert.rejects(
    handleEncounterVoidRequest(deps, { authHeader: AUTH, params: { encounterId: "e1" }, body: { scope: "observation", observationReference: "Observation/o1" } }),
    (error: unknown) => {
      assert.ok(error instanceof VoidTransactionError, `expected VoidTransactionError, got ${String(error)}`);
      assert.equal(error.diagnostics.kind, "no-response");
      if (error.diagnostics.kind !== "no-response") return false;
      assert.equal(error.diagnostics.outcome, "indeterminate");
      assert.equal(error.diagnostics.detail, "fetch failed: socket hang up");
      assert.equal(error.diagnostics.entryCount, 4);
      assert.deepEqual(error.clientBody, {
        error: "Could not confirm what this clear saved: the record server did not answer (4 entries were sent). " +
          "Some or all of it may have been applied. Review the chart before continuing; do not repeat the clear blindly.",
        code: "void-transaction-unanswered",
        outcome: "indeterminate",
        entryCount: 4,
      });
      assert.match(error.message, /did not answer/);
      assert.doesNotMatch(error.message, /rejected/);
      return true;
    },
  );
});

test("a whole-request 412 is NOT verified to roll back on this stack, so it is INDETERMINATE — never the reload-and-reapply answer", async () => {
  const { deps, fhir } = fixture();
  fhir.add(cvf("o1", "OD"));
  fhir.executeTransaction = async (): Promise<Bundle> => {
    throw Object.assign(new Error("FHIR POST /fhir/R4 [Bundle] 412 Precondition Failed: version mismatch"), { status: 412 });
  };

  await assert.rejects(
    handleEncounterVoidRequest(deps, { authHeader: AUTH, params: { encounterId: "e1" }, body: { scope: "observation", observationReference: "Observation/o1" } }),
    (error: unknown) => {
      assert.ok(error instanceof VoidTransactionError, `expected VoidTransactionError, got ${String(error)}`);
      assert.equal(error.diagnostics.kind, "http-rejected");
      assert.equal(error.diagnostics.outcome, "indeterminate");
      assert.equal(error.clientBody.code, "void-transaction-rejected");
      assert.equal(error.clientBody.outcome, "indeterminate");
      assert.doesNotMatch(error.clientBody.error, /reapply|Reload|Nothing was cleared/i);
      assert.match(error.clientBody.error, /Could not confirm what this clear saved/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Round 2 — no unsafe certainty
// ---------------------------------------------------------------------------

test("F1: a same-length transaction-response with NO per-entry statuses is INDETERMINATE — absent status is not absent writes", () => {
  const response: Bundle = {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [{ response: {} }, { response: {} }, { response: {} }, { response: {} }],
  };

  const error = captureThrow(() => assertSuccessfulTransaction(request(), response));

  assert.ok(error instanceof VoidTransactionError, `expected VoidTransactionError, got ${String(error)}`);
  assert.equal(error.diagnostics.kind, "entry-failed");
  if (error.diagnostics.kind !== "entry-failed") return;
  assert.equal(error.diagnostics.outcome, "indeterminate");
  assert.equal(error.diagnostics.unknownCount, 4, "every entry is unknown, not refused");
  assert.equal(error.diagnostics.failedCount, 0, "nothing was positively refused");
  assert.equal(error.diagnostics.appliedCount, 0, "nothing was positively confirmed either");
  assert.equal(error.clientBody.outcome, "indeterminate");
  assert.match(error.clientBody.error, /^Could not confirm what this clear saved/);
  assert.match(error.clientBody.error, /no status for 4 of 4 entries/);
  assert.match(error.clientBody.error, /do not repeat the clear blindly/);
  assert.doesNotMatch(error.clientBody.error, /Nothing was cleared|Reload|try again/);
  assert.match(error.message, /indeterminate/);
});

test("F1: one entry without a status makes the whole answer INDETERMINATE even when the rest are positively refused or accepted", () => {
  const refusedOnly = captureThrow(() => assertSuccessfulTransaction(request(), {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [refused("403 Forbidden", "a"), { response: {} }, refused("403 Forbidden", "c"), refused("403 Forbidden", "d")],
  }));
  assert.ok(refusedOnly instanceof VoidTransactionError);
  assert.equal(refusedOnly.diagnostics.outcome, "indeterminate", "three refusals plus one unknown is not applied-none");
  if (refusedOnly.diagnostics.kind === "entry-failed") {
    assert.equal(refusedOnly.diagnostics.failedCount, 3);
    assert.equal(refusedOnly.diagnostics.unknownCount, 1);
  }

  const acceptedToo = captureThrow(() => assertSuccessfulTransaction(request(), {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [ok("200 OK"), { response: {} }, refused("403 Forbidden", "c"), ok("200 OK")],
  }));
  assert.ok(acceptedToo instanceof VoidTransactionError);
  assert.equal(acceptedToo.diagnostics.outcome, "indeterminate", "a confirmed write plus an unknown is not applied-partial");
  assert.match(acceptedToo.clientBody.error, /at least 2 of 3 changes were saved/);
  assert.match(acceptedToo.clientBody.error, /no status for 1 of 4 entries/);
  assert.doesNotMatch(acceptedToo.clientBody.error, /only partly applied/);
});

test("F1: a status that is not an HTTP status code is unknown, not a refusal", () => {
  for (const bad of ["OK", "99999", "", "2", "abc 200", "600 Nope"]) {
    const error = captureThrow(() => assertSuccessfulTransaction(request(), {
      resourceType: "Bundle",
      type: "transaction-response",
      entry: [ok("200 OK"), ok("201 Created"), { response: { status: bad } }, ok("200 OK")],
    }));
    assert.ok(error instanceof VoidTransactionError, `status ${JSON.stringify(bad)}`);
    assert.equal(error.diagnostics.outcome, "indeterminate", `status ${JSON.stringify(bad)} must be unknown`);
    if (error.diagnostics.kind === "entry-failed") assert.equal(error.diagnostics.unknownCount, 1, `status ${JSON.stringify(bad)}`);
  }
  // "200" alone and "200 OK" are both real statuses.
  assert.doesNotThrow(() => assertSuccessfulTransaction(request(), {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [ok("200"), ok("201 Created"), ok("200 OK"), ok("200")],
  }));
});

test("F1b: only the verified preprocessing rejection — HTTP 400 'Not a bundle' — is APPLIED-NONE; every other whole-request 4xx is INDETERMINATE", () => {
  const rejected = (status: number, text: string) =>
    classifyVoidTransactionFailure(request(), Object.assign(new Error(`FHIR POST /fhir/R4 [Bundle] ${status} Bad Request: ${text}`), { status }));

  const verified = rejected(400, "Not a bundle");
  assert.equal(verified.diagnostics.outcome, "applied-none");
  if (verified.diagnostics.kind === "http-rejected") {
    assert.match(String(verified.diagnostics.verifiedRejection), /Not a bundle/);
    assert.match(String(verified.diagnostics.verifiedRejection), /5\.1\.30/);
  }
  assert.equal(verified.clientBody.outcome, "applied-none");
  assert.match(verified.clientBody.error, /^Nothing was cleared/);

  for (const [status, text] of [[400, "Missing Bundle entry request method"], [401, "Unauthorized"], [403, "Forbidden"], [404, "Not found"], [409, "Conflict"], [412, "Precondition Failed"], [422, "Unprocessable"]] as const) {
    const unverified = rejected(status, text);
    assert.equal(unverified.diagnostics.outcome, "indeterminate", `${status} ${text}`);
    assert.equal(unverified.clientBody.outcome, "indeterminate", `${status} ${text}`);
    assert.match(unverified.clientBody.error, /Could not confirm what this clear saved/, `${status} ${text}`);
    assert.match(unverified.clientBody.error, new RegExp(`HTTP ${status}`), `${status} ${text}`);
    assert.doesNotMatch(unverified.clientBody.error, /Nothing was cleared|Reload|reapply/i, `${status} ${text}`);
  }
});

function captureThrow(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail("expected a throw");
}
