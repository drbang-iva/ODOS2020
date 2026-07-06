import assert from "node:assert/strict";
import { test } from "node:test";
import type { Appointment, Bundle, HealthcareService, Resource, Schedule } from "@medplum/fhirtypes";
import {
  DEFAULT_SCHEDULING_PRACTICE_CONFIG,
  searchAll,
  todayYmd,
  useSchedulingStore,
  type SchedulingFhirClient,
} from "../../ui/src/lib/scheduling-store.js";

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
    date,
    resources: [],
    visitTypes: [],
    appointments: [],
    config: DEFAULT_SCHEDULING_PRACTICE_CONFIG,
    loading: false,
    error: null,
    catalogsLoaded: false,
  });
}

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
