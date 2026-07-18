// mcp/tests/floorBoard.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Appointment } from "@medplum/fhirtypes";
import { ODOS_VISION_COVERAGE_EXTENSION_URL, V2_0276_APPOINTMENT_TYPE_SYSTEM } from "../../ui/src/lib/scheduling.js";
import { floorStateExtension } from "../../ui/src/lib/floor-state.js";
import { deriveFloorBoard, payerCue, timerState, type FloorBoardConfig } from "../../ui/src/lib/floor-board.js";

const CONFIG: FloorBoardConfig = {
  stations: [
    { id: "waiting", label: "Waiting", order: 0 },
    { id: "optical", label: "Optical", order: 1 },
  ],
  laneThresholds: { waiting: { amberMinutes: 10, redMinutes: 20 } },
  defaultThreshold: { amberMinutes: 20, redMinutes: 30 },
  payerMap: { VSP: "vision", "IVA House Plan": "house" },
};

function visionCoverageExtension(display: string) {
  return { url: ODOS_VISION_COVERAGE_EXTENSION_URL, valueReference: { display } };
}

function appt(
  id: string,
  station: string,
  since: string,
  opts: { status?: Appointment["status"]; visionPlan?: string; checkedInAt?: string } = {},
): Appointment {
  const extensions = [floorStateExtension(station, since, opts.checkedInAt ?? since)];
  if (opts.visionPlan) {
    extensions.push(visionCoverageExtension(opts.visionPlan));
  }
  return {
    resourceType: "Appointment",
    id,
    status: opts.status ?? "checked-in",
    participant: [
      { actor: { reference: `Patient/${id}`, display: `Patient ${id}` }, status: "accepted" },
    ],
    extension: extensions,
  };
}

test("timerState buckets minutes into ok/amber/red per threshold and clamps skew to 0", () => {
  const threshold = { amberMinutes: 10, redMinutes: 20 };
  assert.deepEqual(timerState("2026-07-08T14:00:00.000Z", threshold, "2026-07-08T14:05:00.000Z"), {
    minutes: 5,
    level: "ok",
  });
  assert.deepEqual(timerState("2026-07-08T14:00:00.000Z", threshold, "2026-07-08T14:12:00.000Z"), {
    minutes: 12,
    level: "amber",
  });
  assert.deepEqual(timerState("2026-07-08T14:00:00.000Z", threshold, "2026-07-08T14:25:00.000Z"), {
    minutes: 25,
    level: "red",
  });
  assert.deepEqual(timerState("2026-07-08T14:10:00.000Z", threshold, "2026-07-08T14:00:00.000Z"), {
    minutes: 0,
    level: "ok",
  });
});

test("timerState surfaces an unparseable since as red (never a calm ok), not NaN", () => {
  const threshold = { amberMinutes: 10, redMinutes: 20 };
  const result = timerState("not-a-timestamp", threshold, "2026-07-08T14:00:00.000Z");
  assert.equal(result.level, "red", "a corrupt timer must read as attention-worthy, not ok");
  assert.equal(Number.isNaN(result.minutes), false, "minutes must be a real number, never NaN");
});

test("timerState treats thresholds as inclusive lower bounds (amber AT amberMinutes, red AT redMinutes)", () => {
  const threshold = { amberMinutes: 10, redMinutes: 20 };
  assert.equal(
    timerState("2026-07-08T14:00:00.000Z", threshold, "2026-07-08T14:10:00.000Z").level,
    "amber",
    "exactly amberMinutes is amber",
  );
  assert.equal(
    timerState("2026-07-08T14:00:00.000Z", threshold, "2026-07-08T14:20:00.000Z").level,
    "red",
    "exactly redMinutes is red",
  );
});

test("payerCue maps a known plan name to its class; unknown/absent is unmarked", () => {
  assert.deepEqual(payerCue("VSP", CONFIG), { kind: "vision", label: "VSP" });
  assert.deepEqual(payerCue("IVA House Plan", CONFIG), { kind: "house", label: "IVA House Plan" });
  assert.equal(payerCue("Medicare", CONFIG), undefined);
  assert.equal(payerCue(undefined, CONFIG), undefined);
});

test("payerCue's house-kind label uses the practice's configured housePlanLabel, not the raw plan display", () => {
  const configWithLabel: FloorBoardConfig = { ...CONFIG, housePlanLabel: "Our Vision Plan" };
  assert.deepEqual(
    payerCue("IVA House Plan", configWithLabel),
    { kind: "house", label: "Our Vision Plan" },
    "house chip shows the configured display label, not the coverage's raw plan-name text",
  );
  assert.deepEqual(
    payerCue("VSP", configWithLabel),
    { kind: "vision", label: "VSP" },
    "vision-kind label is unaffected by housePlanLabel — it always shows the raw plan display",
  );
  assert.deepEqual(
    payerCue("IVA House Plan", CONFIG),
    { kind: "house", label: "IVA House Plan" },
    "with no housePlanLabel configured, the house chip falls back to the raw plan display",
  );
});

test("deriveFloorBoard groups by station, sorts longest-wait-first, applies lane thresholds", () => {
  const now = "2026-07-08T14:30:00.000Z";
  const appointments = [
    appt("a1", "waiting", "2026-07-08T14:22:00.000Z"),
    appt("a2", "waiting", "2026-07-08T14:05:00.000Z"),
    appt("a3", "optical", "2026-07-08T14:25:00.000Z"),
  ];
  const board = deriveFloorBoard(appointments, [], CONFIG, now);
  assert.equal(board.waiting.length, 2);
  assert.equal(board.waiting[0].appointment.id, "a2", "longest wait (25m) sorts first");
  assert.equal(board.waiting[0].timer.level, "red");
  assert.equal(board.waiting[1].appointment.id, "a1", "8m wait sorts second");
  assert.equal(board.waiting[1].timer.level, "ok");
  assert.equal(board.optical.length, 1);
  assert.equal(board.optical[0].timer.level, "ok", "5m against the 20/30 default threshold");
});

