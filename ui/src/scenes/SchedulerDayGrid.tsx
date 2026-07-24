import type { Appointment, HealthcareService, Schedule } from "@medplum/fhirtypes";
import clsx from "clsx";
import { useEffect, useMemo, useState } from "react";
import {
  CLINIC_MODES,
  RESOURCE_KINDS,
  SCHEDULER_PALETTE,
  appointmentGeometry,
  buildAppointmentBlockContent,
  buildTimeAxis,
  filterSchedulingResourcesByHiddenActorReferences,
  isoFromDateAndMinutes,
  minutesFromIsoDateTime,
  resourceActorReference,
  resourceDisplay,
  resourceKind,
  scheduleReference,
  visibleAppointmentsForMode,
  visibleSchedulingResourcesForOffice,
  visibleSchedulingVisitTypes,
  visitTypeCode,
  visitTypeDisplayColor,
  visitTypeDurationMinutes,
  type ClinicMode,
  type SchedulingOpening,
} from "../lib/scheduling";
import {
  appointmentDraftForSchedulerCell,
  formatSchedulerDateLabel,
  schedulerWindowForView,
  type SchedulerView,
} from "../lib/scheduling-calendar";
import {
  SCHEDULER_SLOT_MINUTES_VIEW_OPTIONS,
  todayYmd,
  useSchedulingStore,
} from "../lib/scheduling-store";
import {
  confirmDoubleBookAndRetry,
  type AppointmentModalDraft,
} from "../lib/scheduler-appointment-ui";
import { AppointmentDetailsModal } from "./scheduler/AppointmentDetailsModal";
import { FindOpenPanel } from "./scheduler/FindOpenPanel";
import { PatientQuickCard } from "./scheduler/PatientQuickCard";
import { SchedulerMonthGrid } from "./scheduler/SchedulerMonthGrid";
import { SchedulerWeekGrid } from "./scheduler/SchedulerWeekGrid";
import { SchedulingSettingsModal } from "./scheduler/SchedulingSettingsModal";
import {
  GUTTER_WIDTH,
  ROW_HEIGHT,
  ResourceDayColumn,
  SchedulerColumnsEmptyState,
  SchedulerTimeGutter,
  type PositionedAppointment,
} from "./scheduler/ResourceDayColumn";
import {
  canStartAppointmentChart,
  type PracticeRoleId,
} from "../lib/practice-roles";

