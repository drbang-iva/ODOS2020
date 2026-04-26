import assert from "node:assert/strict";
import { test } from "node:test";
import { V035_WRITE_TOOL_NAMES, auditHeaders } from "../src/tools/audit.js";

test("v0.35 write tools each emit their per-tool X-OSOD-Source header value", () => {
  assert.deepEqual(V035_WRITE_TOOL_NAMES, [
    "create_episode_of_care",
    "update_episode_of_care",
    "create_condition_with_tier",
    "create_problem_list_condition",
    "update_condition_status",
    "update_condition_tier",
    "update_condition_body_site",
    "update_condition_code",
    "mark_condition_entered_in_error",
    "create_allergy_intolerance",
    "create_smoking_status_observation",
    "create_care_team",
    "create_procedure",
    "update_procedure_body_site",
  ]);

  for (const toolName of V035_WRITE_TOOL_NAMES) {
    assert.deepEqual(auditHeaders(toolName), {
      "X-OSOD-Source": `mcp/${toolName}`,
    });
  }
});