test("deriveFloorBoard picks the payer cue from the bare vision-plan display, not the composite insuranceLine", () => {
  const now = "2026-07-08T14:30:00.000Z";
  const withVsp = appt("a1", "optical", "2026-07-08T14:25:00.000Z", { visionPlan: "VSP" });
  const withHousePlan = appt("a2", "optical", "2026-07-08T14:20:00.000Z", { visionPlan: "IVA House Plan" });
  const noCoverage = appt("a3", "optical", "2026-07-08T14:15:00.000Z");
  const board = deriveFloorBoard([withVsp, withHousePlan, noCoverage], [], CONFIG, now);
  const byId = Object.fromEntries(board.optical.map((card) => [card.appointment.id, card]));
  assert.deepEqual(byId.a1.payerCue, { kind: "vision", label: "VSP" });
  assert.deepEqual(byId.a2.payerCue, { kind: "house", label: "IVA House Plan" });
  assert.equal(byId.a3.payerCue, undefined);
});

test("deriveFloorBoard excludes appointments with no floor state and checked-out/cancelled statuses", () => {
  const now = "2026-07-08T14:30:00.000Z";
  const noFloorState: Appointment = {
    resourceType: "Appointment",
    id: "a4",
    status: "booked",
    participant: [],
  };
  const checkedOut = appt("a5", "optical", "2026-07-08T14:00:00.000Z", { status: "fulfilled" });
  const board = deriveFloorBoard([noFloorState, checkedOut], [], CONFIG, now);
  assert.equal(Object.values(board).flat().length, 0);
});

test("deriveFloorBoard ignores a floor-state station absent from config (stale config edit)", () => {
  const now = "2026-07-08T14:30:00.000Z";
  const orphaned = appt("a6", "removed-station", "2026-07-08T14:00:00.000Z");
  const board = deriveFloorBoard([orphaned], [], CONFIG, now);
  assert.equal(Object.values(board).flat().length, 0);
});

test("deriveFloorBoard excludes an inactive station while reactivation restores its retained lane", () => {
  const now = "2026-07-08T14:30:00.000Z";
  const optical = appt("a-inactive", "optical", "2026-07-08T14:20:00.000Z");
  const inactive: FloorBoardConfig = {
    ...CONFIG,
    stations: CONFIG.stations.map((station) =>
      station.id === "optical" ? { ...station, active: false } : station,
    ),
    laneThresholds: { ...CONFIG.laneThresholds, optical: { amberMinutes: 15, redMinutes: 25 } },
  };
  const hidden = deriveFloorBoard([optical], [], inactive, now);
  assert.equal(hidden.optical, undefined);
  assert.deepEqual(inactive.laneThresholds.optical, { amberMinutes: 15, redMinutes: 25 });

  const reactivated: FloorBoardConfig = {
    ...inactive,
    stations: inactive.stations.map((station) =>
      station.id === "optical" ? { ...station, active: true } : station,
    ),
  };
  assert.equal(deriveFloorBoard([optical], [], reactivated, now).optical.length, 1);
});

test("deriveFloorBoard treats a walk-in (raw status arrived + WALKIN type) as on-the-floor", () => {
  const now = "2026-07-08T14:10:00.000Z";
  const walkIn: Appointment = {
    resourceType: "Appointment",
    id: "a7",
    status: "arrived",
    appointmentType: {
      coding: [{ system: V2_0276_APPOINTMENT_TYPE_SYSTEM, code: "WALKIN" }],
    },
    participant: [{ actor: { reference: "Patient/a7" }, status: "accepted" }],
    extension: [floorStateExtension("waiting", "2026-07-08T14:05:00.000Z", "2026-07-08T14:05:00.000Z")],
  };
  const board = deriveFloorBoard([walkIn], [], CONFIG, now);
  assert.equal(board.waiting.length, 1);
  assert.equal(board.waiting[0].appointment.id, "a7");
});

test("deriveFloorBoard surfaces a preserved checkedInAt distinct from since", () => {
  const now = "2026-07-08T14:30:00.000Z";
  // Moved patient: entered the current lane at 14:20 but first checked in at 13:45.
  const moved = appt("a8", "waiting", "2026-07-08T14:20:00.000Z", { checkedInAt: "2026-07-08T13:45:00.000Z" });
  const board = deriveFloorBoard([moved], [], CONFIG, now);
  assert.equal(board.waiting.length, 1);
  assert.equal(board.waiting[0].since, "2026-07-08T14:20:00.000Z");
  assert.equal(board.waiting[0].checkedInAt, "2026-07-08T13:45:00.000Z");
});

test("deriveFloorBoard falls back checkedInAt to since when the extension lacks it", () => {
  const now = "2026-07-08T14:30:00.000Z";
  const legacy: Appointment = {
    resourceType: "Appointment",
    id: "a9",
    status: "checked-in",
    participant: [{ actor: { reference: "Patient/a9" }, status: "accepted" }],
    extension: [
      {
        url: "https://odos2020.com/fhir/StructureDefinition/odos-floor-state",
        extension: [
          { url: "station", valueString: "waiting" },
          { url: "since", valueInstant: "2026-07-08T14:05:00.000Z" },
        ],
      },
    ],
  };
  const board = deriveFloorBoard([legacy], [], CONFIG, now);
  assert.equal(board.waiting.length, 1);
  assert.equal(board.waiting[0].checkedInAt, "2026-07-08T14:05:00.000Z");
});
