// ui/src/lib/floor-state.ts
import type { Appointment, Extension } from "@medplum/fhirtypes";

/**
 * The floor board's location signal (cockpit design doc §5, floor-board MVP doc §2):
 * R4 has no coded field for "which station is this checked-in patient physically at
 * right now", so a local composite `odos-floor-state` extension carries it on the
 * Appointment — station id + the instant they entered THAT station (`since`, rewritten
 * on every move, drives the time-in-lane timer) + the instant they FIRST checked in
 * (`checkedInAt`, set once and preserved across moves, drives the quiet check-in-time
 * display). 3a is honest-manual: check-in writes this once (station "waiting"), every
 * move after that is a staff drag that rewrites station + since while carrying
 * checkedInAt forward. Pure logic only — no React in this module.
 */
export const ODOS_FLOOR_STATE_EXTENSION_URL = "https://odos2020.com/fhir/StructureDefinition/odos-floor-state";

export interface FloorState {
  station: string;
  since: string;
  /** When the patient first checked in; preserved across station moves. Optional so a
   *  partial/legacy extension without it still parses (consumers fall back to `since`). */
  checkedInAt?: string;
}

/** Build the odos-floor-state composite extension. `checkedInAt` is required at the
 *  write boundary — every writer must decide it (set on check-in, carry forward on move). */
export function floorStateExtension(station: string, since: string, checkedInAt: string): Extension {
  return {
    url: ODOS_FLOOR_STATE_EXTENSION_URL,
    extension: [
      { url: "station", valueString: station },
      { url: "since", valueInstant: since },
      { url: "checkedInAt", valueInstant: checkedInAt },
    ],
  };
}

/** Read the floor state off an Appointment. Undefined if absent or malformed. */
export function parseFloorState(appointment: Appointment): FloorState | undefined {
  const extension = appointment.extension?.find((e) => e.url === ODOS_FLOOR_STATE_EXTENSION_URL);
  if (!extension?.extension) {
    return undefined;
  }
  const station = extension.extension.find((e) => e.url === "station")?.valueString;
  const since = extension.extension.find((e) => e.url === "since")?.valueInstant;
  const checkedInAt = extension.extension.find((e) => e.url === "checkedInAt")?.valueInstant;
  if (!station || !since) {
    return undefined;
  }
  return { station, since, ...(checkedInAt ? { checkedInAt } : {}) };
}
