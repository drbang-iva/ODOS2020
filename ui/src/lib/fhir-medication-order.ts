import type { MedicationRequest } from "@medplum/fhirtypes";

export const ODOS_TRANSMISSION_METHOD_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-transmission-method";
export const ODOS_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-controlled-substance-flag";
export const ODOS_WENO_DRUG_DB_CODE_QUALIFIER_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-weno-drug-db-code-qualifier";
export const ODOS_WENO_QUANTITY_UNIT_OF_MEASURE_CODE_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-weno-quantity-unit-of-measure-code";
export const RXNORM_CODE_SYSTEM = "http://www.nlm.nih.gov/research/umls/rxnorm";
export const NCPDP_PROVIDER_IDENTIFIER_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/NCPDPProviderIdentificationNumber";

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
  drugDbCode?: string;
  drugDbCodeQualifier?: string;
  quantityUnitOfMeasureCode?: string;
  isControlledSubstance?: boolean;
  dosageText: string;
  quantity?: string;
  refills?: number;
  daysSupply?: number;
  routeText?: string;
  reasonReference?: string;
  indicationText?: string;
  pharmacyText?: string;
  pharmacyNcpdpId?: string;
  transmissionMethod: MedicationTransmissionMethod;
  status?: MedicationRequest["status"];
  authoredOn?: string;
}

export function buildMedicationRequest(input: MedicationOrderInput): MedicationRequest {
  const codedDrug = codedDrugFields(input);
  return {
    resourceType: "MedicationRequest",
    status: input.status ?? "active",
    intent: "order",
    medicationCodeableConcept: {
      text: input.medicationText,
      ...(codedDrug
        ? {
            coding: [{
              system: RXNORM_CODE_SYSTEM,
              code: codedDrug.drugDbCode,
              display: input.medicationText,
              extension: [
                {
                  url: ODOS_WENO_DRUG_DB_CODE_QUALIFIER_EXTENSION_URL,
                  valueCode: codedDrug.drugDbCodeQualifier,
                },
                {
                  url: ODOS_WENO_QUANTITY_UNIT_OF_MEASURE_CODE_EXTENSION_URL,
                  valueCode: codedDrug.quantityUnitOfMeasureCode,
                },
              ],
            }],
          }
        : {}),
    },
    subject: { reference: input.patientReference },
    requester: { reference: input.practitionerReference },
    encounter: { reference: input.encounterReference },
    authoredOn: input.authoredOn ?? new Date().toISOString(),
    dosageInstruction: [{
      text: input.dosageText,
      ...(input.routeText ? { route: { text: input.routeText } } : {}),
    }],
    ...(input.quantity || input.refills !== undefined || input.daysSupply !== undefined || input.pharmacyText || input.pharmacyNcpdpId
      ? {
          dispenseRequest: {
            ...(input.quantity ? { quantity: { unit: input.quantity } } : {}),
            ...(input.refills !== undefined
              ? { numberOfRepeatsAllowed: input.refills }
              : {}),
            ...(input.daysSupply !== undefined
              ? { expectedSupplyDuration: { value: input.daysSupply, unit: "days" } }
              : {}),
            ...(input.pharmacyText || input.pharmacyNcpdpId
              ? {
                  performer: {
                    ...(input.pharmacyNcpdpId
                      ? { identifier: { system: NCPDP_PROVIDER_IDENTIFIER_SYSTEM, value: input.pharmacyNcpdpId } }
                      : {}),
                    ...(input.pharmacyText ? { display: input.pharmacyText } : {}),
                  },
                }
              : {}),
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
        url: ODOS_TRANSMISSION_METHOD_EXTENSION_URL,
        valueCode: input.transmissionMethod,
      },
      ...(input.isControlledSubstance === undefined
        ? []
        : [{
            url: ODOS_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL,
            valueBoolean: input.isControlledSubstance,
          }]),
    ],
  };
}

function codedDrugFields(input: MedicationOrderInput): {
  drugDbCode: string;
  drugDbCodeQualifier: string;
  quantityUnitOfMeasureCode: string;
} | undefined {
  const values = [input.drugDbCode, input.drugDbCodeQualifier, input.quantityUnitOfMeasureCode];
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined || !value.trim())) {
    throw new Error(
      "Coded medication input requires drugDbCode, drugDbCodeQualifier, and quantityUnitOfMeasureCode together.",
    );
  }
  return {
    drugDbCode: input.drugDbCode!.trim(),
    drugDbCodeQualifier: input.drugDbCodeQualifier!.trim(),
    quantityUnitOfMeasureCode: input.quantityUnitOfMeasureCode!.trim(),
  };
}
