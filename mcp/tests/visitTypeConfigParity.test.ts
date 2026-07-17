import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_VISIT_TYPE_CATEGORIES as MCP_DEFAULTS,
  ODOS_VISIT_TYPE_CONFIG_CODE as MCP_CODE,
  ODOS_VISIT_TYPE_CONFIG_EXTENSION_URL as MCP_EXTENSION,
  ODOS_VISIT_TYPE_CONFIG_SYSTEM as MCP_SYSTEM,
  buildVisitTypeConfigResource as mcpBuild,
  parseVisitTypeConfig as mcpParse,
  type PersistedVisitTypeConfig,
} from "../src/scheduling/visit-type-config.js";
import {
  DEFAULT_VISIT_TYPE_CATEGORIES as UI_DEFAULTS,
  ODOS_VISIT_TYPE_CONFIG_CODE as UI_CODE,
  ODOS_VISIT_TYPE_CONFIG_EXTENSION_URL as UI_EXTENSION,
  ODOS_VISIT_TYPE_CONFIG_SYSTEM as UI_SYSTEM,
  buildVisitTypeConfigResource as uiBuild,
  parseVisitTypeConfig as uiParse,
} from "../../ui/src/lib/visit-type-config.js";

const CONFIG: PersistedVisitTypeConfig = {
  categories: [
    { id: "dry-eye", label: "Dry Eye", order: 0 },
    { id: "archived", label: "Archived", order: 1, active: false },
  ],
};

test("UI visit-type config mirror matches the MCP kernel and real round-trip", () => {
  assert.equal(UI_SYSTEM, MCP_SYSTEM);
  assert.equal(UI_CODE, MCP_CODE);
  assert.equal(UI_EXTENSION, MCP_EXTENSION);
  assert.deepEqual(UI_DEFAULTS, MCP_DEFAULTS);
  assert.deepEqual(uiBuild(CONFIG), mcpBuild(CONFIG));
  assert.deepEqual(uiParse(uiBuild(CONFIG)), mcpParse(mcpBuild(CONFIG)));
});

test("UI visit-type config validator messages match the kernel verbatim", () => {
  const invalid = {
    categories: [
      { id: "one", label: "Duplicate", order: 0 },
      { id: "two", label: "duplicate", order: 1 },
    ],
  };
  assert.throws(
    () => uiBuild(invalid),
    (error) => {
      assert.ok(error instanceof Error);
      assert.throws(() => mcpBuild(invalid), { message: error.message });
      return true;
    },
  );
});
