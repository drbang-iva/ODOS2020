import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ODOS_STATEMENT_MESSAGE_CONFIG_CODE as MCP_CODE,
  ODOS_STATEMENT_MESSAGE_CONFIG_EXTENSION_URL as MCP_EXTENSION,
  ODOS_STATEMENT_MESSAGE_CONFIG_SYSTEM as MCP_SYSTEM,
  STATEMENT_MESSAGE_MAX_LENGTH as MCP_MAX,
  buildStatementMessageConfigResource as mcpBuild,
  parseStatementMessageConfig as mcpParse,
} from "../src/statements/statement-message-config.js";
import {
  ODOS_STATEMENT_MESSAGE_CONFIG_CODE as UI_CODE,
  ODOS_STATEMENT_MESSAGE_CONFIG_EXTENSION_URL as UI_EXTENSION,
  ODOS_STATEMENT_MESSAGE_CONFIG_SYSTEM as UI_SYSTEM,
  STATEMENT_MESSAGE_MAX_LENGTH as UI_MAX,
  buildStatementMessageConfigResource as uiBuild,
  parseStatementMessageConfig as uiParse,
} from "../../ui/src/scenes/settings/statement-message-config.js";

const CONFIG = {
  statementFooterMessage: "Statement note",
  receiptFooterMessage: "Receipt note",
};

test("UI statement-message config mirror matches the MCP kernel", () => {
  assert.equal(UI_SYSTEM, MCP_SYSTEM);
  assert.equal(UI_CODE, MCP_CODE);
  assert.equal(UI_EXTENSION, MCP_EXTENSION);
  assert.equal(UI_MAX, MCP_MAX);
  assert.deepEqual(uiBuild(CONFIG), mcpBuild(CONFIG));
  assert.deepEqual(uiParse(uiBuild(CONFIG)), mcpParse(mcpBuild(CONFIG)));
});

test("UI and MCP mirrors reject non-object JSON identically", () => {
  const malformed = mcpBuild({});
  malformed.extension![0]!.valueString = "null";
  assert.throws(() => mcpParse(malformed), /JSON is malformed/);
  assert.throws(() => uiParse(malformed), /JSON is malformed/);
});
