import assert from "node:assert/strict";
import { test } from "node:test";
import type { Appointment, Basic, Bundle, HealthcareService, Resource, Schedule } from "@medplum/fhirtypes";
import { buildSchedulingResource } from "../src/fhir/schedulingResource.js";
import { defaultVisitTypeCatalog } from "../src/fhir/schedulingVisitType.js";
import {
  DEFAULT_SCHEDULING_PRACTICE_CONFIG,
  SCHEDULER_ZOOM_MAX,
  SCHEDULER_ZOOM_MIN,
  SCHEDULER_ZOOM_STEP,
  SCHEDULING_SOURCE_TAGS,
  searchAll,
  todayYmd,
  useSchedulingStore,
  type SchedulingFhirClient,
} from "../../ui/src/lib/scheduling-store.js";
import {
  ODOS_VISION_COVERAGE_EXTENSION_URL,
  appointmentVisitTypeCode,
  buildSchedulingAppointment,
  confirmationStatusOf,
  medicalCoverageOf,
  visionCoverageOf,
} from "../../ui/src/lib/scheduling.js";
import {
  ODOS_SCHEDULING_CONFIG_CODE,
  ODOS_SCHEDULING_CONFIG_EXTENSION_URL,
  ODOS_SCHEDULING_CONFIG_SYSTEM,
  buildSchedulingPracticeConfigResource,
  type PersistedSchedulingPracticeConfig,
} from "../../ui/src/lib/scheduling-config.js";

const EMPTY_BUNDLE = { resourceType: "Bundle", type: "searchset", entry: [] } as const;

function bundle<T extends Resource>(resources: T[], nextUrl?: string): Bundle<T> {
  return {
    resourceType: "Bundle",
    type: "searchset",
    entry: resources.map((resource) => ({ resource })),
    ...(nextUrl ? { link: [{ relation: "next", url: nextUrl }] } : {}),
  };
}

function appointment(id: string, start: string): Appointment {
  return {
    resourceType: "Appointment",
    id,
    status: "booked",
    start,
    participant: [{ actor: { reference: "Patient/p1" }, status: "accepted" }],
  };
}

function resetStore(date = "2026-07-06"): void {
  useSchedulingStore.setState({
    view: "day",
    date,
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
    loading: false,
    error: null,
    catalogsLoaded: false,
  });
}

function seededVisitTypes(): HealthcareService[] {
  return defaultVisitTypeCatalog("both").map((visitType, index) => ({
    ...visitType,
    id: `vt-${index + 1}`,
  }));
}

function seededSchedules(): Schedule[] {
  return [
    {
      ...buildSchedulingResource({
        kind: "provider",
        actorReference: "Practitioner/bang-eric",
        actorDisplay: "Bang, Eric",
        disciplines: ["eyecare"],
      }),
      id: "sch-provider",
    },
    {
      ...buildSchedulingResource({
        kind: "room",
        actorReference: "Location/exam-1",
        actorDisplay: "Exam 1",
        disciplines: ["eyecare"],
      }),
      id: "sch-room",
    },
    {
      ...buildSchedulingResource({
        kind: "provider",
        actorReference: "Practitioner/smith-amy",
        actorDisplay: "Smith, Amy",
        disciplines: ["eyecare"],
      }),
      id: "sch-provider-2",
    },
  ];
}

function hydrateCatalogState(appointments: Appointment[] = []): void {
  useSchedulingStore.setState({
    clinicMode: "both",
    resources: seededSchedules(),
    visitTypes: seededVisitTypes(),
    appointments,
    catalogsLoaded: true,
    error: null,
    loading: false,
  });
}

function writableClient(seed: {
  appointments?: Appointment[];
  resources?: Schedule[];
  visitTypes?: HealthcareService[];
  basics?: Basic[];
} = {}): SchedulingFhirClient & {
  created: Array<{ resource: Resource; sourceTag: string }>;
  updated: Array<{ resource: Resource; sourceTag: string }>;
  searches: Array<{ resourceType: string; params?: URLSearchParams }>;
} {
  const data: Record<string, Resource[]> = {
    Appointment: [...(seed.appointments ?? [])],
    Schedule: [...(seed.resources ?? seededSchedules())],
    HealthcareService: [...(seed.visitTypes ?? seededVisitTypes())],
    Basic: [...(seed.basics ?? [])],
  };
  const created: Array<{ resource: Resource; sourceTag: string }> = [];
  const updated: Array<{ resource: Resource; sourceTag: string }> = [];
  const searches: Array<{ resourceType: string; params?: URLSearchParams }> = [];
  return {
    created,
    updated,
    searches,
    async search(resourceType, params) {
      searches.push({ resourceType, params: params ? new URLSearchParams(params) : undefined });
      return bundle(data[resourceType] ?? []) as Bundle<Schedule | HealthcareService | Appointment>;
    },
    async create(resource: Resource, sourceTag: string) {
      const withId = { ...resource, id: `${resource.resourceType}-${created.length + 1}` };
      created.push({ resource: withId, sourceTag });
      data[resource.resourceType] = [...(data[resource.resourceType] ?? []), withId];
      return withId as never;
    },
    async update(resource: Resource, sourceTag: string) {
      updated.push({ resource, sourceTag });
      data[resource.resourceType] = (data[resource.resourceType] ?? []).map((candidate) =>
        candidate.id === resource.id ? resource : candidate,
      );
      return resource as never;
    },
  } as SchedulingFhirClient & {
    created: Array<{ resource: Resource; sourceTag: string }>;
    updated: Array<{ resource: Resource; sourceTag: string }>;
    searches: Array<{ resourceType: string; params?: URLSearchParams }>;
  };
}

