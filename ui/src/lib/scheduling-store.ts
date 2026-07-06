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
}

export interface SchedulingStoreState {
  clinicMode: ClinicMode;
  date: string;
  slotMinutes: number;
  resources: Schedule[];
  visitTypes: HealthcareService[];
  appointments: Appointment[];
  config: SchedulingPracticeConfig;
  loading: boolean;
  error: string | null;
  setClinicMode: (clinicMode: ClinicMode) => void;
  setDate: (date: string) => void;
  shiftDate: (days: number) => void;
  today: () => void;
  loadDay: (deps?: { fhirClient?: SchedulingFhirClient }) => Promise<void>;
}

export const useSchedulingStore = create<SchedulingStoreState>((set, get) => ({
  clinicMode: "both",
  date: todayYmd(),
  slotMinutes: 30,
  resources: [],
  visitTypes: [],
  appointments: [],
  config: DEFAULT_SCHEDULING_PRACTICE_CONFIG,
  loading: false,
  error: null,
  setClinicMode: (clinicMode) => set({ clinicMode }),
  setDate: (date) => set({ date }),
  shiftDate: (days) => set({ date: addDaysYmd(get().date, days) }),
  today: () => set({ date: todayYmd() }),
  async loadDay(deps) {
    const client = deps?.fhirClient ?? fhir;
    const date = get().date;
    set({ loading: true, error: null });
    try {
      const [resources, visitTypes, appointments] = await Promise.all([
        searchAll<Schedule>(client, "Schedule", { active: "true" }),
        searchAll<HealthcareService>(client, "HealthcareService", { active: "true" }),
        searchAll<Appointment>(
          client,
          "Appointment",
          new URLSearchParams([
            ["date", `ge${date}`],
            ["date", `lt${addDaysYmd(date, 1)}`],
          ]),
        ),
      ]);
      set({ resources, visitTypes, appointments, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));

export function todayYmd(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDaysYmd(date: string, days: number): string {
  const cursor = new Date(`${date}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
}

async function searchAll<T extends Resource>(
  client: SchedulingFhirClient,
  resourceType: T["resourceType"],
  params?: Record<string, string> | URLSearchParams | Array<[string, string]>,
): Promise<T[]> {
  const bundle = await client.search<T>(resourceType, params);
  return (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .filter((resource): resource is T => Boolean(resource));
}
