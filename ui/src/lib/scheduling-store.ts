import type { Appointment, Bundle, HealthcareService, Resource, Schedule } from "@medplum/fhirtypes";
import { create } from "zustand";
import { fhir } from "./fhir";
import type { ClinicMode, SchedulingPracticeConfig } from "./scheduling";

export const DEFAULT_SCHEDULING_PRACTICE_CONFIG: SchedulingPracticeConfig = {
  timezoneOffset: "-05:00",
  defaultWeeklyHours: {
    mon: [{ start: "08:00", end: "17:00" }],
    tue: [{ start: "08:00", end: "17:00" }],
    wed: [{ start: "08:00", end: "17:00" }],
    thu: [{ start: "08:00", end: "17:00" }],
    fri: [{ start: "08:00", end: "17:00" }],
  },
  weeklyHoursBySchedule: {},
  // Persisted practice scheduling settings land here in a later slice.
  blocks: [
    {
      kind: "custom",
      description: "Lunch",
      weekdays: ["mon", "tue", "wed", "thu", "fri"],
      start: "12:00",
      end: "13:00",
    },
  ],
};

export interface SchedulingFhirClient {
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string> | URLSearchParams | Array<[string, string]>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string): Promise<Bundle<T>>;
}

export interface SchedulingStoreState {
  clinicMode: ClinicMode;
  date: string;
  slotMinutes: number;
  resources: Schedule[];
  visitTypes: HealthcareService[];
  appointments: Appointment[];
  config: SchedulingPracticeConfig;
  catalogsLoaded: boolean;
  loading: boolean;
  error: string | null;
  setClinicMode: (clinicMode: ClinicMode) => void;
  setDate: (date: string) => void;
  shiftDate: (days: number) => void;
  today: () => void;
  loadDay: (deps?: { fhirClient?: SchedulingFhirClient; force?: boolean }) => Promise<void>;
}

export const useSchedulingStore = create<SchedulingStoreState>((set, get) => ({
  clinicMode: "both",
  date: todayYmd(new Date(), DEFAULT_SCHEDULING_PRACTICE_CONFIG.timezoneOffset),
  slotMinutes: 30,
  resources: [],
  visitTypes: [],
  appointments: [],
  config: DEFAULT_SCHEDULING_PRACTICE_CONFIG,
  catalogsLoaded: false,
  loading: false,
  error: null,
  setClinicMode: (clinicMode) => set({ clinicMode }),
  setDate: (date) => set({ date }),
  shiftDate: (days) => set({ date: addDaysYmd(get().date, days) }),
  today: () => set({ date: todayYmd(new Date(), get().config.timezoneOffset) }),
  async loadDay(deps) {
    const client = deps?.fhirClient ?? fhir;
    const date = get().date;
    const config = get().config;
    const shouldLoadCatalogs = deps?.force === true || !get().catalogsLoaded;
    set({ loading: true, error: null });
    try {
      const [resources, visitTypes, appointments] = await Promise.all([
        shouldLoadCatalogs
          ? searchAll<Schedule>(client, "Schedule", { active: "true" })
          : Promise.resolve(get().resources),
        shouldLoadCatalogs
          ? searchAll<HealthcareService>(client, "HealthcareService", { active: "true" })
          : Promise.resolve(get().visitTypes),
        searchAll<Appointment>(
          client,
          "Appointment",
          new URLSearchParams([
            ["date", `ge${date}T00:00:00${config.timezoneOffset}`],
            ["date", `lt${addDaysYmd(date, 1)}T00:00:00${config.timezoneOffset}`],
          ]),
        ),
      ]);
      if (get().date !== date) {
        return;
      }
      set({ resources, visitTypes, appointments, catalogsLoaded: true, loading: false });
    } catch (err) {
      if (get().date !== date) {
        return;
      }
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));

export function todayYmd(
  date = new Date(),
  timezoneOffset = DEFAULT_SCHEDULING_PRACTICE_CONFIG.timezoneOffset,
): string {
  return new Date(date.getTime() + timezoneOffsetMinutes(timezoneOffset) * 60_000)
    .toISOString()
    .slice(0, 10);
}

export function addDaysYmd(date: string, days: number): string {
  const cursor = new Date(`${date}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
}

export async function searchAll<T extends Resource>(
  client: SchedulingFhirClient,
  resourceType: T["resourceType"],
  params?: Record<string, string> | URLSearchParams | Array<[string, string]>,
): Promise<T[]> {
  let bundle = await client.search<T>(resourceType, paramsWithCount(params));
  const resources: T[] = [];
  for (;;) {
    resources.push(
      ...(bundle.entry ?? [])
        .map((entry) => entry.resource)
        .filter((resource): resource is T => Boolean(resource)),
    );
    const nextUrl = bundle.link?.find((link) => link.relation === "next")?.url;
    if (!nextUrl) {
      return resources;
    }
    if (!client.searchUrl) {
      throw new Error(`FHIR search returned a next link for ${resourceType}, but the client cannot fetch it.`);
    }
    bundle = await client.searchUrl<T>(nextUrl);
  }
}

function paramsWithCount(
  params?: Record<string, string> | URLSearchParams | Array<[string, string]>,
): URLSearchParams {
  const searchParams = new URLSearchParams(params);
  if (!searchParams.has("_count")) {
    searchParams.set("_count", "100");
  }
  return searchParams;
}

function timezoneOffsetMinutes(timezoneOffset: string): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(timezoneOffset);
  if (!match) {
    throw new Error(`Timezone offset must be ±HH:MM, got "${timezoneOffset}".`);
  }
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}
