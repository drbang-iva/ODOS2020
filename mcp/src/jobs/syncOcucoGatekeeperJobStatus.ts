import type { Bundle, Task } from "@medplum/fhirtypes";
import {
  canTransitionLabTransportState,
} from "../fhir/labTransportState.js";
import type { OcucoGatekeeperConfig } from "../integrations/ocuco-gatekeeper/config.js";
import {
  isInnovationsJobStatus,
  isLabzillaJobStatus,
  type OcucoGatekeeperClient,
  type OcucoJobStatus,
  type OcucoJobStatusPullResponse,
} from "../integrations/ocuco-gatekeeper/ocucoGatekeeperClient.js";
import { mapOcucoStatusToLabTransportState } from "../integrations/ocuco-gatekeeper/statusMapper.js";
import type { LabOrderAdapter } from "../lab-orders/lab-order-adapter.js";
import { ODOS_OCUCO_ORDER_ID_SYSTEM } from "../lab-orders/adapters/ocuco-gatekeeper-lab-order-adapter.js";
import { transportStateFromTask } from "../lab-orders/adapters/manual-lab-order-adapter.js";

export interface OcucoStatusSyncFhirClient {
  search<T extends Task>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
}

export interface SyncOcucoGatekeeperJobStatusInput {
  config: OcucoGatekeeperConfig;
  client: OcucoGatekeeperClient;
  fhir: OcucoStatusSyncFhirClient;
  adapter: LabOrderAdapter;
  staffReference: string;
  persistRaw(raw: OcucoJobStatusPullResponse): Promise<void>;
  logger?: { warn(message: string): void };
}

export interface SyncOcucoGatekeeperJobStatusResult {
  pulled: number;
  advanced: number;
  unmapped: number;
  unmatched: number;
  illegal: number;
}

export async function syncOcucoGatekeeperJobStatus(
  input: SyncOcucoGatekeeperJobStatusInput,
): Promise<SyncOcucoGatekeeperJobStatusResult> {
  const logger = input.logger ?? console;
  const session = await input.client.authenticate(input.config);
  const contract = await input.client.getContract(session.authToken, input.config);
  const raw = await input.client.pullJobStatus(
    session.authToken,
    contract.hashRoutingKey,
    input.config,
  );
  await input.persistRaw(raw);

  const rows = statusRows(raw);
  const result: SyncOcucoGatekeeperJobStatusResult = {
    pulled: rows.length,
    advanced: 0,
    unmapped: 0,
    unmatched: 0,
    illegal: 0,
  };

  for (const row of rows) {
    const orderId = statusOrderId(row);
    if (!orderId) {
      result.unmatched += 1;
      logger.warn("Ocuco job status has no usable RxNumber or PoNumber; no local Task can be matched.");
      continue;
    }
    const matches = await input.fhir.search<Task>("Task", {
      identifier: `${ODOS_OCUCO_ORDER_ID_SYSTEM}|${orderId}`,
      _count: "2",
    });
    const tasks = (matches.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
    if (tasks.length !== 1 || !tasks[0].id) {
      result.unmatched += 1;
      logger.warn(`Ocuco job status order ${orderId} did not match exactly one local transmission Task.`);
      continue;
    }

    const task = tasks[0];
    const current = transportStateFromTask(task);
    const mapping = mapOcucoStatusToLabTransportState(row.Status, current);
    if (mapping.unmapped) {
      result.unmapped += 1;
      logger.warn(`Ocuco job status is unmapped for order ${orderId}: ${mapping.rawStatus}`);
      continue;
    }
    if (mapping.state === current) continue;
    if (!canTransitionLabTransportState(current, mapping.state)) {
      result.illegal += 1;
      logger.warn(`Ocuco job status is an illegal transition for order ${orderId}: ${current} -> ${mapping.state}.`);
      continue;
    }

    await input.adapter.advanceTransportState({
      labOrderReference: `Task/${task.id}`,
      toState: mapping.state,
      staffReference: input.staffReference,
      note: `Ocuco Gatekeeper status: ${row.Status}`,
    });
    result.advanced += 1;
  }

  return result;
}

export function statusRows(response: OcucoJobStatusPullResponse): OcucoJobStatus[] {
  const rows: OcucoJobStatus[] = [];
  collectStatusRows(response.job_status, rows);
  return rows;
}

function collectStatusRows(value: unknown, rows: OcucoJobStatus[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStatusRows(item, rows);
    return;
  }
  if (isInnovationsJobStatus(value) || isLabzillaJobStatus(value)) rows.push(value);
}

function statusOrderId(row: OcucoJobStatus): string | undefined {
  if (isInnovationsJobStatus(row)) return row.RxNumber.trim() || undefined;
  if (isLabzillaJobStatus(row)) return row.PoNumber.trim() || undefined;
  return undefined;
}
