// mcp/tests/schedulingFloorStationUi.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Appointment } from "@medplum/fhirtypes";
import { parseFloorState } from "../../ui/src/lib/floor-state.js";
import { useSchedulingStore } from "../../ui/src/lib/scheduling-store.js";

function fakeClient(existing: Appointment) {
  const updates: Appointment[] = [];
  return {
    client: {
      search: async () => ({ resourceType: "Bundle" as const, entry: [] }),
      read: async () => existing,
      create: async (resource: Appointment) => resource,
      update: async (resource: Appointment) => {
        updates.push(resource);
        return resource;
      },
    },
    updates,
  };
}

test("updateAppointment with floorStation writes the osod-floor-state extension", async () => {
  const appointment: Appointment = {
    resourceType: "Appointment",
    id: "appt-1",
    status: "arrived",
    start: "2026-07-08T14:00:00.000Z",
    end: "2026-07-08T14:20:00.000Z",
    minutesDuration: 20,
    participant: [{ actor: { reference: "Patient/p1" }, status: "accepted" }],
  };
  const { client, updates } = fakeClient(appointment);
  await useSchedulingStore.getState().updateAppointment(
    appointment,
    { floorStation: "waiting" },
    { fhirClient: client as never, now: () => "2026-07-08T14:05:00.000Z" },
  );
  assert.equal(updates.length, 1);
  const written = parseFloorState(updates[0]);
  assert.equal(written?.station, "waiting");
  assert.equal(written?.since, "2026-07-08T14:05:00.000Z");
});

test("updateAppointment with floorStation:null clears the extension", async () => {
  const appointment: Appointment = {
    resourceType: "Appointment",
    id: "appt-1",
    status: "fulfilled",
    start: "2026-07-08T14:00:00.000Z",
    end: "2026-07-08T14:20:00.000Z",
    minutesDuration: 20,
    participant: [{ actor: { reference: "Patient/p1" }, status: "accepted" }],
    extension: [
      {
        url: "https://osod.dev/fhir/StructureDefinition/osod-floor-state",
        extension: [
          { url: "station", valueString: "waiting" },
          { url: "since", valueInstant: "2026-07-08T14:00:00.000Z" },
        ],
      },
    ],
  };
  const { client, updates } = fakeClient(appointment);
  await useSchedulingStore.getState().updateAppointment(
    appointment,
    { floorStation: null },
    { fhirClient: client as never },
  );
  assert.equal(parseFloorState(updates[0]), undefined);
});

test("updateAppointment with floorStation preserves unrelated extensions", async () => {
  const visionCoverageUrl = "https://osod.dev/fhir/StructureDefinition/osod-vision-coverage";
  const appointment: Appointment = {
    resourceType: "Appointment",
    id: "appt-1",
    status: "arrived",
    start: "2026-07-08T14:00:00.000Z",
    end: "2026-07-08T14:20:00.000Z",
    minutesDuration: 20,
    participant: [{ actor: { reference: "Patient/p1" }, status: "accepted" }],
    extension: [{ url: visionCoverageUrl, valueReference: { display: "VSP" } }],
  };
  const { client, updates } = fakeClient(appointment);
  await useSchedulingStore.getState().updateAppointment(
    appointment,
    { floorStation: "waiting" },
    { fhirClient: client as never, now: () => "2026-07-08T14:05:00.000Z" },
  );
  const written = updates[0];
  const preserved = written.extension?.find((e) => e.url === visionCoverageUrl);
  assert.equal(preserved?.valueReference?.display, "VSP", "the vision-coverage extension survives a floor move");
  assert.equal(parseFloorState(written)?.station, "waiting", "and the floor-state extension is added alongside it");
});
