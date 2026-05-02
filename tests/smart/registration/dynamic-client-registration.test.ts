import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemorySmartAppRegistryStore,
  type SmartAppMedplumAdapter,
} from "../../../mcp/src/smart/registration/dynamic-client-registration.js";
import { readSmartClientApp, type OSODSmartClientApp } from "../../../mcp/src/smart/registration/smart-client-app.js";
import { createSmartTestServer } from "../helpers.ts";

test("v0.55b dynamic registration stores the OSOD canonical Endpoint and provisions through the adapter", async () => {
  const store = new InMemorySmartAppRegistryStore();
  const adapterCalls: OSODSmartClientApp[] = [];
  const adapter: SmartAppMedplumAdapter = {
    async registerSmartApp(canonicalRecord) {
      adapterCalls.push(canonicalRecord);
      return { client_id: "registered-client-1" };
    },
    async revokeSmartApp() {
      return undefined;
    },
    async updateSmartAppMetadata() {
      return undefined;
    },
  };
  const server = await createSmartTestServer({ smartAppRegistryStore: store, smartAppMedplumAdapter: adapter });
  try {
    const response = await fetch(`${server.origin}/oauth2/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Local Visual Field Launcher",
        redirect_uris: [`${server.origin}/callback`],
        token_endpoint_auth_method: "none",
        scope: "user/Observation.rs",
        scope_request_canonical: "user/Observation.rs",
        risk_class: "low",
        phi_boundary: "metadata-only",
        launch_mode: "ehr",
        network_egress: "local-only",
        external_services_required: false,
        baa_required: false,
        image_analysis_prohibited: true,
        allowedJurisdictions: ["US"],
        prohibitedStates: [],
      }),
    });
    assert.equal(response.status, 201);
    const json = await response.json() as { client_id: string; app_shape: string };
    assert.equal(json.client_id, "registered-client-1");
    assert.equal(json.app_shape, "endpoint");

    assert.equal(store.records.size, 1);
    const [stored] = [...store.records.values()];
    assert.equal(stored.resourceType, "Endpoint");
    const app = readSmartClientApp(stored);
    assert.equal(app.metadata.clientName, "Local Visual Field Launcher");
    assert.equal(app.policy.imageAnalysisProhibited, true);
    assert.equal(adapterCalls.length, 1);
    assert.equal(adapterCalls[0]?.canonicalRecord.id, stored.id);
    assert.equal((await server.state.getClient("registered-client-1"))?.name, "Local Visual Field Launcher");
  } finally {
    await server.close();
  }
});
