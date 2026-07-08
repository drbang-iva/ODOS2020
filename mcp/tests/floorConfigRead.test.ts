// mcp/tests/floorConfigRead.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic } from "@medplum/fhirtypes";
import {
  DEFAULT_FLOOR_BOARD_CONFIG,
  OSOD_FLOOR_CONFIG_CODE,
  OSOD_FLOOR_CONFIG_EXTENSION_URL,
  OSOD_FLOOR_CONFIG_SYSTEM,
  parseFloorConfigResource,
} from "../../ui/src/lib/floor-board.js";

const REAL_CONFIG = {
  stations: [{ id: "waiting", label: "Waiting", order: 0 }],
  laneThresholds: {},
  defaultThreshold: { amberMinutes: 15, redMinutes: 25 },
  payerMap: { "Acme Vision": "vision" as const },
  housePlanLabel: "Acme House Plan",
};

function buildBasic(config: unknown): Basic {
  return {
    resourceType: "Basic",
    code: { coding: [{ system: OSOD_FLOOR_CONFIG_SYSTEM, code: OSOD_FLOOR_CONFIG_CODE }] },
    extension: [{ url: OSOD_FLOOR_CONFIG_EXTENSION_URL, valueString: JSON.stringify(config) }],
  };
}

test("parseFloorConfigResource reads a real practice-configured singleton", () => {
  assert.deepEqual(parseFloorConfigResource(buildBasic(REAL_CONFIG)), REAL_CONFIG);
});

test("parseFloorConfigResource returns undefined for a Basic that is not the floor-config singleton", () => {
  const wrong: Basic = { resourceType: "Basic", code: { coding: [{ system: "other", code: "x" }] } };
  assert.equal(parseFloorConfigResource(wrong), undefined);
});

test("parseFloorConfigResource returns undefined (never throws) on malformed JSON", () => {
  const malformed: Basic = {
    resourceType: "Basic",
    code: { coding: [{ system: OSOD_FLOOR_CONFIG_SYSTEM, code: OSOD_FLOOR_CONFIG_CODE }] },
    extension: [{ url: OSOD_FLOOR_CONFIG_EXTENSION_URL, valueString: "{not json" }],
  };
  assert.doesNotThrow(() => parseFloorConfigResource(malformed));
  assert.equal(parseFloorConfigResource(malformed), undefined);
});

test("parseFloorConfigResource returns undefined for an empty stations array", () => {
  assert.equal(parseFloorConfigResource(buildBasic({ ...REAL_CONFIG, stations: [] })), undefined);
});

test("parseFloorConfigResource falls back defaultThreshold/payerMap when absent from stored JSON", () => {
  const minimal = { stations: REAL_CONFIG.stations };
  const parsed = parseFloorConfigResource(buildBasic(minimal));
  assert.deepEqual(parsed?.defaultThreshold, DEFAULT_FLOOR_BOARD_CONFIG.defaultThreshold);
  assert.deepEqual(parsed?.payerMap, {});
});
