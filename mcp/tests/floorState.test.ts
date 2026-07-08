// mcp/tests/floorState.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OSOD_FLOOR_STATE_EXTENSION_URL,
  floorStateExtension,
  parseFloorState,
} from "../../ui/src/lib/floor-state.js";

test("floorStateExtension builds a composite extension with station + since + checkedInAt", () => {
  const extension = floorStateExtension("waiting", "2026-07-08T14:00:00.000Z", "2026-07-08T13:45:00.000Z");
  assert.equal(extension.url, OSOD_FLOOR_STATE_EXTENSION_URL);
  const station = extension.extension?.find((e) => e.url === "station");
  const since = extension.extension?.find((e) => e.url === "since");
  const checkedInAt = extension.extension?.find((e) => e.url === "checkedInAt");
  assert.equal(station?.valueString, "waiting");
  assert.equal(since?.valueInstant, "2026-07-08T14:00:00.000Z");
  assert.equal(checkedInAt?.valueInstant, "2026-07-08T13:45:00.000Z");
});

test("parseFloorState round-trips", () => {
  const extension = floorStateExtension("chair-1", "2026-07-08T14:05:00.000Z", "2026-07-08T14:05:00.000Z");
  const parsed = parseFloorState({
    resourceType: "Appointment",
    status: "arrived",
    participant: [],
    extension: [extension],
  });
  assert.deepEqual(parsed, {
    station: "chair-1",
    since: "2026-07-08T14:05:00.000Z",
    checkedInAt: "2026-07-08T14:05:00.000Z",
  });
});

test("parseFloorState reads a preserved checkedInAt distinct from since", () => {
  const extension = floorStateExtension("chair-1", "2026-07-08T14:20:00.000Z", "2026-07-08T13:45:00.000Z");
  const parsed = parseFloorState({
    resourceType: "Appointment",
    status: "arrived",
    participant: [],
    extension: [extension],
  });
  assert.deepEqual(parsed, {
    station: "chair-1",
    since: "2026-07-08T14:20:00.000Z",
    checkedInAt: "2026-07-08T13:45:00.000Z",
  });
});

test("parseFloorState is backward-compatible with a station+since extension lacking checkedInAt", () => {
  const parsed = parseFloorState({
    resourceType: "Appointment",
    status: "arrived",
    participant: [],
    extension: [
      {
        url: OSOD_FLOOR_STATE_EXTENSION_URL,
        extension: [
          { url: "station", valueString: "waiting" },
          { url: "since", valueInstant: "2026-07-08T14:00:00.000Z" },
        ],
      },
    ],
  });
  assert.deepEqual(parsed, { station: "waiting", since: "2026-07-08T14:00:00.000Z" });
  assert.equal(parsed?.checkedInAt, undefined);
});

test("parseFloorState returns undefined when the appointment has no floor-state extension", () => {
  assert.equal(
    parseFloorState({ resourceType: "Appointment", status: "booked", participant: [] }),
    undefined,
  );
});

test("parseFloorState returns undefined when the extension is malformed (missing station or since)", () => {
  const malformed = parseFloorState({
    resourceType: "Appointment",
    status: "arrived",
    participant: [],
    extension: [{ url: OSOD_FLOOR_STATE_EXTENSION_URL, extension: [{ url: "since", valueInstant: "2026-07-08T14:00:00.000Z" }] }],
  });
  assert.equal(malformed, undefined);
});
