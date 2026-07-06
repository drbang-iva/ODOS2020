import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BLOCKED_TIME_KINDS,
  OSOD_BLOCKED_TIME_KIND_EXTENSION_URL,
  OSOD_BLOCKED_TIME_KIND_SYSTEM,
  blockedTimeKindOf,
  generateSlots,
} from "../src/scheduling/availability.js";

const MONDAY = "2026-07-06";
const TUESDAY = "2026-07-07";
const WEDNESDAY = "2026-07-08";

const BASE = {
  scheduleReference: "Schedule/sch-1",
  slotMinutes: 30,
  timezoneOffset: "-05:00",
} as const;

test("the blocked-time vocabulary is the AestheticsPro trio (brief §3.3)", () => {
  assert.deepEqual(
    BLOCKED_TIME_KINDS.map((k) => k.code),
    ["office-closed", "staff-off", "custom"],
  );
  assert.deepEqual(
    BLOCKED_TIME_KINDS.map((k) => k.display),
    ["Office Closed", "Staff Member Off", "Custom"],
  );
});

test("operating hours expand into free Slots on the schedule at grid granularity", () => {
  const slots = generateSlots({
    ...BASE,
    weeklyHours: { mon: [{ start: "08:00", end: "12:00" }] },
    from: MONDAY,
    to: MONDAY,
  });
  assert.equal(slots.length, 8);
  assert.ok(slots.every((s) => s.resourceType === "Slot"));
  assert.ok(slots.every((s) => s.status === "free"));
  assert.ok(slots.every((s) => s.schedule.reference === "Schedule/sch-1"));
  assert.equal(slots[0]?.start, "2026-07-06T08:00:00-05:00");
  assert.equal(slots[0]?.end, "2026-07-06T08:30:00-05:00");
  assert.equal(slots[7]?.start, "2026-07-06T11:30:00-05:00");
  assert.equal(slots[7]?.end, "2026-07-06T12:00:00-05:00");
});

test("a day with no configured hours generates no slots (outside-hours gray is a view concern)", () => {
  const slots = generateSlots({
    ...BASE,
    weeklyHours: { mon: [{ start: "08:00", end: "12:00" }] },
    from: TUESDAY,
    to: TUESDAY,
  });
  assert.equal(slots.length, 0);
});

test("split hours (lunch) generate no slot spanning the gap", () => {
  const slots = generateSlots({
    ...BASE,
    weeklyHours: {
      mon: [
        { start: "10:00", end: "12:00" },
        { start: "13:00", end: "15:00" },
      ],
    },
    from: MONDAY,
    to: MONDAY,
  });
  const starts = slots.map((s) => s.start.slice(11, 16));
  assert.deepEqual(starts, ["10:00", "10:30", "11:00", "11:30", "13:00", "13:30", "14:00", "14:30"]);
});

test("a trailing partial window never emits a slot that overruns closing", () => {
  const slots = generateSlots({
    ...BASE,
    weeklyHours: { mon: [{ start: "09:00", end: "10:15" }] },
    from: MONDAY,
    to: MONDAY,
  });
  assert.deepEqual(
    slots.map((s) => s.start.slice(11, 16)),
    ["09:00", "09:30"],
  );
});

test("a multi-day range walks the weekly template by actual weekday", () => {
  const slots = generateSlots({
    ...BASE,
    weeklyHours: {
      mon: [{ start: "08:00", end: "09:00" }],
      wed: [{ start: "14:00", end: "15:00" }],
    },
    from: MONDAY,
    to: WEDNESDAY,
  });
  assert.deepEqual(
    slots.map((s) => s.start),
    [
      "2026-07-06T08:00:00-05:00",
      "2026-07-06T08:30:00-05:00",
      "2026-07-08T14:00:00-05:00",
      "2026-07-08T14:30:00-05:00",
    ],
  );
});

test("a recurring custom block marks overlapped slots busy-unavailable with kind + description", () => {
  const slots = generateSlots({
    ...BASE,
    weeklyHours: { mon: [{ start: "11:00", end: "14:00" }] },
    from: MONDAY,
    to: MONDAY,
    blocks: [
      {
        kind: "custom",
        description: "Rep lunch",
        weekdays: ["mon"],
        start: "12:00",
        end: "13:00",
      },
    ],
  });
  const byStart = new Map(slots.map((s) => [s.start.slice(11, 16), s]));
  assert.equal(byStart.get("11:00")?.status, "free");
  assert.equal(byStart.get("12:00")?.status, "busy-unavailable");
  assert.equal(byStart.get("12:30")?.status, "busy-unavailable");
  assert.equal(byStart.get("13:00")?.status, "free");
  const blocked = byStart.get("12:00")!;
  assert.equal(blockedTimeKindOf(blocked), "custom");
  assert.equal(blocked.comment, "Rep lunch");
  const kindCoding = blocked.extension
    ?.find((e) => e.url === OSOD_BLOCKED_TIME_KIND_EXTENSION_URL)
    ?.valueCodeableConcept?.coding?.[0];
  assert.equal(kindCoding?.system, OSOD_BLOCKED_TIME_KIND_SYSTEM);
});

test("a one-date all-day staff-off block empties that day only", () => {
  const slots = generateSlots({
    ...BASE,
    weeklyHours: {
      mon: [{ start: "08:00", end: "09:00" }],
      tue: [{ start: "08:00", end: "09:00" }],
    },
    from: MONDAY,
    to: TUESDAY,
    blocks: [{ kind: "staff-off", date: MONDAY }],
  });
  const monday = slots.filter((s) => s.start.startsWith(MONDAY));
  const tuesday = slots.filter((s) => s.start.startsWith(TUESDAY));
  assert.ok(monday.every((s) => s.status === "busy-unavailable"));
  assert.ok(monday.every((s) => blockedTimeKindOf(s) === "staff-off"));
  assert.ok(tuesday.every((s) => s.status === "free"));
});

test("a partial overlap blocks the whole slot — front desk cannot book a half-blocked slot", () => {
  const slots = generateSlots({
    ...BASE,
    weeklyHours: { mon: [{ start: "12:00", end: "13:00" }] },
    from: MONDAY,
    to: MONDAY,
    blocks: [{ kind: "custom", description: "x", date: MONDAY, start: "12:15", end: "12:45" }],
  });
  assert.ok(slots.every((s) => s.status === "busy-unavailable"));
});

test("validation: bad granularity, bad offset, inverted range, bad time, and an unanchored block all throw", () => {
  const ok = {
    ...BASE,
    weeklyHours: { mon: [{ start: "08:00", end: "12:00" }] },
    from: MONDAY,
    to: MONDAY,
  };
  assert.throws(() => generateSlots({ ...ok, slotMinutes: 0 }), /slot/i);
  assert.throws(() => generateSlots({ ...ok, timezoneOffset: "CST" }), /offset/i);
  assert.throws(() => generateSlots({ ...ok, from: TUESDAY, to: MONDAY }), /range/i);
  assert.throws(
    () => generateSlots({ ...ok, weeklyHours: { mon: [{ start: "8am", end: "12:00" }] } }),
    /time/i,
  );
  assert.throws(
    () => generateSlots({ ...ok, blocks: [{ kind: "custom", start: "12:00", end: "13:00" }] }),
    /date|weekday/i,
  );
  assert.throws(
    () => generateSlots({ ...ok, blocks: [{ kind: "holiday" as never, date: MONDAY }] }),
    /blocked-time kind/i,
  );
});
