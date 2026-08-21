// WOL/EZ-era transport, retained under Mode B pending vendor confirmation.
// Encrypts with the EZ key against /en/EPCS/DownloadPharmacyDirectory.
// Has never executed in production — no WENO_EZ_* credentials have ever been set.
// Whether this download grant works for a SWITCH NEWRX partner is runbook Q7, open.

import {
  isWenoDirectoryDownloadConfigured,
  type WenoDirectoryDownloadConfig,
} from "./config.js";
import { encryptWenoPayload } from "./wenoCrypto.js";

const PHARMACY_DIRECTORY_DOWNLOAD_TIMEOUT_MS = 30_000;

export interface PharmacyDirectoryRequest {
  UserEmail: string;
  MD5Password: string;
  Daily: "Y" | "N";
  ExcludeNonWenoTest?: "Y";
}

export async function downloadPharmacyDirectory(
  config: WenoDirectoryDownloadConfig,
  request: PharmacyDirectoryRequest,
): Promise<ArrayBuffer> {
  const configured = assertWenoDirectoryDownloadConfigured(config);
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
  config: Required<WenoDirectoryDownloadConfig>,
  path: string,
  userEmail: string,
  payload: unknown,
): string {
  const data = encryptWenoPayload(payload, config.encryptionKey);
  return `${config.baseUrl.replace(/\/$/, "")}${path}?useremail=${encodeURIComponent(userEmail)}&data=${encodeURIComponent(data)}`;
}

function assertWenoDirectoryDownloadConfigured(
  config: WenoDirectoryDownloadConfig,
): Required<WenoDirectoryDownloadConfig> {
  if (!isWenoDirectoryDownloadConfigured(config)) {
    throw new Error("WENO directory download is not configured.");
  }
  return config as Required<WenoDirectoryDownloadConfig>;
}
