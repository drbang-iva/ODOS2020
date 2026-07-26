import type { Schedule } from "@medplum/fhirtypes";
import { fhir } from "./fhir";

export interface SchedulingIntegrityIssue {
  sourceType: "Schedule" | "Appointment";
  sourceId?: string;
  display: string;
  actorDisplay?: string;
  problem: string;
}

export interface SchedulingResourceReadResult {
  resources: Schedule[];
  issues: SchedulingIntegrityIssue[];
}

export interface SchedulingResourceDeactivationResult {
  deactivated: boolean;
  futureAppointmentCount: number;
}

export interface SchedulingResourceAdminClient {
  listResources(): Promise<SchedulingResourceReadResult>;
  inspectIntegrity(): Promise<SchedulingIntegrityIssue[]>;
  deactivate(
    scheduleId: string,
    acknowledgeFutureAppointments: boolean,
  ): Promise<SchedulingResourceDeactivationResult>;
}

export const schedulingResourceAdmin: SchedulingResourceAdminClient = {
  async listResources() {
    return request<SchedulingResourceReadResult>("/scheduling/resources");
  },

  async inspectIntegrity() {
    const result = await request<{ issues: SchedulingIntegrityIssue[] }>("/scheduling/integrity");
    return result.issues;
  },

  async deactivate(scheduleId, acknowledgeFutureAppointments) {
    return request<SchedulingResourceDeactivationResult>(
      `/scheduling/resources/${encodeURIComponent(scheduleId)}/deactivate`,
      {
        method: "POST",
        body: JSON.stringify({ acknowledgeFutureAppointments }),
      },
      [409],
    );
  },
};

async function request<T>(
  path: string,
  init: RequestInit = {},
  acceptedErrorStatuses: number[] = [],
): Promise<T> {
  const authorization = fhir.authHeader();
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
      ...init.headers,
    },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok && !acceptedErrorStatuses.includes(response.status)) {
    throw new Error(body.error ?? `Scheduler resource request failed with HTTP ${response.status}.`);
  }
  return body;
}
