import { authHeaders, clinicalGraphApiBase } from "./clinical-graph-client";

export type SmsLaneRole = "transactional-sms" | "marketing-sms" | "clinical-sms";

export interface SmsOptOutLane {
  label: string;
  number: string;
  roles: SmsLaneRole[];
}

export interface SmsOptOutState {
  patientReference: string;
  smsOptedOut: boolean;
  remainingOptOuts: {
    global: boolean;
    numbers: string[];
  };
  smsLanes: SmsOptOutLane[];
}

export type SmsOptOutIdentityVerification = "in-person" | "phone-verified" | "portal";

export interface ClearSmsOptOutResult {
  patientReference: string;
  smsOptedOut: boolean;
  cleared: boolean;
  suppressionCleared?: boolean;
  remainingOptOuts?: {
    global: boolean;
    numbers: string[];
  };
}

export interface SmsSendResult {
  outcome: "sent" | "suppressed" | "rescheduled";
  providerMessageId?: string;
  reason?: string;
  rescheduledAt?: string;
}

export class CommunicationsResponseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function readSmsOptOut(
  patientReference: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SmsOptOutState> {
  const response = await fetchImpl(
    `${clinicalGraphApiBase()}/communications/opt-out?patient=${encodeURIComponent(patientReference)}`,
    { headers: authHeaders() },
  );
  const body = await response.json().catch(() => ({})) as SmsOptOutState & { error?: string };
  if (!response.ok) {
    throw new CommunicationsResponseError(
      response.status,
      body.error ?? `SMS opt-out state failed (${response.status}).`,
    );
  }
  return body;
}

export async function clearSmsOptOut(
  input: {
    patientReference: string;
    reason: string;
    identityVerification: SmsOptOutIdentityVerification;
    number?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ClearSmsOptOutResult> {
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/opt-out/clear`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as ClearSmsOptOutResult & { error?: string };
  if (!response.ok) {
    throw new CommunicationsResponseError(
      response.status,
      body.error ?? `SMS opt-out clear failed (${response.status}).`,
    );
  }
  return body;
}

export async function sendSms(
  input: {
    patientReference: string;
    body: string;
    idempotencyKey: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<SmsSendResult> {
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/messages`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as SmsSendResult & { error?: string };
  if (!response.ok) {
    throw new CommunicationsResponseError(
      response.status,
      body.error ?? `SMS send failed (${response.status}).`,
    );
  }
  return body;
}
