import { fhir } from "./fhir";

export type WatcherSeverity = "today" | "this-week" | "watch";

export interface WatcherAlert {
  taskId: string;
  watcherId: string;
  severity: WatcherSeverity;
  patientReference: string;
  patientDisplay: string;
  appointmentReference: string;
  appointmentId: string;
  appointmentAt: string;
  message: string;
  frontDeskMessage: string;
  consequence: string;
  primaryAction: { label: string; href: string };
  dismissalReasons: Array<{ code: string; display: string }>;
  balanceCents: number;
  ageDays: number;
}

export interface WatcherDegradedProjection {
  status: "degraded";
  reason: "failed" | "stale" | "never-succeeded";
  lastSuccessfulAt?: string;
}

export type WatcherFrontDeskProjection = WatcherDegradedProjection | {
  status: "healthy";
  lastSuccessfulAt: string;
  alerts: WatcherAlert[];
};

export type WatcherTodayProjection = WatcherDegradedProjection | {
  status: "healthy";
  lastSuccessfulAt: string;
  goLiveAt: string;
  items: WatcherAlert[];
  overflow: { total: number; groups: Array<{ watcherId: string; count: number }> };
  sinceYesterday: {
    today: { patientCount: number; dollarsCents: number };
    yesterday: { patientCount: number; dollarsCents: number };
    delta: { patientCount: number; dollarsCents: number };
  };
};

export type WatcherTaskAction =
  | { action: "dismiss"; reason: string }
  | { action: "snooze"; until: string }
  | { action: "reassign"; practitioner: string }
  | { action: "resolve" };

interface WatcherApiOptions {
  authorization?: string;
  baseUrl?: string;
  request?: typeof fetch;
}

export function loadFrontDeskWatchers(date: string, options: WatcherApiOptions = watcherApiOptions()) {
  return watcherRequest<WatcherFrontDeskProjection>(`/watchers/frontdesk?date=${encodeURIComponent(date)}`, {}, options);
}

export function loadTodayWatchers(date: string, options: WatcherApiOptions = watcherApiOptions()) {
  return watcherRequest<WatcherTodayProjection>(`/watchers/today?date=${encodeURIComponent(date)}`, {}, options);
}

export function updateWatcherTask(taskId: string, action: WatcherTaskAction, options: WatcherApiOptions = watcherApiOptions()) {
  return watcherRequest<{ taskId: string; status: string }>(`/watchers/tasks/${encodeURIComponent(taskId)}/action`, {
    method: "POST",
    body: JSON.stringify(action),
  }, options);
}

export function watcherCollectionHref(alert: WatcherAlert): string {
  const separator = alert.primaryAction.href.includes("?") ? "&" : "?";
  const href = alert.primaryAction.href.includes("collect=")
    ? alert.primaryAction.href
    : `${alert.primaryAction.href}${separator}collect=1`;
  return `${href}&watcherTaskId=${encodeURIComponent(alert.taskId)}`;
}

export function watcherMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

async function watcherRequest<T extends object>(path: string, init: RequestInit, options: WatcherApiOptions): Promise<T> {
  const response = await (options.request ?? fetch)(`${options.baseUrl ?? ""}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(options.authorization ? { Authorization: options.authorization } : {}),
      ...init.headers,
    },
  });
  const body = await response.json() as T | { error?: string };
  if (!response.ok && response.status !== 503) {
    throw new Error("error" in body && body.error ? body.error : `Watcher request failed (${response.status}).`);
  }
  return body as T;
}

function watcherApiOptions(): WatcherApiOptions {
  const meta = import.meta as ImportMeta & { env?: { VITE_ODOS_MCP_BASE_URL?: string } };
  return {
    authorization: fhir.authHeader(),
    baseUrl: meta.env?.VITE_ODOS_MCP_BASE_URL?.replace(/\/$/, "") ?? "",
  };
}
