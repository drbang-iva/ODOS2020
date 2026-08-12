import assert from "node:assert/strict";
import { test } from "node:test";
import {
  procedureFeeImportApi,
  type FeeImportProposal,
} from "../src/lib/procedure-fee-import";

function proposal(overrides: Partial<FeeImportProposal> = {}): FeeImportProposal {
  return {
    proposalId: "fee-import-row-2",
    sourceRows: [2],
    decision: "create",
    display: "Synthetic service",
    category: "procedure",
    routing: "insurance-billable",
    active: true,
    flags: [],
    reasons: [],
    ...overrides,
  };
}

test("fee import client sends inspect propose and commit only to server-mediated endpoints", async () => {
  // Sending import writes anywhere except the two approved server endpoints must make this test red.
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    const body = JSON.parse(String(init?.body)) as { action?: string };
    if (body.action === "inspect") {
      return Response.json({ headers: ["Name"], rowCount: 1, suggestedMapping: { display: "Name" } });
    }
    if (body.action === "propose") {
      return Response.json({ proposals: [proposal()], matchOptions: [], counts: { create: 1, match: 0, skip: 0, flagged: 0 } });
    }
    return Response.json({ outcomes: [{ proposalId: "fee-import-row-2", status: "created", message: "Created." }], counts: { created: 1, matched: 0, skipped: 0, failed: 0 } });
  };
  const api = procedureFeeImportApi(fetchImpl);
  await api.inspect("Name\nSynthetic service\n");
  await api.propose("Name\nSynthetic service\n", { display: "Name" });
  await api.commit([proposal()]);

  assert.deepEqual(requests.map((request) => request.url), [
    "/clinical-graph/fee-schedule/import/preview",
    "/clinical-graph/fee-schedule/import/preview",
    "/clinical-graph/fee-schedule/import/commit",
  ]);
  assert.equal(requests.every((request) => request.init?.method === "POST"), true);
  assert.deepEqual(requests.map((request) => JSON.parse(String(request.init?.body))), [
    { action: "inspect", csvText: "Name\nSynthetic service\n" },
    { action: "propose", csvText: "Name\nSynthetic service\n", mapping: { display: "Name" } },
    { proposals: [proposal()] },
  ]);
  assert.equal(requests.every((request) =>
    new Headers(request.init?.headers).get("Content-Type") === "application/json"
  ), true);
});

test("fee import client surfaces safe server errors without echoing the CSV", async () => {
  // Concatenating the request payload into client errors must expose this cell and make the test red.
  const secretCell = "SYNTHETIC-SECRET-PRICE-CELL";
  const api = procedureFeeImportApi(async () => Response.json({
    error: "CSV could not be parsed with strict quoting and column counts.",
  }, { status: 400 }));
  await assert.rejects(
    () => api.inspect(`Name,Fee\nSynthetic,${secretCell}\n`),
    (error: unknown) => error instanceof Error &&
      error.message === "CSV could not be parsed with strict quoting and column counts." &&
      !error.message.includes(secretCell),
  );
});
