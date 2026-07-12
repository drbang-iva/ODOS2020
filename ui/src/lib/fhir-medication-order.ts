import type { MedicationRequest } from "@medplum/fhirtypes";

export const OSOD_TRANSMISSION_METHOD_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-transmission-method";
export const OSOD_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-controlled-substance-flag";

export type MedicationTransmissionMethod =
  | "not-transmitted"
  | "printed"
  | "phoned-in"
  | "electronically-sent";

export interface MedicationOrderInput {
  patientReference: string;
  practitionerReference: string;
  encounterReference: string;
  medicationText: string;
  isControlledSubstance?: boolean;
  dosageText: string;
  quantity?: string;
  refills?: number;
  daysSupply?: number;
  routeText?: string;
  reasonReference?: string;
  indicationText?: string;
  pharmacyText?: string;
  transmissionMethod: MedicationTransmissionMethod;
  status?: MedicationRequest["status"];
  authoredOn?: string;
}

export function buildMedicationRequest(input: MedicationOrderInput): MedicationRequest {
  return {
    resourceType: "MedicationRequest",
    status: input.status ?? "active",
    intent: "order",
    medicationCodeableConcept: { text: input.medicationText },
    subject: { reference: input.patientReference },
    requester: { reference: input.practitionerReference },
    encounter: { reference: input.encounterReference },
    authoredOn: input.authoredOn ?? new Date().toISOString(),
    dosageInstruction: [{
      text: input.dosageText,
      ...(input.routeText ? { route: { text: input.routeText } } : {}),
    }],
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
  };
}
