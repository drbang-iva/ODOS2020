import type { Appointment, Bundle, HealthcareService, Resource, Schedule } from "@medplum/fhirtypes";
import { create } from "zustand";
import { fhir } from "./fhir";
import {
  appointmentDurationMinutes,
  appointmentVisitTypeCode,
  confirmationStatusOf,
  isFollowUpAppointment,
  isUrgentAppointment,
  medicalCoverageOf,
  osodAppointmentStatusOf,
  scheduleReferenceForActor,
  validateAndBuildSchedulingAppointment,
  visionCoverageOf,
  type AppointmentConfirmationStatus,
  type BookSchedulingAppointmentInput,
  type ClinicMode,
  type CoverageInput,
  type OsodAppointmentStatus,
  type SchedulingPracticeConfig,
} from "./scheduling";

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
  create?<T extends Resource>(resource: T, sourceTag: string): Promise<T>;
  update?<T extends Resource>(resource: T, sourceTag: string): Promise<T>;
}

export interface SchedulingWriteDeps {
  fhirClient?: SchedulingFhirClient;
  now?: () => string;
}

export interface AppointmentChangeInput {
  patient?: { reference: string; display?: string } | null;
  description?: string;
  visitTypeCode?: string;
  resourceScheduleReferences?: string[];
  start?: string;
  durationMinutes?: number;
  status?: OsodAppointmentStatus;
  confirmation?: AppointmentConfirmationStatus;
  visionCoverage?: CoverageInput;
  medicalCoverage?: CoverageInput;
  notes?: string;
  urgent?: boolean;
  followUp?: boolean;
  allowDoubleBook?: boolean;
}

