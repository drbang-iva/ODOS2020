import { isWenoConfigured, type WenoEzIntegrationConfig } from "./config.js";

const NOT_WIRED_ERROR =
  "WENO EZ Integration not yet wired — see TODO WENO-DASHBOARD markers";

export interface ComposeRxIframeRequest {
  // TODO WENO-DASHBOARD: the exact ComposeRx request field names are available only in WENO's certification dashboard and are unverified.
  unverifiedDashboardPayload: unknown;
}

export interface ComposeRxIframeResponse {
  // TODO WENO-DASHBOARD: the exact ComposeRx response field names, including the iframe URL field, are available only in WENO's certification dashboard and are unverified.
  unverifiedDashboardPayload: unknown;
}

export interface RxLogIframeRequest {
  // TODO WENO-DASHBOARD: the exact RxLog request field names are available only in WENO's certification dashboard and are unverified.
  unverifiedDashboardPayload: unknown;
}

export interface RxLogIframeResponse {
  // TODO WENO-DASHBOARD: the exact RxLog response field names, including the iframe URL field, are available only in WENO's certification dashboard and are unverified.
  unverifiedDashboardPayload: unknown;
}

export interface NewRxSyncReportRequest {
  // TODO WENO-DASHBOARD: the exact NewRx Sync Report request field names are available only in WENO's certification dashboard and are unverified.
  unverifiedDashboardPayload: unknown;
}

export interface NewRxSyncReportResponse {
  // TODO WENO-DASHBOARD: the exact NewRx Sync Report response and row field names are available only in WENO's certification dashboard and are unverified.
  unverifiedDashboardPayload: unknown;
}

export async function getComposeRxIframeUrl(
  config: WenoEzIntegrationConfig,
  _request: ComposeRxIframeRequest,
): Promise<string> {
  assertWenoConfigured(config);
  throw new Error(NOT_WIRED_ERROR);
}

export async function getRxLogIframeUrl(
  config: WenoEzIntegrationConfig,
  _request: RxLogIframeRequest,
): Promise<string> {
  assertWenoConfigured(config);
  throw new Error(NOT_WIRED_ERROR);
}

export async function pullNewRxSyncReport(
  config: WenoEzIntegrationConfig,
  _request: NewRxSyncReportRequest,
): Promise<NewRxSyncReportResponse> {
  assertWenoConfigured(config);
  throw new Error(NOT_WIRED_ERROR);
}

export function encodeWenoBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function decodeWenoBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function assertWenoConfigured(config: WenoEzIntegrationConfig): void {
  if (!isWenoConfigured(config)) {
    throw new Error("WENO EZ Integration is not configured.");
  }
}