const STORED_CONFIG: PersistedSchedulingPracticeConfig = {
  timezoneOffset: "-06:00",
  defaultWeeklyHours: {
    mon: [{ start: "09:00", end: "15:00" }],
  },
  weeklyHoursBySchedule: {
    "Schedule/sch-provider": { mon: [{ start: "10:00", end: "14:00" }] },
  },
  blocks: [
    {
      kind: "staff-off",
      description: "Training",
      date: "2026-07-06",
      start: "11:00",
      end: "12:00",
      scheduleReferences: ["Schedule/sch-provider"],
    },
  ],
  offices: [{ id: "main", name: "Main Office" }],
  officeBySchedule: { "Schedule/sch-provider": "main" },
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("scheduler store searchAll requests 100-count pages and follows Bundle next links", async () => {
  const firstPage = bundle<Appointment>(
    [appointment("a1", "2026-07-06T09:00:00-05:00")],
    "/fhir/R4/Appointment?_getpages=next",
  );
  const secondPage = bundle<Appointment>([
    appointment("a2", "2026-07-06T09:30:00-05:00"),
  ]);
  let firstParams: Record<string, string> | URLSearchParams | Array<[string, string]> | undefined;
  const nextUrls: string[] = [];
  const client: SchedulingFhirClient = {
    async search(resourceType, params) {
      assert.equal(resourceType, "Appointment");
      firstParams = params;
      return firstPage;
    },
    async searchUrl(url) {
      nextUrls.push(url);
      return secondPage;
    },
  };

  const results = await searchAll<Appointment>(client, "Appointment", { date: "ge2026-07-06" });

  assert.deepEqual(results.map((result) => result.id), ["a1", "a2"]);
  assert.equal(new URLSearchParams(firstParams).get("_count"), "100");
  assert.deepEqual(nextUrls, ["/fhir/R4/Appointment?_getpages=next"]);
});

test("loadDay queries appointments with practice-offset day bounds", async () => {
  resetStore("2026-07-06");
  const calls: Array<{ resourceType: string; params?: URLSearchParams }> = [];
  const client: SchedulingFhirClient = {
    async search(resourceType, params) {
      calls.push({ resourceType, params: params ? new URLSearchParams(params) : undefined });
      return EMPTY_BUNDLE as Bundle<Schedule | HealthcareService | Appointment>;
    },
  };

  await useSchedulingStore.getState().loadDay({ fhirClient: client, force: true });

  const appointmentCall = calls.find((call) => call.resourceType === "Appointment");
  assert.ok(appointmentCall?.params);
  assert.deepEqual(appointmentCall.params.getAll("date"), [
    "ge2026-07-06T00:00:00-05:00",
    "lt2026-07-07T00:00:00-05:00",
  ]);
});

test("loadDay searches the coded Basic singleton and keeps the default config when absent", async () => {
  resetStore("2026-07-06");
  const client = writableClient();

  await useSchedulingStore.getState().loadDay({ fhirClient: client, force: true });

  const configSearch = client.searches.find((call) => call.resourceType === "Basic");
  assert.equal(
    configSearch?.params?.get("code"),
    `${ODOS_SCHEDULING_CONFIG_SYSTEM}|${ODOS_SCHEDULING_CONFIG_CODE}`,
  );
  assert.equal(configSearch?.params?.get("_count"), "10");
  assert.deepEqual(useSchedulingStore.getState().config, DEFAULT_SCHEDULING_PRACTICE_CONFIG);
  assert.equal(useSchedulingStore.getState().configResource, undefined);
});

test("loadDay hydrates config and preserves the backing Basic resource identity", async () => {
  resetStore("2026-07-06");
  const basic = {
    ...buildSchedulingPracticeConfigResource(STORED_CONFIG),
    id: "cfg-1",
    meta: { versionId: "4" },
  };
  const client = writableClient({ basics: [basic] });

  await useSchedulingStore.getState().loadDay({ fhirClient: client, force: true });

  assert.deepEqual(useSchedulingStore.getState().config, STORED_CONFIG);
  assert.equal(useSchedulingStore.getState().configResource?.id, "cfg-1");
  assert.deepEqual(useSchedulingStore.getState().configResource?.meta, { versionId: "4" });
});

test("loadDay hydrates config before appointment search bounds and force-refreshes it", async () => {
  resetStore("2026-07-06");
  const basic = {
    ...buildSchedulingPracticeConfigResource(STORED_CONFIG),
    id: "cfg-1",
    meta: { versionId: "4" },
  };
  const client = writableClient({ basics: [basic] });

  await useSchedulingStore.getState().loadDay({ fhirClient: client, force: true });
  useSchedulingStore.getState().setDate("2026-07-07");
  await useSchedulingStore.getState().loadDay({ fhirClient: client });
  await useSchedulingStore.getState().loadDay({ fhirClient: client, force: true });

  const appointmentSearch = client.searches.find((call) => call.resourceType === "Appointment");
  assert.deepEqual(appointmentSearch?.params?.getAll("date"), [
    "ge2026-07-06T00:00:00-06:00",
    "lt2026-07-07T00:00:00-06:00",
  ]);
  assert.equal(client.searches.filter((call) => call.resourceType === "Basic").length, 2);
});

test("loadDay falls back to default config when the Basic search fails and still loads the day", async () => {
  resetStore("2026-07-06");
  const client: SchedulingFhirClient = {
    async search(resourceType) {
      if (resourceType === "Basic") {
        throw new Error("Basic search denied");
      }
      if (resourceType === "Schedule") {
        return bundle([seededSchedules()[0]!]) as Bundle<Schedule>;
      }
      if (resourceType === "HealthcareService") {
        return bundle([seededVisitTypes()[0]!]) as Bundle<HealthcareService>;
      }
      return bundle([appointment("appt-1", "2026-07-06T09:00:00-05:00")]) as Bundle<Appointment>;
    },
  };

  await useSchedulingStore.getState().loadDay({ fhirClient: client, force: true });

  const state = useSchedulingStore.getState();
  assert.deepEqual(state.config, DEFAULT_SCHEDULING_PRACTICE_CONFIG);
  assert.equal(state.configResource, undefined);
  assert.match(state.configError ?? "", /Basic search denied/);
  assert.equal(state.error, null);
  assert.equal(state.catalogsLoaded, true);
  assert.deepEqual(state.resources.map((resource) => resource.id), ["sch-provider"]);
  assert.deepEqual(state.appointments.map((entry) => entry.id), ["appt-1"]);
});

test("loadDay falls back to default config when stored JSON is malformed and still loads the day", async () => {
  resetStore("2026-07-06");
  const malformed: Basic = {
    resourceType: "Basic",
    id: "cfg-bad",
    code: {
      coding: [{ system: ODOS_SCHEDULING_CONFIG_SYSTEM, code: ODOS_SCHEDULING_CONFIG_CODE }],
    },
    extension: [{ url: ODOS_SCHEDULING_CONFIG_EXTENSION_URL, valueString: "{" }],
  };
  const client = writableClient({
    basics: [malformed],
    appointments: [appointment("appt-1", "2026-07-06T09:00:00-05:00")],
  });

  await useSchedulingStore.getState().loadDay({ fhirClient: client, force: true });

  const state = useSchedulingStore.getState();
  assert.deepEqual(state.config, DEFAULT_SCHEDULING_PRACTICE_CONFIG);
  assert.equal(state.configResource, undefined);
  assert.match(state.configError ?? "", /malformed|parsed/i);
  assert.equal(state.error, null);
  assert.equal(state.catalogsLoaded, true);
  assert.deepEqual(state.appointments.map((entry) => entry.id), ["appt-1"]);
});

test("saveConfig refuses to overwrite when the stored config could not be read", async () => {
  resetStore("2026-07-06");
  const client = writableClient();
  await useSchedulingStore.getState().loadDay({
    fhirClient: {
      ...client,
      async search(resourceType, params) {
        if (resourceType === "Basic") {
          throw new Error("Basic search denied");
        }
        return client.search(resourceType, params);
      },
    },
    force: true,
  });

  await assert.rejects(
    useSchedulingStore.getState().saveConfig(STORED_CONFIG, { fhirClient: client }),
    /stored settings could not be read; refusing to overwrite/i,
  );

  assert.equal(client.created.length, 0);
});

test("loadDay uses the newest scheduling-config singleton and warns when duplicates exist", async () => {
  resetStore("2026-07-06");
  const olderConfig = { ...STORED_CONFIG, timezoneOffset: "-06:00" };
  const newerConfig = { ...STORED_CONFIG, timezoneOffset: "-07:00" };
  const older = {
    ...buildSchedulingPracticeConfigResource(olderConfig),
    id: "cfg-older",
    meta: { lastUpdated: "2026-07-05T10:00:00.000Z" },
  };
  const newer = {
    ...buildSchedulingPracticeConfigResource(newerConfig),
    id: "cfg-newer",
    meta: { lastUpdated: "2026-07-06T10:00:00.000Z" },
  };
  const client = writableClient({ basics: [older, newer] });

  await useSchedulingStore.getState().loadDay({ fhirClient: client, force: true });

  const state = useSchedulingStore.getState();
  assert.equal(state.config.timezoneOffset, "-07:00");
  assert.equal(state.configResource?.id, "cfg-newer");
  assert.match(state.configError ?? "", /multiple/i);
});

test("saveConfig updates the singleton Basic with config source tag and reloads the day", async () => {
  resetStore("2026-07-06");
  const existing = {
    ...buildSchedulingPracticeConfigResource(DEFAULT_SCHEDULING_PRACTICE_CONFIG),
    id: "cfg-1",
    meta: { versionId: "4" },
  };
  useSchedulingStore.setState({ configResource: existing, catalogsLoaded: true });
  const client = writableClient({ basics: [existing] });

  await useSchedulingStore.getState().saveConfig(STORED_CONFIG, { fhirClient: client });

  assert.equal(client.updated.length, 1);
  assert.equal(client.updated[0]?.sourceTag, SCHEDULING_SOURCE_TAGS.config);
  const updated = client.updated[0]?.resource as Basic;
  assert.equal(updated.id, "cfg-1");
  assert.deepEqual(updated.meta, { versionId: "4" });
  assert.deepEqual(useSchedulingStore.getState().config, STORED_CONFIG);
  assert.equal(
    client.searches.some((call) => call.resourceType === "Appointment"),
    true,
  );
});

test("saveConfig keeps the committed config, clears loading, and reloads only appointments", async () => {
  resetStore("2026-07-06");
  const existing = {
    ...buildSchedulingPracticeConfigResource(DEFAULT_SCHEDULING_PRACTICE_CONFIG),
    id: "cfg-1",
    meta: { versionId: "4" },
  };
  useSchedulingStore.setState({
    configResource: existing,
    catalogsLoaded: true,
    resources: seededSchedules(),
    visitTypes: seededVisitTypes(),
  });
  const client = writableClient({ basics: [existing] });

  await useSchedulingStore.getState().saveConfig(STORED_CONFIG, { fhirClient: client });

  assert.deepEqual(useSchedulingStore.getState().config, STORED_CONFIG);
  assert.equal(useSchedulingStore.getState().loading, false);
  assert.equal(client.searches.filter((call) => call.resourceType === "Appointment").length, 1);
  assert.equal(client.searches.filter((call) => call.resourceType === "Basic").length, 0);
  assert.equal(client.searches.filter((call) => call.resourceType === "Schedule").length, 0);
  assert.equal(client.searches.filter((call) => call.resourceType === "HealthcareService").length, 0);
});

test("config hydration reconciles a removed selected office back to all offices", async () => {
  resetStore("2026-07-06");
  useSchedulingStore.setState({ officeId: "satellite" });
  const withoutSatellite = {
    ...STORED_CONFIG,
    offices: [{ id: "main", name: "Main Office" }],
    officeBySchedule: {},
  };
  const client = writableClient({
    basics: [{ ...buildSchedulingPracticeConfigResource(withoutSatellite), id: "cfg-1" }],
  });

  await useSchedulingStore.getState().loadDay({ fhirClient: client, force: true });

  assert.equal(useSchedulingStore.getState().officeId, "all");
});

test("saveConfig creates the singleton Basic on first boot", async () => {
  resetStore("2026-07-06");
  hydrateCatalogState();
  const client = writableClient();

  await useSchedulingStore.getState().saveConfig(STORED_CONFIG, { fhirClient: client });

  assert.equal(client.created.length, 1);
  assert.equal(client.created[0]?.sourceTag, SCHEDULING_SOURCE_TAGS.config);
  assert.equal((client.created[0]?.resource as Basic).resourceType, "Basic");
  assert.notDeepEqual(useSchedulingStore.getState().config, DEFAULT_SCHEDULING_PRACTICE_CONFIG);
  assert.deepEqual(useSchedulingStore.getState().config, STORED_CONFIG);
});

test("todayYmd computes the calendar date in the practice timezone offset", () => {
  assert.equal(todayYmd(new Date("2026-07-06T02:30:00Z"), "+03:00"), "2026-07-06");
  assert.equal(todayYmd(new Date("2026-07-06T03:30:00Z"), "-05:00"), "2026-07-05");
});

test("loadDay ignores slower stale responses after the selected date changes", async () => {
  resetStore("2026-07-06");
  const oldAppointments = deferred<Bundle<Appointment>>();
  const newAppointments = deferred<Bundle<Appointment>>();
  const client: SchedulingFhirClient = {
    async search(resourceType, params) {
      if (resourceType !== "Appointment") {
        return EMPTY_BUNDLE as Bundle<Schedule | HealthcareService>;
      }
      const dates = new URLSearchParams(params).getAll("date").join("|");
      if (dates.includes("2026-07-06")) {
        return oldAppointments.promise;
      }
      return newAppointments.promise;
    },
  };

  const oldLoad = useSchedulingStore.getState().loadDay({ fhirClient: client, force: true });
  useSchedulingStore.getState().setDate("2026-07-07");
  const newLoad = useSchedulingStore.getState().loadDay({ fhirClient: client, force: true });

  newAppointments.resolve(bundle([appointment("new", "2026-07-07T09:00:00-05:00")]));
  await newLoad;
  oldAppointments.resolve(bundle([appointment("old", "2026-07-06T09:00:00-05:00")]));
  await oldLoad;

  const state = useSchedulingStore.getState();
  assert.equal(state.date, "2026-07-07");
  assert.deepEqual(state.appointments.map((entry) => entry.id), ["new"]);
  assert.equal(state.error, null);
});

test("shiftDate follows the selected scheduler view granularity", () => {
  resetStore("2026-01-31");
  useSchedulingStore.getState().setView("day");
  useSchedulingStore.getState().shiftDate(1);
  assert.equal(useSchedulingStore.getState().date, "2026-02-01");

  useSchedulingStore.setState({ date: "2026-07-08" });
  useSchedulingStore.getState().setView("week");
  useSchedulingStore.getState().shiftDate(-1);
  assert.equal(useSchedulingStore.getState().date, "2026-07-01");

  useSchedulingStore.setState({ date: "2026-01-31" });
  useSchedulingStore.getState().setView("month");
  useSchedulingStore.getState().shiftDate(1);
  assert.equal(useSchedulingStore.getState().date, "2026-02-28");
});

test("openDay switches to the day view and target date in one atomic update", () => {
  resetStore("2026-07-06");
  useSchedulingStore.setState({ view: "month" });
  const updates: Array<{ view: string; date: string }> = [];
  const unsubscribe = useSchedulingStore.subscribe((state) =>
    updates.push({ view: state.view, date: state.date }),
  );
  useSchedulingStore.getState().openDay("2026-07-20");
  unsubscribe();

  const state = useSchedulingStore.getState();
  assert.equal(state.view, "day");
  assert.equal(state.date, "2026-07-20");
  // The flash came from setDate + setView firing as two separate mutations: one
  // intermediate render showed the old view at the new date. openDay must land both
  // in a single store notification.
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { view: "day", date: "2026-07-20" });
});

