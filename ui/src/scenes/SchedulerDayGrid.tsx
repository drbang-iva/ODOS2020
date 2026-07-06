import type { Appointment, HealthcareService, Schedule } from "@medplum/fhirtypes";
import clsx from "clsx";
import { useEffect, useMemo, useState } from "react";
import {
  CLINIC_MODES,
  SCHEDULER_PALETTE,
  appointmentGeometry,
  availabilityShadingForColumn,
  blocksForScheduleWithIndex,
  buildAppointmentBlockContent,
  buildTimeAxis,
  isoFromDateAndMinutes,
  minutesFromIsoDateTime,
  resourceActorReference,
  resourceDisplay,
  scheduleReference,
  visibleAppointmentsForMode,
  visibleSchedulingResourcesForOffice,
  visibleSchedulingVisitTypes,
  visitTypeCode,
  visitTypeDisplayColor,
  visitTypeDurationMinutes,
  weeklyHoursForSchedule,
  type AppointmentBlockContent,
  type AppointmentGeometry,
  type ClinicMode,
  type SchedulingOpening,
} from "../lib/scheduling";
import { todayYmd, useSchedulingStore } from "../lib/scheduling-store";
import {
  confirmDoubleBookAndRetry,
  defaultAppointmentModalDraft,
  type AppointmentModalDraft,
} from "../lib/scheduler-appointment-ui";
import { AppointmentDetailsModal } from "./scheduler/AppointmentDetailsModal";
import { FindOpenPanel } from "./scheduler/FindOpenPanel";
import { PatientQuickCard } from "./scheduler/PatientQuickCard";
import { SchedulingSettingsModal } from "./scheduler/SchedulingSettingsModal";

const ROW_HEIGHT = 46;
const GUTTER_WIDTH = 76;
const DATE_DISPLAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

interface PositionedAppointment {
  appointment: Appointment;
  geometry: AppointmentGeometry;
  content: AppointmentBlockContent;
}

