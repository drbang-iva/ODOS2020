import type { Bundle } from "@medplum/fhirtypes";

export interface PatientWriteVersion {
  writtenAgainst: string;
  current: string;
}

export function patientWriteVersion(response: Bundle, patientReference: string, writtenAgainst: string): PatientWriteVersion | undefined {
  let resourceVersion: string | undefined;
  let locationVersion: string | undefined;
  for (const entry of response.entry ?? []) {
    const resource = entry.resource;
    if (resource?.resourceType === "Patient" && `Patient/${resource.id}` === patientReference
      && typeof resource.meta?.versionId === "string" && resource.meta.versionId.length > 0) {
      resourceVersion = resource.meta.versionId;
    }
    const match = entry.response?.location?.match(/(?:^|\/)(Patient\/[A-Za-z0-9.-]{1,64})\/_history\/([A-Za-z0-9.-]{1,64})$/);
    if (match?.[1] === patientReference) locationVersion = match[2];
  }
  if (resourceVersion && locationVersion && resourceVersion !== locationVersion) return undefined;
  const current = resourceVersion ?? locationVersion;
  return current ? { writtenAgainst, current } : undefined;
}