test("openDay reconciles the week resource selection like setView does", () => {
  resetStore("2026-07-06");
  useSchedulingStore.setState({
    view: "week",
    resources: seededSchedules(),
    weekResourceScheduleReference: "Schedule/does-not-exist",
  });
  useSchedulingStore.getState().openDay("2026-07-20");

  const reference = useSchedulingStore.getState().weekResourceScheduleReference;
  assert.ok(
    reference === undefined || reference?.startsWith("Schedule/"),
    "stale week resource reference should be reconciled to a real resource or cleared",
  );
});

test("slotMinutes derives from the selected office's booking increment", () => {
  resetStore();
  useSchedulingStore.setState({
    config: {
      ...DEFAULT_SCHEDULING_PRACTICE_CONFIG,
      offices: [
        { id: "main", name: "Main", slotMinutes: 15 },
        { id: "west", name: "West", slotMinutes: 10 },
      ],
      defaultSlotMinutes: 20,
    },
    officeId: "all",
  });

  useSchedulingStore.getState().setOfficeId("main");
  assert.equal(useSchedulingStore.getState().slotMinutes, 15, "specific office uses its own increment");
  useSchedulingStore.getState().setOfficeId("west");
  assert.equal(useSchedulingStore.getState().slotMinutes, 10);
  useSchedulingStore.getState().setOfficeId("all");
  assert.equal(useSchedulingStore.getState().slotMinutes, 20, "all offices fall back to the practice default");
});

