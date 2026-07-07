import type { Appointment, HealthcareService, Schedule } from "@medplum/fhirtypes";
import clsx from "clsx";
import { useMemo } from "react";
import {
  appointmentGeometry,
  availabilityShadingForColumn,
  blocksForScheduleWithIndex,
  buildAppointmentBlockContent,
  buildTimeAxisForDates,
  resourceActorReference,
  resourceDisplay,
  scheduleReference,
  visibleAppointmentsForMode,
  weeklyHoursForSchedule,
  type AppointmentBlockContent,
  type AppointmentGeometry,
  type ClinicMode,
  type SchedulingPracticeConfig,
} from "../../lib/scheduling";
import { weekDays } from "../../lib/scheduling-calendar";

const ROW_HEIGHT = 46;
const GUTTER_WIDTH = 76;
const DAY_HEADER_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

interface PositionedAppointment {
  appointment: Appointment;
  geometry: AppointmentGeometry;
  content: AppointmentBlockContent;
}

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
  selectedScheduleReference?: string;
  slotMinutes: number;
  visitTypes: HealthcareService[];
}) {
  const days = useMemo(() => weekDays(date), [date]);
  const selectedResource =
    resources.find((resource) => scheduleReference(resource) === selectedScheduleReference) ?? resources[0];
  const timeAxis = useMemo(
    () =>
      selectedResource
        ? buildTimeAxisForDates({
            dates: days,
            resources: [selectedResource],
            config,
            slotMinutes,
          })
        : { startMinutes: 0, endMinutes: 0, rows: [] },
    [config, days, selectedResource, slotMinutes],
  );
  const gridTemplateColumns = `${GUTTER_WIDTH}px repeat(7, minmax(150px, 1fr))`;
  const bodyHeight = Math.max(timeAxis.rows.length * ROW_HEIGHT, ROW_HEIGHT);

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
              <EmptyWeekState loading={loading} />
            ) : (
              <div className="grid" style={{ gridTemplateColumns, minHeight: bodyHeight }}>
                <TimeGutter rows={timeAxis.rows} />
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
            key={`${date}-${region.kind}-${region.startMinutes}`}
            className={clsx(
              "absolute inset-x-0",
              region.kind === "in-hours" ? "bg-white/[0.075]" : "bg-white/[0.025]",
            )}
            style={{ top: region.rowStart * ROW_HEIGHT, height: region.rowSpan * ROW_HEIGHT }}
          />
        ))}
      {rows.map((row) => (
        <div
          key={row.startMinutes}
          className="relative border-b border-white/10"
          style={{ height: ROW_HEIGHT }}
          onClick={() => onCellClick(date, resource, row.startMinutes)}
        />
      ))}
      {regions
        .filter((region) => region.kind === "blocked")
        .map((region) => {
          const editable = region.blockedKind === "custom" && region.blockIndex !== undefined;
          return (
            <button
              key={`${date}-blocked-${region.startMinutes}-${region.endMinutes}`}
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
      {positioned.map((block) => (
        <AppointmentBlock
          key={`${date}-${block.appointment.id ?? `${block.geometry.rowStart}-${block.content.patientDisplay}`}`}
          block={block}
          resource={resource}
          onClick={onAppointmentClick}
        />
      ))}
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
  return (
    <button
      type="button"
      className="absolute inset-x-1 z-20 overflow-hidden rounded-sm border px-2 py-1 text-left shadow-lg"
      style={{
        top: geometry.rowStart * ROW_HEIGHT + 3,
        height: Math.max(geometry.rowSpan * ROW_HEIGHT - 6, 30),
        background: `linear-gradient(135deg, ${color}, ${color}cc)`,
        borderColor: `${color}ee`,
        color: contrastTextColor(color),
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
    </button>
  );
}

function EmptyWeekState({ loading }: { loading: boolean }) {
  return (
    <div className="grid min-h-[420px] place-items-center border-t border-white/10 bg-black/25">
      <div className="text-sm text-white/50">
        {loading ? "Loading scheduler week..." : "No scheduler resources found for this clinic mode."}
      </div>
    </div>
  );
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
