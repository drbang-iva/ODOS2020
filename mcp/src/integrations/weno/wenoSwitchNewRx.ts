import { randomUUID } from "node:crypto";
import type {
  Address,
  HumanName,
  MedicationRequest,
  Patient,
  Practitioner,
} from "@medplum/fhirtypes";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { ODOS_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL } from "../../fhir/medicationOrder.js";
import { isWenoSwitchConfigured, type WenoSwitchConfig } from "./config.js";

export const WENO_SWITCH_CERT_ENDPOINT =
  "https://cert.wenoexchange.com/wenox/restapi/WenoSwitch";

const SCRIPT_VERSION = "20170715";
const NON_CONTROLLED_DEA_SCHEDULE_CODE = "C38046";
const NPI_SYSTEM = "http://hl7.org/fhir/sid/us-npi";
const sentMessageIds = new Set<string>();

export interface WenoSwitchPharmacy {
  ncpdpId: string;
  npi?: string;
  name: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  phone: string;
}

export interface BuildWenoSwitchNewRxInput {
  patient: Patient;
  prescriber: Practitioner;
  medicationRequest: MedicationRequest;
  pharmacy: WenoSwitchPharmacy;
  drugDbCode: string;
  drugDbCodeQualifier: string;
  quantityUnitOfMeasureCode: string;
  config: WenoSwitchConfig;
  messageId: string;
  sentTime: string;
  prescriberPlaceOfService?: string;
}

// A Status result confirms only WENO's synchronous acceptance, never pharmacy delivery.
export type WenoSwitchNewRxResult =
  | { kind: "status"; code: string; description: string }
  | { kind: "error"; code: string; descriptionCode: string; description: string };

export interface SendWenoSwitchNewRxOptions {
  fetchImpl?: typeof fetch;
}

export function createWenoSwitchMessageId(): string {
  return randomUUID().replaceAll("-", "");
}

