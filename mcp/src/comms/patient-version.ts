import type { Bundle } from "@medplum/fhirtypes";

export interface PatientWriteVersion {
  writtenAgainst: string;
  current: string;
}

export function patientWriteVersion(response: Bundle, patientReference: string, writtenAgainst: string): PatientWriteVersion | undefined {
  for (const entry of response.entry ?? []) {
    const location = entry.response?.location;
    const match = location?.match(/(?:^|\/)(Patient\/[A-Za-z0-9.-]{1,64})\/_history\/([A-Za-z0-9.-]{1,64})$/);
    if (match?.[1] === patientReference) return { writtenAgainst, current: match[2] };
  }
  return undefined;
}
