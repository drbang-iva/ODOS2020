// ui/src/lib/floor-state.ts
import type { Appointment, Extension } from "@medplum/fhirtypes";

/**
 * The floor board's location signal (cockpit design doc §5, floor-board MVP doc §2):
 * R4 has no coded field for "which station is this checked-in patient physically at
 * right now", so a local composite `osod-floor-state` extension carries it on the
 * Appointment — station id + the instant it was set. 3a is honest-manual: check-in
 * writes this once (station "waiting"), every move after that is a staff drag that
 * rewrites it. Pure logic only — no React in this module.
 */
export const OSOD_FLOOR_STATE_EXTENSION_URL = "https://osod.dev/fhir/StructureDefinition/osod-floor-state";

export interface FloorState {
  station: string;
  since: string;
}

/** Build the osod-floor-state composite extension for a station + timestamp. */
export function floorStateExtension(station: string, since: string): Extension {
  return {
    url: OSOD_FLOOR_STATE_EXTENSION_URL,
    extension: [
      { url: "station", valueString: station },
      { url: "since", valueInstant: since },
    ],
  };
}

/** Read the floor state off an Appointment. Undefined if absent or malformed. */
export function parseFloorState(appointment: Appointment): FloorState | undefined {
  const extension = appointment.extension?.find((e) => e.url === OSOD_FLOOR_STATE_EXTENSION_URL);
  if (!extension?.extension) {
    return undefined;
  }
  const station = extension.extension.find((e) => e.url === "station")?.valueString;
  const since = extension.extension.find((e) => e.url === "since")?.valueInstant;
  if (!station || !since) {
    return undefined;
  }
  return { station, since };
}
