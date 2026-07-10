// mcp/tests/floorConfigParity.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_FLOOR_STATIONS,
  DEFAULT_LANE_THRESHOLDS,
  OSOD_FLOOR_CONFIG_CODE as MCP_OSOD_FLOOR_CONFIG_CODE,
  OSOD_FLOOR_CONFIG_EXTENSION_URL as MCP_OSOD_FLOOR_CONFIG_EXTENSION_URL,
  OSOD_FLOOR_CONFIG_SYSTEM as MCP_OSOD_FLOOR_CONFIG_SYSTEM,
  buildFloorConfigResource as mcpBuildFloorConfigResource,
  parseFloorConfig as mcpParseFloorConfig,
  type PersistedFloorConfig,
} from "../src/scheduling/floor-config.js";
import { DEFAULT_FLOOR_BOARD_CONFIG } from "../../ui/src/lib/floor-board.js";
import {
  OSOD_FLOOR_CONFIG_CODE as UI_OSOD_FLOOR_CONFIG_CODE,
  OSOD_FLOOR_CONFIG_EXTENSION_URL as UI_OSOD_FLOOR_CONFIG_EXTENSION_URL,
  OSOD_FLOOR_CONFIG_SYSTEM as UI_OSOD_FLOOR_CONFIG_SYSTEM,
  buildFloorConfigResource as uiBuildFloorConfigResource,
  parseFloorConfig as uiParseFloorConfig,
} from "../../ui/src/lib/floor-config.js";

const CONFIG: PersistedFloorConfig = {
  stations: [
    { id: "waiting", label: "Waiting", order: 0 },
    { id: "optical", label: "Optical", order: 1, active: false },
  ],
  laneThresholds: {
    waiting: { amberMinutes: 10, redMinutes: 20 },
    optical: { amberMinutes: 20, redMinutes: 30 },
  },
  defaultThreshold: { amberMinutes: 20, redMinutes: 30 },
  payerMap: { VSP: "vision" },
};

test("ui DEFAULT_FLOOR_BOARD_CONFIG.stations mirror mcp DEFAULT_FLOOR_STATIONS (no ui/mcp drift)", () => {
  assert.deepEqual(DEFAULT_FLOOR_BOARD_CONFIG.stations, DEFAULT_FLOOR_STATIONS);
});

test("ui DEFAULT_FLOOR_BOARD_CONFIG.defaultThreshold mirrors mcp DEFAULT_LANE_THRESHOLDS", () => {
  assert.deepEqual(DEFAULT_FLOOR_BOARD_CONFIG.defaultThreshold, DEFAULT_LANE_THRESHOLDS);
});

test("UI floor-config mirror constants and inactive-station wire shape match the kernel", () => {
  assert.equal(UI_OSOD_FLOOR_CONFIG_SYSTEM, MCP_OSOD_FLOOR_CONFIG_SYSTEM);
  assert.equal(UI_OSOD_FLOOR_CONFIG_CODE, MCP_OSOD_FLOOR_CONFIG_CODE);
  assert.equal(UI_OSOD_FLOOR_CONFIG_EXTENSION_URL, MCP_OSOD_FLOOR_CONFIG_EXTENSION_URL);
  assert.deepEqual(uiBuildFloorConfigResource(CONFIG), mcpBuildFloorConfigResource(CONFIG));
  assert.deepEqual(
    uiParseFloorConfig(uiBuildFloorConfigResource(CONFIG)),
    mcpParseFloorConfig(mcpBuildFloorConfigResource(CONFIG)),
  );
});

test("UI floor-config mirror validator messages match the kernel verbatim", () => {
  for (const invalid of [
    { ...CONFIG, defaultThreshold: { amberMinutes: 0, redMinutes: 30 } },
    { ...CONFIG, defaultThreshold: { amberMinutes: 20, redMinutes: 20 } },
    { ...CONFIG, laneThresholds: { missing: { amberMinutes: 10, redMinutes: 20 } } },
  ]) {
    assert.throws(
      () => uiBuildFloorConfigResource(invalid),
      (error) => {
        assert.ok(error instanceof Error);
        assert.throws(() => mcpBuildFloorConfigResource(invalid), { message: error.message });
        return true;
      },
    );
  }
});
