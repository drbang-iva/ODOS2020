import assert from "node:assert/strict";
import { test } from "node:test";
import type { Appointment, Coverage, HealthcareService, Schedule } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { OdosChips } from "../src/components/inputs/OdosChips";
import type { AppointmentModalDraft } from "../src/lib/scheduler-appointment-ui";
import {
  ODOS_DISCIPLINE_SYSTEM,
  buildAppointmentBlockContent,
  buildSchedulingAppointment,
  buildVisitType,
  filterSchedulingResourcesByHiddenActorReferences,
  type SchedulingPracticeConfig,
} from "../src/lib/scheduling";
import {
  DEFAULT_SCHEDULING_PRACTICE_CONFIG,
  SCHEDULER_HIDDEN_RESOURCES_STORAGE_KEY,
  SCHEDULER_SLOT_MINUTES_STORAGE_KEY,
  readSchedulerHiddenResourceRefs,
  schedulerSlotMinutesState,
  useSchedulingStore,
} from "../src/lib/scheduling-store";
import { SchedulerDayGrid, SchedulerToolbar } from "../src/scenes/SchedulerDayGrid";
import { AppointmentHoverCard } from "../src/scenes/scheduler/AppointmentHoverCard";
import { AppointmentDetailsModal } from "../src/scenes/scheduler/AppointmentDetailsModal";
import { PatientQuickCard } from "../src/scenes/scheduler/PatientQuickCard";
import { ResourceDayColumn, SchedulerTimeGutter } from "../src/scenes/scheduler/ResourceDayColumn";
import { SchedulingSettingsModal } from "../src/scenes/scheduler/SchedulingSettingsModal";

const RESOURCE: Schedule = {
  resourceType: "Schedule",
  id: "schedule-1",
  active: true,
  actor: [{ reference: "Practitioner/doctor-1", display: "Dr One" }],
};

const SCHEDULER_RESOURCES: Schedule[] = [
  schedulingResource("schedule-1", "Practitioner/doctor-1", "Dr One", "eyecare"),
  schedulingResource("exam-1", "Location/exam-1", "Exam 1", "eyecare"),
  schedulingResource("oct-1", "Device/oct-1", "OCT 1", "eyecare"),
  schedulingResource("aesthetics-1", "Practitioner/aesthetics-1", "Aesthetics Provider", "aesthetics"),
];

const ROUTINE = visitType("routine", "Routine Exam", 30);
const OFF_PRESET = visitType("off-preset", "Off-preset Visit", 20);

test("appointment block content trims notes and omits blank comments", () => {
  const withNote = buildAppointmentBlockContent(
    appointment({ comment: "  Dilate before OCT retina recheck.  " }),
    [],
  );
  const withoutNote = buildAppointmentBlockContent(appointment({ comment: " \n\t " }), []);

  assert.equal(withNote.note, "Dilate before OCT retina recheck.");
  assert.equal(withoutNote.note, undefined);
});

test("shared day and week appointment blocks show the note indicator only when present", () => {
  const withNote = renderGridBlock("Dilate before OCT retina recheck.");
  const withoutNote = renderGridBlock();

  assert.match(withNote, /aria-label="Appointment note"/);
  assert.doesNotMatch(withoutNote, /aria-label="Appointment note"/);
});

