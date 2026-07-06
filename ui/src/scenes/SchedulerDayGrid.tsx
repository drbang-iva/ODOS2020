import type { Appointment, HealthcareService, Schedule } from "@medplum/fhirtypes";
import clsx from "clsx";
import { useEffect, useMemo, useState } from "react";
import {
  CLINIC_MODES,
  SCHEDULER_PALETTE,
  appointmentGeometry,
  availabilityShadingForColumn,
  buildAppointmentBlockContent,
  buildTimeAxis,
  resourceDisplay,
  visibleAppointmentsForMode,
  visibleSchedulingResources,
  visibleSchedulingVisitTypes,
  visitTypeCode,
  visitTypeColor,
  weeklyHoursForSchedule,
  type AppointmentBlockContent,
  type AppointmentGeometry,
} from "../lib/scheduling";
import { useSchedulingStore } from "../lib/scheduling-store";

const ROW_HEIGHT = 46;
const GUTTER_WIDTH = 76;

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
  const loading = useSchedulingStore((state) => state.loading);
  const error = useSchedulingStore((state) => state.error);
  const setClinicMode = useSchedulingStore((state) => state.setClinicMode);
  const shiftDate = useSchedulingStore((state) => state.shiftDate);
  const today = useSchedulingStore((state) => state.today);
  const loadDay = useSchedulingStore((state) => state.loadDay);
  const [legendOpen, setLegendOpen] = useState(true);

  useEffect(() => {
    void loadDay();
  }, [date, loadDay]);

  const visibleResources = useMemo(
    () => visibleSchedulingResources(resources, clinicMode),
    [resources, clinicMode],
  );
  const visibleVisitTypes = useMemo(
    () => visibleSchedulingVisitTypes(visitTypes, clinicMode),
    [visitTypes, clinicMode],
  );
  const visibleAppointments = useMemo(
    () => visibleAppointmentsForMode(appointments, clinicMode),
    [appointments, clinicMode],
  );
  const timeAxis = useMemo(
    () => buildTimeAxis({ date, resources: visibleResources, config, slotMinutes }),
    [date, visibleResources, config, slotMinutes],
  );
  const positionedAppointments = useMemo(
    () =>
      visibleAppointments
        .map((appointment): PositionedAppointment | undefined => {
          const geometry = appointmentGeometry({
            appointment,
            resources: visibleResources,
            axisStartMinutes: timeAxis.startMinutes,
            slotMinutes,
          });
          if (!geometry || geometry.rowStart + geometry.rowSpan <= 0 || geometry.rowStart >= timeAxis.rows.length) {
            return undefined;
          }
          return {
            appointment,
            geometry,
            content: buildAppointmentBlockContent(appointment, visitTypes),
          };
        })
        .filter((block): block is PositionedAppointment => Boolean(block))
        .sort((a, b) => a.geometry.rowStart - b.geometry.rowStart),
    [visibleAppointments, visibleResources, timeAxis.startMinutes, timeAxis.rows.length, slotMinutes, visitTypes],
  );
  const gridTemplateColumns =
    visibleResources.length > 0
      ? `${GUTTER_WIDTH}px repeat(${visibleResources.length}, minmax(190px, 1fr))`
      : `${GUTTER_WIDTH}px`;
  const bodyHeight = Math.max(timeAxis.rows.length * ROW_HEIGHT, ROW_HEIGHT);

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
        onNextDay={() => shiftDate(1)}
        onPreviousDay={() => shiftDate(-1)}
        onToday={today}
      />
      {legendOpen && <SchedulerLegend visitTypes={visibleVisitTypes} />}
      {error && (
        <div className="border-y border-red-400/40 bg-red-950/50 px-4 py-2 text-sm text-red-100">
          {error}
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
    </main>
  );
}

function SchedulerToolbar({
  clinicMode,
  date,
  legendOpen,
  onClinicModeChange,
  onLegendToggle,
  onNextDay,
  onPreviousDay,
  onToday,
}: {
  clinicMode: string;
  date: string;
  legendOpen: boolean;
  onClinicModeChange: (mode: "eyecare" | "aesthetics" | "both") => void;
  onLegendToggle: () => void;
  onNextDay: () => void;
  onPreviousDay: () => void;
  onToday: () => void;
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
      <button className="scheduler-button" type="button" disabled>
        Find Open
      </button>
      <button className="scheduler-button" type="button" disabled>
        Move
      </button>
      <button className={clsx("scheduler-button", legendOpen && "border-white/35 bg-white/15")} type="button" onClick={onLegendToggle}>
        Legend
      </button>
      <select className="scheduler-select" disabled value="main-office" aria-label="Office selector">
        <option value="main-office">Main Office</option>
      </select>
      <select
        className="scheduler-select"
        value={clinicMode}
        aria-label="Clinic mode"
        onChange={(event) => onClinicModeChange(event.target.value as "eyecare" | "aesthetics" | "both")}
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
          const color = visitTypeColor(visitType) ?? SCHEDULER_PALETTE.newExamBlue;
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
}: {
  resource: Schedule;
  columnIndex: number;
  date: string;
  rows: Array<{ startMinutes: number }>;
  axisStartMinutes: number;
  axisEndMinutes: number;
  slotMinutes: number;
  appointments: PositionedAppointment[];
}) {
  const config = useSchedulingStore((state) => state.config);
  const regions = availabilityShadingForColumn({
    date,
    axisStartMinutes,
    axisEndMinutes,
    slotMinutes,
    weeklyHours: weeklyHoursForSchedule(config, resource),
    blocks: config.blocks,
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
        />
      ))}
      {regions
        .filter((region) => region.kind === "blocked")
        .map((region) => (
          <div
            key={`${columnIndex}-blocked-${region.startMinutes}-${region.endMinutes}`}
            className="absolute inset-x-1 z-10 overflow-hidden border border-white/10 bg-zinc-500/45 px-2 py-1 text-[11px] font-semibold text-white/80"
            style={{
              top: region.rowStart * ROW_HEIGHT + 2,
              height: Math.max(region.rowSpan * ROW_HEIGHT - 4, 24),
            }}
          >
            <div className="truncate">{region.description ?? region.blockedKindDisplay ?? "Blocked"}</div>
          </div>
        ))}
      {appointments.map((block) => (
        <AppointmentBlock key={block.appointment.id ?? `${block.geometry.rowStart}-${block.content.patientDisplay}`} block={block} />
      ))}
    </div>
  );
}

function AppointmentBlock({ block }: { block: PositionedAppointment }) {
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
      onClick={() => console.log("scheduler.appointment.selected", appointment.id ?? appointment.start)}
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

function formatDateDisplay(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
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
