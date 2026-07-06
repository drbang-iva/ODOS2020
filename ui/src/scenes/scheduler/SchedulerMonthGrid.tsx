import type { Appointment, HealthcareService, Schedule } from "@medplum/fhirtypes";
import clsx from "clsx";
import { useMemo } from "react";
import {
  monthAppointmentSummaries,
  monthCalendarGrid,
  isDefaultClosedDay,
} from "../../lib/scheduling-calendar";
import type { ClinicMode, SchedulingPracticeConfig } from "../../lib/scheduling";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function SchedulerMonthGrid({
  appointments,
  clinicMode,
  config,
  date,
  loading,
  officeId,
  onDateSelect,
  resources,
  visitTypes,
}: {
  appointments: Appointment[];
  clinicMode: ClinicMode;
  config: SchedulingPracticeConfig;
  date: string;
  loading: boolean;
  officeId: string | "all";
  onDateSelect: (date: string) => void;
  resources: Schedule[];
  visitTypes: HealthcareService[];
}) {
  const grid = useMemo(() => monthCalendarGrid(date), [date]);
  const summaries = useMemo(
    () =>
      monthAppointmentSummaries({
        appointments,
        resources,
        visitTypes,
        config,
        clinicMode,
        officeId,
        timezoneOffset: config.timezoneOffset,
      }),
    [appointments, clinicMode, config, officeId, resources, visitTypes],
  );

  return (
    <section className="px-4 pb-5">
      <div className="overflow-hidden border border-white/10 bg-black/20">
        <div className="grid grid-cols-7 border-b border-white/10 bg-black/35">
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} className="border-r border-white/10 px-3 py-2 text-xs font-semibold uppercase text-white/50">
              {label}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {grid.cells.map((cell) => {
            const summary = summaries[cell.date];
            const closed = isDefaultClosedDay(cell.date, config);
            return (
              <button
                key={cell.date}
                type="button"
                className={clsx(
                  "min-h-32 border-r border-b border-white/10 p-2 text-left transition hover:bg-white/[0.08]",
                  cell.inCurrentMonth ? "bg-white/[0.035]" : "bg-black/25 text-white/45",
                  closed && "bg-white/[0.015]",
                )}
                onClick={() => onDateSelect(cell.date)}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span
                    className={clsx(
                      "text-sm font-semibold",
                      cell.inCurrentMonth ? "text-white" : "text-white/45",
                    )}
                  >
                    {Number(cell.date.slice(8, 10))}
                  </span>
                  {closed && <span className="text-[10px] uppercase text-white/35">Closed</span>}
                </div>
                <div className="space-y-1">
                  {(summary?.chips ?? []).map((chip) => (
                    <div
                      key={`${cell.date}-${chip.appointmentId ?? chip.time}-${chip.patientLastName}`}
                      className="flex min-w-0 items-center gap-1.5 rounded-sm border border-white/10 bg-black/30 px-1.5 py-1 text-[11px] text-white/85"
                    >
                      <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: chip.color }} />
                      <span className="shrink-0 font-semibold tabular-nums">{chip.time}</span>
                      <span className="min-w-0 truncate">{chip.patientLastName}</span>
                    </div>
                  ))}
                  {summary && summary.hiddenCount > 0 && (
                    <div className="px-1.5 text-[11px] font-semibold text-white/50">+{summary.hiddenCount} more</div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      {loading && <div className="mt-3 text-sm text-white/55">Loading scheduler month...</div>}
    </section>
  );
}