export interface MoveAppointmentInput {
  start: string;
  resourceScheduleActor: string;
  allowDoubleBook?: boolean;
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
  createAppointment: (
    input: BookSchedulingAppointmentInput,
    deps?: SchedulingWriteDeps,
  ) => Promise<void>;
  updateAppointment: (
    appointment: Appointment,
    changes: AppointmentChangeInput,
    deps?: SchedulingWriteDeps,
  ) => Promise<void>;
  setAppointmentStatus: (
    appointment: Appointment,
    osodStatus: OsodAppointmentStatus,
    deps?: SchedulingWriteDeps,
  ) => Promise<void>;
  setConfirmationStatus: (
    appointment: Appointment,
    code: AppointmentConfirmationStatus,
    deps?: SchedulingWriteDeps,
  ) => Promise<void>;
  moveAppointment: (
    appointment: Appointment,
    input: MoveAppointmentInput,
    deps?: SchedulingWriteDeps,
  ) => Promise<void>;
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
  async createAppointment(input, deps) {
    const client = deps?.fhirClient ?? fhir;
    set({ loading: true, error: null });
    try {
      const appointment = validateAndBuildSchedulingAppointment({
        clinicMode: get().clinicMode,
        visitTypes: get().visitTypes,
        resources: get().resources,
        appointments: get().appointments,
        input,
        now: deps?.now,
      });
      await createResource(client, appointment, "scheduler");
      await get().loadDay({ fhirClient: client });
    } catch (err) {
      set({ loading: false, error: errorMessage(err) });
      throw err;
    }
  },
  async updateAppointment(appointment, changes, deps) {
    await writeAppointmentUpdate(get, set, appointment, changes, deps, "scheduler-update");
  },
  async setAppointmentStatus(appointment, osodStatus, deps) {
    await writeAppointmentUpdate(
      get,
      set,
      appointment,
      { status: osodStatus },
      deps,
      "scheduler-status",
    );
  },
  async setConfirmationStatus(appointment, code, deps) {
    await writeAppointmentUpdate(
      get,
      set,
      appointment,
      { confirmation: code },
      deps,
      "scheduler-confirmation",
    );
  },
  async moveAppointment(appointment, input, deps) {
    const targetSchedule = input.resourceScheduleActor.startsWith("Schedule/")
      ? input.resourceScheduleActor
      : scheduleReferenceForActor(get().resources, input.resourceScheduleActor);
    if (!targetSchedule) {
      const err = new Error(
        `Move target ${input.resourceScheduleActor} is not a loaded scheduler resource actor.`,
      );
      set({ error: err.message });
      throw err;
    }
    await writeAppointmentUpdate(
      get,
      set,
      appointment,
      {
        start: input.start,
        resourceScheduleReferences: [targetSchedule],
        allowDoubleBook: input.allowDoubleBook,
      },
      deps,
      "scheduler-move",
    );
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

async function writeAppointmentUpdate(
  get: () => SchedulingStoreState,
  set: (state: Partial<SchedulingStoreState>) => void,
  appointment: Appointment,
  changes: AppointmentChangeInput,
  deps: SchedulingWriteDeps | undefined,
  sourceTag: string,
): Promise<void> {
  const client = deps?.fhirClient ?? fhir;
  set({ loading: true, error: null });
  try {
    const updated = rebuildAppointmentForUpdate(get(), appointment, changes, deps?.now);
    await updateResource(client, updated, sourceTag);
    await get().loadDay({ fhirClient: client });
  } catch (err) {
    set({ loading: false, error: errorMessage(err) });
    throw err;
  }
}

function rebuildAppointmentForUpdate(
  state: SchedulingStoreState,
  appointment: Appointment,
  changes: AppointmentChangeInput,
  now?: () => string,
): Appointment {
  const existingPatient = patientInputOf(appointment);
  const patient =
    changes.patient === null ? undefined : changes.patient !== undefined ? changes.patient : existingPatient;
  const description =
    changes.description !== undefined ? cleanOptionalString(changes.description) : appointment.description;
  const visitTypeCode = changes.visitTypeCode ?? appointmentVisitTypeCode(appointment);
  if (!visitTypeCode) {
    throw new Error("Appointment update requires a visit-type catalog code.");
  }
  const start = changes.start ?? appointment.start;
  if (!start) {
    throw new Error("Appointment update requires an appointment start time.");
  }
  const resourceScheduleReferences =
    changes.resourceScheduleReferences ?? resourceScheduleReferencesOf(state.resources, appointment);
  const built = validateAndBuildSchedulingAppointment({
    clinicMode: state.clinicMode,
    visitTypes: state.visitTypes,
    resources: state.resources,
    appointments: state.appointments,
    input: {
      ...(patient ? { patient } : {}),
      ...(description ? { description } : {}),
      visitTypeCode,
      resourceScheduleReferences,
      start,
      durationMinutes: changes.durationMinutes ?? appointmentDurationMinutes(appointment),
      status: changes.status ?? osodAppointmentStatusOf(appointment) ?? "scheduled",
      confirmation: changes.confirmation ?? confirmationStatusOf(appointment) ?? "not-confirmed",
      ...(changes.visionCoverage !== undefined
        ? { visionCoverage: changes.visionCoverage }
        : coverageInput(visionCoverageOf(appointment), "visionCoverage")),
      ...(changes.medicalCoverage !== undefined
        ? { medicalCoverage: changes.medicalCoverage }
        : coverageInput(medicalCoverageOf(appointment), "medicalCoverage")),
      notes: changes.notes !== undefined ? changes.notes : appointment.comment,
      urgent: changes.urgent ?? isUrgentAppointment(appointment),
      followUp: changes.followUp ?? isFollowUpAppointment(appointment),
      allowDoubleBook: changes.allowDoubleBook,
      created: appointment.created,
    },
    now,
    ignoreAppointmentId: appointment.id,
  });
  return {
    ...built,
    ...(appointment.id ? { id: appointment.id } : {}),
    ...(appointment.meta ? { meta: appointment.meta } : {}),
  };
}

function patientInputOf(appointment: Appointment): { reference: string; display?: string } | undefined {
  const actor = appointment.participant.find((participant) =>
    participant.actor?.reference?.startsWith("Patient/"),
  )?.actor;
  if (!actor?.reference) {
    return undefined;
  }
  return {
    reference: actor.reference,
    ...(actor.display ? { display: actor.display } : {}),
  };
}

function resourceScheduleReferencesOf(resources: Schedule[], appointment: Appointment): string[] {
  return appointment.participant
    .map((participant) => participant.actor?.reference)
    .filter(
      (reference): reference is string =>
        typeof reference === "string" && !reference.startsWith("Patient/"),
    )
    .map((actorReference) => scheduleReferenceForActor(resources, actorReference))
    .filter((reference): reference is string => Boolean(reference));
}

function coverageInput(
  coverage: CoverageInput | undefined,
  _key: "visionCoverage" | "medicalCoverage",
): { visionCoverage?: CoverageInput; medicalCoverage?: CoverageInput } {
  return coverage ? { [_key]: coverage } : {};
}

async function createResource<T extends Resource>(
  client: SchedulingFhirClient,
  resource: T,
  sourceTag: string,
): Promise<T> {
  if (!client.create) {
    throw new Error("FHIR client cannot create scheduler appointments.");
  }
  return client.create(resource, sourceTag);
}

async function updateResource<T extends Resource>(
  client: SchedulingFhirClient,
  resource: T,
  sourceTag: string,
): Promise<T> {
  if (!client.update) {
    throw new Error("FHIR client cannot update scheduler appointments.");
  }
  return client.update(resource, sourceTag);
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