test("zoomIn / zoomOut step the vertical zoom by SCHEDULER_ZOOM_STEP", () => {
  resetStore();
  useSchedulingStore.setState({ zoom: 1 });
  useSchedulingStore.getState().zoomIn();
  assert.equal(useSchedulingStore.getState().zoom, 1 + SCHEDULER_ZOOM_STEP, "zoomIn adds one step");
  useSchedulingStore.getState().zoomOut();
  useSchedulingStore.getState().zoomOut();
  assert.equal(useSchedulingStore.getState().zoom, 1 - SCHEDULER_ZOOM_STEP, "zoomOut subtracts one step");
});

test("zoomIn / zoomOut clamp to the min and max vertical zoom", () => {
  resetStore();
  useSchedulingStore.setState({ zoom: SCHEDULER_ZOOM_MAX });
  useSchedulingStore.getState().zoomIn();
  assert.equal(useSchedulingStore.getState().zoom, SCHEDULER_ZOOM_MAX, "clamps at max");

  useSchedulingStore.setState({ zoom: SCHEDULER_ZOOM_MIN });
  useSchedulingStore.getState().zoomOut();
  assert.equal(useSchedulingStore.getState().zoom, SCHEDULER_ZOOM_MIN, "clamps at min");
});

test("loadWindow performs one ranged Appointment search and buckets results by practice-local day", async () => {
  resetStore("2026-07-08");
  useSchedulingStore.getState().setView("week");
  const client = writableClient({
    appointments: [
      appointment("late", "2026-07-07T01:30:00Z"),
      appointment("local", "2026-07-07T09:00:00-05:00"),
    ],
  });

  await useSchedulingStore.getState().loadWindow("2026-07-06", "2026-07-13", {
    fhirClient: client,
    force: true,
  });

  const appointmentSearches = client.searches.filter((call) => call.resourceType === "Appointment");
  assert.equal(appointmentSearches.length, 1);
  assert.deepEqual(appointmentSearches[0]?.params?.getAll("date"), [
    "ge2026-07-06T00:00:00-05:00",
    "lt2026-07-13T00:00:00-05:00",
  ]);
  const state = useSchedulingStore.getState();
  assert.deepEqual(state.appointmentsByDay["2026-07-06"]?.map((entry) => entry.id), ["late"]);
  assert.deepEqual(state.appointmentsByDay["2026-07-07"]?.map((entry) => entry.id), ["local"]);
  assert.deepEqual(state.loadedWindow, {
    fromYmd: "2026-07-06",
    toYmdExclusive: "2026-07-13",
    view: "week",
    anchorDate: "2026-07-08",
  });
});