export function buildWenoSwitchNewRx(input: BuildWenoSwitchNewRxInput): string {
  const config = requireSwitchConfig(input.config);
  if (input.medicationRequest.extension?.some((extension) =>
    extension.url === ODOS_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL
      && extension.valueBoolean === true
  )) {
    throw new Error("WENO Switch NewRx supports non-controlled prescriptions only.");
  }
  const patientName = requiredName(input.patient.name, "Patient name");
  const patientAddress = requiredAddress(input.patient.address, "Patient address");
  const prescriberName = requiredName(input.prescriber.name, "Prescriber name");
  const prescriberAddress = requiredAddress(input.prescriber.address, "Prescriber address");
  const patientGender = requiredGender(input.patient.gender);
  const patientBirthDate = requiredDate(input.patient.birthDate, "Patient date of birth");
  const prescriberNpi = required(
    input.prescriber.identifier?.find((identifier) => identifier.system === NPI_SYSTEM)?.value,
    "Prescriber NPI",
  );
  const drugDescription = required(
    input.medicationRequest.medicationCodeableConcept?.text,
    "DrugDescription",
  );
  if (drugDescription.length > 105) {
    throw new Error("WENO NewRx DrugDescription must be 105 characters or fewer.");
  }
  const quantity = medicationQuantity(input.medicationRequest);
  const daysSupply = requiredNumber(
    input.medicationRequest.dispenseRequest?.expectedSupplyDuration?.value,
    "DaysSupply",
  );
  const numberOfRefills = requiredNumber(
    input.medicationRequest.dispenseRequest?.numberOfRepeatsAllowed,
    "NumberOfRefills",
  );
  const sig = required(input.medicationRequest.dosageInstruction?.[0]?.text, "Sig");
  const writtenDate = isoDateTime(input.medicationRequest.authoredOn, "WrittenDate");
  const sentTime = isoDateTime(input.sentTime, "SentTime");
  const messageId = required(input.messageId, "MessageID");
  validateMessageId(messageId);
  const substitutions = input.medicationRequest.substitution?.allowedBoolean === false ? "1" : "0";

  const patientPhone = phone(input.patient.telecom);
  const prescriberPhone = phone(input.prescriber.telecom);
  const pharmacyNpi = optionalElement("NPI", input.pharmacy.npi);
  const patientCommunication = communicationNumbers(patientPhone);
  const prescriberCommunication = communicationNumbers(prescriberPhone);

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<Message DatatypesVersion="${SCRIPT_VERSION}" TransportVersion="${SCRIPT_VERSION}" TransactionDomain="SCRIPT" TransactionVersion="${SCRIPT_VERSION}" StructuresVersion="${SCRIPT_VERSION}" ECLVersion="${SCRIPT_VERSION}">`,
    "<Header>",
    `<To Qualifier="P">${xml(required(input.pharmacy.ncpdpId, "Pharmacy NCPDP ID"))}</To>`,
    `<From Qualifier="D">${xml(config.routingId)}</From>`,
    `<MessageID>${xml(messageId)}</MessageID>`,
    `<SentTime>${xml(sentTime)}</SentTime>`,
    "<Security>",
    "<UsernameToken>",
    `<Username>${xml(config.partnerId)}</Username>`,
    `<Password Type="PasswordDigest">${xml(config.partnerPasswordMd5)}</Password>`,
    "</UsernameToken>",
    "</Security>",
    "<SenderSoftware>",
    `<SenderSoftwareDeveloper>${xml(config.senderSoftwareDeveloper)}</SenderSoftwareDeveloper>`,
    "<SenderSoftwareProduct>ODOS 20/20</SenderSoftwareProduct>",
    `<SenderSoftwareVersionRelease>${xml(config.senderSoftwareVersion)}</SenderSoftwareVersionRelease>`,
    "</SenderSoftware>",
    "</Header>",
    "<Body>",
    "<NewRx>",
    "<Patient>",
    "<HumanPatient>",
    `<Name><LastName>${xml(patientName.family)}</LastName><FirstName>${xml(patientName.given)}</FirstName></Name>`,
    `<Gender>${patientGender}</Gender>`,
    `<DateOfBirth><Date>${xml(patientBirthDate)}</Date></DateOfBirth>`,
    `<Address><AddressLine1>${xml(patientAddress.line1)}</AddressLine1><City>${xml(patientAddress.city)}</City><StateProvince>${xml(patientAddress.state)}</StateProvince><PostalCode>${xml(patientAddress.postalCode)}</PostalCode><CountryCode>US</CountryCode></Address>`,
    patientCommunication,
    "</HumanPatient>",
    "</Patient>",
    "<Pharmacy>",
    `<Identification><NCPDPID>${xml(required(input.pharmacy.ncpdpId, "Pharmacy NCPDP ID"))}</NCPDPID>${pharmacyNpi}</Identification>`,
    `<BusinessName>${xml(required(input.pharmacy.name, "Pharmacy name"))}</BusinessName>`,
    `<Address><AddressLine1>${xml(required(input.pharmacy.addressLine1, "Pharmacy address"))}</AddressLine1><City>${xml(required(input.pharmacy.city, "Pharmacy city"))}</City><StateProvince>${xml(required(input.pharmacy.state, "Pharmacy state"))}</StateProvince><PostalCode>${xml(required(input.pharmacy.postalCode, "Pharmacy postal code"))}</PostalCode><CountryCode>US</CountryCode></Address>`,
    communicationNumbers(required(input.pharmacy.phone, "Pharmacy phone")),
    "</Pharmacy>",
    "<Prescriber>",
    "<NonVeterinarian>",
    `<Identification><NPI>${xml(prescriberNpi)}</NPI></Identification>`,
    `<Name><LastName>${xml(prescriberName.family)}</LastName><FirstName>${xml(prescriberName.given)}</FirstName><Suffix>OD</Suffix></Name>`,
    `<Address><AddressLine1>${xml(prescriberAddress.line1)}</AddressLine1><City>${xml(prescriberAddress.city)}</City><StateProvince>${xml(prescriberAddress.state)}</StateProvince><PostalCode>${xml(prescriberAddress.postalCode)}</PostalCode><CountryCode>US</CountryCode></Address>`,
    prescriberCommunication,
    `<PrescriberPlaceOfService>${xml(required(input.prescriberPlaceOfService ?? "11", "PrescriberPlaceOfService"))}</PrescriberPlaceOfService>`,
    "</NonVeterinarian>",
    "</Prescriber>",
    "<MedicationPrescribed>",
    `<DrugDescription>${xml(drugDescription)}</DrugDescription>`,
    `<DrugCoded><DrugDBCode><Code>${xml(required(input.drugDbCode, "DrugDBCode"))}</Code><Qualifier>${xml(required(input.drugDbCodeQualifier, "DrugDBCode qualifier"))}</Qualifier></DrugDBCode><DEASchedule><Code>${NON_CONTROLLED_DEA_SCHEDULE_CODE}</Code></DEASchedule></DrugCoded>`,
    `<Quantity><Value>${xml(quantity)}</Value><CodeListQualifier>38</CodeListQualifier><QuantityUnitOfMeasure><Code>${xml(required(input.quantityUnitOfMeasureCode, "QuantityUnitOfMeasure code"))}</Code></QuantityUnitOfMeasure></Quantity>`,
    `<DaysSupply>${daysSupply}</DaysSupply>`,
    `<WrittenDate><DateTime>${xml(writtenDate)}</DateTime></WrittenDate>`,
    `<Substitutions>${substitutions}</Substitutions>`,
    `<NumberOfRefills>${numberOfRefills}</NumberOfRefills>`,
    `<Sig><SigText>${xml(sig)}</SigText></Sig>`,
    "</MedicationPrescribed>",
    "</NewRx>",
    "</Body>",
    "</Message>",
  ].filter(Boolean).join("");
}

export async function sendWenoSwitchNewRx(
  newRxXml: string,
  options: SendWenoSwitchNewRxOptions = {},
): Promise<WenoSwitchNewRxResult> {
  const messageId = validateNewRxXml(newRxXml);
  if (sentMessageIds.has(messageId)) {
    throw new Error(`WENO NewRx MessageID ${messageId} was already sent by this process.`);
  }
  sentMessageIds.add(messageId);

  const response = await (options.fetchImpl ?? fetch)(WENO_SWITCH_CERT_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/xml",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: newRxXml,
  });
  const responseBody = await response.text();
  try {
    return parseWenoSwitchResponse(responseBody);
  } catch (error) {
    if (!response.ok) {
      throw new Error(`WENO Switch request failed with HTTP ${response.status}.`, { cause: error });
    }
    throw error;
  }
}

export function parseWenoSwitchResponse(responseXml: string): WenoSwitchNewRxResult {
  const parsed = parseXml(responseXml, "WENO Switch response");
  const body = objectAt(objectAt(parsed, "Message"), "Body");
  if (body.Status !== undefined) {
    const status = objectValue(body.Status, "Status");
    return {
      kind: "status",
      code: textAt(status, "Code", "Status Code"),
      description: textAt(status, "Description", "Status Description"),
    };
  }
  if (body.Error !== undefined) {
    const error = objectValue(body.Error, "Error");
    return {
      kind: "error",
      code: textAt(error, "Code", "Error Code"),
      descriptionCode: textAt(error, "DescriptionCode", "Error DescriptionCode"),
      description: textAt(error, "Description", "Error Description"),
    };
  }
  throw new Error("WENO Switch response must contain Body/Status or Body/Error.");
}

function validateNewRxXml(newRxXml: string): string {
  const parsed = parseXml(newRxXml, "WENO NewRx");
  const message = objectAt(parsed, "Message");
  const expectedAttributes: Record<string, string> = {
    "@_DatatypesVersion": SCRIPT_VERSION,
    "@_TransportVersion": SCRIPT_VERSION,
    "@_TransactionDomain": "SCRIPT",
    "@_TransactionVersion": SCRIPT_VERSION,
    "@_StructuresVersion": SCRIPT_VERSION,
    "@_ECLVersion": SCRIPT_VERSION,
  };
  for (const [attribute, expected] of Object.entries(expectedAttributes)) {
    if (message[attribute] !== expected) {
      throw new Error(`WENO NewRx Message ${attribute.slice(2)} must be ${expected}.`);
    }
  }

  const header = objectAt(message, "Header");
  const body = objectAt(message, "Body");
  const newRx = objectAt(body, "NewRx");
  const humanPatient = objectAt(objectAt(newRx, "Patient"), "HumanPatient");
  const patientName = objectAt(humanPatient, "Name");
  const patientAddress = objectAt(humanPatient, "Address");
  const pharmacy = objectAt(newRx, "Pharmacy");
  const pharmacyIdentification = objectAt(pharmacy, "Identification");
  const prescriber = objectAt(objectAt(newRx, "Prescriber"), "NonVeterinarian");
  const prescriberIdentification = objectAt(prescriber, "Identification");
  const prescriberName = objectAt(prescriber, "Name");
  const prescriberAddress = objectAt(prescriber, "Address");
  const medication = objectAt(newRx, "MedicationPrescribed");
  const drugDescription = textAt(medication, "DrugDescription", "DrugDescription");
  const drugCoded = objectAt(medication, "DrugCoded");
  const drugDbCode = objectAt(drugCoded, "DrugDBCode");
  const deaSchedule = objectAt(drugCoded, "DEASchedule");
  const quantity = objectAt(medication, "Quantity");
  const quantityUnit = objectAt(quantity, "QuantityUnitOfMeasure");
  const writtenDate = objectAt(medication, "WrittenDate");

  attributedTextAt(header, "To", "Header To");
  attributedTextAt(header, "From", "Header From");
  const messageId = textAt(header, "MessageID", "MessageID");
  validateMessageId(messageId);
  requireOffset(textAt(header, "SentTime", "SentTime"), "SentTime");
  const usernameToken = objectAt(objectAt(header, "Security"), "UsernameToken");
  textAt(usernameToken, "Username", "Security Username");
  attributedTextAt(usernameToken, "Password", "Security Password");
  const senderSoftware = objectAt(header, "SenderSoftware");
  textAt(senderSoftware, "SenderSoftwareDeveloper", "SenderSoftwareDeveloper");
  textAt(senderSoftware, "SenderSoftwareProduct", "SenderSoftwareProduct");
  textAt(senderSoftware, "SenderSoftwareVersionRelease", "SenderSoftwareVersionRelease");
  textAt(patientName, "LastName", "Patient last name");
  textAt(patientName, "FirstName", "Patient first name");
  textAt(humanPatient, "Gender", "Patient gender");
  textAt(objectAt(humanPatient, "DateOfBirth"), "Date", "Patient date of birth");
  requiredAddressXml(patientAddress, "Patient");
  textAt(pharmacyIdentification, "NCPDPID", "Pharmacy NCPDP ID");
  textAt(pharmacy, "BusinessName", "Pharmacy name");
  requiredAddressXml(objectAt(pharmacy, "Address"), "Pharmacy");
  textAt(prescriberIdentification, "NPI", "Prescriber NPI");
  textAt(prescriberName, "LastName", "Prescriber last name");
  textAt(prescriberName, "FirstName", "Prescriber first name");
  requiredAddressXml(prescriberAddress, "Prescriber");
  textAt(prescriber, "PrescriberPlaceOfService", "PrescriberPlaceOfService");
  if (drugDescription.length > 105) {
    throw new Error("WENO NewRx DrugDescription must be 105 characters or fewer.");
  }
  textAt(drugDbCode, "Code", "DrugDBCode");
  textAt(drugDbCode, "Qualifier", "DrugDBCode qualifier");
  if (textAt(deaSchedule, "Code", "DEASchedule Code") !== NON_CONTROLLED_DEA_SCHEDULE_CODE) {
    throw new Error("WENO Switch NewRx supports only DEASchedule C38046 non-controlled messages.");
  }
  textAt(quantity, "Value", "Quantity");
  if (textAt(quantity, "CodeListQualifier", "Quantity CodeListQualifier") !== "38") {
    throw new Error("WENO NewRx Quantity CodeListQualifier must be 38.");
  }
  textAt(quantityUnit, "Code", "QuantityUnitOfMeasure code");
  textAt(medication, "DaysSupply", "DaysSupply");
  requireOffset(textAt(writtenDate, "DateTime", "WrittenDate"), "WrittenDate");
  const substitutions = textAt(medication, "Substitutions", "Substitutions");
  if (substitutions !== "0" && substitutions !== "1") {
    throw new Error("WENO NewRx Substitutions must be 0 or 1.");
  }
  textAt(medication, "NumberOfRefills", "NumberOfRefills");
  textAt(objectAt(medication, "Sig"), "SigText", "Sig");
  return messageId;
}

function requireSwitchConfig(config: WenoSwitchConfig): Required<WenoSwitchConfig> {
  if (!isWenoSwitchConfigured(config)) {
    throw new Error("WENO Switch is not configured.");
  }
  return config as Required<WenoSwitchConfig>;
}

function requiredName(names: HumanName[] | undefined, label: string): { family: string; given: string } {
  const name = names?.find((candidate) => candidate.family && candidate.given?.[0]);
  if (!name) throw new Error(`WENO NewRx missing required ${label}.`);
  return {
    family: required(name.family, `${label} family`),
    given: required(name.given?.[0], `${label} given`),
  };
}

function requiredAddress(addresses: Address[] | undefined, label: string): {
  line1: string;
  city: string;
  state: string;
  postalCode: string;
} {
  const address = addresses?.find((candidate) =>
    candidate.line?.[0] && candidate.city && candidate.state && candidate.postalCode
      && (!candidate.country || candidate.country === "US")
  );
  if (!address) throw new Error(`WENO NewRx missing required ${label}.`);
  return {
    line1: required(address.line?.[0], `${label} line 1`),
    city: required(address.city, `${label} city`),
    state: required(address.state, `${label} state`),
    postalCode: required(address.postalCode, `${label} postal code`),
  };
}

function requiredGender(gender: Patient["gender"]): "M" | "F" {
  if (gender === "male") return "M";
  if (gender === "female") return "F";
  throw new Error("WENO NewRx Patient gender must be male or female.");
}

function validateMessageId(messageId: string): void {
  if (messageId.length > 35 || /\s/.test(messageId)) {
    throw new Error("WENO NewRx MessageID must be 1-35 characters without spaces.");
  }
}

function medicationQuantity(request: MedicationRequest): string {
  const quantity = request.dispenseRequest?.quantity;
  if (quantity?.value !== undefined) return String(quantity.value);
  return required(quantity?.unit, "Quantity");
}

function requiredNumber(value: number | undefined, label: string): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    throw new Error(`WENO NewRx missing required ${label}.`);
  }
  return String(value);
}

function requiredDate(value: string | undefined, label: string): string {
  const date = required(value, label);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`WENO NewRx ${label} must use YYYY-MM-DD.`);
  }
  return date;
}

function isoDateTime(value: string | undefined, label: string): string {
  const requiredValue = required(value, label);
  const parsed = new Date(requiredValue);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`WENO NewRx ${label} must be a valid date-time.`);
  }
  return parsed.toISOString();
}

function phone(telecom: Patient["telecom"] | Practitioner["telecom"]): string | undefined {
  return telecom?.find((contact) => contact.system === "phone" && contact.value)?.value;
}

function communicationNumbers(value: string | undefined): string {
  if (!value) return "";
  return `<CommunicationNumbers><PrimaryTelephone><Number>${xml(value)}</Number></PrimaryTelephone></CommunicationNumbers>`;
}

function optionalElement(name: string, value: string | undefined): string {
  if (!value?.trim()) return "";
  return `<${name}>${xml(value)}</${name}>`;
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`WENO NewRx missing required ${label}.`);
  return value.trim();
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function parseXml(value: string, label: string): Record<string, unknown> {
  const validity = XMLValidator.validate(value);
  if (validity !== true) throw new Error(`${label} is not well-formed XML.`);
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
  }).parse(value) as unknown;
  return objectValue(parsed, label);
}

function objectAt(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return objectValue(value[key], key);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`WENO XML missing required ${label}.`);
  }
  return value as Record<string, unknown>;
}

function textAt(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) {
    throw new Error(`WENO XML missing required ${label}.`);
  }
  return field.trim();
}

function attributedTextAt(value: Record<string, unknown>, key: string, label: string): string {
  const element = objectAt(value, key);
  return textAt(element, "#text", label);
}

function requireOffset(value: string, label: string): void {
  if (!/(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value)) {
    throw new Error(`WENO NewRx ${label} must include a UTC offset.`);
  }
}

function requiredAddressXml(address: Record<string, unknown>, label: string): void {
  textAt(address, "AddressLine1", `${label} address line 1`);
  textAt(address, "City", `${label} city`);
  textAt(address, "StateProvince", `${label} state`);
  textAt(address, "PostalCode", `${label} postal code`);
}
