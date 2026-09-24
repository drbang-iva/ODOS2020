import { fhir } from "./fhir";
import type { Desk, Doctor } from "../../../mcp/src/clinic/open-charts-types";

export type { Desk, Doctor, DoctorRow, Owner, Reason, ReviewRow } from "../../../mcp/src/clinic/open-charts-types";

export type OpenChartsShape = "doctor" | "desk";

export const OPEN_CHARTS_UNAVAILABLE = "Open charts are unavailable right now.";

const PRACTICE_TIME_ZONE_MESSAGES: Record<string, string> = {
  "practice-time-zone-unset": "Set the practice time zone in Settings → Practice time zone.",
  "practice-time-zone-invalid": "The practice time-zone setting is invalid — fix it in Settings.",
  "practice-time-zone-unreadable": OPEN_CHARTS_UNAVAILABLE,
};

/** The sentence for a practice time-zone error code, shared by the Open charts card and the Clinic summary. */
export function practiceTimeZoneMessage(code: unknown): string | undefined {
  return typeof code === "string" ? PRACTICE_TIME_ZONE_MESSAGES[code] : undefined;
}

export class OpenChartsError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

export function isDoctorOpenCharts(value: Doctor | Desk): value is Doctor {
  return "needsReview" in value;
}

export async function fetchOpenCharts(shape: "doctor", options?: { expandOlder?: boolean }, fetchImpl?: typeof fetch): Promise<Doctor>;
export async function fetchOpenCharts(shape: "desk", options?: { expandOlder?: boolean }, fetchImpl?: typeof fetch): Promise<Desk>;
export async function fetchOpenCharts(shape: OpenChartsShape, options?: { expandOlder?: boolean }, fetchImpl?: typeof fetch): Promise<Doctor | Desk>;
export async function fetchOpenCharts(
  shape: OpenChartsShape,
  { expandOlder = false }: { expandOlder?: boolean } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Doctor | Desk> {
  const path = `${shape === "doctor" ? "/clinic/open-charts" : "/clinic/open-charts/desk"}${expandOlder ? "?expand=older" : ""}`;
  let response: Response;
  try {
    response = await fetchImpl(path, {
      headers: {
        Accept: "application/json",
        ...(fhir.authHeader() ? { Authorization: fhir.authHeader()! } : {}),
      },
    });
  } catch {
    throw new OpenChartsError(OPEN_CHARTS_UNAVAILABLE, 0);
  }
  const body = await response.json().catch(() => undefined) as (Doctor | Desk | { code?: string }) | undefined;
  if (!response.ok || !body) {
    const code = body && "code" in body && typeof body.code === "string" ? body.code : undefined;
    const message = response.status === 409 ? practiceTimeZoneMessage(code) : undefined;
    throw new OpenChartsError(message ?? OPEN_CHARTS_UNAVAILABLE, response.status, code);
  }
  return body as Doctor | Desk;
}
