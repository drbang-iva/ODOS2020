import type { ServiceRequest } from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";

export const REFERRAL_LETTER_BODY_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/referral-letter-body";

export interface ReferralIncludeList {
  letter: boolean;
  demographics: boolean;
  history: boolean;
  clinical_summary: boolean;
  images: boolean;
  hipaa_cover_sheet: boolean;
  history_count: number;
}

export type ReferralPriority = "routine" | "urgent" | "stat";

export interface ReferralConsultant {
  reference: string;
  display: string;
  faxNumber?: string;
}

export interface ReferralDraftUpdate {
  targetReference?: string;
  includeList?: ReferralIncludeList;
  priority?: ReferralPriority;
  reasonText?: string | null;
  letterBody?: string;
}

export interface ReferralArtifactResponse {
  serviceRequestReference: string;
  pdfBase64: string;
  bodyHtml: string;
  documentReference: string;
  provenanceReference?: string;
}

export interface ConsultReportArtifactResponse extends ReferralArtifactResponse {
  sourceEncounter: {
    reference: string;
    date: string;
    label: string;
  };
}

export interface CorrespondenceTemplate {
  id: string;
  name: string;
  letterType: string;
  specialty: string;
  register: "formal" | "warm";
  curated: boolean;
}

export interface FaxStatus {
  reference: string;
  status: string;
  jobId?: string;
  error?: string;
  updatedAt?: string;
}

export interface ReferralFaxResponse {
  fax: FaxStatus;
  provenanceReference?: string;
  warning?: string;
}

export class ReferralConflictError extends Error {}

export interface ReferralApi {
  listTemplates(signal?: AbortSignal): Promise<CorrespondenceTemplate[]>;
  loadDefaults(signal?: AbortSignal): Promise<ReferralIncludeList>;
  saveDefaults(includeList: ReferralIncludeList): Promise<ReferralIncludeList>;
  searchConsultants(query: string, signal?: AbortSignal): Promise<ReferralConsultant[]>;
  loadRecentConsultants(signal?: AbortSignal): Promise<ReferralConsultant[]>;
  createReferral(input: {
    patientId: string;
    targetReference: string;
    encounterReference: string;
    includeList: ReferralIncludeList;
    priority: ReferralPriority;
    reasonText?: string;
  }): Promise<ServiceRequest>;
  createInboundReferral(input: {
    patientId: string;
    referrerReference?: string;
    referrerDisplay: string;
    performerReference: string;
    captureSource: "front-desk" | "fax" | "chart";
    reasonText: string;
  }): Promise<ServiceRequest>;
  listInboundReferrals(patientId: string, signal?: AbortSignal): Promise<ServiceRequest[]>;
  previewConsultReport(
    patientId: string,
    referralId: string,
    signal?: AbortSignal,
  ): Promise<ConsultReportArtifactResponse>;
  updateReferral(patientId: string, referralId: string, input: ReferralDraftUpdate): Promise<ServiceRequest>;
  regenerateReferral(patientId: string, referralId: string): Promise<ServiceRequest>;
  applyTemplate(patientId: string, referralId: string, templateId: string): Promise<ServiceRequest>;
  previewReferral(patientId: string, referralId: string, editedLetterBody: string, templateId?: string): Promise<ReferralArtifactResponse>;
  sendReferral(patientId: string, referralId: string, editedLetterBody: string, templateId?: string): Promise<ReferralArtifactResponse>;
  faxReferral(input: {
    patientId: string;
    referralId: string;
    destinationNumber: string;
    documentBase64: string;
    filename: string;
    billingCode: string;
  }): Promise<ReferralFaxResponse>;
  loadFaxStatus(patientId: string, referralId: string): Promise<FaxStatus | null>;
}

