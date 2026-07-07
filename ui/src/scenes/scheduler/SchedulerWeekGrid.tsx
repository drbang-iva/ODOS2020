import type { Appointment, HealthcareService, Schedule } from "@medplum/fhirtypes";
import { useMemo } from "react";
import {
  appointmentGeometry,
  buildAppointmentBlockContent,
  buildTimeAxisForDates,
  resourceActorReference,
  resourceDisplay,
  scheduleReference,
  visibleAppointmentsForMode,
  type ClinicMode,
  type SchedulingPracticeConfig,
} from "../../lib/scheduling";
import { weekDays } from "../../lib/scheduling-calendar";
import {
  GUTTER_WIDTH,
  ResourceDayColumn,
  SchedulerColumnsEmptyState,
  SchedulerTimeGutter,
  type PositionedAppointment,
} from "./ResourceDayColumn";

const DAY_HEADER_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function SchedulerWeekGrid({
  appointmentsByDay,
  clinicMode,
  config,
  date,
  loading,
  onAppointmentClick,
  onBlockedRegionClick,
  onCellClick,
  onSelectedResourceChange,
  resources,
  rowHeight,
  selectedScheduleReference,
  slotMinutes,
  visitTypes,
}: {
  appointmentsByDay: Record<string, Appointment[]>;
  clinicMode: ClinicMode;
  config: SchedulingPracticeConfig;
  date: string;
  loading: boolean;
  onAppointmentClick: (appointment: Appointment, sourceResourceActor?: string) => void;
  onBlockedRegionClick: (blockIndex: number | undefined) => void;
  onCellClick: (date: string, resource: Schedule, startMinutes: number) => void;
  onSelectedResourceChange: (reference: string | undefined) => void;
  resources: Schedule[];
  rowHeight: number;
  selectedScheduleReference?: string;
  slotMinutes: number;
  visitTypes: HealthcareService[];
}) {
  const days = useMemo(() => weekDays(date), [date]);
  const selectedResource =
    resources.find((resource) => scheduleReference(resource) === selectedScheduleReference) ?? resources[0];
  // The selected resource's bookings across the visible week — feeds the axis so
  // out-of-hours appointments expand it instead of being silently dropped.
  const selectedResourceAppointments = useMemo(() => {
    const actor = selectedResource ? resourceActorReference(selectedResource) : undefined;
    if (!actor) {
      return [];
    }
    return days.flatMap((day) =>
      visibleAppointmentsForMode(appointmentsByDay[day] ?? [], clinicMode).filter((appointment) =>
        appointment.participant.some((participant) => participant.actor?.reference === actor),
      ),
    );
  }, [appointmentsByDay, clinicMode, days, selectedResource]);
  const timeAxis = useMemo(
    () =>
      selectedResource
        ? buildTimeAxisForDates({
            dates: days,
            resources: [selectedResource],
            config,
            slotMinutes,
            appointments: selectedResourceAppointments,
          })
        : { startMinutes: 0, endMinutes: 0, rows: [] },
    [config, days, selectedResource, slotMinutes, selectedResourceAppointments],
  );
  const gridTemplateColumns = `${GUTTER_WIDTH}px repeat(7, minmax(150px, 1fr))`;
  const bodyHeight = Math.max(timeAxis.rows.length * rowHeight, rowHeight);

  return (
    <section className="px-4 pb-5">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="scheduler-field min-w-64">
          Resource
          <select
            className="scheduler-input"
            value={selectedResource ? scheduleReference(selectedResource) ?? "" : ""}
            onChange={(event) => onSelectedResourceChange(event.target.value || undefined)}
          >
            {resources.map((resource) => {
              const reference = scheduleReference(resource) ?? "";
              return (
                <option key={reference || resourceDisplay(resource)} value={reference}>
                  {resourceDisplay(resource)}
                </option>
              );
            })}
          </select>
        </label>
      </div>
      <div className="overflow-hidden border border-white/10 bg-black/20">
        <div className="overflow-x-auto">
          <div className="min-w-[1180px]">
            <div className="grid border-b border-white/10" style={{ gridTemplateColumns }}>
              <div className="border-r border-white/10 bg-black/40 px-3 py-3 text-xs uppercase text-white/45">
                Time
              </div>
              {days.map((day) => (
                <div key={day} className="border-r border-white/10 bg-black/30 px-3 py-2">
                  <div className="text-sm font-semibold text-white">{DAY_HEADER_FORMAT.format(new Date(`${day}T12:00:00Z`))}</div>
                  <div className="text-xs text-white/45">{day}</div>
                </div>
              ))}
            </div>
            {!selectedResource || timeAxis.rows.length === 0 ? (
              <SchedulerColumnsEmptyState loading={loading} viewNoun="week" />
            ) : (
              <div className="grid" style={{ gridTemplateColumns, minHeight: bodyHeight }}>
                <SchedulerTimeGutter rows={timeAxis.rows} rowHeight={rowHeight} />
                {days.map((day) => (
                  <WeekDayColumn
                    key={day}
                    appointments={appointmentsByDay[day] ?? []}
                    axisEndMinutes={timeAxis.endMinutes}
                    axisStartMinutes={timeAxis.startMinutes}
                    clinicMode={clinicMode}
                    config={config}
                    date={day}
                    onAppointmentClick={onAppointmentClick}
                    onBlockedRegionClick={onBlockedRegionClick}
                    onCellClick={onCellClick}
                    resource={selectedResource}
                    rows={timeAxis.rows}
                    rowHeight={rowHeight}
                    slotMinutes={slotMinutes}
                    visitTypes={visitTypes}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {loading && <div className="mt-3 text-sm text-white/55">Loading scheduler week...</div>}
    </section>
  );
}

function WeekDayColumn({
  appointments,
  axisEndMinutes,
  axisStartMinutes,
  clinicMode,
  config,
  date,
  onAppointmentClick,
  onBlockedRegionClick,
  onCellClick,
  resource,
  rows,
  rowHeight,
  slotMinutes,
  visitTypes,
}: {
  appointments: Appointment[];
  axisEndMinutes: number;
  axisStartMinutes: number;
  clinicMode: ClinicMode;
  config: SchedulingPracticeConfig;
  date: string;
  onAppointmentClick: (appointment: Appointment, sourceResourceActor?: string) => void;
  onBlockedRegionClick: (blockIndex: number | undefined) => void;
  onCellClick: (date: string, resource: Schedule, startMinutes: number) => void;
  resource: Schedule;
  rows: Array<{ startMinutes: number }>;
  rowHeight: number;
  slotMinutes: number;
  visitTypes: HealthcareService[];
}) {
  const actorReference = resourceActorReference(resource);
  const visibleAppointments = visibleAppointmentsForMode(appointments, clinicMode).filter((appointment) =>
    actorReference
      ? appointment.participant.some((participant) => participant.actor?.reference === actorReference)
      : false,
  );
  const positioned = visibleAppointments
    .flatMap((appointment): PositionedAppointment[] => {
      const geometries = appointmentGeometry({
        appointment,
        resources: [resource],
        axisStartMinutes,
        slotMinutes,
        timezoneOffset: config.timezoneOffset,
      });
      return geometries
        .filter((geometry) => geometry.rowStart + geometry.rowSpan > 0 && geometry.rowStart < rows.length)
        .map((geometry) => ({
          appointment,
          geometry,
          content: buildAppointmentBlockContent(appointment, visitTypes),
        }));
    })
    .sort((a, b) => a.geometry.rowStart - b.geometry.rowStart);
  return (
    <ResourceDayColumn
      resource={resource}
      config={config}
      columnKey={date}
      date={date}
      rows={rows}
      rowHeight={rowHeight}
      axisStartMinutes={axisStartMinutes}
      axisEndMinutes={axisEndMinutes}
      slotMinutes={slotMinutes}
      appointments={positioned}
      onAppointmentClick={onAppointmentClick}
      onBlockedRegionClick={onBlockedRegionClick}
      onCellClick={(columnResource, startMinutes) => onCellClick(date, columnResource, startMinutes)}
    />
  );
}
