import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  prepareBinaryForParserCreate,
} from "../../mcp/src/parsers/binarySecurityContext.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_INDEX = resolve(HERE, "../../mcp/src/index.ts");

test("Mandate 8 boundary: MCP exposes no auth-flow or credential-management tools", () => {
  const toolNames = listMcpToolNames();
  const forbiddenToolNames = [
    "invite_user",
    "create_user_invite",
    "reset_user_password",
    "create_project_membership",
    "update_project_membership",
    "modify_project_membership",
    "change_role_assignment",
    "bind_access_policy",
    "approve_baa",
    "approve_deploy",
    "approve_legal_screen",
    "initiate_break_glass",
    "break_glass",
  ];

  for (const forbidden of forbiddenToolNames) {
    assert.equal(
      toolNames.includes(forbidden),
      false,
      `Mandate 8 boundary: MCP must not expose ${forbidden}.`,
    );
  }
});

test("Mandate 8 boundary: MCP tool names contain no auth-flow aliases", () => {
  const toolNames = listMcpToolNames();
  const forbiddenPatterns = [
    /invite/i,
    /password/i,
    /project.*membership/i,
    /membership.*project/i,
    /role.*assign/i,
    /access.*policy.*bind/i,
    /baa/i,
    /legal/i,
    /deploy.*approve/i,
    /break.*glass/i,
  ];

  for (const toolName of toolNames) {
    for (const pattern of forbiddenPatterns) {
      assert.equal(
        pattern.test(toolName),
        false,
        `Mandate 8 boundary: MCP tool ${toolName} matches forbidden auth-flow pattern ${pattern}.`,
      );
    }
  }
});

test("Mandate 8 boundary: agent direct Binary POST bypass is rejected by parser guard", () => {
  assert.throws(
    () =>
      prepareBinaryForParserCreate(
        { resourceType: "Binary", contentType: "image/jpeg", data: "AA==" },
        { source: "agent-direct-fhir", anchorReference: "Patient/patient-1" },
      ),
    /Mandate 8 boundary/,
  );
});

function listMcpToolNames(): string[] {
  const source = readFileSync(MCP_INDEX, "utf8");
  return Array.from(source.matchAll(/name:\s*"([^"]+)"/g), (match) => match[1]);
}
