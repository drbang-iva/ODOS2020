import assert from "node:assert/strict";
import { test } from "node:test";
import { V04_WRITE_TOOL_NAMES, auditHeaders } from "../src/tools/audit.js";

test("v0.4 foundation write tools each emit their per-tool X-OSOD-Source header value", () => {
  assert.deepEqual(V04_WRITE_TOOL_NAMES, [
    "create_lens_device",
    "update_lens_device_properties",
    "create_device_definition",
    "create_concept_map",
    "create_substance",
  ]);

  for (const toolName of V04_WRITE_TOOL_NAMES) {
    assert.deepEqual(auditHeaders(toolName), {
      "X-OSOD-Source": `mcp/${toolName}`,
    });
  }
});
