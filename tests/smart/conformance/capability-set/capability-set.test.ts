import assert from "node:assert/strict";
import { test } from "node:test";
import { V055B_SMART_CAPABILITIES } from "../../../../mcp/src/smart/registration/smart-client-app.js";
import { createSmartTestServer } from "../../helpers.ts";

test("v0.55b SMART discovery advertises only the implemented capability set", async () => {
  const server = await createSmartTestServer();
  try {
    const response = await fetch(`${server.origin}/.well-known/smart-configuration`);
    assert.equal(response.status, 200);
    const json = await response.json() as { capabilities: string[] };
    assert.deepEqual(json.capabilities, [...V055B_SMART_CAPABILITIES]);
  } finally {
    await server.close();
  }
});
