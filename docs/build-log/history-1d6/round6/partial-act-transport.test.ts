import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import express from "../../../../mcp/node_modules/express/index.js";
import { HISTORY_ITEM_REVIEW_CODE } from "../../../../mcp/src/clinical-graph/history-answer-observation.js";
import { registerHistoryItemRoutes } from "../../../../mcp/src/clinical-graph/history-item-routes.js";
import { HISTORY_OPTION_CATALOGS } from "../../../../mcp/src/clinical-graph/history-template-engine.js";
import { createStaffRouteFhirClient } from "../../../../mcp/src/fhir-client.js";
import { TEST_FHIR_AUDIT_RECORDER } from "../../../../mcp/tests/fhirAuditTestStub.js";
import { historyRosFixture } from "../../../../mcp/tests/helpers/historyRosFixture.js";

for (const mode of ["visible-partial-response", "lost-partial-response"] as const) {
  test(`real FHIR transport repairs or compensates ${mode}`, async () => {
    const s = historyRosFixture();
    const staff = await s.deps.authenticate("synthetic");
    assert.ok(staff);
    const execute = staff.fhir.executeTransaction.bind(staff.fhir);
    let injected = false;
    let deletes = 0;
    const fhirServer = createServer(async (request, response) => {
      if (request.method === "DELETE") {
        deletes += 1;
        const id = request.url!.split("/").at(-1);
        const index = s.rows.findIndex(row => row.id === id);
        if (index >= 0) s.rows.splice(index, 1);
        response.statusCode = 204; response.end(); return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bundle = JSON.parse(Buffer.concat(chunks).toString());
      const isAct = bundle.entry?.[0]?.resource?.code?.coding?.some((coding: { code?: string }) => coding.code === HISTORY_ITEM_REVIEW_CODE);
      let result;
      if (isAct && !injected) {
        injected = true;
        const partial = await execute({ ...bundle, entry: [bundle.entry[0]] });
        if (mode === "lost-partial-response") { response.destroy(); return; }
        result = { ...partial, entry: [...partial.entry, { response: { status: "500 Internal Server Error" } }] };
      } else result = await execute(bundle);
      response.setHeader("Content-Type", "application/fhir+json"); response.end(JSON.stringify(result));
    });
    fhirServer.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => fhirServer.once("listening", resolve));
    try {
      const fhirAddress = fhirServer.address();
      assert.ok(fhirAddress && typeof fhirAddress !== "string");
      staff.fhir.executeTransaction = createStaffRouteFhirClient({
        baseUrl: `http://127.0.0.1:${fhirAddress.port}`,
        accessToken: "synthetic",
        staffReference: "Practitioner/test",
        actorRole: "provider",
        audit: TEST_FHIR_AUDIT_RECORDER,
      }).executeTransaction;
      const body = {
        patientReference: "Patient/ros-test", encounterReference: "Encounter/current", sectionKey: "review-of-systems",
        action: "items-reviewed", method: "bulk", gestureId: randomUUID(),
        targets: HISTORY_OPTION_CATALOGS.ros_items.slice(0, 2).map(option => ({
          sectionKey: "review-of-systems", sectionId: "systems", optionCode: option.code,
        })),
      };
      const app = express(); app.use(express.json()); registerHistoryItemRoutes(app, async () => s.deps);
      const http = app.listen(0, "127.0.0.1");
      await new Promise<void>(resolve => http.once("listening", resolve));
      try {
        const address = http.address(); assert.ok(address && typeof address !== "string");
        const run = async () => {
          const response = await fetch(`http://127.0.0.1:${address.port}/clinical-graph/history/items/review`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
          });
          return { status: response.status, body: await response.json() };
        };
        const first = await run(); const retry = await run(); const again = await run();
        const provenance = s.rows.filter(row => row.resourceType === "Provenance").length;
        const acts = s.rows.filter(row => row.resourceType === "Observation" &&
          row.code.coding?.some(coding => coding.code === HISTORY_ITEM_REVIEW_CODE)).length;
        console.log("PARTIAL_ACT_TRANSPORT", JSON.stringify({ mode, responses: [first.status, retry.status, again.status], deletes, acts, provenance }));
        assert.equal(first.status, 500); assert.deepEqual(again, retry);
        if (mode === "visible-partial-response") {
          assert.equal(retry.status, 409); assert.equal(deletes, 1); assert.equal(acts, 0); assert.equal(provenance, 1);
        } else {
          assert.equal(retry.status, 200); assert.equal(deletes, 0); assert.equal(acts, 1); assert.equal(provenance, 2);
        }
      } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
    } finally { await new Promise<void>(resolve => fhirServer.close(() => resolve())); }
  });
}