export function createReferralApi(fetchImpl: typeof fetch = fetch): ReferralApi {
  return {
    async listTemplates(signal) {
      const response = await requestJson<{ templates: CorrespondenceTemplate[] }>(
        fetchImpl,
        "/correspondence/templates?letterType=referral",
        { signal },
      );
      return response.templates;
    },

    async loadDefaults(signal) {
      const response = await requestJson<{ includeList: ReferralIncludeList }>(
        fetchImpl,
        "/referrals/defaults",
        { signal },
      );
      return response.includeList;
    },

    async saveDefaults(includeList) {
      const response = await requestJson<{ includeList: ReferralIncludeList }>(
        fetchImpl,
        "/referrals/defaults",
        { method: "PUT", body: { includeList } },
      );
      return response.includeList;
    },

    async searchConsultants(query, signal) {
      const params = new URLSearchParams({ q: query });
      const response = await requestJson<{ consultants: ReferralConsultant[] }>(
        fetchImpl,
        `/referrals/consultants?${params}`,
        { signal },
      );
      return response.consultants;
    },

    async loadRecentConsultants(signal) {
      const response = await requestJson<{ consultants: ReferralConsultant[] }>(
        fetchImpl,
        "/referrals/consultants/recent",
        { signal },
      );
      return response.consultants;
    },

    async createReferral(input) {
      const response = await requestJson<{ serviceRequest: ServiceRequest }>(
        fetchImpl,
        `/referrals/patients/${encodeURIComponent(input.patientId)}`,
        {
          method: "POST",
          body: {
            targetReference: input.targetReference,
            encounterReference: input.encounterReference,
            includeList: input.includeList,
            priority: input.priority,
            ...(input.reasonText?.trim() ? { reasonText: input.reasonText.trim() } : {}),
          },
        },
      );
      return response.serviceRequest;
    },

    async createInboundReferral(input) {
      const response = await requestJson<{ serviceRequest: ServiceRequest }>(
        fetchImpl,
        `/correspondence/inbound-referrals/patients/${encodeURIComponent(input.patientId)}`,
        {
          method: "POST",
          body: {
            ...(input.referrerReference ? { referrerReference: input.referrerReference } : {}),
            referrerDisplay: input.referrerDisplay,
            performerReference: input.performerReference,
            captureSource: input.captureSource,
            reasonText: input.reasonText,
          },
        },
      );
      return response.serviceRequest;
    },

    async listInboundReferrals(patientId, signal) {
      const response = await requestJson<{ serviceRequests: ServiceRequest[] }>(
        fetchImpl,
        `/correspondence/inbound-referrals/patients/${encodeURIComponent(patientId)}`,
        { signal },
      );
      return response.serviceRequests;
    },

    previewConsultReport(patientId, referralId, signal) {
      return requestJson<ConsultReportArtifactResponse>(
        fetchImpl,
        `${inboundReferralPath(patientId, referralId)}/preview`,
        { method: "POST", body: {}, signal },
      );
    },

    async updateReferral(patientId, referralId, input) {
      const response = await requestJson<{ serviceRequest: ServiceRequest }>(
        fetchImpl,
        referralPath(patientId, referralId),
        { method: "PATCH", body: input },
      );
      return response.serviceRequest;
    },

    async regenerateReferral(patientId, referralId) {
      const response = await requestJson<{ serviceRequest: ServiceRequest }>(
        fetchImpl,
        `${referralPath(patientId, referralId)}/regenerate`,
        { method: "POST", body: {} },
      );
      return response.serviceRequest;
    },

    async applyTemplate(patientId, referralId, templateId) {
      const response = await requestJson<{ serviceRequest: ServiceRequest }>(
        fetchImpl,
        `${referralPath(patientId, referralId)}/apply-template`,
        { method: "POST", body: { templateId } },
      );
      return response.serviceRequest;
    },

    previewReferral(patientId, referralId, editedLetterBody, templateId) {
      return requestJson<ReferralArtifactResponse>(
        fetchImpl,
        `${referralPath(patientId, referralId)}/preview`,
        {
          method: "POST",
          body: {
            editedLetterBody,
            ...(templateId ? { templateId } : {}),
          },
        },
      );
    },

    sendReferral(patientId, referralId, editedLetterBody, templateId) {
      return requestJson<ReferralArtifactResponse>(
        fetchImpl,
        `${referralPath(patientId, referralId)}/send`,
        {
          method: "POST",
          body: {
            editedLetterBody,
            ...(templateId ? { templateId } : {}),
          },
        },
      );
    },

    faxReferral(input) {
      const authorization = fhir.authHeader();
      return requestResponse<ReferralFaxResponse>(fetchImpl, faxPath(input.patientId, input.referralId), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/pdf",
          "X-ODOS-Fax-Destination": input.destinationNumber,
          "X-ODOS-Billing-Code": input.billingCode,
          "X-ODOS-Filename": input.filename,
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: base64Bytes(input.documentBase64),
      });
    },

    async loadFaxStatus(patientId, referralId) {
      const response = await requestJson<{ fax: FaxStatus | null }>(
        fetchImpl,
        `${faxPath(patientId, referralId)}/status`,
      );
      return response.fax;
    },
  };
}

export const referralApi = createReferralApi();

export function readReferralLetterBody(serviceRequest: ServiceRequest): string {
  return serviceRequest.extension?.find(
    (extension) => extension.url === REFERRAL_LETTER_BODY_EXTENSION_URL,
  )?.valueString ?? "";
}

function referralPath(patientId: string, referralId: string): string {
  return `/referrals/patients/${encodeURIComponent(patientId)}/${encodeURIComponent(referralId)}`;
}

function inboundReferralPath(patientId: string, referralId: string): string {
  return `/correspondence/inbound-referrals/patients/${encodeURIComponent(patientId)}/${encodeURIComponent(referralId)}`;
}

function faxPath(patientId: string, referralId: string): string {
  return `/fax/referrals/${encodeURIComponent(patientId)}/${encodeURIComponent(referralId)}`;
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  options: {
    method?: "PATCH" | "POST" | "PUT";
    body?: unknown;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const authorization = fhir.authHeader();
  const response = await fetchImpl(url, {
    method: options.method,
    headers: {
      Accept: "application/json",
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(authorization ? { Authorization: authorization } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal: options.signal,
  });
  return responseBody<T>(response);
}

async function requestResponse<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetchImpl(url, init);
  return responseBody<T>(response);
}

async function responseBody<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) {
    const message = body.error ?? `Referral request failed with HTTP ${response.status}.`;
    if (response.status === 409) throw new ReferralConflictError(message);
    throw new Error(message);
  }
  return body;
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
