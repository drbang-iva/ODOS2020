import type { Observation } from "@medplum/fhirtypes";

export const OBSERVATION_ATTESTATION_UI_STATE_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/observation-attestation-ui-state";

export const OBSERVATION_ATTESTATION_UI_STATES = [
  "pending-clinician-review",
  "clinician-reviewing",
  "attestation-in-flight",
] as const;

export type ObservationAttestationUiState =
  (typeof OBSERVATION_ATTESTATION_UI_STATES)[number];

export function attestationReviewState(
  observation: Pick<Observation, "status" | "extension">,
): ObservationAttestationUiState | Observation["status"] {
  const uiState = observation.extension?.find(
    (extension) => extension.url === OBSERVATION_ATTESTATION_UI_STATE_EXTENSION_URL,
  )?.valueCode;

  if (isObservationAttestationUiState(uiState)) {
    return uiState;
  }

  return observation.status;
}

export function isObservationAttestationUiState(
  value: string | undefined,
): value is ObservationAttestationUiState {
  return OBSERVATION_ATTESTATION_UI_STATES.includes(value as ObservationAttestationUiState);
}
