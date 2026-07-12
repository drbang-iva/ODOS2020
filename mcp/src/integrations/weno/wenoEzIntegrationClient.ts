import { isWenoConfigured, type WenoEzIntegrationConfig } from "./config.js";
import { encryptWenoPayload } from "./wenoCrypto.js";

const PHARMACY_DIRECTORY_DOWNLOAD_TIMEOUT_MS = 30_000;

export const WENO_ALTERNATIVE_CONTACT_RELATIONSHIP = {
  NOT_APPLICABLE: 0,
  SPOUSE: 1,
  CHILD: 2,
  PARENT: 3,
  GRANDPARENT: 4,
  GRANDCHILD: 5,
  AUNT_OR_UNCLE: 6,
  NIECE_OR_NEPHEW: 7,
  COUSIN: 8,
  ADOPTED_CHILD: 9,
  FOSTER_CHILD: 10,
  CHILD_IN_LAW: 11,
  SIBLING_IN_LAW: 12,
  PARENT_IN_LAW: 13,
  SIBLING: 14,
  WARD: 15,
  STEP_PARENT: 16,
  STEP_CHILD: 17,
  SELF: 18,
  EMPLOYEE: 20,
  UNKNOWN: 21,
  EX_SPOUSE: 25,
  GUARDIAN: 26,
} as const;

export type WenoAlternativeContactRelationship =
  typeof WENO_ALTERNATIVE_CONTACT_RELATIONSHIP[keyof typeof WENO_ALTERNATIVE_CONTACT_RELATIONSHIP];

export interface ComposeRxIframeRequest {
  UserEmail: string;
  MD5Password: string;
  LocationID: string;
  TestPatient: "Y" | "N";
  PatientType: "Human" | "NonHuman";
  OrgPatientID: string;
  LastName: string;
  FirstName: string;
  MiddleName?: string;
  Prefix?: string;
  Suffix?: string;
  Gender: "M" | "F" | "U";
  DateOfBirth: string;
  AddressLine1: string;
  AddressLine2?: string;
  City: string;
  State: string;
  PostalCode: string;
  CountryCode: string;
  PrimaryPhone: string;
  SupportsSMS: "Y" | "N";
  PatientEmail?: string;
  Allergy?: string;
  PatientHeight?: string;
  PatientWeight?: string;
  HeightWeightObservationDate?: string;
  ResponsiblePartySameAsPatient: "Y" | "N";
  ResponsiblePartyLastName?: string;
  ResponsiblePartyFirstName?: string;
  ResponsiblePartyAddressLine1?: string;
  ResponsiblePartyAddressLine2?: string;
  ResponsiblePartyCity?: string;
  ResponsiblePartyState?: string;
  ResponsiblePartyPostalCode?: string;
  ResponsiblePartyCountryCode?: string;
  ResponsiblePartyPrimaryPhone?: string;
  ResponsiblePartyEmail?: string;
  AlternativeContactRelationship?: WenoAlternativeContactRelationship;
  PatientLocation: "Home" | "Facility";
  FacilityName?: string;
  FacilityAddressLine1?: string;
  FacilityAddressLine2?: string;
  FacilityCity?: string;
  FacilityState?: string;
  FacilityPostalCode?: string;
  FacilityCountryCode?: string;
  FacilityPrimaryPhone?: string;
  FacilityEmail?: string;
  FacilityFax?: string;
  PrimaryPharmacyNCPCP: string;
  AlternativePharmacyNCPCP?: string;
  PatientDrugAllergyRxCUI?: number[];
  PatientCurrentMedRxCUI?: number[];
}

export interface RxLogIframeRequest {
  UserEmail: string;
  MD5Password: string;
}

export interface NewRxSyncReportRequest {
  UserEmail: string;
  MD5Password: string;
  FromDate: string;
  ToDate: string;
  ResponseFormat?: "CSV" | "JSON";
}

export interface PharmacyDirectoryRequest {
  UserEmail: string;
  MD5Password: string;
  Daily: "Y" | "N";
  ExcludeNonWenoTest?: "Y";
}

export interface NewRxSyncReportRow {
  PatientID: string;
  RelatestoNewRxMsgID: string;
  DeliveryStatus: string;
  DateTimeofactionUTC: string;
  SynchType: string;
}

export function getComposeRxIframeUrl(
  config: WenoEzIntegrationConfig,
  request: ComposeRxIframeRequest,
): string {
  const configured = assertWenoConfigured(config);
  const payload = buildComposeRxPayload(request);
  return buildUrl(configured, "/en/NewRx/ComposeRx", request.UserEmail, payload);
}

export function getRxLogIframeUrl(
  config: WenoEzIntegrationConfig,
  request: RxLogIframeRequest,
): string {
  const configured = assertWenoConfigured(config);
  return buildUrl(configured, "/en/EPCS/RxLog", request.UserEmail, request);
}

export async function pullNewRxSyncReport(
  config: WenoEzIntegrationConfig,
  request: NewRxSyncReportRequest,
): Promise<string> {
  const configured = assertWenoConfigured(config);
  validateSyncDateSpan(request.FromDate, request.ToDate);
  const payload = { ...request, ResponseFormat: request.ResponseFormat ?? "CSV" };
  const response = await fetch(buildUrl(
    configured,
    "/en/EPCS/DownloadNewRxSyncDataVal",
    request.UserEmail,
    payload,
  ), { headers: { Accept: payload.ResponseFormat === "JSON" ? "application/json" : "text/csv" } });
  if (!response.ok) {
    throw new Error(`WENO NewRx Sync Report request failed with HTTP ${response.status}.`);
  }
  return response.text();
}

