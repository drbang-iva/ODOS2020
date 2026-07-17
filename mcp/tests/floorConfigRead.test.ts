// mcp/tests/floorConfigRead.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic } from "@medplum/fhirtypes";
import {
  DEFAULT_FLOOR_BOARD_CONFIG,
  deriveFloorBoard,
  ODOS_FLOOR_CONFIG_CODE,
  ODOS_FLOOR_CONFIG_EXTENSION_URL,
  ODOS_FLOOR_CONFIG_SYSTEM,
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
    code: { coding: [{ system: ODOS_FLOOR_CONFIG_SYSTEM, code: ODOS_FLOOR_CONFIG_CODE }] },
    extension: [{ url: ODOS_FLOOR_CONFIG_EXTENSION_URL, valueString: JSON.stringify(config) }],
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
    code: { coding: [{ system: ODOS_FLOOR_CONFIG_SYSTEM, code: ODOS_FLOOR_CONFIG_CODE }] },
    extension: [{ url: ODOS_FLOOR_CONFIG_EXTENSION_URL, valueString: "{not json" }],
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

// Codex re-eval finding: a non-empty-array check alone lets [null] through, which
// later crashes deriveFloorBoard on station.id. Every station entry's shape must be
// validated, not just array-non-emptiness.
test("parseFloorConfigResource rejects a stations array containing a malformed entry (e.g. null)", () => {
  assert.equal(parseFloorConfigResource(buildBasic({ ...REAL_CONFIG, stations: [null] })), undefined);
  assert.equal(
    parseFloorConfigResource(buildBasic({ ...REAL_CONFIG, stations: [{ id: "waiting" }] })),
    undefined,
    "a station missing label/order is also rejected",
  );
});

test("parseFloorConfigResource accepts optional active=false and rejects malformed active values", () => {
  const inactive = buildBasic({
    ...REAL_CONFIG,
    stations: REAL_CONFIG.stations.map((station) =>
      station.id === "waiting" ? { ...station, active: false } : station,
    ),
  });
  assert.equal(
    parseFloorConfigResource(inactive)?.stations.find((station) => station.id === "waiting")?.active,
    false,
  );
  assert.equal(
    parseFloorConfigResource(
      buildBasic({
        ...REAL_CONFIG,
        stations: REAL_CONFIG.stations.map((station) => ({ ...station, active: "no" })),
      }),
    ),
    undefined,
  );
});

test("parseFloorConfigResource never lets a malformed config reach deriveFloorBoard — falls back safely instead of crashing", () => {
  const basic = buildBasic({ ...REAL_CONFIG, stations: [null, { id: "x" }] });
  const parsed = parseFloorConfigResource(basic) ?? DEFAULT_FLOOR_BOARD_CONFIG;
  assert.doesNotThrow(() => deriveFloorBoard([], [], parsed, "2026-07-08T14:00:00.000Z"));
});

test("parseFloorConfigResource rejects a malformed laneThresholds shape (not an object, or a bad entry)", () => {
  assert.equal(
    parseFloorConfigResource(buildBasic({ ...REAL_CONFIG, laneThresholds: "not-an-object" })),
    undefined,
  );
  assert.equal(
    parseFloorConfigResource(buildBasic({ ...REAL_CONFIG, laneThresholds: { waiting: { amberMinutes: "ten" } } })),
    undefined,
  );
});

test("parseFloorConfigResource rejects a malformed defaultThreshold", () => {
  assert.equal(
    parseFloorConfigResource(buildBasic({ ...REAL_CONFIG, defaultThreshold: { amberMinutes: 10 } })),
    undefined,
    "missing redMinutes is rejected",
  );
});

test("parseFloorConfigResource rejects a payerMap with an invalid cue-kind value", () => {
  assert.equal(
    parseFloorConfigResource(buildBasic({ ...REAL_CONFIG, payerMap: { Medicare: "bogus-kind" } })),
    undefined,
  );
});
