import type { Identifier, MedicationRequest } from "@medplum/fhirtypes";

export const OSOD_TRANSMISSION_METHOD_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-transmission-method";
export const OSOD_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-controlled-substance-flag";

export const MEDICATION_TRANSMISSION_METHOD_CODES = [
  "not-transmitted",
  "printed",
  "phoned-in",
  "electronically-sent",
] as const;
export type MedicationTransmissionMethod =
  (typeof MEDICATION_TRANSMISSION_METHOD_CODES)[number];

export interface MedicationOrderInput {
  patientReference: string;
  practitionerReference?: string;
  encounterReference?: string;
  medicationText: string;
  isControlledSubstance?: boolean;
  dosageText?: string;
  quantity?: string;
  refills?: number;
  daysSupply?: number;
  routeText?: string;
  reasonReference?: string;
  indicationText?: string;
  pharmacyText?: string;
  transmissionMethod: MedicationTransmissionMethod;
  status?: MedicationRequest["status"];
  identifier?: Identifier[];
  authoredOn?: string;
  reportedBoolean?: boolean;
  note?: MedicationRequest["note"];
}

export function buildMedicationRequest(input: MedicationOrderInput): MedicationRequest {
  return {
    resourceType: "MedicationRequest",
    ...(input.identifier ? { identifier: input.identifier } : {}),
    status: input.status ?? "active",
    intent: "order",
    medicationCodeableConcept: { text: input.medicationText },
    subject: { reference: input.patientReference },
    ...(input.practitionerReference
      ? { requester: { reference: input.practitionerReference } }
      : {}),
    ...(input.encounterReference ? { encounter: { reference: input.encounterReference } } : {}),
    authoredOn: input.authoredOn ?? new Date().toISOString(),
    ...(input.reportedBoolean === undefined
      ? {}
      : { reportedBoolean: input.reportedBoolean }),
    ...(input.dosageText || input.routeText
      ? {
          dosageInstruction: [{
            ...(input.dosageText ? { text: input.dosageText } : {}),
            ...(input.routeText ? { route: { text: input.routeText } } : {}),
          }],
        }
      : {}),
    ...(input.quantity || input.refills !== undefined || input.daysSupply !== undefined || input.pharmacyText
      ? {
          dispenseRequest: {
            ...(input.quantity ? { quantity: { unit: input.quantity } } : {}),
            ...(input.refills !== undefined
              ? { numberOfRepeatsAllowed: input.refills }
              : {}),
            ...(input.daysSupply !== undefined
              ? { expectedSupplyDuration: { value: input.daysSupply, unit: "days" } }
              : {}),
            ...(input.pharmacyText ? { performer: { display: input.pharmacyText } } : {}),
          },
        }
      : {}),
    ...(input.reasonReference
      ? { reasonReference: [{ reference: input.reasonReference }] }
      : input.indicationText
        ? { reasonCode: [{ text: input.indicationText }] }
        : {}),
    extension: [
      {
        url: OSOD_TRANSMISSION_METHOD_EXTENSION_URL,
        valueCode: input.transmissionMethod,
      },
      {
        url: OSOD_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL,
        valueBoolean: input.isControlledSubstance ?? false,
      },
    ],
    ...(input.note ? { note: input.note } : {}),
  };
}