test("loadWindow ignores stale ranged responses after the selected view and date change", async () => {
  resetStore("2026-07-08");
  useSchedulingStore.getState().setView("week");
  const oldAppointments = deferred<Bundle<Appointment>>();
  const newAppointments = deferred<Bundle<Appointment>>();
  const oldSearchStarted = deferred<void>();
  const client: SchedulingFhirClient = {
    async search(resourceType, params) {
      if (resourceType !== "Appointment") {
        return EMPTY_BUNDLE as Bundle<Schedule | HealthcareService>;
      }
      const dates = new URLSearchParams(params).getAll("date").join("|");
      if (dates.includes("2026-07-06")) {
        oldSearchStarted.resolve();
        return oldAppointments.promise;
      }
      return newAppointments.promise;
    },
  };

  const oldLoad = useSchedulingStore
    .getState()
    .loadWindow("2026-07-06", "2026-07-13", { fhirClient: client, force: true });
  await oldSearchStarted.promise;
  useSchedulingStore.getState().setView("month");
  useSchedulingStore.getState().setDate("2026-08-15");
  const newLoad = useSchedulingStore
    .getState()
    .loadWindow("2026-07-27", "2026-09-07", { fhirClient: client, force: true });

  newAppointments.resolve(bundle([appointment("new", "2026-08-03T09:00:00-05:00")]));
  await newLoad;
  oldAppointments.resolve(bundle([appointment("old", "2026-07-06T09:00:00-05:00")]));
  await oldLoad;

  const state = useSchedulingStore.getState();
  assert.deepEqual(state.appointmentsByDay["2026-08-03"]?.map((entry) => entry.id), ["new"]);
  assert.equal(state.appointmentsByDay["2026-07-06"], undefined);
  assert.deepEqual(state.loadedWindow, {
    fromYmd: "2026-07-27",
    toYmdExclusive: "2026-09-07",
    view: "month",
    anchorDate: "2026-08-15",
  });
});

