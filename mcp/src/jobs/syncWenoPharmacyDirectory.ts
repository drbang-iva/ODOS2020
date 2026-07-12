import type { WenoEzIntegrationConfig } from "../integrations/weno/config.js";
import {
  downloadPharmacyDirectory,
  type PharmacyDirectoryRequest,
} from "../integrations/weno/wenoEzIntegrationClient.js";

const WENO_PHARMACY_DIRECTORY_SAMPLE_REQUIRED =
  "WENO pharmacy directory parsing is not yet wired — needs a real WENO pharmacy directory sample file to determine the LITE Excel column schema.";

export type WenoPharmacyDirectoryTrigger =
  | "scheduled-daily"
  | "scheduled-weekly-full"
  | "manual";

export interface PharmacyDirectoryRow {
  ncpdpId: string; // TODO WENO-SAMPLE: verify the LITE workbook column name and value shape.
  onWeno: boolean; // TODO WENO-SAMPLE: verify the LITE workbook column name and encoded values.
}

export interface WenoPharmacyDirectoryStorageClient {
  store(
    rows: PharmacyDirectoryRow[],
    mode: "incremental" | "replace",
  ): Promise<number>;
}

export interface SyncWenoPharmacyDirectoryInput {
  trigger: WenoPharmacyDirectoryTrigger;
  config: WenoEzIntegrationConfig;
  request: PharmacyDirectoryRequest;
  storage: WenoPharmacyDirectoryStorageClient;
}

export interface SyncWenoPharmacyDirectoryResult {
  trigger: WenoPharmacyDirectoryTrigger;
  fetchedBytes: number;
  parsed: number;
  stored: number;
}

export async function syncWenoPharmacyDirectory(
  input: SyncWenoPharmacyDirectoryInput,
): Promise<SyncWenoPharmacyDirectoryResult> {
  const bytes = await downloadPharmacyDirectory(input.config, input.request);
  const rows = parsePharmacyDirectoryZip(bytes);
  const stored = await input.storage.store(
    rows,
    input.request.Daily === "N" ? "replace" : "incremental",
  );
  return {
    trigger: input.trigger,
    fetchedBytes: bytes.byteLength,
    parsed: rows.length,
    stored,
  };
}

// TODO WENO-SAMPLE: unzip and map the LITE workbook only after its real schema is verified.
export function parsePharmacyDirectoryZip(_bytes: ArrayBuffer): PharmacyDirectoryRow[] {
  throw new Error(WENO_PHARMACY_DIRECTORY_SAMPLE_REQUIRED);
}
