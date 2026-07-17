import type { CodeableConcept } from "@medplum/fhirtypes";

export const ODOS_LAB_TRANSPORT_STATE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/lab-transport-state";

export const LAB_TRANSPORT_STATES = [
  { code: "queued", display: "Queued" },
  { code: "sent", display: "Sent" },
  { code: "received", display: "Received" },
  { code: "cancelled", display: "Cancelled" },
  { code: "error", display: "Error" },
  { code: "acknowledged", display: "Acknowledged" },
  { code: "in-production", display: "In Production" },
  { code: "shipped", display: "Shipped" },
] as const;

export type LabTransportState = (typeof LAB_TRANSPORT_STATES)[number]["code"];

const STATE_BY_CODE = new Map<string, (typeof LAB_TRANSPORT_STATES)[number]>(
  LAB_TRANSPORT_STATES.map((state) => [state.code, state]),
);

export function assertLabTransportState(code: string): asserts code is LabTransportState {
  if (!STATE_BY_CODE.has(code)) {
    throw new Error(`Unknown lab transport state "${code}" — must be one of the 8 defined lab transport states.`);
  }
}

export function labTransportStateConcept(code: string): CodeableConcept {
  assertLabTransportState(code);
  const state = STATE_BY_CODE.get(code)!;
  return {
    coding: [{
      system: ODOS_LAB_TRANSPORT_STATE_SYSTEM,
      code: state.code,
      display: state.display,
    }],
    text: state.display,
  };
}

export function isTerminalLabTransportState(state: LabTransportState): boolean {
  return state === "received" || state === "cancelled";
}

export function canTransitionLabTransportState(
  from: LabTransportState,
  to: LabTransportState,
): boolean {
  if (isTerminalLabTransportState(from)) return false;
  if (to === "error") return true;
  if (to === "cancelled") return true;
  if (from === "queued") return to === "sent";
  const forwardOrder: LabTransportState[] = [
    "sent",
    "acknowledged",
    "in-production",
    "shipped",
    "received",
  ];
  const fromIndex = forwardOrder.indexOf(from);
  const toIndex = forwardOrder.indexOf(to);
  return fromIndex >= 0 && toIndex > fromIndex;
}