export function SchedulerDayGrid() {
  const clinicMode = useSchedulingStore((state) => state.clinicMode);
  const date = useSchedulingStore((state) => state.date);
  const slotMinutes = useSchedulingStore((state) => state.slotMinutes);
  const resources = useSchedulingStore((state) => state.resources);
  const visitTypes = useSchedulingStore((state) => state.visitTypes);
  const appointments = useSchedulingStore((state) => state.appointments);
  const config = useSchedulingStore((state) => state.config);
  const officeId = useSchedulingStore((state) => state.officeId);
  const loading = useSchedulingStore((state) => state.loading);
  const error = useSchedulingStore((state) => state.error);
  const configError = useSchedulingStore((state) => state.configError);
  const setClinicMode = useSchedulingStore((state) => state.setClinicMode);
  const setOfficeId = useSchedulingStore((state) => state.setOfficeId);
  const clearConfigError = useSchedulingStore((state) => state.clearConfigError);
  const shiftDate = useSchedulingStore((state) => state.shiftDate);
  const today = useSchedulingStore((state) => state.today);
  const loadDay = useSchedulingStore((state) => state.loadDay);
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
    void loadDay();
  }, [date, loadDay]);

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

  const visibleResources = useMemo(
    () => visibleSchedulingResourcesForOffice(resources, clinicMode, config, officeId),
    [resources, clinicMode, config, officeId],
  );
  const visibleVisitTypes = useMemo(
    () => visibleSchedulingVisitTypes(visitTypes, clinicMode),
    [visitTypes, clinicMode],
  );
  const visibleAppointments = useMemo(
    () => visibleAppointmentsForMode(appointments, clinicMode),
    [appointments, clinicMode],
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
    () => buildTimeAxis({ date, resources: visibleResources, config, slotMinutes }),
    [date, visibleResources, config, slotMinutes],
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
  const bodyHeight = Math.max(timeAxis.rows.length * ROW_HEIGHT, ROW_HEIGHT);

  function openNewAppointment(resource: Schedule, startMinutes: number, status: "scheduled" | "walk-in" = "scheduled") {
    setDetails({
      draft: defaultAppointmentModalDraft({
        date,
        startMinutes,
        timezoneOffset: config.timezoneOffset,
        resources: visibleResources,
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

  function handleAppointmentClick(appointment: Appointment, sourceResourceActor?: string) {
    setQuickCardSelection({ appointment, sourceResourceActor });
    if (!quickCardPinned) {
      setDetails(null);
    }
  }

  function handleWalkIn() {
    const resource = visibleResources[0];
    if (!resource) {
      return;
    }
    openNewAppointment(resource, timeAxis.rows[0]?.startMinutes ?? 9 * 60, "walk-in");
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
    const resource = visibleResources.find((candidate) => scheduleReference(candidate) === opening.scheduleReference);
    const visitType = visitTypes.find((candidate) => visitTypeCode(candidate) === selectedVisitTypeCode);
    if (!resource) {
      return;
    }
    const draft = defaultAppointmentModalDraft({
      date: opening.start.slice(0, 10),
      startMinutes: minutesFromIsoDateTime(opening.start, config.timezoneOffset),
      timezoneOffset: config.timezoneOffset,
      resources: visibleResources,
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
        onNextDay={() => shiftDate(1)}
        onPreviousDay={() => shiftDate(-1)}
        onOfficeChange={setOfficeId}
        onSettings={() => openSettings()}
        onToday={today}
        onWalkIn={handleWalkIn}
        officeId={officeId}
        offices={config.offices}
        moveActive={Boolean(moveSource)}
        moveEnabled={Boolean(quickCardAppointment)}
      />
      {findOpenVisible && (
        <FindOpenPanel
          clinicMode={clinicMode}
          defaultDate={todayYmd(new Date(), config.timezoneOffset)}
          resources={visibleResources}
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
                <EmptyGridState loading={loading} />
              ) : (
                <div className="grid" style={{ gridTemplateColumns, minHeight: bodyHeight }}>
                  <TimeGutter rows={timeAxis.rows} />
                  {visibleResources.map((resource, columnIndex) => (
                    <ResourceColumn
                      key={resource.id ?? resource.actor?.[0]?.reference}
                      resource={resource}
                      columnIndex={columnIndex}
                      date={date}
                      rows={timeAxis.rows}
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
      <PatientQuickCard
        appointment={quickCardAppointment}
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
          resources={visibleResources}
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

function SchedulerToolbar({
  clinicMode,
  date,
  legendOpen,
  officeId,
  offices,
  onClinicModeChange,
  onFindOpen,
  onLegendToggle,
  onMove,
  onNextDay,
  onOfficeChange,
  onPreviousDay,
  onSettings,
  onToday,
  onWalkIn,
  moveActive,
  moveEnabled,
}: {
  clinicMode: ClinicMode;
  date: string;
  legendOpen: boolean;
  officeId: string | "all";
  offices: Array<{ id: string; name: string }>;
  onClinicModeChange: (mode: ClinicMode) => void;
  onFindOpen: () => void;
  onLegendToggle: () => void;
  onMove: () => void;
  onNextDay: () => void;
  onOfficeChange: (officeId: string | "all") => void;
  onPreviousDay: () => void;
  onSettings: () => void;
  onToday: () => void;
  onWalkIn: () => void;
  moveActive: boolean;
  moveEnabled: boolean;
}) {
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-black/35 px-4 py-3">
      <button className="scheduler-button" type="button" onClick={onToday}>
        Today
      </button>
      <button className="scheduler-icon-button" type="button" aria-label="Previous day" onClick={onPreviousDay}>
        &lt;
      </button>
      <button className="scheduler-icon-button" type="button" aria-label="Next day" onClick={onNextDay}>
        &gt;
      </button>
      <div className="min-w-[210px] px-2 text-sm font-semibold text-white">
        {formatDateDisplay(date)}
      </div>
      <div className="flex rounded border border-white/15 bg-black/30 p-0.5">
        <button className="scheduler-segment-active" type="button">
          Day
        </button>
        <button className="scheduler-segment" type="button" disabled>
          Week
        </button>
        <button className="scheduler-segment" type="button" disabled>
          Month
        </button>
      </div>
      <button className="scheduler-button" type="button" onClick={onWalkIn}>
        Walk-In
      </button>
      <button className="scheduler-button" type="button" onClick={onFindOpen}>
        Find Open
      </button>
      <button className="scheduler-button" type="button" onClick={onSettings}>
        Settings
      </button>
      <button
        className={clsx("scheduler-button", moveActive && "border-amber-300/50 bg-amber-500/15")}
        type="button"
        disabled={!moveEnabled}
        onClick={onMove}
      >
        {moveActive ? "Moving" : "Move"}
      </button>
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
    <div className="border-r border-white/10 bg-black/30 px-3 py-2">
      <div className="truncate text-sm font-semibold text-white">{resourceDisplay(resource)}</div>
      <div className="truncate text-xs text-white/45">{resource.actor?.[0]?.reference ?? "No actor"}</div>
    </div>
  );
}

function EmptyGridState({ loading }: { loading: boolean }) {
  return (
    <div className="grid min-h-[420px] place-items-center border-t border-white/10 bg-black/25">
      <div className="text-sm text-white/50">
        {loading ? "Loading scheduler day..." : "No scheduler resources found for this clinic mode."}
      </div>
    </div>
  );
}

function TimeGutter({ rows }: { rows: Array<{ startMinutes: number; label: string }> }) {
  return (
    <div className="border-r border-white/10 bg-black/35">
      {rows.map((row) => (
        <div
          key={row.startMinutes}
          className="border-b border-white/10 px-2 pt-1 text-right text-[11px] text-white/50"
          style={{ height: ROW_HEIGHT }}
        >
          {row.startMinutes % 60 === 0 ? row.label : ""}
        </div>
      ))}
    </div>
  );
}

function ResourceColumn({
  resource,
  columnIndex,
  date,
  rows,
  axisStartMinutes,
  axisEndMinutes,
  slotMinutes,
  appointments,
  onAppointmentClick,
  onBlockedRegionClick,
  onCellClick,
}: {
  resource: Schedule;
  columnIndex: number;
  date: string;
  rows: Array<{ startMinutes: number }>;
  axisStartMinutes: number;
  axisEndMinutes: number;
  slotMinutes: number;
  appointments: PositionedAppointment[];
  onAppointmentClick: (appointment: Appointment, sourceResourceActor?: string) => void;
  onBlockedRegionClick: (blockIndex: number | undefined) => void;
  onCellClick: (resource: Schedule, startMinutes: number) => void;
}) {
  const config = useSchedulingStore((state) => state.config);
  const indexedBlocks = blocksForScheduleWithIndex(config, resource);
  const regions = availabilityShadingForColumn({
    date,
    axisStartMinutes,
    axisEndMinutes,
    slotMinutes,
    weeklyHours: weeklyHoursForSchedule(config, resource),
    blocks: indexedBlocks.map((entry) => entry.block),
    blockIndexes: indexedBlocks.map((entry) => entry.blockIndex),
  });

  return (
    <div className="relative border-r border-white/10" style={{ minHeight: rows.length * ROW_HEIGHT }}>
      {regions
        .filter((region) => region.kind !== "blocked")
        .map((region) => (
          <div
            key={`${columnIndex}-${region.kind}-${region.startMinutes}`}
            className={clsx(
              "absolute inset-x-0",
              region.kind === "in-hours" ? "bg-white/[0.075]" : "bg-white/[0.025]",
            )}
            style={{
              top: region.rowStart * ROW_HEIGHT,
              height: region.rowSpan * ROW_HEIGHT,
            }}
          />
        ))}
      {rows.map((row) => (
        <div
          key={row.startMinutes}
          className="relative border-b border-white/10"
          style={{ height: ROW_HEIGHT }}
          onClick={() => onCellClick(resource, row.startMinutes)}
        />
      ))}
      {regions
        .filter((region) => region.kind === "blocked")
        .map((region) => {
          const editable = region.blockedKind === "custom" && region.blockIndex !== undefined;
          return (
            <button
              key={`${columnIndex}-blocked-${region.startMinutes}-${region.endMinutes}`}
              className={clsx(
                "absolute inset-x-1 z-10 overflow-hidden border border-white/10 bg-zinc-500/45 px-2 py-1 text-left text-[11px] font-semibold text-white/80",
                editable && "hover:bg-zinc-400/55",
              )}
              type="button"
              disabled={!editable}
              style={{
                top: region.rowStart * ROW_HEIGHT + 2,
                height: Math.max(region.rowSpan * ROW_HEIGHT - 4, 24),
              }}
              onClick={(event) => {
                event.stopPropagation();
                if (editable) {
                  onBlockedRegionClick(region.blockIndex);
                }
              }}
            >
              <div className="truncate">{region.description ?? region.blockedKindDisplay ?? "Blocked"}</div>
            </button>
          );
        })}
      {appointments.map((block) => (
        <AppointmentBlock
          key={`${block.geometry.columnIndex}-${block.appointment.id ?? `${block.geometry.rowStart}-${block.content.patientDisplay}`}`}
          block={block}
          resource={resource}
          onClick={onAppointmentClick}
        />
      ))}
    </div>
  );
}

function AppointmentBlock({
  block,
  resource,
  onClick,
}: {
  block: PositionedAppointment;
  resource: Schedule;
  onClick: (appointment: Appointment, sourceResourceActor?: string) => void;
}) {
  const { geometry, content, appointment } = block;
  const color = content.color;
  const textColor = contrastTextColor(color);
  return (
    <button
      type="button"
      className="absolute inset-x-1 z-20 overflow-hidden rounded-sm border px-2 py-1 text-left shadow-lg"
      style={{
        top: geometry.rowStart * ROW_HEIGHT + 3,
        height: Math.max(geometry.rowSpan * ROW_HEIGHT - 6, 30),
        background: `linear-gradient(135deg, ${color}, ${color}cc)`,
        borderColor: `${color}ee`,
        color: textColor,
      }}
      onClick={(event) => {
        event.stopPropagation();
        onClick(appointment, resourceActorReference(resource));
      }}
    >
      <div className="truncate text-[13px] font-bold leading-tight">{content.patientDisplay}</div>
      <div className="truncate text-[11px] font-semibold leading-tight opacity-90">{content.visitTypeDisplay}</div>
      <div className="truncate text-[10px] leading-tight opacity-85">
        {content.statusDisplay} · {content.confirmationDisplay}
      </div>
      <div className="truncate text-[10px] leading-tight opacity-80">{content.insuranceLine}</div>
      {content.badges.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {content.badges.map((badge) => (
            <span
              key={badge.code}
              className="rounded-sm bg-black/25 px-1 py-0.5 text-[9px] font-bold uppercase"
            >
              {badge.display}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

function currentAppointment(appointment: Appointment | null, appointments: Appointment[]): Appointment | null {
  if (!appointment?.id) {
    return appointment;
  }
  return appointments.find((candidate) => candidate.id === appointment.id) ?? appointment;
}

function formatDateDisplay(date: string): string {
  return DATE_DISPLAY_FORMAT.format(new Date(`${date}T12:00:00Z`));
}

function contrastTextColor(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) {
    return "#ffffff";
  }
  const value = match[1];
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? "#08080f" : "#ffffff";
}