test("loadDay reuses loaded catalogs on date navigation and force-refreshes on demand", async () => {
  resetStore("2026-07-06");
  const counts = new Map<string, number>();
  const client: SchedulingFhirClient = {
    async search(resourceType) {
      counts.set(resourceType, (counts.get(resourceType) ?? 0) + 1);
      return EMPTY_BUNDLE as Bundle<Schedule | HealthcareService | Appointment>;
    },
  };

  await useSchedulingStore.getState().loadDay({ fhirClient: client, force: true });
  useSchedulingStore.getState().setDate("2026-07-07");
  await useSchedulingStore.getState().loadDay({ fhirClient: client });
  await useSchedulingStore.getState().loadDay({ fhirClient: client, force: true });

  assert.equal(counts.get("Appointment"), 3);
  assert.equal(counts.get("Schedule"), 2);
  assert.equal(counts.get("HealthcareService"), 2);
});

test("createAppointment writes a mirrored Appointment, source-tags the write, then reloads the day", async () => {
  resetStore("2026-07-06");
  hydrateCatalogState();
  const client = writableClient();

  await useSchedulingStore.getState().createAppointment(
    {
      patient: { reference: "Patient/p1", display: "Doe, Jane" },
      visitTypeCode: "routine-exam-new",
      resourceScheduleReferences: ["Schedule/sch-provider"],
      start: "2026-07-06T09:00:00-05:00",
    },
    { fhirClient: client, now: () => "2026-07-06T14:00:00-05:00" },
  );

  assert.equal(client.created.length, 1);
  assert.equal(client.created[0]?.sourceTag, SCHEDULING_SOURCE_TAGS.create);
  const created = client.created[0]?.resource as Appointment;
  assert.equal(created.status, "booked");
  assert.equal(created.created, "2026-07-06T14:00:00-05:00");
  assert.deepEqual(
    created.participant.map((participant) => participant.actor?.reference),
    ["Patient/p1", "Practitioner/bang-eric"],
  );
  assert.deepEqual(useSchedulingStore.getState().appointments.map((entry) => entry.id), [
    "Appointment-1",
  ]);
  assert.equal(
    appointmentVisitTypeCode(useSchedulingStore.getState().appointments[0]!),
    "routine-exam-new",
  );
});

