import type { DocumentReference, Reference, ServiceRequest } from "@medplum/fhirtypes";

export const FAX_STATUS_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-fax-transmission-status";
export const FAX_DESTINATION_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-fax-destination";
export const FAX_ERROR_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-fax-error";
export const WESTFAX_JOB_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/westfax-job-id";

export const WESTFAX_RESULTS = [
  "Sent",
  "Dialing",
  "Removed",
  "BadNumber",
  "Busy",
  "NoAnswer",
  "NoFaxDevice",
  "Cancelled",
  "Failed",
  "InvalidNumber",
  "Unknown",
] as const;

export type WestFaxResult = (typeof WESTFAX_RESULTS)[number];
export type FaxTransmissionStatus = "Pending" | WestFaxResult;

export function buildFaxSendRecord(input: {
  serviceRequest: ServiceRequest;
  senderReference: string;
  destinationNumber: string;
  filename: string;
  size: number;
  recordedAt: string;
}): DocumentReference {
  const related: Reference[] = [{ reference: serviceRequestReference(input.serviceRequest) }];
  if (input.serviceRequest.encounter?.reference) related.push(input.serviceRequest.encounter);

  return {
    resourceType: "DocumentReference",
    status: "current",
    type: { text: "Outbound fax transmission" },
    subject: {
      reference: input.serviceRequest.subject.reference,
      ...(input.serviceRequest.subject.display
        ? { display: input.serviceRequest.subject.display }
        : {}),
    },
    date: input.recordedAt,
    author: [{ reference: input.senderReference }],
    description: `Outbound referral fax to ${input.destinationNumber}`,
    content: [{
      attachment: {
        contentType: "application/pdf",
        title: input.filename,
        size: input.size,
      },
    }],
    context: {
      ...(input.serviceRequest.encounter ? { encounter: [input.serviceRequest.encounter] } : {}),
      related,
    },
    extension: [
      { url: FAX_STATUS_EXTENSION_URL, valueString: "Pending" },
      { url: FAX_DESTINATION_EXTENSION_URL, valueString: input.destinationNumber },
    ],
  };
}

export function withFaxSendResult(
  record: DocumentReference,
  input: {
    status: FaxTransmissionStatus;
    jobId?: string;
    error?: string;
    updatedAt: string;
  },
): DocumentReference {
  const extensions = (record.extension ?? []).filter(
    (extension) =>
      extension.url !== FAX_STATUS_EXTENSION_URL &&
      extension.url !== FAX_ERROR_EXTENSION_URL,
  );
  return {
    ...record,
    date: input.updatedAt,
    identifier: input.jobId
      ? replaceIdentifier(record.identifier, WESTFAX_JOB_IDENTIFIER_SYSTEM, input.jobId)
      : record.identifier,
    extension: [
      ...extensions,
      { url: FAX_STATUS_EXTENSION_URL, valueString: input.status },
      ...(input.error ? [{ url: FAX_ERROR_EXTENSION_URL, valueString: input.error }] : []),
    ],
  };
}

export function faxStatus(record: DocumentReference): FaxTransmissionStatus {
  const value = record.extension?.find(
    (extension) => extension.url === FAX_STATUS_EXTENSION_URL,
  )?.valueString;
  if (value === "Pending" || WESTFAX_RESULTS.includes(value as WestFaxResult)) {
    return value as FaxTransmissionStatus;
  }
  return "Unknown";
}

export function westFaxResult(value: unknown): WestFaxResult {
  return typeof value === "string" && WESTFAX_RESULTS.includes(value as WestFaxResult)
    ? value as WestFaxResult
    : "Unknown";
}

function serviceRequestReference(serviceRequest: ServiceRequest): string {
  if (!serviceRequest.id) throw new Error("Fax source referral is missing its id.");
  return `ServiceRequest/${serviceRequest.id}`;
}

function replaceIdentifier(
  identifiers: DocumentReference["identifier"],
  system: string,
  value: string,
): NonNullable<DocumentReference["identifier"]> {
  return [
    ...(identifiers ?? []).filter((identifier) => identifier.system !== system),
    { system, value },
  ];
}