export function SchedulerDayGrid({ roles = [] }: { roles?: readonly PracticeRoleId[] } = {}) {
  const clinicMode = useSchedulingStore((state) => state.clinicMode);
  const view = useSchedulingStore((state) => state.view);
  const date = useSchedulingStore((state) => state.date);
  const slotMinutes = useSchedulingStore((state) => state.slotMinutes);
  const slotMinutesOverride = useSchedulingStore((state) => state.slotMinutesOverride);
  const hiddenResourceRefs = useSchedulingStore((state) => state.hiddenResourceRefs);
  const resources = useSchedulingStore((state) => state.resources);
  const visitTypes = useSchedulingStore((state) => state.visitTypes);
  const appointments = useSchedulingStore((state) => state.appointments);
  const appointmentsByDay = useSchedulingStore((state) => state.appointmentsByDay);
  const config = useSchedulingStore((state) => state.config);
  const officeId = useSchedulingStore((state) => state.officeId);
  const weekResourceScheduleReference = useSchedulingStore((state) => state.weekResourceScheduleReference);
  const loading = useSchedulingStore((state) => state.loading);
  const error = useSchedulingStore((state) => state.error);
  const configError = useSchedulingStore((state) => state.configError);
  const setClinicMode = useSchedulingStore((state) => state.setClinicMode);
  const setView = useSchedulingStore((state) => state.setView);
  const setSlotMinutes = useSchedulingStore((state) => state.setSlotMinutes);
  const setResourceHidden = useSchedulingStore((state) => state.setResourceHidden);
  const clearHiddenResources = useSchedulingStore((state) => state.clearHiddenResources);
  const setOfficeId = useSchedulingStore((state) => state.setOfficeId);
  const openDay = useSchedulingStore((state) => state.openDay);
  const setWeekResourceScheduleReference = useSchedulingStore((state) => state.setWeekResourceScheduleReference);
  const clearConfigError = useSchedulingStore((state) => state.clearConfigError);
  const shiftDate = useSchedulingStore((state) => state.shiftDate);
  const today = useSchedulingStore((state) => state.today);
  const zoom = useSchedulingStore((state) => state.zoom);
  const zoomIn = useSchedulingStore((state) => state.zoomIn);
  const zoomOut = useSchedulingStore((state) => state.zoomOut);
  const loadDay = useSchedulingStore((state) => state.loadDay);
  const loadWindow = useSchedulingStore((state) => state.loadWindow);
  const saveConfig = useSchedulingStore((state) => state.saveConfig);
  const findOpenings = useSchedulingStore((state) => state.findOpenings);
  const createAppointment = useSchedulingStore((state) => state.createAppointment);
  const updateAppointment = useSchedulingStore((state) => state.updateAppointment);
  const setAppointmentStatus = useSchedulingStore((state) => state.setAppointmentStatus);
  const moveAppointment = useSchedulingStore((state) => state.moveAppointment);
  const [legendOpen, setLegendOpen] = useState(true);
  const [findOpenVisible, setFindOpenVisible] = useState(false);
  const [settingsBlockIndex, setSettingsBlockIndex] = useState<number | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickCardSelection, setQuickCardSelection] = useState<{
    appointment: Appointment;
    sourceResourceActor?: string;
  } | null>(null);
  const [quickCardPinned, setQuickCardPinned] = useState(false);
  const [details, setDetails] = useState<
    { appointment: Appointment; draft?: never } | { appointment?: never; draft: AppointmentModalDraft } | null
  >(null);
  const [moveSource, setMoveSource] = useState<{
    appointment: Appointment;
    sourceResourceActor?: string;
  } | null>(null);

  useEffect(() => {
    if (view === "day") {
      void loadDay();
      return;
    }
    const window = schedulerWindowForView(date, view);
    void loadWindow(window.fromYmd, window.toYmdExclusive);
  }, [date, loadDay, loadWindow, view]);

  useEffect(() => {
    if (view !== "day") {
      setMoveSource(null);
      setFindOpenVisible(false);
    }
  }, [view]);

  useEffect(() => {
    if (!moveSource) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMoveSource(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moveSource]);

  const baseVisibleResources = useMemo(
    () => visibleSchedulingResourcesForOffice(resources, clinicMode, config, officeId),
    [resources, clinicMode, config, officeId],
  );
  const visibleResources = useMemo(
    () => filterSchedulingResourcesByHiddenActorReferences(baseVisibleResources, hiddenResourceRefs),
    [baseVisibleResources, hiddenResourceRefs],
  );
  const visibleVisitTypes = useMemo(
    () => visibleSchedulingVisitTypes(visitTypes, clinicMode),
    [visitTypes, clinicMode],
  );
  // Source the day grid from the practice-day bucket, not the raw window-wide
  // appointments: appointmentGeometry positions purely by time-of-day, so on a
  // week/month -> day transition the previous window's appointments would paint
  // the single day column until loadDay() refetches. appointmentsByDay[date] is
  // day-scoped by construction, so only the selected day ever renders.
  const visibleAppointments = useMemo(
    () => visibleAppointmentsForMode(appointmentsByDay[date] ?? [], clinicMode),
    [appointmentsByDay, date, clinicMode],
  );
  const quickCardAppointment = useMemo(
    () => currentAppointment(quickCardSelection?.appointment ?? null, appointments),
    [appointments, quickCardSelection],
  );
  const detailsAppointment = useMemo(
    () => currentAppointment(details && "appointment" in details ? details.appointment ?? null : null, appointments),
    [appointments, details],
  );
  const moveSourceAppointment = useMemo(
    () => currentAppointment(moveSource?.appointment ?? null, appointments),
    [appointments, moveSource],
  );
  const timeAxis = useMemo(
    () => buildTimeAxis({ date, resources: baseVisibleResources, config, slotMinutes, appointments: visibleAppointments }),
    [date, baseVisibleResources, config, slotMinutes, visibleAppointments],
  );
  const positionedAppointments = useMemo(
    () =>
      visibleAppointments
        .flatMap((appointment): PositionedAppointment[] => {
          const geometries = appointmentGeometry({
            appointment,
            resources: visibleResources,
            axisStartMinutes: timeAxis.startMinutes,
            slotMinutes,
            timezoneOffset: config.timezoneOffset,
          });
          return geometries
            .filter(
              (geometry) =>
                geometry.rowStart + geometry.rowSpan > 0 && geometry.rowStart < timeAxis.rows.length,
            )
            .map((geometry) => ({
              appointment,
              geometry,
              content: buildAppointmentBlockContent(appointment, visitTypes),
            }));
        })
        .sort((a, b) => a.geometry.rowStart - b.geometry.rowStart),
    [
      visibleAppointments,
      visibleResources,
      timeAxis.startMinutes,
      timeAxis.rows.length,
      slotMinutes,
      config.timezoneOffset,
      visitTypes,
    ],
  );
  const gridTemplateColumns =
    visibleResources.length > 0
      ? `${GUTTER_WIDTH}px repeat(${visibleResources.length}, minmax(190px, 1fr))`
      : `${GUTTER_WIDTH}px`;
  const rowHeight = Math.round(ROW_HEIGHT * zoom);
  const bodyHeight = Math.max(timeAxis.rows.length * rowHeight, rowHeight);

  function openNewAppointment(
    resource: Schedule,
    startMinutes: number,
    appointmentDate = date,
    status: "scheduled" | "walk-in" = "scheduled",
  ) {
    setDetails({
      draft: appointmentDraftForSchedulerCell({
        date: appointmentDate,
        startMinutes,
        timezoneOffset: config.timezoneOffset,
        resources: baseVisibleResources,
        visitTypes,
        clinicMode,
        resource,
        status,
      }),
    });
  }

  async function moveToCell(
    source: { appointment: Appointment; sourceResourceActor?: string },
    resource: Schedule,
    startMinutes: number,
    allowDoubleBook = false,
  ) {
    const actor = resourceActorReference(resource);
    const appointment = currentAppointment(source.appointment, appointments);
    if (!actor || !appointment) {
      return;
    }
    try {
      await moveAppointment(
        appointment,
        {
          start: isoFromDateAndMinutes(date, startMinutes, config.timezoneOffset),
          resourceScheduleActor: actor,
          sourceResourceScheduleActor: source.sourceResourceActor,
          allowDoubleBook,
        },
      );
      setMoveSource(null);
    } catch (err) {
      if (!allowDoubleBook) {
        await confirmDoubleBookAndRetry(err, () => moveToCell(source, resource, startMinutes, true));
      }
    }
  }

  function handleCellClick(resource: Schedule, startMinutes: number) {
    if (moveSource) {
      void moveToCell(moveSource, resource, startMinutes);
      return;
    }
    openNewAppointment(resource, startMinutes);
  }

  function handleWeekCellClick(weekDate: string, resource: Schedule, startMinutes: number) {
    openNewAppointment(resource, startMinutes, weekDate);
  }

  function handleMonthDateSelect(monthDate: string) {
    openDay(monthDate);
  }

  function handleAppointmentClick(appointment: Appointment, sourceResourceActor?: string) {
    setQuickCardSelection({ appointment, sourceResourceActor });
    if (!quickCardPinned) {
      setDetails(null);
    }
  }

  function handleWalkIn() {
    const resource = baseVisibleResources[0];
    if (!resource) {
      return;
    }
    openNewAppointment(resource, timeAxis.rows[0]?.startMinutes ?? 9 * 60, date, "walk-in");
  }

  function openSettings(blockIndex?: number) {
    setSettingsBlockIndex(blockIndex);
    setSettingsOpen(true);
  }

  function handleBlockedRegionClick(blockIndex: number | undefined) {
    if (blockIndex !== undefined) {
      openSettings(blockIndex);
    }
  }

  function handleOpeningSelect(opening: SchedulingOpening, selectedVisitTypeCode: string) {
    const resource = baseVisibleResources.find((candidate) => scheduleReference(candidate) === opening.scheduleReference);
    const visitType = visitTypes.find((candidate) => visitTypeCode(candidate) === selectedVisitTypeCode);
    if (!resource) {
      return;
    }
    const draft = appointmentDraftForSchedulerCell({
      date: opening.start.slice(0, 10),
      startMinutes: minutesFromIsoDateTime(opening.start, config.timezoneOffset),
      timezoneOffset: config.timezoneOffset,
      resources: baseVisibleResources,
      visitTypes,
      clinicMode,
      resource,
    });
    setDetails({
      draft: {
        ...draft,
        visitTypeCode: selectedVisitTypeCode,
        durationMinutes: visitTypeDurationMinutes(visitType ?? ({} as HealthcareService)) ?? draft.durationMinutes,
      },
    });
    setFindOpenVisible(false);
  }

  return (
    <main
      className="min-h-screen text-white"
      style={{ backgroundColor: SCHEDULER_PALETTE.surfaceBase }}
    >
      <SchedulerToolbar
        clinicMode={clinicMode}
        date={date}
        dayActionsEnabled={view === "day"}
        legendOpen={legendOpen}
        onClinicModeChange={setClinicMode}
        onLegendToggle={() => setLegendOpen((open) => !open)}
        onFindOpen={() => setFindOpenVisible((open) => !open)}
        onMove={() =>
          setMoveSource((current) =>
            current
              ? null
              : quickCardAppointment
                ? { appointment: quickCardAppointment, sourceResourceActor: quickCardSelection?.sourceResourceActor }
                : null,
          )
        }
        onNext={() => shiftDate(1)}
        onPrevious={() => shiftDate(-1)}
        onOfficeChange={setOfficeId}
        onSettings={() => openSettings()}
        onSlotMinutesChange={setSlotMinutes}
        onResourceHiddenChange={setResourceHidden}
        onShowAllResources={clearHiddenResources}
        onToday={today}
        onViewChange={setView}
        onWalkIn={handleWalkIn}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        zoomEnabled={view !== "month"}
        officeId={officeId}
        offices={config.offices}
        resources={baseVisibleResources}
        hiddenResourceRefs={hiddenResourceRefs}
        slotMinutesOverride={slotMinutesOverride}
        moveActive={Boolean(moveSource)}
        moveEnabled={Boolean(quickCardAppointment)}
        view={view}
      />
      {findOpenVisible && (
        <FindOpenPanel
          clinicMode={clinicMode}
          defaultDate={todayYmd(new Date(), config.timezoneOffset)}
          resources={baseVisibleResources}
          timezoneOffset={config.timezoneOffset}
          visitTypes={visitTypes}
          onClose={() => setFindOpenVisible(false)}
          onFind={findOpenings}
          onSelect={handleOpeningSelect}
        />
      )}
      {moveSourceAppointment && (
        <div className="border-b border-amber-300/40 bg-amber-950/50 px-4 py-2 text-sm text-amber-100">
          Move mode: click a target cell for {moveSourceAppointment.description ?? moveSourceAppointment.id ?? "appointment"}.
          Press Escape to cancel.
        </div>
      )}
      {legendOpen && <SchedulerLegend visitTypes={visibleVisitTypes} />}
      {error && (
        <div className="border-y border-red-400/40 bg-red-950/50 px-4 py-2 text-sm text-red-100">
          {error}
        </div>
      )}
      {configError && (
        <div className="flex items-center justify-between gap-3 border-y border-amber-300/40 bg-amber-950/50 px-4 py-2 text-sm text-amber-100">
          <span>Scheduling settings warning: {configError}</span>
          <button className="scheduler-button" type="button" onClick={clearConfigError}>
            Dismiss
          </button>
        </div>
      )}
      {view === "day" ? (
        <section className="px-4 pb-5">
          <div className="overflow-hidden border border-white/10 bg-black/20">
            <div className="overflow-x-auto">
              <div className="min-w-[820px]">
                <div
                  className="grid border-b border-white/10"
                  style={{ gridTemplateColumns }}
                >
                  <div className="border-r border-white/10 bg-black/40 px-3 py-3 text-xs uppercase text-white/45">
                    Time
                  </div>
                  {visibleResources.map((resource) => (
                    <ResourceHeader key={resource.id ?? resource.actor?.[0]?.reference} resource={resource} />
                  ))}
                </div>
                {visibleResources.length === 0 || timeAxis.rows.length === 0 ? (
                  <SchedulerColumnsEmptyState loading={loading} viewNoun="day" />
                ) : (
                  <div className="grid" style={{ gridTemplateColumns, minHeight: bodyHeight }}>
                    <SchedulerTimeGutter rows={timeAxis.rows} rowHeight={rowHeight} />
                    {visibleResources.map((resource, columnIndex) => (
                      <ResourceDayColumn
                        key={resource.id ?? resource.actor?.[0]?.reference}
                        resource={resource}
                        config={config}
                        columnKey={String(columnIndex)}
                        date={date}
                        rows={timeAxis.rows}
                        rowHeight={rowHeight}
                        axisStartMinutes={timeAxis.startMinutes}
                        axisEndMinutes={timeAxis.endMinutes}
                        slotMinutes={slotMinutes}
                        appointments={positionedAppointments.filter(
                          (block) => block.geometry.columnIndex === columnIndex,
                        )}
                        onAppointmentClick={handleAppointmentClick}
                        onBlockedRegionClick={handleBlockedRegionClick}
                        onCellClick={handleCellClick}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          {loading && (
            <div className="mt-3 text-sm text-white/55">Loading scheduler day...</div>
          )}
        </section>
      ) : view === "week" ? (
        <SchedulerWeekGrid
          appointmentsByDay={appointmentsByDay}
          clinicMode={clinicMode}
          config={config}
          date={date}
          loading={loading}
          onAppointmentClick={handleAppointmentClick}
          onBlockedRegionClick={handleBlockedRegionClick}
          onCellClick={handleWeekCellClick}
          onSelectedResourceChange={setWeekResourceScheduleReference}
          resources={visibleResources}
          rowHeight={rowHeight}
          selectedScheduleReference={weekResourceScheduleReference}
          slotMinutes={slotMinutes}
          visitTypes={visitTypes}
        />
      ) : (
        <SchedulerMonthGrid
          appointments={appointments}
          clinicMode={clinicMode}
          config={config}
          date={date}
          loading={loading}
          officeId={officeId}
          onDateSelect={handleMonthDateSelect}
          resources={resources}
          visitTypes={visitTypes}
        />
      )}
      <PatientQuickCard
        appointment={quickCardAppointment}
        canStartChart={canStartAppointmentChart(roles)}
        pinned={quickCardPinned}
        onPinnedChange={setQuickCardPinned}
        onClose={() => {
          setQuickCardPinned(false);
          setQuickCardSelection(null);
        }}
        onDetails={(appointment) => setDetails({ appointment })}
        date={date}
      />
      {details && (
        <AppointmentDetailsModal
          appointment={"appointment" in details ? detailsAppointment ?? undefined : undefined}
          initialDraft={"draft" in details ? details.draft : undefined}
          clinicMode={clinicMode}
          timezoneOffset={config.timezoneOffset}
          resources={baseVisibleResources}
          visitTypes={visitTypes}
          onClose={() => setDetails(null)}
          onCreate={createAppointment}
          onUpdate={updateAppointment}
          onSetStatus={setAppointmentStatus}
        />
      )}
      {settingsOpen && (
        <SchedulingSettingsModal
          config={config}
          currentDate={date}
          initialBlockIndex={settingsBlockIndex}
          resources={resources}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsBlockIndex(undefined);
          }}
          onSave={saveConfig}
        />
      )}
    </main>
  );
}

export function SchedulerToolbar({
  clinicMode,
  date,
  dayActionsEnabled,
  legendOpen,
  officeId,
  offices,
  resources,
  hiddenResourceRefs,
  slotMinutesOverride,
  onClinicModeChange,
  onFindOpen,
  onLegendToggle,
  onMove,
  onNext,
  onOfficeChange,
  onPrevious,
  onSettings,
  onSlotMinutesChange,
  onResourceHiddenChange,
  onShowAllResources,
  onToday,
  onViewChange,
  onWalkIn,
  onZoomIn,
  onZoomOut,
  zoomEnabled,
  moveActive,
  moveEnabled,
  view,
}: {
  clinicMode: ClinicMode;
  date: string;
  dayActionsEnabled: boolean;
  legendOpen: boolean;
  officeId: string | "all";
  offices: Array<{ id: string; name: string }>;
  resources: Schedule[];
  hiddenResourceRefs: string[];
  slotMinutesOverride: 10 | 15 | 30 | null;
  onClinicModeChange: (mode: ClinicMode) => void;
  onFindOpen: () => void;
  onLegendToggle: () => void;
  onMove: () => void;
  onNext: () => void;
  onOfficeChange: (officeId: string | "all") => void;
  onPrevious: () => void;
  onSettings: () => void;
  onSlotMinutesChange: (minutes: 10 | 15 | 30 | null) => void;
  onResourceHiddenChange: (reference: string, hidden: boolean) => void;
  onShowAllResources: () => void;
  onToday: () => void;
  onViewChange: (view: SchedulerView) => void;
  onWalkIn: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  zoomEnabled: boolean;
  moveActive: boolean;
  moveEnabled: boolean;
  view: SchedulerView;
}) {
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-black/35 px-4 py-3">
      <button className="scheduler-button" type="button" onClick={onToday}>
        Today
      </button>
      <button className="scheduler-icon-button" type="button" aria-label={`Previous ${view}`} onClick={onPrevious}>
        &lt;
      </button>
      <button className="scheduler-icon-button" type="button" aria-label={`Next ${view}`} onClick={onNext}>
        &gt;
      </button>
      <div className="min-w-[210px] px-2 text-sm font-semibold text-white">
        {formatSchedulerDateLabel(date, view)}
      </div>
      <div className="flex rounded border border-white/15 bg-black/30 p-0.5">
        <button
          className={view === "day" ? "scheduler-segment-active" : "scheduler-segment"}
          type="button"
          onClick={() => onViewChange("day")}
        >
          Day
        </button>
        <button
          className={view === "week" ? "scheduler-segment-active" : "scheduler-segment"}
          type="button"
          onClick={() => onViewChange("week")}
        >
          Week
        </button>
        <button
          className={view === "month" ? "scheduler-segment-active" : "scheduler-segment"}
          type="button"
          onClick={() => onViewChange("month")}
        >
          Month
        </button>
      </div>
      {zoomEnabled && (
        <div className="flex items-center rounded border border-white/15 bg-black/30 p-0.5" role="group" aria-label="Zoom">
          <button className="scheduler-segment" type="button" aria-label="Zoom out" onClick={onZoomOut}>
            −
          </button>
          <button className="scheduler-segment" type="button" aria-label="Zoom in" onClick={onZoomIn}>
            +
          </button>
        </div>
      )}
      {zoomEnabled && (
        <select
          className="scheduler-select"
          aria-label="Grid interval"
          value={slotMinutesOverride ?? "auto"}
          onChange={(event) =>
            onSlotMinutesChange(
              event.target.value === "auto"
                ? null
                : Number(event.target.value) as 10 | 15 | 30,
            )
          }
        >
          <option value="auto">Auto (config)</option>
          {SCHEDULER_SLOT_MINUTES_VIEW_OPTIONS.map((minutes) => (
            <option key={minutes} value={minutes}>{minutes} min</option>
          ))}
        </select>
      )}
      {zoomEnabled && (
        <SchedulerColumnsControl
          resources={resources}
          hiddenResourceRefs={hiddenResourceRefs}
          onResourceHiddenChange={onResourceHiddenChange}
          onShowAll={onShowAllResources}
        />
      )}
      {dayActionsEnabled && (
        <button className="scheduler-button" type="button" onClick={onWalkIn}>
          Walk-In
        </button>
      )}
      {dayActionsEnabled && (
        <button className="scheduler-button" type="button" onClick={onFindOpen}>
          Find Open
        </button>
      )}
      <button className="scheduler-button" type="button" onClick={onSettings}>
        Settings
      </button>
      {dayActionsEnabled && (
        <button
          className={clsx("scheduler-button", moveActive && "border-amber-300/50 bg-amber-500/15")}
          type="button"
          disabled={!moveEnabled}
          onClick={onMove}
        >
          {moveActive ? "Moving" : "Move"}
        </button>
      )}
      <button className={clsx("scheduler-button", legendOpen && "border-white/35 bg-white/15")} type="button" onClick={onLegendToggle}>
        Legend
      </button>
      {offices.length > 1 && (
        <select
          className="scheduler-select"
          value={officeId}
          aria-label="Office selector"
          onChange={(event) => onOfficeChange(event.target.value as string | "all")}
        >
          <option value="all">All Offices</option>
          {offices.map((office) => (
            <option key={office.id} value={office.id}>
              {office.name}
            </option>
          ))}
        </select>
      )}
      <select
        className="scheduler-select"
        value={clinicMode}
        aria-label="Clinic mode"
        onChange={(event) => onClinicModeChange(event.target.value as ClinicMode)}
      >
        {CLINIC_MODES.map((mode) => (
          <option key={mode.code} value={mode.code}>
            {mode.display}
          </option>
        ))}
      </select>
    </header>
  );
}

export function SchedulerColumnsControl({
  resources,
  hiddenResourceRefs,
  onResourceHiddenChange,
  onShowAll,
}: {
  resources: Schedule[];
  hiddenResourceRefs: string[];
  onResourceHiddenChange: (reference: string, hidden: boolean) => void;
  onShowAll: () => void;
}) {
  const hidden = new Set(hiddenResourceRefs);
  const groupLabels = {
    provider: "Providers",
    room: "Rooms",
    equipment: "Equipment",
  } as const;

  return (
    <details className="relative">
      <summary className="scheduler-button cursor-pointer list-none">Columns</summary>
      <div className="absolute left-0 top-full z-40 mt-2 min-w-64 rounded border border-white/15 bg-[#10101c] p-3 shadow-2xl">
        <div className="mb-3 flex items-center justify-between gap-4">
          <span className="text-xs font-semibold uppercase tracking-wide text-white/55">Visible columns</span>
          <button
            className="text-xs font-semibold text-cyan-300 hover:text-cyan-200 disabled:text-white/30"
            type="button"
            disabled={hiddenResourceRefs.length === 0}
            onClick={onShowAll}
          >
            Show all
          </button>
        </div>
        <div className="space-y-3" aria-label="Scheduler columns">
          {RESOURCE_KINDS.map((kind) => {
            const group = resources.filter((resource) => resourceKind(resource) === kind.code);
            if (group.length === 0) {
              return null;
            }
            return (
              <div key={kind.code}>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">
                  {groupLabels[kind.code]}
                </div>
                <div className="space-y-1">
                  {group.map((resource) => {
                    const reference = resourceActorReference(resource);
                    if (!reference) {
                      return null;
                    }
                    const display = resourceDisplay(resource);
                    return (
                      <label key={reference} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm text-white/80 hover:bg-white/[0.06]">
                        <input
                          aria-label={`Show ${display} column`}
                          type="checkbox"
                          checked={!hidden.has(reference)}
                          onChange={(event) => onResourceHiddenChange(reference, !event.target.checked)}
                        />
                        <span>{display}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </details>
  );
}

function SchedulerLegend({ visitTypes }: { visitTypes: HealthcareService[] }) {
  return (
    <div className="flex flex-wrap gap-2 border-b border-white/10 bg-black/20 px-4 py-2">
      {visitTypes.length === 0 ? (
        <span className="text-sm text-white/45">No active visit types</span>
      ) : (
        visitTypes.map((visitType) => {
          const color = visitTypeDisplayColor(visitType);
          return (
            <div
              key={visitType.id ?? visitTypeCode(visitType) ?? visitType.name}
              className="flex items-center gap-2 rounded border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-white/75"
            >
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
              <span>{visitType.name ?? visitTypeCode(visitType) ?? "Visit type"}</span>
            </div>
          );
        })
      )}
    </div>
  );
}

function ResourceHeader({ resource }: { resource: Schedule }) {
  return (
    <div
      className="border-r border-white/10 bg-black/30 px-3 py-2"
      data-scheduler-resource-column={resourceActorReference(resource)}
    >
      <div className="truncate text-sm font-semibold text-white">{resourceDisplay(resource)}</div>
      <div className="truncate text-xs text-white/45">{resource.actor?.[0]?.reference ?? "No actor"}</div>
    </div>
  );
}

function currentAppointment(appointment: Appointment | null, appointments: Appointment[]): Appointment | null {
  if (!appointment?.id) {
    return appointment;
  }
  return appointments.find((candidate) => candidate.id === appointment.id) ?? appointment;
}