test("setAppointmentStatus and setConfirmationStatus update from the refreshed resource snapshot", async () => {
  resetStore("2026-07-06");
  const existing: Appointment = {
    ...buildSchedulingAppointment({
      patient: { reference: "Patient/p1" },
      visitTypeCode: "routine-exam-new",
      discipline: "eyecare",
      resources: [{ reference: "Practitioner/bang-eric" }],
      start: "2026-07-06T09:00:00-05:00",
      durationMinutes: 30,
    }),
    id: "appt-1",
    meta: { versionId: "3" },
  };
  hydrateCatalogState([existing]);
  const client = writableClient({ appointments: [existing] });

  await useSchedulingStore.getState().setAppointmentStatus(existing, "walk-in", {
    fhirClient: client,
  });
  await useSchedulingStore.getState().setConfirmationStatus(existing, "confirmed", {
    fhirClient: client,
  });

  const statusUpdate = client.updated[0]?.resource as Appointment;
  assert.equal(client.updated[0]?.sourceTag, SCHEDULING_SOURCE_TAGS.status);
  assert.equal(statusUpdate.status, "arrived");
  assert.equal(statusUpdate.appointmentType?.coding?.[0]?.code, "WALKIN");
  const confirmationUpdate = client.updated[1]?.resource as Appointment;
  assert.equal(client.updated[1]?.sourceTag, SCHEDULING_SOURCE_TAGS.confirmation);
  assert.equal(confirmationUpdate.status, "arrived");
  assert.equal(confirmationUpdate.appointmentType?.coding?.[0]?.code, "WALKIN");
  assert.equal(confirmationStatusOf(confirmationUpdate), "confirmed");
});

test("confirmation updates merge onto the current Appointment without dropping foreign fields", async () => {
  resetStore("2026-07-06");
  const existing: Appointment = {
    ...buildSchedulingAppointment({
      patient: { reference: "Patient/p1" },
      visitTypeCode: "routine-exam-new",
      discipline: "eyecare",
      resources: [{ reference: "Practitioner/bang-eric" }],
      start: "2026-07-06T09:00:00-05:00",
      durationMinutes: 30,
      status: "checked-in",
    }),
    id: "appt-preserve",
    identifier: [{ system: "https://foreign.example/appt", value: "ABC-123" }],
    slot: [{ reference: "Slot/slot-1" }],
    basedOn: [{ reference: "ServiceRequest/sr-1" }],
    cancelationReason: { text: "foreign reason" },
    extension: [
      {
        url: "https://foreign.example/fhir/StructureDefinition/do-not-touch",
        valueString: "foreign value",
      },
      ...buildSchedulingAppointment({
        patient: { reference: "Patient/p1" },
        visitTypeCode: "routine-exam-new",
        discipline: "eyecare",
        resources: [{ reference: "Practitioner/bang-eric" }],
        start: "2026-07-06T09:00:00-05:00",
        durationMinutes: 30,
      }).extension!,
    ],
  };
  hydrateCatalogState([existing]);
  const client = writableClient({ appointments: [existing] });

  await useSchedulingStore.getState().setConfirmationStatus(existing, "confirmed", {
    fhirClient: client,
  });

  const updated = client.updated[0]?.resource as Appointment;
  assert.equal(updated.status, "checked-in");
  assert.deepEqual(updated.identifier, existing.identifier);
  assert.deepEqual(updated.slot, existing.slot);
  assert.deepEqual(updated.basedOn, existing.basedOn);
  assert.deepEqual(updated.cancelationReason, existing.cancelationReason);
  assert.equal(
    updated.extension?.find((extension) => extension.url === "https://foreign.example/fhir/StructureDefinition/do-not-touch")
      ?.valueString,
    "foreign value",
  );
  assert.equal(confirmationStatusOf(updated), "confirmed");
});

test("coverage updates distinguish undefined keep, null clear, and value replace", async () => {
  resetStore("2026-07-06");
  const existing: Appointment = {
    ...buildSchedulingAppointment({
      patient: { reference: "Patient/p1" },
      visitTypeCode: "routine-exam-new",
      discipline: "eyecare",
      resources: [{ reference: "Practitioner/bang-eric" }],
      start: "2026-07-06T09:00:00-05:00",
      durationMinutes: 30,
      visionCoverage: { reference: "Coverage/vision-1", display: "VSP" },
      medicalCoverage: { reference: "Coverage/medical-1", display: "BCBS" },
    }),
    id: "appt-coverage",
    extension: [
      {
        url: "https://foreign.example/fhir/StructureDefinition/keep-me",
        valueString: "still here",
      },
      ...buildSchedulingAppointment({
        patient: { reference: "Patient/p1" },
        visitTypeCode: "routine-exam-new",
        discipline: "eyecare",
        resources: [{ reference: "Practitioner/bang-eric" }],
        start: "2026-07-06T09:00:00-05:00",
        durationMinutes: 30,
        visionCoverage: { reference: "Coverage/vision-1", display: "VSP" },
        medicalCoverage: { reference: "Coverage/medical-1", display: "BCBS" },
      }).extension!,
    ],
  };
  hydrateCatalogState([existing]);
  const client = writableClient({ appointments: [existing] });

  await useSchedulingStore.getState().updateAppointment(
    existing,
    { visionCoverage: null as never },
    { fhirClient: client },
  );

  const updated = client.updated[0]?.resource as Appointment;
  assert.equal(visionCoverageOf(updated), undefined);
  assert.deepEqual(medicalCoverageOf(updated), { reference: "Coverage/medical-1", display: "BCBS" });
  assert.equal(
    updated.extension?.find((extension) => extension.url === "https://foreign.example/fhir/StructureDefinition/keep-me")
      ?.valueString,
    "still here",
  );
  assert.equal(
    updated.extension?.some((extension) => extension.url === ODOS_VISION_COVERAGE_EXTENSION_URL),
    false,
  );
});

