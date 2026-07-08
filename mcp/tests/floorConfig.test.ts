// mcp/tests/floorConfig.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_FLOOR_STATIONS,
  DEFAULT_LANE_THRESHOLDS,
  OSOD_FLOOR_CONFIG_CODE,
  OSOD_FLOOR_CONFIG_EXTENSION_URL,
  OSOD_FLOOR_CONFIG_SYSTEM,
  buildFloorConfigResource,
  parseFloorConfig,
  type PersistedFloorConfig,
} from "../src/scheduling/floor-config.js";

const CONFIG: PersistedFloorConfig = {
  stations: [
    { id: "front-desk", label: "Front desk", order: 0 },
    { id: "waiting", label: "Waiting", order: 1 },
    { id: "pretest", label: "Pretest", order: 2 },
    { id: "chair-1", label: "Chair 1", order: 3 },
    { id: "optical", label: "Optical", order: 4 },
    { id: "checkout", label: "Checkout", order: 5 },
  ],
  laneThresholds: {
    waiting: { amberMinutes: 10, redMinutes: 20 },
  },
  defaultThreshold: { amberMinutes: 20, redMinutes: 30 },
  payerMap: { VSP: "vision", EyeMed: "vision", "IVA House Plan": "house" },
  housePlanLabel: "IVA House Plan",
};

test("buildFloorConfigResource round-trips through parseFloorConfig", () => {
  const resource = buildFloorConfigResource(CONFIG);
  assert.equal(resource.resourceType, "Basic");
  assert.equal(resource.code?.coding?.[0]?.system, OSOD_FLOOR_CONFIG_SYSTEM);
  assert.equal(resource.code?.coding?.[0]?.code, OSOD_FLOOR_CONFIG_CODE);
  const extension = resource.extension?.find((e) => e.url === OSOD_FLOOR_CONFIG_EXTENSION_URL);
  assert.ok(extension?.valueString, "config extension carries the JSON payload");
  assert.deepEqual(parseFloorConfig(resource), CONFIG);
});

test("buildFloorConfigResource preserves id + meta when updating in place", () => {
  const existing = buildFloorConfigResource(CONFIG);
  existing.id = "floor-config-1";
  existing.meta = { versionId: "3" };
  const updated = buildFloorConfigResource(
    { ...CONFIG, housePlanLabel: "Our Vision Plan" },
    existing,
  );
  assert.equal(updated.id, "floor-config-1");
  assert.equal(updated.meta?.versionId, "3");
});

test("parseFloorConfig rejects a Basic that is not the floor-config singleton", () => {
  assert.throws(
    () => parseFloorConfig({ resourceType: "Basic", code: { coding: [{ system: "other", code: "x" }] } }),
    /not the osod floor-config singleton/,
  );
});

test("parseFloorConfig rejects a singleton Basic that is missing its config extension", () => {
  assert.throws(
    () =>
      parseFloorConfig({
        resourceType: "Basic",
        code: { coding: [{ system: OSOD_FLOOR_CONFIG_SYSTEM, code: OSOD_FLOOR_CONFIG_CODE }] },
      }),
    /missing its config extension/,
  );
});

test("parseFloorConfig rejects malformed stored JSON with a clear error", () => {
  const basic = buildFloorConfigResource(CONFIG);
  const ext = basic.extension!.find((e) => e.url === OSOD_FLOOR_CONFIG_EXTENSION_URL)!;
  ext.valueString = "{not json";
  assert.throws(() => parseFloorConfig(basic), /Floor-config JSON/i);
});

test("parseFloorConfig is forward-compatible: unknown top-level keys in stored JSON are dropped, not fatal", () => {
  const basic = buildFloorConfigResource(CONFIG);
  const ext = basic.extension!.find((e) => e.url === OSOD_FLOOR_CONFIG_EXTENSION_URL)!;
  ext.valueString = JSON.stringify({ ...JSON.parse(ext.valueString!), futureKnob: true });
  assert.deepEqual(parseFloorConfig(basic), CONFIG);
});

test("buildFloorConfigResource validates the config shape: empty stations, duplicate ids, dangling lane threshold", () => {
  assert.throws(
    () => buildFloorConfigResource({ ...CONFIG, stations: [] }),
    /at least one station/,
  );
  assert.throws(
    () =>
      buildFloorConfigResource({
        ...CONFIG,
        stations: [
          { id: "front-desk", label: "Front desk", order: 0 },
          { id: "front-desk", label: "Duplicate", order: 1 },
        ],
      }),
    /station ids must be unique/,
  );
  assert.throws(
    () =>
      buildFloorConfigResource({
        ...CONFIG,
        laneThresholds: { "not-a-station": { amberMinutes: 10, redMinutes: 20 } },
      }),
    /unknown station/,
  );
});

test("buildFloorConfigResource validates thresholds: non-positive amber, red not greater than amber", () => {
  assert.throws(
    () =>
      buildFloorConfigResource({ ...CONFIG, defaultThreshold: { amberMinutes: 0, redMinutes: 30 } }),
    /amberMinutes must be a positive number/,
  );
  assert.throws(
    () =>
      buildFloorConfigResource({ ...CONFIG, defaultThreshold: { amberMinutes: 20, redMinutes: 20 } }),
    /redMinutes must be greater than amberMinutes/,
  );
});

test("buildFloorConfigResource validates payerMap values against known payer cue kinds", () => {
  assert.throws(
    () =>
      buildFloorConfigResource({
        ...CONFIG,
        payerMap: { ...CONFIG.payerMap, "Typo Payer": "visoin" as never },
      }),
    /Unknown payer cue kind "visoin" for payer "Typo Payer"/,
  );
});

test("DEFAULT_FLOOR_STATIONS and DEFAULT_LANE_THRESHOLDS match the design doc defaults", () => {
  assert.deepEqual(
    DEFAULT_FLOOR_STATIONS.map((s) => s.id),
    ["front-desk", "waiting", "pretest", "chair-1", "chair-2", "optical", "checkout"],
  );
  assert.deepEqual(DEFAULT_LANE_THRESHOLDS, { amberMinutes: 20, redMinutes: 30 });
});