export async function downloadPharmacyDirectory(
  config: WenoEzIntegrationConfig,
  request: PharmacyDirectoryRequest,
): Promise<ArrayBuffer> {
  const configured = assertWenoConfigured(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PHARMACY_DIRECTORY_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(buildUrl(
      configured,
      "/en/EPCS/DownloadPharmacyDirectory",
      request.UserEmail,
      request,
    ), { headers: { Accept: "application/zip" }, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`WENO Pharmacy Directory request failed with HTTP ${response.status}.`);
    }
    return response.arrayBuffer();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("WENO Pharmacy Directory request timed out after 30 seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildUrl(
  config: Required<WenoEzIntegrationConfig>,
  path: string,
  userEmail: string,
  payload: unknown,
): string {
  const data = encryptWenoPayload(payload, config.encryptionKey);
  return `${config.baseUrl.replace(/\/$/, "")}${path}?useremail=${encodeURIComponent(userEmail)}&data=${encodeURIComponent(data)}`;
}

function assertWenoConfigured(config: WenoEzIntegrationConfig): Required<WenoEzIntegrationConfig> {
  if (!isWenoConfigured(config)) {
    throw new Error("WENO EZ Integration is not configured.");
  }
  return config as Required<WenoEzIntegrationConfig>;
}

function buildComposeRxPayload(request: ComposeRxIframeRequest): ComposeRxIframeRequest {
  return {
    UserEmail: request.UserEmail,
    MD5Password: request.MD5Password,
    LocationID: request.LocationID,
    TestPatient: request.TestPatient,
    PatientType: request.PatientType,
    OrgPatientID: request.OrgPatientID,
    LastName: request.LastName,
    FirstName: request.FirstName,
    ...optional("MiddleName", request.MiddleName),
    ...optional("Prefix", request.Prefix),
    ...optional("Suffix", request.Suffix),
    Gender: request.Gender,
    DateOfBirth: request.DateOfBirth,
    AddressLine1: request.AddressLine1,
    ...optional("AddressLine2", request.AddressLine2),
    City: request.City,
    State: request.State,
    PostalCode: request.PostalCode,
    CountryCode: request.CountryCode,
    PrimaryPhone: request.PrimaryPhone,
    SupportsSMS: request.SupportsSMS,
    ...optional("PatientEmail", request.PatientEmail),
    ...optional("Allergy", request.Allergy),
    ...optional("PatientHeight", request.PatientHeight),
    ...optional("PatientWeight", request.PatientWeight),
    ...optional("HeightWeightObservationDate", request.HeightWeightObservationDate),
    ResponsiblePartySameAsPatient: request.ResponsiblePartySameAsPatient,
    ...optional("ResponsiblePartyLastName", request.ResponsiblePartyLastName),
    ...optional("ResponsiblePartyFirstName", request.ResponsiblePartyFirstName),
    ...optional("ResponsiblePartyAddressLine1", request.ResponsiblePartyAddressLine1),
    ...optional("ResponsiblePartyAddressLine2", request.ResponsiblePartyAddressLine2),
    ...optional("ResponsiblePartyCity", request.ResponsiblePartyCity),
    ...optional("ResponsiblePartyState", request.ResponsiblePartyState),
    ...optional("ResponsiblePartyPostalCode", request.ResponsiblePartyPostalCode),
    ...optional("ResponsiblePartyCountryCode", request.ResponsiblePartyCountryCode),
    ...optional("ResponsiblePartyPrimaryPhone", request.ResponsiblePartyPrimaryPhone),
    ...optional("ResponsiblePartyEmail", request.ResponsiblePartyEmail),
    ...optional("AlternativeContactRelationship", request.AlternativeContactRelationship),
    PatientLocation: request.PatientLocation,
    ...optional("FacilityName", request.FacilityName),
    ...optional("FacilityAddressLine1", request.FacilityAddressLine1),
    ...optional("FacilityAddressLine2", request.FacilityAddressLine2),
    ...optional("FacilityCity", request.FacilityCity),
    ...optional("FacilityState", request.FacilityState),
    ...optional("FacilityPostalCode", request.FacilityPostalCode),
    ...optional("FacilityCountryCode", request.FacilityCountryCode),
    ...optional("FacilityPrimaryPhone", request.FacilityPrimaryPhone),
    ...optional("FacilityEmail", request.FacilityEmail),
    ...optional("FacilityFax", request.FacilityFax),
    PrimaryPharmacyNCPCP: request.PrimaryPharmacyNCPCP,
    ...optional("AlternativePharmacyNCPCP", request.AlternativePharmacyNCPCP),
    ...optional("PatientDrugAllergyRxCUI", request.PatientDrugAllergyRxCUI),
    ...optional("PatientCurrentMedRxCUI", request.PatientCurrentMedRxCUI),
  };
}

function optional<Key extends keyof ComposeRxIframeRequest>(
  key: Key,
  value: ComposeRxIframeRequest[Key],
): Partial<Pick<ComposeRxIframeRequest, Key>> {
  if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return {};
  return { [key]: value } as Pick<ComposeRxIframeRequest, Key>;
}

function validateSyncDateSpan(fromDate: string, toDate: string): void {
  const from = parseDate(fromDate, "FromDate");
  const to = parseDate(toDate, "ToDate");
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (days < 0) {
    throw new Error("WENO Sync Report ToDate must be on or after FromDate.");
  }
  if (days > 7) {
    throw new Error("WENO Sync Report date range cannot exceed 7 days.");
  }
}

function parseDate(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`WENO Sync Report ${field} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`WENO Sync Report ${field} must be a valid calendar date.`);
  }
  return parsed;
}