test("moveAppointment rebuilds time and resource participants through the same conflict guard", async () => {
  resetStore("2026-07-06");
  const existing: Appointment = {
    ...buildSchedulingAppointment({
      patient: { reference: "Patient/p1", display: "Doe, Jane" },
      visitTypeCode: "routine-exam-new",
      discipline: "eyecare",
      resources: [{ reference: "Practitioner/bang-eric" }],
      start: "2026-07-06T09:00:00-05:00",
      durationMinutes: 30,
    }),
    id: "appt-1",
  };
  hydrateCatalogState([existing]);
  const client = writableClient({ appointments: [existing] });

  await useSchedulingStore.getState().moveAppointment(
    existing,
    { start: "2026-07-06T10:00:00-05:00", resourceScheduleActor: "Location/exam-1" },
    { fhirClient: client },
  );

  const moved = client.updated[0]?.resource as Appointment;
  assert.equal(client.updated[0]?.sourceTag, SCHEDULING_SOURCE_TAGS.move);
  assert.equal(moved.start, "2026-07-06T10:00:00-05:00");
  assert.equal(moved.end, "2026-07-06T10:30:00-05:00");
  assert.deepEqual(
    moved.participant.map((participant) => participant.actor?.reference),
    ["Patient/p1", "Location/exam-1"],
  );
});

test("moveAppointment swaps only the source resource actor and preserves other resource participants", async () => {
  resetStore("2026-07-06");
  const existing: Appointment = {
    ...buildSchedulingAppointment({
      patient: { reference: "Patient/p1", display: "Doe, Jane" },
      visitTypeCode: "routine-exam-new",
      discipline: "eyecare",
      resources: [{ reference: "Practitioner/bang-eric" }, { reference: "Location/exam-1" }],
      start: "2026-07-06T09:00:00-05:00",
      durationMinutes: 30,
    }),
    id: "appt-multi-resource",
  };
  hydrateCatalogState([existing]);
  const client = writableClient({ appointments: [existing] });

  await useSchedulingStore.getState().moveAppointment(
    existing,
    {
      start: "2026-07-06T10:00:00-05:00",
      resourceScheduleActor: "Practitioner/smith-amy",
      sourceResourceScheduleActor: "Practitioner/bang-eric",
    } as never,
    { fhirClient: client },
  );

  const moved = client.updated[0]?.resource as Appointment;
  assert.deepEqual(
    moved.participant.map((participant) => participant.actor?.reference),
    ["Patient/p1", "Practitioner/smith-amy", "Location/exam-1"],
  );
});

test("createAppointment fetches target-day target-resource conflicts before booking", async () => {
  resetStore("2026-07-06");
  hydrateCatalogState([]);
  const remoteConflict: Appointment = {
    ...buildSchedulingAppointment({
      patient: { reference: "Patient/p0" },
      visitTypeCode: "routine-exam-new",
      discipline: "eyecare",
      resources: [{ reference: "Practitioner/bang-eric" }],
      start: "2026-07-09T09:00:00-05:00",
      durationMinutes: 30,
    }),
    id: "remote-conflict",
  };
  const client = writableClient({ appointments: [remoteConflict] });

  await assert.rejects(
    useSchedulingStore.getState().createAppointment(
      {
        patient: { reference: "Patient/p1" },
        visitTypeCode: "routine-exam-new",
        resourceScheduleReferences: ["Schedule/sch-provider"],
        start: "2026-07-09T09:15:00-05:00",
      },
      { fhirClient: client },
    ),
    /remote-conflict|already booked/,
  );

  const conflictSearch = client.searches.find(
    (call) => call.resourceType === "Appointment" && call.params?.get("actor") === "Practitioner/bang-eric",
  );
  assert.deepEqual(conflictSearch?.params?.getAll("date"), [
    "ge2026-07-09T00:00:00-05:00",
    "lt2026-07-10T00:00:00-05:00",
  ]);
  assert.equal(client.created.length, 0);
});

test("status-only updates skip conflict checks even when the current day is double-booked", async () => {
  resetStore("2026-07-06");
  const first: Appointment = {
    ...buildSchedulingAppointment({
      patient: { reference: "Patient/p1" },
      visitTypeCode: "routine-exam-new",
      discipline: "eyecare",
      resources: [{ reference: "Practitioner/bang-eric" }],
      start: "2026-07-06T09:00:00-05:00",
      durationMinutes: 30,
    }),
    id: "appt-first",
  };
  const second: Appointment = {
    ...buildSchedulingAppointment({
      patient: { reference: "Patient/p2" },
      visitTypeCode: "routine-exam-new",
      discipline: "eyecare",
      resources: [{ reference: "Practitioner/bang-eric" }],
      start: "2026-07-06T09:15:00-05:00",
      durationMinutes: 30,
    }),
    id: "appt-second",
  };
  hydrateCatalogState([first, second]);
  const client = writableClient({ appointments: [first, second] });

  await useSchedulingStore.getState().setAppointmentStatus(first, "checked-in", {
    fhirClient: client,
  });

  const updated = client.updated[0]?.resource as Appointment;
  assert.equal(updated.id, "appt-first");
  assert.equal(updated.status, "checked-in");
});
