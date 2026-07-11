import type { WenoEzIntegrationConfig } from "../integrations/weno/config.js";
import {
  pullNewRxSyncReport,
  type NewRxSyncReportRequest,
} from "../integrations/weno/wenoEzIntegrationClient.js";

export type WenoRxSyncTrigger = "scheduled" | "manual";

export interface SyncWenoRxActivityInput {
  trigger: WenoRxSyncTrigger;
  config: WenoEzIntegrationConfig;
  request: NewRxSyncReportRequest;
}

export async function syncWenoRxActivity(input: SyncWenoRxActivityInput): Promise<void> {
  const report = await pullNewRxSyncReport(input.config, input.request);
  // TODO WENO-DASHBOARD: no public NewRx Sync Report join key identifies the matching MedicationRequest; define row matching only after the real dashboard schema is available.
  // Once verified rows flow, update the matching MedicationRequest's osod-transmission-method extension to electronically-sent and advance its status from the verified WENO result.
  void report;
}
