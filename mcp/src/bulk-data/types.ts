import type { Resource } from "@medplum/fhirtypes";

export const BULK_EXPORT_ENDPOINTS = [
  "Group/{id}/$export",
  "Patient/$export",
  "$export",
] as const;

export const BULK_EXPORT_STATUSES = [
  "accepted",
  "in-progress",
  "completed",
  "cancelled",
  "errored",
] as const;

export type BulkExportEndpoint = (typeof BULK_EXPORT_ENDPOINTS)[number];
export type BulkExportStatus = (typeof BULK_EXPORT_STATUSES)[number];

export interface BulkExportJob {
  readonly id: string;
  readonly kickoffEndpoint: BulkExportEndpoint | `Group/${string}/$export`;
  readonly requestingClientId: string;
  readonly requestingTokenHash: string;
  status: BulkExportStatus;
  readonly transactionTime: string;
  readonly requestedTypes?: readonly string[];
  readonly requestedSince?: string;
  manifest?: BulkDataManifest;
  readonly outputDir: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly retentionUntil: string;
  readonly requiresAccessToken: boolean;
  readonly groupId?: string;
  readonly cohortPatientIds?: readonly string[];
  readonly authorizationContext: BulkExportAuthorizationContext;
}

export interface BulkExportAuthorizationContext {
  readonly clientId: string;
  readonly tokenHash: string;
  readonly scope: string;
  readonly patient?: string;
  readonly user?: string;
}

export interface BulkDataManifest {
  readonly transactionTime: string;
  readonly request: string;
  readonly requiresAccessToken: boolean;
  readonly output: readonly BulkDataManifestOutput[];
  readonly error: readonly BulkDataManifestOutput[];
}

export interface BulkDataManifestOutput {
  readonly type: string;
  readonly url: string;
  readonly count?: number;
}

export interface BulkDataExportFixture {
  readonly resources: readonly Resource[];
  readonly groups: ReadonlyMap<string, readonly string[]>;
}

export interface BulkDataRuntimeConfig {
  readonly patientExportEnabled: boolean;
  readonly systemExportEnabled: boolean;
  readonly retentionDays: number;
  readonly outputRoot: string;
  readonly practicePublicBaseUrl: string;
  readonly supportedTypeFilter: boolean;
}
