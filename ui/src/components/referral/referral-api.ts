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
}

export interface ReferralDraftUpdate {
  targetReference?: string;
  includeList?: ReferralIncludeList;
  priority?: ReferralPriority;
  reasonText?: string;
}

export interface ReferralArtifactResponse {
  serviceRequestReference: string;
  artifact: string;
  provenanceReference?: string;
}

export class ReferralConflictError extends Error {}

export interface ReferralApi {
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
  updateReferral(patientId: string, referralId: string, input: ReferralDraftUpdate): Promise<ServiceRequest>;
  regenerateReferral(patientId: string, referralId: string): Promise<ServiceRequest>;
  previewReferral(patientId: string, referralId: string, editedLetterBody: string): Promise<ReferralArtifactResponse>;
  sendReferral(patientId: string, referralId: string, editedLetterBody: string): Promise<ReferralArtifactResponse>;
}

export function createReferralApi(fetchImpl: typeof fetch = fetch): ReferralApi {
  return {
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

    previewReferral(patientId, referralId, editedLetterBody) {
      return requestJson<ReferralArtifactResponse>(
        fetchImpl,
        `${referralPath(patientId, referralId)}/preview`,
        { method: "POST", body: { editedLetterBody } },
      );
    },

    sendReferral(patientId, referralId, editedLetterBody) {
      return requestJson<ReferralArtifactResponse>(
        fetchImpl,
        `${referralPath(patientId, referralId)}/send`,
        { method: "POST", body: { editedLetterBody } },
      );
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
  const body = await response.json() as T & { error?: string };
  if (!response.ok) {
    const message = body.error ?? `Referral request failed with HTTP ${response.status}.`;
    if (response.status === 409) throw new ReferralConflictError(message);
    throw new Error(message);
  }
  return body;
}
