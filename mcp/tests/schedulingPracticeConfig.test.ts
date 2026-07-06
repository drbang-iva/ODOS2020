import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OSOD_SCHEDULING_CONFIG_CODE,
  OSOD_SCHEDULING_CONFIG_EXTENSION_URL,
  OSOD_SCHEDULING_CONFIG_SYSTEM,
  buildSchedulingPracticeConfigResource,
  parseSchedulingPracticeConfig,
  type PersistedSchedulingPracticeConfig,
} from "../src/scheduling/practice-config.js";

const CONFIG: PersistedSchedulingPracticeConfig = {
  timezoneOffset: "-05:00",
  defaultWeeklyHours: {
    mon: [{ start: "08:00", end: "17:00" }],
    fri: [{ start: "08:00", end: "12:00" }],
  },
  weeklyHoursBySchedule: {
    "Schedule/sch-1": { tue: [{ start: "10:00", end: "18:00" }] },
  },
  blocks: [
    {
      kind: "custom",
      description: "Lunch",
      weekdays: ["mon", "tue", "wed", "thu", "fri"],
      start: "12:00",
      end: "13:00",
    },
    {
      kind: "staff-off",
      date: "2026-07-10",
      scheduleReferences: ["Schedule/sch-1"],
    },
  ],
  offices: [{ id: "main", name: "Main Office" }],
  officeBySchedule: { "Schedule/sch-1": "main" },
};

test("the practice scheduling config persists as a coded singleton Basic resource", () => {
  const basic = buildSchedulingPracticeConfigResource(CONFIG);
  assert.equal(basic.resourceType, "Basic");
  const coding = basic.code.coding?.[0];
  assert.equal(coding?.system, OSOD_SCHEDULING_CONFIG_SYSTEM);
  assert.equal(coding?.code, OSOD_SCHEDULING_CONFIG_CODE);
  const ext = basic.extension?.find((e) => e.url === OSOD_SCHEDULING_CONFIG_EXTENSION_URL);
  assert.ok(ext?.valueString, "config JSON rides in the registered extension");
});

test("the config round-trips: parse(build(config)) deep-equals the input", () => {
  const basic = buildSchedulingPracticeConfigResource(CONFIG);
  assert.deepEqual(parseSchedulingPracticeConfig(basic), CONFIG);
});

test("build preserves an existing resource id + meta (update-in-place for the singleton)", () => {
  const existing = buildSchedulingPracticeConfigResource(CONFIG);
  existing.id = "cfg-1";
  existing.meta = { versionId: "4" };
  const rebuilt = buildSchedulingPracticeConfigResource(CONFIG, existing);
  assert.equal(rebuilt.id, "cfg-1");
  assert.deepEqual(rebuilt.meta, { versionId: "4" });
});

test("build validates the config shape: bad offset, bad time, unknown block kind, dangling office ref", () => {
  assert.throws(
    () => buildSchedulingPracticeConfigResource({ ...CONFIG, timezoneOffset: "EST" }),
    /offset/i,
  );
  assert.throws(
    () =>
      buildSchedulingPracticeConfigResource({
        ...CONFIG,
        defaultWeeklyHours: { mon: [{ start: "8am", end: "17:00" }] },
      }),
    /time/i,
  );
  assert.throws(
    () =>
      buildSchedulingPracticeConfigResource({
        ...CONFIG,
        blocks: [{ kind: "holiday" as never, date: "2026-07-10" }],
      }),
    /blocked-time kind/i,
  );
  assert.throws(
    () =>
      buildSchedulingPracticeConfigResource({
        ...CONFIG,
        officeBySchedule: { "Schedule/sch-1": "satellite" },
      }),
    /office/i,
  );
});

test("parse rejects a Basic that is not the scheduling-config singleton", () => {
  assert.throws(
    () =>
      parseSchedulingPracticeConfig({
        resourceType: "Basic",
        code: { coding: [{ system: "https://example.com", code: "other" }] },
      }),
    /scheduling-config/i,
  );
});

test("parse is forward-compatible: unknown top-level keys in stored JSON are dropped, not fatal", () => {
  const basic = buildSchedulingPracticeConfigResource(CONFIG);
  const ext = basic.extension!.find((e) => e.url === OSOD_SCHEDULING_CONFIG_EXTENSION_URL)!;
  ext.valueString = JSON.stringify({ ...JSON.parse(ext.valueString!), futureKnob: true });
  assert.deepEqual(parseSchedulingPracticeConfig(basic), CONFIG);
});

test("parse rejects malformed stored JSON with a clear error", () => {
  const basic = buildSchedulingPracticeConfigResource(CONFIG);
  const ext = basic.extension!.find((e) => e.url === OSOD_SCHEDULING_CONFIG_EXTENSION_URL)!;
  ext.valueString = "{not json";
  assert.throws(() => parseSchedulingPracticeConfig(basic), /config JSON/i);
});
