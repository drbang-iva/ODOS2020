// mcp/tests/floorConfigParity.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_FLOOR_STATIONS, DEFAULT_LANE_THRESHOLDS } from "../src/scheduling/floor-config.js";
import { DEFAULT_FLOOR_BOARD_CONFIG } from "../../ui/src/lib/floor-board.js";

test("ui DEFAULT_FLOOR_BOARD_CONFIG.stations mirror mcp DEFAULT_FLOOR_STATIONS (no ui/mcp drift)", () => {
  assert.deepEqual(DEFAULT_FLOOR_BOARD_CONFIG.stations, DEFAULT_FLOOR_STATIONS);
});

test("ui DEFAULT_FLOOR_BOARD_CONFIG.defaultThreshold mirrors mcp DEFAULT_LANE_THRESHOLDS", () => {
  assert.deepEqual(DEFAULT_FLOOR_BOARD_CONFIG.defaultThreshold, DEFAULT_LANE_THRESHOLDS);
});
