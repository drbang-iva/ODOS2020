import type { Appointment, Basic, Bundle, Extension, HealthcareService, Resource, Schedule } from "@medplum/fhirtypes";
import { create } from "zustand";
import { fhir } from "./fhir";
import { searchAll } from "./fhir-search";
export { searchAll } from "./fhir-search";
import {
  OSOD_APPOINTMENT_CONFIRMATION_EXTENSION_URL,
  OSOD_DISCIPLINE_SYSTEM,
  OSOD_FOLLOW_UP_EXTENSION_URL,
  OSOD_MEDICAL_COVERAGE_EXTENSION_URL,
  OSOD_VISION_COVERAGE_EXTENSION_URL,
  OSOD_VISIT_TYPE_SYSTEM,
  V2_0276_APPOINTMENT_TYPE_SYSTEM,
  FIND_OPEN_DEFAULT_LIMIT,
  FIND_OPEN_HORIZON_DAYS,
  addMinutesIso,
  appointmentDayBoundsParams,
  appointmentRangeBoundsParams,
  appointmentActorReferences,
  appointmentConfirmationExtension,
  appointmentDurationMinutes,
  appointmentVisitTypeCode,
  addDaysYmd,
  findNextOpenings,
  isNonBlockingAppointmentStatus,
  isResourceVisibleInMode,
  resourceActorReference,
  scheduleReference,
  scheduleReferenceForActor,
  toFhirAppointmentStatus,
  validateAndBuildSchedulingAppointment,
  visitTypeCode,
  visitTypeDiscipline,
  visitTypeDurationMinutes,
  visitTypeEligibleResourceReferences,
  visibleSchedulingResourcesForOffice,
  resolveSlotMinutes,
  ymdFromIsoDateTime,
  type AppointmentConfirmationStatus,
  type BookSchedulingAppointmentInput,
  type ClinicMode,
  type CoverageInput,
  type OsodAppointmentStatus,
  type SchedulingOpening,
  type SchedulingPracticeConfig,
} from "./scheduling";
import { OSOD_FLOOR_STATE_EXTENSION_URL, floorStateExtension, parseFloorState } from "./floor-state";
import {
  bucketAppointmentsByPracticeDay,
  reconcileWeekResourceReference,
  schedulerWindowForView,
  shiftSchedulerDate,
  type SchedulerView,
} from "./scheduling-calendar";
import { resourceScheduleReferencesOf } from "./scheduler-appointment-ui";
import { validateSchedulingPracticeSettings } from "./scheduling-settings";
import {
  OSOD_SCHEDULING_CONFIG_CODE,
  OSOD_SCHEDULING_CONFIG_SYSTEM,
  buildSchedulingPracticeConfigResource,
  parseSchedulingPracticeConfig,
} from "./scheduling-config";

export const SCHEDULING_SOURCE_TAGS = {
  create: "scheduler",
  update: "scheduler-update",
  status: "scheduler-status",
  confirmation: "scheduler-confirmation",
  move: "scheduler-move",
  config: "scheduler-config",
} as const;

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
  blocks: [
    {
      kind: "custom",
      description: "Lunch",
      weekdays: ["mon", "tue", "wed", "thu", "fri"],
      start: "12:00",
      end: "13:00",
    },
  ],
  offices: [{ id: "main", name: "Main Office" }],
  officeBySchedule: {},
};

// Day/week vertical zoom — a per-user viewing preference (session state, not
// practice config) that scales row height so a fine booking increment (10/15
// min) doesn't make a single hour fill the screen.
export const SCHEDULER_ZOOM_MIN = 0.5;
export const SCHEDULER_ZOOM_MAX = 1.75;
export const SCHEDULER_ZOOM_STEP = 0.25;
function clampZoom(zoom: number): number {
  return Number.isFinite(zoom)
    ? Math.min(SCHEDULER_ZOOM_MAX, Math.max(SCHEDULER_ZOOM_MIN, zoom))
    : 1;
}

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
  visionCoverage?: CoverageInput | null;
  medicalCoverage?: CoverageInput | null;
  notes?: string;
  urgent?: boolean;
  followUp?: boolean;
  allowDoubleBook?: boolean;
  /** Floor board station id (cockpit Phase 3a). null clears the floor-state extension. */
  floorStation?: string | null;
}

export interface MoveAppointmentInput {
  start: string;
  resourceScheduleActor: string;
  sourceResourceScheduleActor?: string;
  allowDoubleBook?: boolean;
}

export interface FindOpeningsInput {
  visitTypeCode: string;
  resourceScheduleReference?: string;
  from: string;
  limit?: number;
  horizonDays?: number;
}

