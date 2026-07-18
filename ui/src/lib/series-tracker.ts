import { authHeaders, clinicalGraphApiBase } from "./clinical-graph-client";

export interface SeriesProtocolDefinition {
  id: string;
  name: string;
  eligibleProcedureTypeCodes: string[];
  sessionCount: number;
  intervalMinDays: number;
  intervalMaxDays: number;
  maintenanceAfter: boolean;
  active: boolean;
  planDefinitionCanonical: string;
  activityDefinitionCanonical: string;
  updatedAt: string;
}

export type SeriesProtocolDefinitionDraft = Pick<
  SeriesProtocolDefinition,
  | "name"
  | "eligibleProcedureTypeCodes"
  | "sessionCount"
  | "intervalMinDays"
  | "intervalMaxDays"
  | "maintenanceAfter"
> & { id?: string };

export interface SeriesDueWindow {
  start: string;
  end: string;
  minWeeks: number;
  maxWeeks: number;
}

export interface SeriesSessionView {
  number: number;
  status: "completed" | "next" | "future";
  actualDate?: string;
  procedureReference?: string;
  dueWindow?: SeriesDueWindow;
}

export interface SeriesTrackerView {
  carePlanReference: string;
  title: string;
  status: string;
  maintenanceAfter: boolean;
  eligibleProcedureTypeCodes: string[];
  sessions: SeriesSessionView[];
}

export interface SeriesSignOffPrompt {
  carePlanReference: string;
  patientReference: string;
  protocolTitle: string;
  nextSessionNumber: number;
  totalSessions: number;
  dueWindow: SeriesDueWindow;
  procedureTypeCode?: string;
}

interface ApiOptions {
  fetchImpl?: typeof fetch;
  authorization?: string;
}

export async function fetchSeriesProtocols(
  includeArchived = false,
  options: ApiOptions = {},
): Promise<SeriesProtocolDefinition[]> {
  const body = await request<{ protocols: SeriesProtocolDefinition[] }>(
    `/series-tracker/protocols?includeArchived=${includeArchived}`,
    undefined,
    options,
  );
  return body.protocols;
}

export async function saveSeriesProtocol(
  draft: SeriesProtocolDefinitionDraft,
  options: ApiOptions = {},
): Promise<SeriesProtocolDefinition> {
  return (await request<{ protocol: SeriesProtocolDefinition }>("/series-tracker/protocols", draft, options)).protocol;
}

export async function archiveSeriesProtocol(
  id: string,
  options: ApiOptions = {},
): Promise<SeriesProtocolDefinition> {
  return (await request<{ protocol: SeriesProtocolDefinition }>(
    `/series-tracker/protocols/${encodeURIComponent(id)}/archive`,
    {},
    options,
  )).protocol;
}

export async function fetchPatientSeries(
  patientReference: string,
  options: ApiOptions = {},
): Promise<SeriesTrackerView[]> {
  const patientId = patientReference.replace(/^Patient\//, "");
  return (await request<{ series: SeriesTrackerView[] }>(
    `/series-tracker/patients/${encodeURIComponent(patientId)}`,
    undefined,
    options,
  )).series;
}

export async function prescribeSeriesProtocol(
  patientReference: string,
  protocolId: string,
  options: ApiOptions = {},
): Promise<SeriesTrackerView> {
  const patientId = patientReference.replace(/^Patient\//, "");
  return (await request<{ series: SeriesTrackerView }>(
    `/series-tracker/patients/${encodeURIComponent(patientId)}/care-plans`,
    { protocolId },
    options,
  )).series;
}

export async function signOffSeriesProcedures(
  encounterId: string,
  options: ApiOptions = {},
): Promise<{ updatedProcedureCount: number; prompt?: SeriesSignOffPrompt }> {
  return request(`/series-tracker/encounters/${encodeURIComponent(encounterId)}/sign-off`, {}, options);
}

export function formatSeriesDueWindow(window: SeriesDueWindow): string {
  return `Due ${shortDate(window.start)}–${shortDate(window.end)} (wk ${weekRange(window)})`;
}

export function formatSeriesSignOffPrompt(prompt: SeriesSignOffPrompt): string {
  return `Session ${prompt.nextSessionNumber} of ${prompt.totalSessions} is due in ~${weekRange(prompt.dueWindow)} weeks.`;
}

function weekRange(window: SeriesDueWindow): string {
  const min = compactNumber(window.minWeeks);
  const max = compactNumber(window.maxWeeks);
  return min === max ? min : `${min}–${max}`;
}

function compactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function shortDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

async function request<T>(path: string, body: unknown, options: ApiOptions): Promise<T> {
  const response = await (options.fetchImpl ?? fetch)(`${clinicalGraphApiBase()}${path}`, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: {
      ...authHeaders(),
      ...(options.authorization ? { Authorization: options.authorization } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Series tracker request failed: ${response.status}`);
  return result;
}
