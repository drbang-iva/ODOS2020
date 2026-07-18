import type { LabTransportState } from "../../fhir/labTransportState.js";

export interface OcucoStatusMapping {
  state: LabTransportState;
  unmapped: boolean;
  rawStatus: string;
}

export function mapOcucoStatusToLabTransportState(
  rawStatus: string,
  currentState: LabTransportState,
): OcucoStatusMapping {
  const normalized = rawStatus.toLowerCase();
  let state: LabTransportState | undefined;

  // TODO OCUCO-LIVE-STATUS: refine this keyword list against BP Digital's observed
  // status strings. The current list is limited to Ocuco's documented examples.
  if (normalized.includes("ship")) state = "shipped";
  else if (/edg|coat|inspection/.test(normalized)) state = "in-production";
  else if (normalized.includes("receiv")) state = "acknowledged";
  else if (normalized.includes("order entry")) state = "sent";

  return state
    ? { state, unmapped: false, rawStatus }
    : { state: currentState, unmapped: true, rawStatus };
}