test("appointment hover card shows the full note only when present", () => {
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { innerWidth: 1400, innerHeight: 900 },
  });
  try {
    const content = buildAppointmentBlockContent(
      appointment({ comment: "Dilate before OCT retina recheck." }),
      [],
    );
    const withNote = renderToStaticMarkup(
      <AppointmentHoverCard content={content} anchor={{ top: 100, left: 200, right: 360 }} />,
    );
    const withoutNote = renderToStaticMarkup(
      <AppointmentHoverCard
        content={buildAppointmentBlockContent(appointment(), [])}
        anchor={{ top: 100, left: 200, right: 360 }}
      />,
    );

    assert.match(withNote, /Appointment note/);
    assert.match(withNote, /Dilate before OCT retina recheck\./);
    assert.doesNotMatch(withoutNote, /Appointment note|Dilate before OCT retina recheck\./);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("patient quick card shows the full appointment note only when present", () => {
  const props = {
    pinned: false,
    canStartChart: true,
    onPinnedChange: () => undefined,
    onClose: () => undefined,
    onDetails: () => undefined,
    date: "2026-07-14",
  };
  const withNote = renderToStaticMarkup(
    <PatientQuickCard
      {...props}
      appointment={appointment({
        comment: "  Manifest refraction and dilation before doctor.  ",
        participant: [{ actor: { reference: "Practitioner/doctor-1", display: "Dr One" } }],
      })}
    />,
  );
  const withoutNote = renderToStaticMarkup(
    <PatientQuickCard
      {...props}
      appointment={appointment({
        comment: " \n ",
        participant: [{ actor: { reference: "Practitioner/doctor-1", display: "Dr One" } }],
      })}
    />,
  );

  assert.match(withNote, /Appointment note/);
  assert.match(withNote, /Manifest refraction and dilation before doctor\./);
  assert.doesNotMatch(withoutNote, /Appointment note|Manifest refraction and dilation before doctor\./);
});

test("patient quick card exposes the chart action only after check-in", () => {
  const props = {
    pinned: false,
    canStartChart: true,
    onPinnedChange: () => undefined,
    onClose: () => undefined,
    onDetails: () => undefined,
    date: "2026-07-14",
  };
  const checkedIn = renderToStaticMarkup(
    <PatientQuickCard {...props} appointment={appointment({ status: "arrived" })} />,
  );
  const booked = renderToStaticMarkup(
    <PatientQuickCard {...props} appointment={appointment({ status: "booked" })} />,
  );

  assert.match(checkedIn, />Start chart</);
  assert.doesNotMatch(booked, />Start chart|>Open chart</);
});

test("slot interval override persists, survives office switches, and Auto re-derives config", () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = memoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  const config: SchedulingPracticeConfig = {
    ...DEFAULT_SCHEDULING_PRACTICE_CONFIG,
    defaultSlotMinutes: 30,
    offices: [
      { id: "main", name: "Main", slotMinutes: 10 },
      { id: "satellite", name: "Satellite", slotMinutes: 30 },
    ],
  };
  try {
    storage.setItem(SCHEDULER_SLOT_MINUTES_STORAGE_KEY, "15");
    assert.deepEqual(schedulerSlotMinutesState(config, "main", storage), {
      slotMinutes: 15,
      slotMinutesOverride: 15,
    });

    useSchedulingStore.setState({ config, officeId: "main", slotMinutes: 10, slotMinutesOverride: null });
    useSchedulingStore.getState().setSlotMinutes(15);
    assert.equal(useSchedulingStore.getState().slotMinutes, 15);
    assert.equal(storage.getItem(SCHEDULER_SLOT_MINUTES_STORAGE_KEY), "15");

    useSchedulingStore.getState().setOfficeId("satellite");
    assert.equal(useSchedulingStore.getState().slotMinutes, 15);
    assert.equal(useSchedulingStore.getState().slotMinutesOverride, 15);

    useSchedulingStore.getState().setSlotMinutes(null);
    assert.equal(storage.getItem(SCHEDULER_SLOT_MINUTES_STORAGE_KEY), null);
    assert.equal(useSchedulingStore.getState().slotMinutes, 30);
    assert.equal(useSchedulingStore.getState().slotMinutesOverride, null);
  } finally {
    useSchedulingStore.setState({
      config: DEFAULT_SCHEDULING_PRACTICE_CONFIG,
      officeId: "all",
      slotMinutes: 30,
      slotMinutesOverride: null,
    });
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test("hidden resource preferences add, remove, round-trip, clear, and tolerate stale references", () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = memoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  const originalHidden = useSchedulingStore.getState().hiddenResourceRefs;
  try {
    useSchedulingStore.setState({ hiddenResourceRefs: [] });
    useSchedulingStore.getState().setResourceHidden("Practitioner/doctor-1", true);
    assert.deepEqual(useSchedulingStore.getState().hiddenResourceRefs, ["Practitioner/doctor-1"]);
    assert.deepEqual(readSchedulerHiddenResourceRefs(storage), ["Practitioner/doctor-1"]);

    useSchedulingStore.getState().setResourceHidden("Location/exam-1", true);
    useSchedulingStore.getState().setResourceHidden("Practitioner/doctor-1", false);
    assert.deepEqual(useSchedulingStore.getState().hiddenResourceRefs, ["Location/exam-1"]);

    storage.setItem(
      SCHEDULER_HIDDEN_RESOURCES_STORAGE_KEY,
      JSON.stringify(["Device/retinal-camera", "Device/retinal-camera", "", 42]),
    );
    assert.deepEqual(readSchedulerHiddenResourceRefs(storage), ["Device/retinal-camera"]);

    useSchedulingStore.getState().clearHiddenResources();
    assert.deepEqual(useSchedulingStore.getState().hiddenResourceRefs, []);
    assert.equal(storage.getItem(SCHEDULER_HIDDEN_RESOURCES_STORAGE_KEY), null);
  } finally {
    useSchedulingStore.setState({ hiddenResourceRefs: originalHidden });
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test("hidden actor filtering preserves visible resource order and ignores unknown stored refs", () => {
  const filtered = filterSchedulingResourcesByHiddenActorReferences(
    SCHEDULER_RESOURCES.slice(0, 3),
    ["Location/exam-1", "Device/unknown"],
  );
  assert.deepEqual(
    filtered.map((resource) => resource.actor?.[0]?.reference),
    ["Practitioner/doctor-1", "Device/oct-1"],
  );
});

test("shared day and week toolbar exposes Auto, 30, 15, and 10 minute view controls", () => {
  for (const view of ["day", "week"] as const) {
    const html = renderToStaticMarkup(
      <SchedulerToolbar
        clinicMode="both"
        date="2026-07-14"
        dayActionsEnabled={view === "day"}
        legendOpen
        officeId="all"
        offices={[]}
        resources={SCHEDULER_RESOURCES}
        hiddenResourceRefs={[]}
        slotMinutesOverride={15}
        onClinicModeChange={() => undefined}
        onFindOpen={() => undefined}
        onLegendToggle={() => undefined}
        onMove={() => undefined}
        onNext={() => undefined}
        onOfficeChange={() => undefined}
        onPrevious={() => undefined}
        onSettings={() => undefined}
        onSlotMinutesChange={() => undefined}
        onResourceHiddenChange={() => undefined}
        onShowAllResources={() => undefined}
        onToday={() => undefined}
        onViewChange={() => undefined}
        onWalkIn={() => undefined}
        onZoomIn={() => undefined}
        onZoomOut={() => undefined}
        zoomEnabled
        moveActive={false}
        moveEnabled={false}
        view={view}
      />,
    );
    assert.match(html, /aria-label="Grid interval"/);
    for (const label of ["Auto (config)", "30 min", "15 min", "10 min"]) assert.ok(html.includes(label));
  }
});

test("Columns groups current resources, updates Day and Week, restores all, and reaches the empty state", async () => {
  const originalState = useSchedulingStore.getState();
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = memoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  let renderer!: ReactTestRenderer;
  try {
    useSchedulingStore.setState({
      ...originalState,
      clinicMode: "eyecare",
      view: "day",
      date: "2026-07-14",
      slotMinutes: 30,
      slotMinutesOverride: null,
      hiddenResourceRefs: [],
      resources: SCHEDULER_RESOURCES,
      visitTypes: [],
      appointments: [],
      appointmentsByDay: {},
      loadedWindow: null,
      config: DEFAULT_SCHEDULING_PRACTICE_CONFIG,
      officeId: "all",
      weekResourceScheduleReference: "Schedule/schedule-1",
      catalogsLoaded: true,
      loading: false,
      error: null,
      loadDay: async () => undefined,
      loadWindow: async () => undefined,
    });
    await act(async () => {
      renderer = create(<SchedulerDayGrid />);
      await Promise.resolve();
    });

    const schedulerText = testInstanceText(renderer.root);
    assert.ok(schedulerText.includes("Dr One"));
    assert.ok(schedulerText.includes("Provider"));
    assert.ok(!schedulerText.includes("Practitioner/doctor-1"));
    assert.ok(!schedulerText.includes("Schedule/schedule-1"));

    const pickerText = testInstanceText(renderer.root.findByProps({ "aria-label": "Scheduler columns" }));
    for (const label of ["Providers", "Rooms", "Equipment", "Dr One", "Exam 1", "OCT 1"]) {
      assert.ok(pickerText.includes(label), `picker includes ${label}`);
    }
    assert.ok(!pickerText.includes("Aesthetics Provider"), "current clinic mode excludes unrelated resources");
    assert.deepEqual(renderedColumnRefs(renderer), ["Practitioner/doctor-1", "Location/exam-1", "Device/oct-1"]);

    assert.equal(button(renderer, "Dr One").props["aria-pressed"], true);
    act(() => button(renderer, "Dr One").props.onClick());
    assert.deepEqual(renderedColumnRefs(renderer), ["Location/exam-1", "Device/oct-1"]);

    act(() => button(renderer, "Week").props.onClick());
    const weekOptions = renderer.root.findByType("section").findAllByType("option").map((option) => option.props.value);
    assert.deepEqual(weekOptions, ["Schedule/exam-1", "Schedule/oct-1"]);

    act(() => button(renderer, "Day").props.onClick());
    act(() => button(renderer, "Show all").props.onClick());
    assert.deepEqual(renderedColumnRefs(renderer), ["Practitioner/doctor-1", "Location/exam-1", "Device/oct-1"]);

    for (const label of ["Dr One", "Exam 1", "OCT 1"]) {
      act(() => button(renderer, label).props.onClick());
    }
    assert.deepEqual(renderedColumnRefs(renderer), []);
    assert.match(JSON.stringify(renderer.toJSON()), /No scheduler resources found for this clinic mode/);
  } finally {
    renderer?.unmount();
    useSchedulingStore.setState(originalState, true);
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test("blocked-time selected resources preserve schedule references through OdosChips", () => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <SchedulingSettingsModal
        config={{
          ...DEFAULT_SCHEDULING_PRACTICE_CONFIG,
          blocks: [{
            kind: "custom",
            description: "Team meeting",
            weekdays: ["wed"],
            start: "12:00",
            end: "13:00",
            scheduleReferences: ["Schedule/schedule-1"],
          }],
        }}
        currentDate="2026-07-30"
        resources={SCHEDULER_RESOURCES}
        canManageResources={false}
        integrityIssues={[]}
        integrityLoading={false}
        onClose={() => undefined}
        onDeactivateResource={async () => { throw new Error("not called"); }}
        onInspectIntegrity={async () => undefined}
        onSave={async () => undefined}
      />,
    );
  });
  const resourceChips = renderer.root.findByType(OdosChips);
  assert.equal(resourceChips.props.ariaLabel, "Selected scheduling resources");
  assert.deepEqual(resourceChips.props.selected, ["Schedule/schedule-1"]);
  assert.deepEqual(
    resourceChips.props.options.map((option: { value: string }) => option.value),
    ["Schedule/schedule-1", "Schedule/exam-1", "Schedule/oct-1", "Schedule/aesthetics-1"],
  );
  const examChip = resourceChips.findAllByType("button").find((candidate) => candidate.children.join("") === "Exam 1");
  assert.ok(examChip);
  act(() => examChip.props.onClick());
  assert.deepEqual(
    renderer.root.findByType(OdosChips).props.selected,
    ["Schedule/schedule-1", "Schedule/exam-1"],
  );
  act(() => renderer.unmount());
});

test("practice-admin resource lifecycle guards future appointments, supports acknowledgement, and lists broken links without raw ids", async () => {
  const originalState = useSchedulingStore.getState();
  const calls: Array<{ scheduleId: string; acknowledge: boolean }> = [];
  let renderer!: ReactTestRenderer;
  try {
    useSchedulingStore.setState({
      ...originalState,
      clinicMode: "eyecare",
      view: "day",
      date: "2026-07-14",
      resources: [SCHEDULER_RESOURCES[0]!],
      resourceIssues: [],
      integrityIssues: [{
        sourceType: "Schedule",
        sourceId: "ghost-schedule",
        display: "Ghost Provider",
        actorDisplay: "Ghost Provider",
        problem: "Resource is missing a valid provider, room, or equipment link.",
      }],
      integrityLoading: false,
      visitTypes: [],
      appointments: [],
      appointmentsByDay: {},
      config: DEFAULT_SCHEDULING_PRACTICE_CONFIG,
      catalogsLoaded: true,
      loading: false,
      error: null,
      loadDay: async () => undefined,
      loadWindow: async () => undefined,
      inspectIntegrity: async () => undefined,
      deactivateResource: async (scheduleId, acknowledge) => {
        calls.push({ scheduleId, acknowledge });
        if (!acknowledge) {
          return { deactivated: false, futureAppointmentCount: 2 };
        }
        useSchedulingStore.setState({ resources: [] });
        return { deactivated: true, futureAppointmentCount: 2 };
      },
    });
    await act(async () => {
      renderer = create(<SchedulerDayGrid roles={["admin"]} />);
      await Promise.resolve();
    });
    act(() => button(renderer, "Settings").props.onClick());
    await act(async () => Promise.resolve());

    const settingsText = testInstanceText(renderer.root);
    assert.ok(settingsText.includes("Scheduler Resources"));
    assert.ok(settingsText.includes("Ghost Provider"));
    assert.ok(settingsText.includes("Read-only check"));
    assert.ok(!settingsText.includes("Practitioner/doctor-1"));
    assert.ok(!settingsText.includes("Schedule/schedule-1"));

    await act(async () => {
      button(renderer, "Deactivate resource").props.onClick();
      await Promise.resolve();
    });
    assert.match(testInstanceText(renderer.root), /2\s+future appointment/);
    assert.deepEqual(calls[0], { scheduleId: "schedule-1", acknowledge: false });

    await act(async () => {
      button(renderer, "Acknowledge and deactivate").props.onClick();
      await Promise.resolve();
    });
    assert.deepEqual(calls[1], { scheduleId: "schedule-1", acknowledge: true });
    assert.deepEqual(renderedColumnRefs(renderer), []);
  } finally {
    renderer?.unmount();
    useSchedulingStore.setState(originalState, true);
  }
});

test("scheduler resource lifecycle controls stay practice-admin-only", async () => {
  const originalState = useSchedulingStore.getState();
  let renderer!: ReactTestRenderer;
  try {
    useSchedulingStore.setState({
      ...originalState,
      resources: [SCHEDULER_RESOURCES[0]!],
      resourceIssues: [],
      integrityIssues: [],
      visitTypes: [],
      appointments: [],
      appointmentsByDay: {},
      catalogsLoaded: true,
      loadDay: async () => undefined,
      loadWindow: async () => undefined,
    });
    await act(async () => {
      renderer = create(<SchedulerDayGrid roles={["staff"]} />);
      await Promise.resolve();
    });
    act(() => button(renderer, "Settings").props.onClick());
    assert.ok(!testInstanceText(renderer.root).includes("Scheduler Resources"));
  } finally {
    renderer?.unmount();
    useSchedulingStore.setState(originalState, true);
  }
});

test("browser Appointment builder rejects an empty-id participant actor before FHIR write", () => {
  assert.throws(
    () => buildSchedulingAppointment({
      patient: { reference: "Patient/patient-1" },
      visitTypeCode: "routine",
      discipline: "eyecare",
      resources: [{ reference: "Practitioner/" }],
      start: "2026-07-14T09:00:00-05:00",
      durationMinutes: 30,
    }),
    /Appointment participant actor.*Type\/<id>/,
  );
});

test("one visible hours-less column retains the base practice time axis while true empty cases stay empty", async () => {
  const originalState = useSchedulingStore.getState();
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = memoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  const practiceHoursConfig: SchedulingPracticeConfig = {
    ...DEFAULT_SCHEDULING_PRACTICE_CONFIG,
    defaultWeeklyHours: {},
    weeklyHoursBySchedule: {
      "Schedule/schedule-1": {},
      "Schedule/exam-1": { tue: [{ start: "08:00", end: "17:00" }] },
      "Schedule/oct-1": { tue: [{ start: "09:00", end: "16:00" }] },
    },
  };
  let renderer!: ReactTestRenderer;
  try {
    useSchedulingStore.setState({
      ...originalState,
      clinicMode: "eyecare",
      view: "day",
      date: "2026-07-14",
      slotMinutes: 30,
      slotMinutesOverride: null,
      hiddenResourceRefs: ["Location/exam-1", "Device/oct-1"],
      resources: SCHEDULER_RESOURCES,
      visitTypes: [],
      appointments: [],
      appointmentsByDay: {},
      loadedWindow: null,
      config: practiceHoursConfig,
      officeId: "all",
      weekResourceScheduleReference: "Schedule/schedule-1",
      catalogsLoaded: true,
      loading: false,
      error: null,
      loadDay: async () => undefined,
      loadWindow: async () => undefined,
    });
    await act(async () => {
      renderer = create(<SchedulerDayGrid />);
      await Promise.resolve();
    });

    assert.deepEqual(renderedColumnRefs(renderer), ["Practitioner/doctor-1"]);
    assert.equal(timeAxisRows(renderer).length, 18);
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /No scheduler resources found for this clinic mode/);

    act(() => button(renderer, "Dr One").props.onClick());
    assert.deepEqual(renderedColumnRefs(renderer), []);
    assert.equal(timeAxisRows(renderer).length, 0);
    assert.match(JSON.stringify(renderer.toJSON()), /No scheduler resources found for this clinic mode/);

    act(() => button(renderer, "Show all").props.onClick());
    assert.deepEqual(renderedColumnRefs(renderer), ["Practitioner/doctor-1", "Location/exam-1", "Device/oct-1"]);
    assert.equal(timeAxisRows(renderer).length, 18);

    act(() => useSchedulingStore.setState({
      config: { ...practiceHoursConfig, weeklyHoursBySchedule: {} },
    }));
    assert.deepEqual(renderedColumnRefs(renderer), ["Practitioner/doctor-1", "Location/exam-1", "Device/oct-1"]);
    assert.equal(timeAxisRows(renderer).length, 0);
    assert.match(JSON.stringify(renderer.toJSON()), /No scheduler resources found for this clinic mode/);
  } finally {
    renderer?.unmount();
    useSchedulingStore.setState(originalState, true);
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test("duration presets update the saved draft and invalid custom input keeps the existing validator authoritative", async () => {
  let createdDuration: number | undefined;
  const renderer = await renderModal({
    onCreate: async (input) => { createdDuration = input.durationMinutes; },
  });
  act(() => renderer.root.findByProps({ "aria-label": "Duration preset" }).props.onChange({ target: { value: "60" } }));
  await clickSave(renderer);
  assert.equal(createdDuration, 60);

  const invalid = await renderModal();
  act(() => invalid.root.findByProps({ "aria-label": "Duration preset" }).props.onChange({ target: { value: "custom" } }));
  act(() => invalid.root.findByProps({ "aria-label": "Custom duration minutes" }).props.onChange({ target: { value: "0" } }));
  await clickSave(invalid);
  assert.match(JSON.stringify(invalid.toJSON()), /Duration must be &gt;= 1 minute|Duration must be >= 1 minute/);
  renderer.unmount();
  invalid.unmount();
});

test("visit-type auto-fill maps an off-preset duration to Custom with its value", async () => {
  const renderer = await renderModal({ visitTypes: [ROUTINE, OFF_PRESET] });
  act(() => renderer.root.findByProps({ "aria-label": "Service Type" }).props.onChange({ target: { value: "off-preset" } }));
  assert.equal(renderer.root.findByProps({ "aria-label": "Duration preset" }).props.value, "custom");
  assert.equal(renderer.root.findByProps({ "aria-label": "Custom duration minutes" }).props.value, 20);
  renderer.unmount();
});

test("patient coverages populate the matching insurance selects and save their display strings", async () => {
  let savedVision: { reference?: string; display?: string } | undefined;
  let savedMedical: { reference?: string; display?: string } | undefined;
  const renderer = await renderModal({
    initialDraft: draft({ patient: { reference: "Patient/patient-1", display: "Seed Patient" } }),
    loadPatientInsurance: async () => ({ coverages: [VISION, MEDICAL], relatedPeople: [] }),
    onCreate: async (input) => {
      savedVision = input.visionCoverage;
      savedMedical = input.medicalCoverage;
    },
  });
  const vision = renderer.root.findByProps({ "aria-label": "Vision Insurance" });
  const medical = renderer.root.findByProps({ "aria-label": "Medical Insurance" });
  assert.ok(vision.findAllByType("option").some((option) => option.children.join("") === "Vision Carrier · Vision Plus"));
  assert.ok(medical.findAllByType("option").some((option) => option.children.join("") === "Medical Carrier · Medical PPO"));
  act(() => vision.props.onChange({ target: { value: "Coverage/vision-1" } }));
  act(() => medical.props.onChange({ target: { value: "Coverage/medical-1" } }));
  await clickSave(renderer);
  assert.deepEqual(savedVision, { reference: "Coverage/vision-1", display: "Vision Carrier · Vision Plus" });
  assert.deepEqual(savedMedical, { reference: "Coverage/medical-1", display: "Medical Carrier · Medical PPO" });
  renderer.unmount();
});

test("Other reveals the insurance escape-hatch input", async () => {
  const renderer = await renderModal({
    initialDraft: draft({ patient: { reference: "Patient/patient-1", display: "Seed Patient" } }),
    loadPatientInsurance: async () => ({ coverages: [VISION], relatedPeople: [] }),
  });
  act(() => renderer.root.findByProps({ "aria-label": "Vision Insurance" }).props.onChange({ target: { value: "other" } }));
  const other = renderer.root.findByProps({ "aria-label": "Other Vision Insurance" });
  act(() => other.props.onChange({ target: { value: "Walk-in plan" } }));
  assert.equal(renderer.root.findByProps({ "aria-label": "Other Vision Insurance" }).props.value, "Walk-in plan");
  renderer.unmount();
});

test("an appointment without a patient keeps free-text insurance inputs", async () => {
  let loads = 0;
  const renderer = await renderModal({
    loadPatientInsurance: async () => { loads += 1; return { coverages: [], relatedPeople: [] }; },
  });
  assert.equal(renderer.root.findByProps({ "aria-label": "Vision Insurance" }).type, "input");
  assert.equal(renderer.root.findByProps({ "aria-label": "Medical Insurance" }).type, "input");
  assert.equal(loads, 0);
  renderer.unmount();
});

test("coverage fetch failure quietly degrades both insurance fields to free text", async () => {
  const renderer = await renderModal({
    initialDraft: draft({ patient: { reference: "Patient/patient-1", display: "Seed Patient" } }),
    loadPatientInsurance: async () => { throw new Error("offline"); },
  });
  assert.equal(renderer.root.findByProps({ "aria-label": "Vision Insurance" }).type, "input");
  assert.equal(renderer.root.findByProps({ "aria-label": "Medical Insurance" }).type, "input");
  assert.match(JSON.stringify(renderer.toJSON()), /Insurance plans could not be loaded; enter the display manually/);
  assert.equal(renderer.root.findAllByProps({ role: "alert" }).length, 0);
  renderer.unmount();
});

test("new appointment intake captures a free-text referrer against the selected provider", async () => {
  const events: string[] = [];
  const inbound: unknown[] = [];
  const renderer = await renderModal({
    initialDraft: draft({
      patient: { reference: "Patient/patient-1", display: "Seed Patient" },
    }),
    loadPatientInsurance: async () => ({ coverages: [], relatedPeople: [] }),
    correspondenceApi: {
      searchConsultants: async () => [],
      createInboundReferral: async (input) => {
        events.push("referral");
        inbound.push(input);
        return { resourceType: "ServiceRequest", status: "active", intent: "order", subject: { reference: "Patient/patient-1" } };
      },
    },
    onCreate: async () => {
      events.push("appointment");
    },
  });
  act(() => renderer.root.findByProps({ "aria-label": "Referred by" }).props.onChange({
    target: { value: "Dr. Outside" },
  }));
  act(() => renderer.root.findByProps({ "aria-label": "Reason for referral" }).props.onChange({
    target: { value: "Retinal concern" },
  }));
  await clickSave(renderer);

  assert.deepEqual(events, ["appointment", "referral"]);
  assert.deepEqual(inbound, [{
    patientId: "patient-1",
    referrerDisplay: "Dr. Outside",
    performerReference: "Practitioner/doctor-1",
    captureSource: "front-desk",
    reasonText: "Retinal concern",
  }]);
  renderer.unmount();
});

async function renderModal(overrides: Partial<React.ComponentProps<typeof AppointmentDetailsModal>> = {}) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AppointmentDetailsModal
        initialDraft={draft()}
        clinicMode="both"
        timezoneOffset="-05:00"
        resources={[RESOURCE]}
        visitTypes={[ROUTINE]}
        onClose={() => undefined}
        onCreate={async () => undefined}
        onUpdate={async () => undefined}
        onSetStatus={async () => undefined}
        {...overrides}
      />,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  return renderer;
}

async function clickSave(renderer: ReactTestRenderer) {
  const save = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save");
  assert.ok(save);
  await act(async () => {
    save.props.onClick();
    await Promise.resolve();
  });
}

function draft(overrides: Partial<AppointmentModalDraft> = {}): AppointmentModalDraft {
  return {
    nonPatient: false,
    description: "",
    visitTypeCode: "routine",
    resourceScheduleReferences: ["Schedule/schedule-1"],
    start: "2026-07-14T09:00:00-05:00",
    durationMinutes: 30,
    status: "scheduled",
    confirmation: "not-confirmed",
    visionCoverageReference: "",
    visionCoverageDisplay: "",
    medicalCoverageReference: "",
    medicalCoverageDisplay: "",
    notes: "",
    urgent: false,
    followUp: false,
    ...overrides,
  };
}

function visitType(code: string, name: string, durationMinutes: number): HealthcareService {
  return { ...buildVisitType({ code, name, durationMinutes, discipline: "eyecare" }), id: code };
}

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    resourceType: "Appointment",
    id: "appointment-1",
    status: "booked",
    start: "2026-07-14T09:00:00-05:00",
    end: "2026-07-14T09:30:00-05:00",
    participant: [
      { actor: { reference: "Patient/patient-1", display: "Patient, Test" } },
      { actor: { reference: "Practitioner/doctor-1", display: "Dr One" } },
    ],
    ...overrides,
  };
}

function renderGridBlock(comment?: string): string {
  const nextAppointment = appointment({ ...(comment === undefined ? {} : { comment }) });
  return renderToStaticMarkup(
    <ResourceDayColumn
      resource={RESOURCE}
      config={DEFAULT_SCHEDULING_PRACTICE_CONFIG}
      date="2026-07-14"
      rows={[{ startMinutes: 540 }]}
      axisStartMinutes={540}
      axisEndMinutes={570}
      slotMinutes={30}
      appointments={[{
        appointment: nextAppointment,
        geometry: { columnIndex: 0, rowStart: 0, rowSpan: 1 },
        content: buildAppointmentBlockContent(nextAppointment, []),
      }]}
      columnKey="day-or-week"
      rowHeight={46}
      onAppointmentClick={() => undefined}
      onBlockedRegionClick={() => undefined}
      onCellClick={() => undefined}
    />,
  );
}

function coverage(id: string, kind: "vision" | "medical", carrier: string, plan: string): Coverage {
  return {
    resourceType: "Coverage",
    id,
    status: "active",
    type: { coding: [{ code: kind }], text: kind },
    beneficiary: { reference: "Patient/patient-1" },
    payor: [{ reference: `Organization/${id}`, display: carrier }],
    class: [{ type: { coding: [{ code: "plan" }], text: "plan" }, value: plan, name: plan }],
  };
}

const VISION = coverage("vision-1", "vision", "Vision Carrier", "Vision Plus");
const MEDICAL = coverage("medical-1", "medical", "Medical Carrier", "Medical PPO");

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

function schedulingResource(
  id: string,
  reference: string,
  display: string,
  discipline: "eyecare" | "aesthetics",
): Schedule {
  return {
    resourceType: "Schedule",
    id,
    active: true,
    actor: [{ reference, display }],
    serviceCategory: [{ coding: [{ system: ODOS_DISCIPLINE_SYSTEM, code: discipline }] }],
  };
}

function renderedColumnRefs(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => typeof node.props["data-scheduler-resource-column"] === "string")
    .map((node) => node.props["data-scheduler-resource-column"] as string);
}

function timeAxisRows(renderer: ReactTestRenderer): Array<{ startMinutes: number; label: string }> {
  return renderer.root.findAllByType(SchedulerTimeGutter)[0]?.props.rows ?? [];
}

function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const match = renderer.root.findAllByType("button").find((candidate) => candidate.children.join("") === label);
  assert.ok(match, `${label} button exists`);
  return match;
}

function testInstanceText(node: ReactTestInstance): string {
  return node.children
    .map((child) => typeof child === "string" ? child : testInstanceText(child))
    .join(" ");
}