export interface LoadedSchedulingWindow {
  fromYmd: string;
  toYmdExclusive: string;
  view: SchedulerView;
  anchorDate: string;
}

export interface SchedulingStoreState {
  clinicMode: ClinicMode;
  view: SchedulerView;
  date: string;
  slotMinutes: number;
  zoom: number;
  resources: Schedule[];
  visitTypes: HealthcareService[];
  appointments: Appointment[];
  appointmentsByDay: Record<string, Appointment[]>;
  loadedWindow: LoadedSchedulingWindow | null;
  config: SchedulingPracticeConfig;
  configResource?: Basic;
  configError: string | null;
  configReadFailed: boolean;
  officeId: string | "all";
  weekResourceScheduleReference?: string;
  catalogsLoaded: boolean;
  loading: boolean;
  error: string | null;
  setClinicMode: (clinicMode: ClinicMode) => void;
  setView: (view: SchedulerView) => void;
  setDate: (date: string) => void;
  openDay: (date: string) => void;
  setOfficeId: (officeId: string | "all") => void;
  setWeekResourceScheduleReference: (reference: string | undefined) => void;
  clearConfigError: () => void;
  shiftDate: (direction: number) => void;
  today: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  saveConfig: (config: SchedulingPracticeConfig, deps?: SchedulingWriteDeps) => Promise<void>;
  loadDay: (deps?: { fhirClient?: SchedulingFhirClient; force?: boolean }) => Promise<void>;
  loadWindow: (
    fromYmd: string,
    toYmdExclusive: string,
    deps?: { fhirClient?: SchedulingFhirClient; force?: boolean },
  ) => Promise<void>;
  findOpenings: (input: FindOpeningsInput, deps?: { fhirClient?: SchedulingFhirClient; now?: () => string }) => Promise<SchedulingOpening[]>;
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
  view: "day",
  date: todayYmd(new Date(), DEFAULT_SCHEDULING_PRACTICE_CONFIG.timezoneOffset),
  slotMinutes: resolveSlotMinutes(DEFAULT_SCHEDULING_PRACTICE_CONFIG, "all"),
  zoom: 1,
  resources: [],
  visitTypes: [],
  appointments: [],
  appointmentsByDay: {},
  loadedWindow: null,
  config: DEFAULT_SCHEDULING_PRACTICE_CONFIG,
  configResource: undefined,
  configError: null,
  configReadFailed: false,
  officeId: "all",
  weekResourceScheduleReference: undefined,
  catalogsLoaded: false,
  loading: false,
  error: null,
  setClinicMode: (clinicMode) =>
    set((state) => ({
      clinicMode,
      weekResourceScheduleReference: reconcileWeekResourceReference({
        currentReference: state.weekResourceScheduleReference,
        resources: state.resources,
        clinicMode,
        config: state.config,
        officeId: state.officeId,
      }),
    })),
  setView: (view) =>
    set((state) => ({
      view,
      weekResourceScheduleReference: reconcileWeekResourceReference({
        currentReference: state.weekResourceScheduleReference,
        resources: state.resources,
        clinicMode: state.clinicMode,
        config: state.config,
        officeId: state.officeId,
      }),
    })),
  setDate: (date) => set({ date }),
  openDay: (date) =>
    set((state) => ({
      date,
      view: "day",
      weekResourceScheduleReference: reconcileWeekResourceReference({
        currentReference: state.weekResourceScheduleReference,
        resources: state.resources,
        clinicMode: state.clinicMode,
        config: state.config,
        officeId: state.officeId,
      }),
    })),
  setOfficeId: (officeId) =>
    set((state) => ({
      officeId,
      slotMinutes: resolveSlotMinutes(state.config, officeId),
      weekResourceScheduleReference: reconcileWeekResourceReference({
        currentReference: state.weekResourceScheduleReference,
        resources: state.resources,
        clinicMode: state.clinicMode,
        config: state.config,
        officeId,
      }),
    })),
  setWeekResourceScheduleReference: (reference) => set({ weekResourceScheduleReference: reference }),
  clearConfigError: () => set({ configError: null }),
  shiftDate: (direction) => set({ date: shiftSchedulerDate(get().date, get().view, direction) }),
  today: () => set({ date: todayYmd(new Date(), get().config.timezoneOffset) }),
  zoomIn: () => set((state) => ({ zoom: clampZoom(state.zoom + SCHEDULER_ZOOM_STEP) })),
  zoomOut: () => set((state) => ({ zoom: clampZoom(state.zoom - SCHEDULER_ZOOM_STEP) })),
  async saveConfig(config, deps) {
    const client = deps?.fhirClient ?? fhir;
    if (get().configReadFailed) {
      const message = "Stored settings could not be read; refusing to overwrite.";
      set({ loading: false, error: message });
      throw new Error(message);
    }
    set({ loading: true, error: null });
    try {
      validateSchedulingPracticeSettings(config);
      const existing = get().configResource;
      const resource = buildSchedulingPracticeConfigResource(config, existing);
      const saved = existing?.id
        ? await updateResource(client, resource, SCHEDULING_SOURCE_TAGS.config)
        : await createResource(client, resource, SCHEDULING_SOURCE_TAGS.config);
      set(configStatePatch(get(), config, saved, null, false, { loading: false, error: null }));
      await reloadSelectedSchedulerView(get, client);
    } catch (err) {
      set({ loading: false, error: errorMessage(err) });
      throw err;
    }
  },
  async loadDay(deps) {
    const client = deps?.fhirClient ?? fhir;
    const date = get().date;
    const view = get().view;
    const shouldLoadCatalogs = deps?.force === true || !get().catalogsLoaded;
    set({ loading: true, error: null });
    try {
      const loadedConfig = shouldLoadCatalogs
        ? await safeFetchSchedulingConfig(client)
        : {
            config: get().config,
            resource: get().configResource,
            warning: get().configError,
            readFailed: get().configReadFailed,
          };
      if (get().date !== date || get().view !== view) {
        return;
      }
      const config = loadedConfig.config;
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
          appointmentDayBoundsParams(date, config.timezoneOffset),
        ),
      ]);
      if (get().date !== date || get().view !== view) {
        return;
      }
      const patched = configStatePatch(
        get(),
        config,
        loadedConfig.resource,
        loadedConfig.warning ?? null,
        loadedConfig.readFailed ?? false,
      );
      const officeId = patched.officeId ?? get().officeId;
      set({
        resources,
        visitTypes,
        appointments,
        appointmentsByDay: bucketAppointmentsByPracticeDay(appointments, config.timezoneOffset),
        loadedWindow: {
          fromYmd: date,
          toYmdExclusive: addDaysYmd(date, 1),
          view,
          anchorDate: date,
        },
        ...patched,
        weekResourceScheduleReference: reconcileWeekResourceReference({
          currentReference: get().weekResourceScheduleReference,
          resources,
          clinicMode: get().clinicMode,
          config,
          officeId,
        }),
        catalogsLoaded: true,
        loading: false,
      });
    } catch (err) {
      if (get().date !== date || get().view !== view) {
        return;
      }
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
  async loadWindow(fromYmd, toYmdExclusive, deps) {
    const client = deps?.fhirClient ?? fhir;
    const anchorDate = get().date;
    const view = get().view;
    const shouldLoadCatalogs = deps?.force === true || !get().catalogsLoaded;
    set({ loading: true, error: null });
    try {
      const loadedConfig = shouldLoadCatalogs
        ? await safeFetchSchedulingConfig(client)
        : {
            config: get().config,
            resource: get().configResource,
            warning: get().configError,
            readFailed: get().configReadFailed,
          };
      if (get().date !== anchorDate || get().view !== view) {
        return;
      }
      const config = loadedConfig.config;
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
          appointmentRangeBoundsParams(fromYmd, toYmdExclusive, config.timezoneOffset),
        ),
      ]);
      if (get().date !== anchorDate || get().view !== view) {
        return;
      }
      const patched = configStatePatch(
        get(),
        config,
        loadedConfig.resource,
        loadedConfig.warning ?? null,
        loadedConfig.readFailed ?? false,
      );
      const officeId = patched.officeId ?? get().officeId;
      set({
        resources,
        visitTypes,
        appointments,
        appointmentsByDay: bucketAppointmentsByPracticeDay(appointments, config.timezoneOffset),
        loadedWindow: {
          fromYmd,
          toYmdExclusive,
          view,
          anchorDate,
        },
        ...patched,
        weekResourceScheduleReference: reconcileWeekResourceReference({
          currentReference: get().weekResourceScheduleReference,
          resources,
          clinicMode: get().clinicMode,
          config,
          officeId,
        }),
        catalogsLoaded: true,
        loading: false,
      });
    } catch (err) {
      if (get().date !== anchorDate || get().view !== view) {
        return;
      }
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
  async findOpenings(input, deps) {
    const client = deps?.fhirClient ?? fhir;
    const state = get();
    const resources = visibleSchedulingResourcesForOffice(
      state.resources,
      state.clinicMode,
      state.config,
      state.officeId,
    ).filter((resource) => {
      if (!input.resourceScheduleReference) {
        return true;
      }
      return scheduleReference(resource) === input.resourceScheduleReference;
    });
    return findNextOpenings({
      visitTypeCode: input.visitTypeCode,
      visitTypes: state.visitTypes,
      resources,
      config: state.config,
      from: input.from,
      slotMinutes: state.slotMinutes,
      limit: input.limit ?? FIND_OPEN_DEFAULT_LIMIT,
      horizonDays: input.horizonDays ?? FIND_OPEN_HORIZON_DAYS,
      now: deps?.now ?? (() => new Date().toISOString()),
      loadAppointmentsForDay: (date, actorReferences) =>
        fetchOpeningAppointmentsForDay(state, client, date, actorReferences ?? []),
    });
  },
  async createAppointment(input, deps) {
    const client = deps?.fhirClient ?? fhir;
    set({ loading: true, error: null });
    try {
      const checkConflicts = shouldCheckCreateConflicts(input);
      const appointments = checkConflicts
        ? await fetchTargetConflictAppointments(get(), client, input.start, input.resourceScheduleReferences)
        : [];
      const appointment = validateAndBuildSchedulingAppointment({
        clinicMode: get().clinicMode,
        visitTypes: get().visitTypes,
        resources: get().resources,
        appointments,
        input: checkConflicts ? input : { ...input, allowDoubleBook: true },
        now: deps?.now,
      });
      await createResource(client, appointment, SCHEDULING_SOURCE_TAGS.create);
      await reloadSelectedSchedulerView(get, client);
    } catch (err) {
      set({ loading: false, error: errorMessage(err) });
      throw err;
    }
  },
  async updateAppointment(appointment, changes, deps) {
    await writeAppointmentUpdate(get, set, appointment, changes, deps, SCHEDULING_SOURCE_TAGS.update);
  },
  async setAppointmentStatus(appointment, osodStatus, deps) {
    await writeAppointmentUpdate(
      get,
      set,
      appointment,
      { status: osodStatus },
      deps,
      SCHEDULING_SOURCE_TAGS.status,
    );
  },
  async setConfirmationStatus(appointment, code, deps) {
    await writeAppointmentUpdate(
      get,
      set,
      appointment,
      { confirmation: code },
      deps,
      SCHEDULING_SOURCE_TAGS.confirmation,
    );
  },
  async moveAppointment(appointment, input, deps) {
    const current = currentAppointment(get(), appointment);
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
    const resourceScheduleReferences = input.sourceResourceScheduleActor
      ? replaceSourceResourceScheduleReference(
          get().resources,
          current,
          input.sourceResourceScheduleActor,
          targetSchedule,
        )
      : [targetSchedule];
    await writeAppointmentUpdate(
      get,
      set,
      appointment,
      {
        start: input.start,
        resourceScheduleReferences,
        allowDoubleBook: input.allowDoubleBook,
      },
      deps,
      SCHEDULING_SOURCE_TAGS.move,
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

async function fetchSchedulingConfig(client: SchedulingFhirClient): Promise<{
  config: SchedulingPracticeConfig;
  resource?: Basic;
  warning?: string;
}> {
  const bundle = await client.search<Basic>(
    "Basic",
    new URLSearchParams([
      ["code", `${OSOD_SCHEDULING_CONFIG_SYSTEM}|${OSOD_SCHEDULING_CONFIG_CODE}`],
      ["_count", "10"],
    ]),
  );
  const resources = (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .filter((resource): resource is Basic => Boolean(resource));
  const resource = newestBasic(resources);
  if (!resource) {
    return { config: DEFAULT_SCHEDULING_PRACTICE_CONFIG };
  }
  return {
    config: parseSchedulingPracticeConfig(resource),
    resource,
    ...(resources.length > 1
      ? { warning: `Multiple scheduling-config singletons found; using ${resource.id ? `Basic/${resource.id}` : "the newest resource"}.` }
      : {}),
  };
}

async function safeFetchSchedulingConfig(client: SchedulingFhirClient): Promise<{
  config: SchedulingPracticeConfig;
  resource?: Basic;
  warning?: string;
  readFailed?: boolean;
}> {
  try {
    return { ...(await fetchSchedulingConfig(client)), readFailed: false };
  } catch (err) {
    return {
      config: DEFAULT_SCHEDULING_PRACTICE_CONFIG,
      warning: errorMessage(err),
      readFailed: true,
    };
  }
}

function newestBasic(resources: Basic[]): Basic | undefined {
  return [...resources].sort((a, b) => lastUpdatedMs(b) - lastUpdatedMs(a))[0];
}

function lastUpdatedMs(resource: Basic): number {
  const value = resource.meta?.lastUpdated;
  return value ? Date.parse(value) || 0 : 0;
}

function configStatePatch(
  state: SchedulingStoreState,
  config: SchedulingPracticeConfig,
  resource: Basic | undefined,
  configError: string | null,
  configReadFailed: boolean,
  extra: Partial<SchedulingStoreState> = {},
): Partial<SchedulingStoreState> {
  const officeIds = new Set(config.offices.map((office) => office.id));
  const officeId = state.officeId === "all" || officeIds.has(state.officeId) ? state.officeId : "all";
  return {
    config,
    configResource: resource,
    configError,
    configReadFailed,
    officeId,
    slotMinutes: resolveSlotMinutes(config, officeId),
    ...extra,
  };
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
    const state = get();
    const current = currentAppointment(state, appointment);
    const updated = rebuildAppointmentForUpdate(state, current, changes, deps);
    if (shouldCheckUpdateConflicts(current, updated, changes)) {
      const conflicts = await fetchTargetConflictAppointmentsForAppointment(state, client, updated);
      assertNoAppointmentConflicts(updated, conflicts, current.id);
    }
    await updateResource(client, updated, sourceTag);
    await reloadSelectedSchedulerView(get, client);
  } catch (err) {
    set({ loading: false, error: errorMessage(err) });
    throw err;
  }
}

async function reloadSelectedSchedulerView(
  get: () => SchedulingStoreState,
  client: SchedulingFhirClient,
): Promise<void> {
  const state = get();
  if (state.view === "day") {
    await state.loadDay({ fhirClient: client });
    return;
  }
  const window = schedulerWindowForView(state.date, state.view);
  await state.loadWindow(window.fromYmd, window.toYmdExclusive, { fhirClient: client });
}

function rebuildAppointmentForUpdate(
  state: SchedulingStoreState,
  appointment: Appointment,
  changes: AppointmentChangeInput,
  deps: SchedulingWriteDeps | undefined,
): Appointment {
  const updated: Appointment = {
    ...appointment,
    participant: [...appointment.participant],
    ...(appointment.extension ? { extension: [...appointment.extension] } : {}),
  };

  if (changes.patient !== undefined) {
    applyPatientChange(updated, changes.patient);
  }
  if (changes.description !== undefined) {
    setOptional(updated, "description", cleanOptionalString(changes.description));
  }
  if (changes.visitTypeCode !== undefined) {
    applyVisitTypeChange(state, updated, changes.visitTypeCode);
  }
  if (changes.resourceScheduleReferences !== undefined) {
    applyResourceScheduleReferences(state, updated, changes.resourceScheduleReferences);
  }
  if (changes.start !== undefined) {
    updated.start = changes.start;
  }
  if (changes.durationMinutes !== undefined) {
    if (!Number.isInteger(changes.durationMinutes) || changes.durationMinutes <= 0) {
      throw new Error("Appointment duration (durationMinutes) must be a positive integer.");
    }
    updated.minutesDuration = changes.durationMinutes;
  }
  if (changes.start !== undefined || changes.durationMinutes !== undefined) {
    const duration = appointmentDurationMinutes(updated);
    if (!updated.start || !duration) {
      throw new Error("Appointment update requires an appointment start time and positive duration.");
    }
    updated.end = addMinutesIso(updated.start, duration);
  }
  if (changes.status !== undefined) {
    applyStatusChange(updated, changes.status);
  }
  if (changes.confirmation !== undefined) {
    replaceExtension(updated, OSOD_APPOINTMENT_CONFIRMATION_EXTENSION_URL, appointmentConfirmationExtension(changes.confirmation));
  }
  if (changes.visionCoverage !== undefined) {
    applyCoverageChange(updated, OSOD_VISION_COVERAGE_EXTENSION_URL, changes.visionCoverage);
  }
  if (changes.medicalCoverage !== undefined) {
    applyCoverageChange(updated, OSOD_MEDICAL_COVERAGE_EXTENSION_URL, changes.medicalCoverage);
  }
  if (changes.floorStation !== undefined) {
    applyFloorStationChange(updated, changes.floorStation, deps?.now);
  }
  if (changes.notes !== undefined) {
    setOptional(updated, "comment", cleanOptionalString(changes.notes));
  }
  if (changes.urgent !== undefined) {
    if (changes.urgent) {
      updated.priority = 1;
    } else {
      delete updated.priority;
    }
  }
  if (changes.followUp !== undefined) {
    replaceExtension(
      updated,
      OSOD_FOLLOW_UP_EXTENSION_URL,
      changes.followUp ? { url: OSOD_FOLLOW_UP_EXTENSION_URL, valueBoolean: true } : undefined,
    );
  }

  return updated;
}

function currentAppointment(state: SchedulingStoreState, appointment: Appointment): Appointment {
  return appointment.id
    ? state.appointments.find((candidate) => candidate.id === appointment.id) ?? appointment
    : appointment;
}

function shouldCheckCreateConflicts(input: BookSchedulingAppointmentInput): boolean {
  if (input.allowDoubleBook) {
    return false;
  }
  return !isNonBlockingAppointmentStatus(toFhirAppointmentStatus(input.status ?? "scheduled").status);
}

function shouldCheckUpdateConflicts(
  before: Appointment,
  after: Appointment,
  changes: AppointmentChangeInput,
): boolean {
  if (changes.allowDoubleBook || isNonBlockingAppointmentStatus(after.status)) {
    return false;
  }
  if (
    changes.start === undefined &&
    changes.durationMinutes === undefined &&
    changes.resourceScheduleReferences === undefined
  ) {
    return false;
  }
  return (
    before.start !== after.start ||
    before.end !== after.end ||
    resourceActorsKey(before) !== resourceActorsKey(after)
  );
}

async function fetchTargetConflictAppointments(
  state: SchedulingStoreState,
  client: SchedulingFhirClient,
  start: string,
  resourceScheduleReferences: string[],
): Promise<Appointment[]> {
  const actors = resourceScheduleReferences
    .map((reference) => {
      const schedule = state.resources.find((resource) => scheduleReference(resource) === reference);
      return schedule ? resourceActorReference(schedule) : undefined;
    })
    .filter((reference): reference is string => Boolean(reference));
  return fetchConflictAppointmentsByActors(state, client, start, actors);
}

async function fetchTargetConflictAppointmentsForAppointment(
  state: SchedulingStoreState,
  client: SchedulingFhirClient,
  appointment: Appointment,
): Promise<Appointment[]> {
  if (!appointment.start) {
    throw new Error("Appointment update requires an appointment start time.");
  }
  return fetchConflictAppointmentsByActors(state, client, appointment.start, resourceActorReferences(appointment));
}

async function fetchConflictAppointmentsByActors(
  state: SchedulingStoreState,
  client: SchedulingFhirClient,
  start: string,
  actorReferences: string[],
): Promise<Appointment[]> {
  const date = ymdFromIsoDateTime(start, state.config.timezoneOffset);
  const byKey = new Map<string, Appointment>();
  for (const actor of actorReferences) {
    const appointments = await searchAll<Appointment>(
      client,
      "Appointment",
      withActorParam(appointmentDayBoundsParams(date, state.config.timezoneOffset), actor),
    );
    for (const appointment of appointments) {
      byKey.set(appointment.id ?? JSON.stringify(appointment), appointment);
    }
  }
  return [...byKey.values()];
}

async function fetchOpeningAppointmentsForDay(
  state: SchedulingStoreState,
  client: SchedulingFhirClient,
  date: string,
  actorReferences: string[],
): Promise<Appointment[]> {
  if (actorReferences.length === 0) {
    return searchAll<Appointment>(client, "Appointment", appointmentDayBoundsParams(date, state.config.timezoneOffset));
  }
  const byKey = new Map<string, Appointment>();
  for (const actor of actorReferences) {
    const appointments = await searchAll<Appointment>(
      client,
      "Appointment",
      withActorParam(appointmentDayBoundsParams(date, state.config.timezoneOffset), actor),
    );
    for (const appointment of appointments) {
      byKey.set(appointment.id ?? JSON.stringify(appointment), appointment);
    }
  }
  return [...byKey.values()];
}

function withActorParam(params: URLSearchParams, actor: string): URLSearchParams {
  params.set("actor", actor);
  return params;
}

function assertNoAppointmentConflicts(
  appointment: Appointment,
  candidates: Appointment[],
  ignoreAppointmentId?: string,
): void {
  if (!appointment.start || !appointment.end || isNonBlockingAppointmentStatus(appointment.status)) {
    return;
  }
  const start = Date.parse(appointment.start);
  const end = Date.parse(appointment.end);
  for (const actor of resourceActorReferences(appointment)) {
    const conflict = candidates.find((candidate) => {
      if (candidate.id && candidate.id === ignoreAppointmentId) {
        return false;
      }
      if (isNonBlockingAppointmentStatus(candidate.status)) {
        return false;
      }
      if (!appointmentActorReferences(candidate).includes(actor)) {
        return false;
      }
      if (!candidate.start || !candidate.end) {
        return false;
      }
      return overlaps(start, end, Date.parse(candidate.start), Date.parse(candidate.end));
    });
    if (conflict) {
      throw new Error(
        `Resource ${actor} is already booked over ${appointment.start} ` +
          `(conflict with Appointment/${conflict.id ?? "?"}). Pass allowDoubleBook to overbook.`,
      );
    }
  }
}

function replaceSourceResourceScheduleReference(
  resources: Schedule[],
  appointment: Appointment,
  sourceActorReference: string,
  targetScheduleReference: string,
): string[] {
  const sourceScheduleReference = sourceActorReference.startsWith("Schedule/")
    ? sourceActorReference
    : scheduleReferenceForActor(resources, sourceActorReference);
  if (!sourceScheduleReference) {
    throw new Error(`Move source ${sourceActorReference} is not a loaded scheduler resource actor.`);
  }
  const current = resourceScheduleReferencesOf(resources, appointment);
  if (!current.includes(sourceScheduleReference)) {
    throw new Error(`Move source ${sourceActorReference} is not assigned to Appointment/${appointment.id ?? "?"}.`);
  }
  return current.map((reference) =>
    reference === sourceScheduleReference ? targetScheduleReference : reference,
  );
}

function applyPatientChange(
  appointment: Appointment,
  patient: { reference: string; display?: string } | null | undefined,
): void {
  appointment.participant = appointment.participant.filter(
    (participant) => !participant.actor?.reference?.startsWith("Patient/"),
  );
  if (!patient) {
    return;
  }
  appointment.participant.unshift({
    actor: {
      reference: patient.reference,
      ...(patient.display ? { display: patient.display } : {}),
    },
    status: "accepted",
  });
}

function applyVisitTypeChange(
  state: SchedulingStoreState,
  appointment: Appointment,
  code: string,
): void {
  const entry = state.visitTypes.find((visitType) => visitTypeCode(visitType) === code && visitType.active !== false);
  if (!entry) {
    throw new Error(`Unknown visit type "${code}" — not in the active catalog.`);
  }
  const discipline = visitTypeDiscipline(entry);
  if (!discipline) {
    throw new Error(`Visit type "${code}" has no discipline category.`);
  }
  if (!isDisciplineVisibleForMode(discipline, state.clinicMode)) {
    throw new Error(
      `Visit type "${code}" is not available under this practice's clinic mode ("${state.clinicMode}").`,
    );
  }
  appointment.serviceCategory = [
    {
      coding: [
        {
          system: OSOD_DISCIPLINE_SYSTEM,
          code: discipline,
          display: discipline === "eyecare" ? "Eyecare" : "Aesthetics",
        },
      ],
    },
  ];
  appointment.serviceType = [
    {
      coding: [
        {
          system: OSOD_VISIT_TYPE_SYSTEM,
          code,
          ...(entry.name ? { display: entry.name } : {}),
        },
      ],
      ...(entry.name ? { text: entry.name } : {}),
    },
  ];
  if (!appointmentDurationMinutes(appointment)) {
    const duration = visitTypeDurationMinutes(entry);
    if (duration) {
      appointment.minutesDuration = duration;
      if (appointment.start) {
        appointment.end = addMinutesIso(appointment.start, duration);
      }
    }
  }
}

function applyResourceScheduleReferences(
  state: SchedulingStoreState,
  appointment: Appointment,
  references: string[],
): void {
  if (references.length === 0) {
    throw new Error("Booking requires at least one resource (provider/room/equipment).");
  }
  const visitType = appointmentVisitTypeCode(appointment);
  if (!visitType) {
    throw new Error("Appointment update requires a visit-type catalog code.");
  }
  const entry = state.visitTypes.find((candidate) => visitTypeCode(candidate) === visitType && candidate.active !== false);
  const eligible = entry ? visitTypeEligibleResourceReferences(entry) : [];
  const patientParticipants = appointment.participant.filter((participant) =>
    participant.actor?.reference?.startsWith("Patient/"),
  );
  const resourceParticipants = references.map((reference) => {
    const schedule = state.resources.find((resource) => scheduleReference(resource) === reference);
    if (!schedule) {
      throw new Error(`${reference} not found in the loaded scheduler resources.`);
    }
    if (!isResourceVisibleInMode(schedule, state.clinicMode)) {
      throw new Error(
        `Resource ${reference} is not visible under this practice's clinic mode ("${state.clinicMode}").`,
      );
    }
    const actor = schedule.actor?.[0];
    if (!actor?.reference) {
      throw new Error(`Resource ${reference} has no actor reference.`);
    }
    if (eligible.length > 0 && !eligible.includes(actor.reference)) {
      throw new Error(`Resource ${actor.reference} is not eligible for visit type "${visitType}".`);
    }
    const existing = appointment.participant.find((participant) => participant.actor?.reference === actor.reference);
    return {
      ...(existing ?? {}),
      actor: {
        ...(existing?.actor ?? {}),
        reference: actor.reference,
        ...(actor.display ? { display: actor.display } : {}),
      },
      status: existing?.status ?? "accepted",
    };
  });
  appointment.participant = [...patientParticipants, ...resourceParticipants];
}

function applyStatusChange(appointment: Appointment, status: OsodAppointmentStatus): void {
  const mapped = toFhirAppointmentStatus(status);
  appointment.status = mapped.status;
  if (mapped.appointmentTypeCode) {
    const coding = {
      system: V2_0276_APPOINTMENT_TYPE_SYSTEM,
      code: mapped.appointmentTypeCode,
    };
    appointment.appointmentType = {
      ...(appointment.appointmentType ?? {}),
      coding: [
        ...(appointment.appointmentType?.coding ?? []).filter(
          (candidate) =>
            candidate.system !== V2_0276_APPOINTMENT_TYPE_SYSTEM ||
            candidate.code !== mapped.appointmentTypeCode,
        ),
        coding,
      ],
    };
    return;
  }
  if (!appointment.appointmentType?.coding?.length) {
    return;
  }
  const coding = appointment.appointmentType.coding.filter(
    (candidate) => candidate.system !== V2_0276_APPOINTMENT_TYPE_SYSTEM || candidate.code !== "WALKIN",
  );
  if (coding.length > 0) {
    appointment.appointmentType = { ...appointment.appointmentType, coding };
  } else {
    delete appointment.appointmentType;
  }
}

function applyCoverageChange(
  appointment: Appointment,
  url: string,
  coverage: CoverageInput | null,
): void {
  replaceExtension(
    appointment,
    url,
    coverage
      ? {
          url,
          valueReference: {
            ...(coverage.reference ? { reference: coverage.reference } : {}),
            ...(coverage.display ? { display: coverage.display } : {}),
          },
        }
      : undefined,
  );
}

function applyFloorStationChange(
  appointment: Appointment,
  station: string | null,
  now: (() => string) | undefined,
): void {
  if (!station) {
    // Checkout: clear the whole floor-state (station + since + checkedInAt).
    replaceExtension(appointment, OSOD_FLOOR_STATE_EXTENSION_URL, undefined);
    return;
  }
  const timestamp = (now ?? (() => new Date().toISOString()))();
  // Preserve the original check-in time across station moves; set it fresh only on the
  // first check-in (when no floor-state exists yet). `appointment` here is the update
  // clone still carrying the pre-change extension, so parseFloorState reads the CURRENT
  // (pre-move) state.
  const existingCheckedInAt = parseFloorState(appointment)?.checkedInAt;
  replaceExtension(
    appointment,
    OSOD_FLOOR_STATE_EXTENSION_URL,
    floorStateExtension(station, timestamp, existingCheckedInAt ?? timestamp),
  );
}

function replaceExtension(appointment: Appointment, url: string, next: Extension | undefined): void {
  const extensions = appointment.extension ?? [];
  let replaced = false;
  const merged = extensions.flatMap((extension) => {
    if (extension.url !== url) {
      return [extension];
    }
    if (next && !replaced) {
      replaced = true;
      return [next];
    }
    return [];
  });
  if (next && !replaced) {
    merged.push(next);
  }
  if (merged.length > 0) {
    appointment.extension = merged;
  } else {
    delete appointment.extension;
  }
}

function setOptional<K extends "description" | "comment">(
  appointment: Appointment,
  key: K,
  value: Appointment[K] | undefined,
): void {
  if (value) {
    appointment[key] = value;
  } else {
    delete appointment[key];
  }
}

function resourceActorReferences(appointment: Appointment): string[] {
  return appointmentActorReferences(appointment).filter((reference) => !reference.startsWith("Patient/"));
}

function resourceActorsKey(appointment: Appointment): string {
  return resourceActorReferences(appointment).sort().join("|");
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function isDisciplineVisibleForMode(discipline: string, mode: ClinicMode): boolean {
  return mode === "both" || discipline === mode;
}

async function createResource<T extends Resource>(
  client: SchedulingFhirClient,
  resource: T,
  sourceTag: string,
): Promise<T> {
  if (!client.create) {
    throw new Error(`FHIR client cannot create scheduler ${resource.resourceType}.`);
  }
  return client.create(resource, sourceTag);
}

async function updateResource<T extends Resource>(
  client: SchedulingFhirClient,
  resource: T,
  sourceTag: string,
): Promise<T> {
  if (!client.update) {
    throw new Error(`FHIR client cannot update scheduler ${resource.resourceType}.`);
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
