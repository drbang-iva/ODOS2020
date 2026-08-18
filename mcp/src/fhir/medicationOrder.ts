import type { Extension, Identifier, MedicationRequest, Patient } from "@medplum/fhirtypes";

export const ODOS_TRANSMISSION_METHOD_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-transmission-method";
export const ODOS_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-controlled-substance-flag";
export const ODOS_WENO_DRUG_DB_CODE_QUALIFIER_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-weno-drug-db-code-qualifier";
export const ODOS_WENO_QUANTITY_UNIT_OF_MEASURE_CODE_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-weno-quantity-unit-of-measure-code";
export const ODOS_PREFERRED_PHARMACY_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-preferred-pharmacy";
export const RXNORM_CODE_SYSTEM = "http://www.nlm.nih.gov/research/umls/rxnorm";
export const NCPDP_PROVIDER_IDENTIFIER_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/NCPDPProviderIdentificationNumber";
export const WENO_MESSAGE_ID_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/sid/weno-switch-message-id";

export const MEDICATION_TRANSMISSION_METHOD_CODES = [
  "not-transmitted",
  "printed",
  "phoned-in",
  "electronically-sent",
] as const;
export type MedicationTransmissionMethod =
  (typeof MEDICATION_TRANSMISSION_METHOD_CODES)[number];

export interface MedicationOrderPharmacy {
  ncpdpId: string;
  npi?: string;
  name: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  phone: string;
}

export interface MedicationOrderInput {
  patientReference: string;
  practitionerReference?: string;
  recorderReference?: string;
  encounterReference?: string;
  medicationText: string;
  drugDbCode?: string;
  drugDbCodeQualifier?: string;
  quantityUnitOfMeasureCode?: string;
  isControlledSubstance?: boolean;
  dosageText?: string;
  quantity?: string;
  refills?: number;
  daysSupply?: number;
  routeText?: string;
  reasonReference?: string;
  indicationText?: string;
  pharmacyText?: string;
  pharmacyNcpdpId?: string;
  pharmacy?: MedicationOrderPharmacy;
  transmissionMethod: MedicationTransmissionMethod;
  status?: MedicationRequest["status"];
  identifier?: Identifier[];
  authoredOn?: string;
  reportedBoolean?: boolean;
  note?: MedicationRequest["note"];
}

export function buildMedicationRequest(input: MedicationOrderInput): MedicationRequest {
  const codedDrug = codedDrugFields(input);
  const pharmacy = input.pharmacy ? normalizedPharmacy(input.pharmacy) : undefined;
  const pharmacyText = pharmacy ? pharmacyDisplay(pharmacy) : input.pharmacyText;
  const pharmacyNcpdpId = pharmacy?.ncpdpId ?? input.pharmacyNcpdpId;
  return {
    resourceType: "MedicationRequest",
    ...(input.identifier ? { identifier: input.identifier } : {}),
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
    ...(input.practitionerReference
      ? { requester: { reference: input.practitionerReference } }
      : {}),
    ...(input.recorderReference
      ? { recorder: { reference: input.recorderReference } }
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
    ...(input.quantity || input.refills !== undefined || input.daysSupply !== undefined || pharmacyText || pharmacyNcpdpId
      ? {
          dispenseRequest: {
            ...(input.quantity ? { quantity: { unit: input.quantity } } : {}),
            ...(input.refills !== undefined
              ? { numberOfRepeatsAllowed: input.refills }
              : {}),
            ...(input.daysSupply !== undefined
              ? { expectedSupplyDuration: { value: input.daysSupply, unit: "days" } }
              : {}),
            ...(pharmacyText || pharmacyNcpdpId
              ? {
                  performer: {
                    ...(pharmacyNcpdpId
                      ? { identifier: { system: NCPDP_PROVIDER_IDENTIFIER_SYSTEM, value: pharmacyNcpdpId } }
                      : {}),
                    ...(pharmacyText ? { display: pharmacyText } : {}),
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
      ...(pharmacy ? [pharmacyExtension(pharmacy)] : []),
    ],
    ...(input.note ? { note: input.note } : {}),
  };
}

export function pharmacyFromResource(
  resource: Pick<MedicationRequest | Patient, "extension">,
): MedicationOrderPharmacy | undefined {
  const extension = resource.extension?.find(
    (candidate) => candidate.url === ODOS_PREFERRED_PHARMACY_EXTENSION_URL,
  );
  if (!extension) return undefined;
  const value = (url: string): string | undefined =>
    extension.extension?.find((child) => child.url === url)?.valueString?.trim() || undefined;
  const pharmacy = {
    ncpdpId: value("ncpdpId"),
    npi: value("npi"),
    name: value("name"),
    addressLine1: value("addressLine1"),
    addressLine2: value("addressLine2"),
    city: value("city"),
    state: value("state"),
    postalCode: value("postalCode"),
    phone: value("phone"),
  };
  if (!pharmacy.ncpdpId || !pharmacy.name || !pharmacy.addressLine1
    || !pharmacy.city || !pharmacy.state || !pharmacy.postalCode || !pharmacy.phone) {
    return undefined;
  }
  return pharmacy as MedicationOrderPharmacy;
}

export function withPreferredPharmacy<T extends Patient | MedicationRequest>(
  resource: T,
  pharmacy: MedicationOrderPharmacy | undefined,
): T {
  const extension = (resource.extension ?? []).filter(
    (candidate) => candidate.url !== ODOS_PREFERRED_PHARMACY_EXTENSION_URL,
  );
  return {
    ...resource,
    ...(extension.length || pharmacy
      ? { extension: [...extension, ...(pharmacy ? [pharmacyExtension(normalizedPharmacy(pharmacy))] : [])] }
      : { extension: undefined }),
  };
}

export function pharmacyDisplay(pharmacy: MedicationOrderPharmacy): string {
  const address = [
    [pharmacy.addressLine1, pharmacy.addressLine2].filter(Boolean).join(" "),
    [pharmacy.city, pharmacy.state, pharmacy.postalCode].filter(Boolean).join(" "),
  ].filter(Boolean).join(" · ");
  return [pharmacy.name, address, pharmacy.phone].filter(Boolean).join(" · ");
}

function pharmacyExtension(pharmacy: MedicationOrderPharmacy): Extension {
  return {
    url: ODOS_PREFERRED_PHARMACY_EXTENSION_URL,
    extension: [
      { url: "ncpdpId", valueString: pharmacy.ncpdpId },
      ...(pharmacy.npi ? [{ url: "npi", valueString: pharmacy.npi }] : []),
      { url: "name", valueString: pharmacy.name },
      { url: "addressLine1", valueString: pharmacy.addressLine1 },
      ...(pharmacy.addressLine2 ? [{ url: "addressLine2", valueString: pharmacy.addressLine2 }] : []),
      { url: "city", valueString: pharmacy.city },
      { url: "state", valueString: pharmacy.state },
      { url: "postalCode", valueString: pharmacy.postalCode },
      { url: "phone", valueString: pharmacy.phone },
    ],
  };
}

function normalizedPharmacy(pharmacy: MedicationOrderPharmacy): MedicationOrderPharmacy {
  const requiredFields = [
    "ncpdpId",
    "name",
    "addressLine1",
    "city",
    "state",
    "postalCode",
    "phone",
  ] as const;
  const normalized = Object.fromEntries(
    Object.entries(pharmacy).map(([key, value]) => [key, value?.trim()]),
  ) as unknown as MedicationOrderPharmacy;
  for (const field of requiredFields) {
    if (!normalized[field]) {
      throw new Error(`Structured pharmacy requires ${field}.`);
    }
  }
  return normalized;
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
