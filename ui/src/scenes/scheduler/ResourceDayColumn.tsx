import type { Appointment, Schedule } from "@medplum/fhirtypes";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import {
  availabilityShadingForColumn,
  blocksForScheduleWithIndex,
  resourceActorReference,
  weeklyHoursForSchedule,
  type AppointmentBlockContent,
  type AppointmentGeometry,
  type SchedulingPracticeConfig,
} from "../../lib/scheduling";
import { buildCompactCues, isCompactBlock } from "../../lib/scheduler-block-density";
import { AppointmentHoverCard } from "./AppointmentHoverCard";
import { watcherMoney, type WatcherAlert } from "../../lib/watchers";

// Shared geometry for the day and week resource grids. Both render "one resource,
// one day, a column of time-positioned blocks"; keeping a single renderer here is
// what keeps the block content (insurance line + badges) from drifting between the
// two views, and gives the Pass-2 exploded view a third consumer of the same unit.
export const ROW_HEIGHT = 46;
export const GUTTER_WIDTH = 76;

export interface PositionedAppointment {
  appointment: Appointment;
  geometry: AppointmentGeometry;
  content: AppointmentBlockContent;
}

export function SchedulerTimeGutter({
  rows,
  rowHeight = ROW_HEIGHT,
}: {
  rows: Array<{ startMinutes: number; label: string }>;
  rowHeight?: number;
}) {
  return (
    <div className="border-r border-white/10 bg-black/35">
      {rows.map((row) => (
        <div
          key={row.startMinutes}
          className="border-b border-white/10 px-2 pt-1 text-right text-[11px] text-white/50"
          style={{ height: rowHeight }}
        >
          {row.startMinutes % 60 === 0 ? row.label : ""}
        </div>
      ))}
    </div>
  );
}

export function SchedulerColumnsEmptyState({ loading, viewNoun }: { loading: boolean; viewNoun: string }) {
  return (
    <div className="grid min-h-[420px] place-items-center border-t border-white/10 bg-black/25">
      <div className="text-sm text-white/50">
        {loading
          ? `Loading scheduler ${viewNoun}...`
          : "No scheduler resources found for this clinic mode."}
      </div>
    </div>
  );
}

const HOVER_OPEN_DELAY_MS = 150;

function AppointmentBlock({
  block,
  resource,
  rowHeight,
  onClick,
  watcherAlert,
}: {
  block: PositionedAppointment;
  resource: Schedule;
  rowHeight: number;
  onClick: (appointment: Appointment, sourceResourceActor?: string) => void;
  watcherAlert?: WatcherAlert;
}) {
  const { geometry, content, appointment } = block;
  const color = content.color;
  const height = Math.max(geometry.rowSpan * rowHeight - 6, 30);
  const compact = isCompactBlock(height);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const [hoverAnchor, setHoverAnchor] = useState<{ top: number; left: number; right: number } | null>(null);

  useEffect(() => () => window.clearTimeout(openTimer.current), []);

  function openHoverCard() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      setHoverAnchor({ top: rect.top, left: rect.left, right: rect.right });
    }
  }

  function scheduleHoverCard() {
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(openHoverCard, HOVER_OPEN_DELAY_MS);
  }

  function closeHoverCard() {
    window.clearTimeout(openTimer.current);
    setHoverAnchor(null);
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="absolute inset-x-1 z-20 overflow-hidden rounded-sm border px-2 py-1 text-left shadow-lg"
        style={{
          top: geometry.rowStart * rowHeight + 3,
          height,
          background: `linear-gradient(135deg, ${color}, ${color}cc)`,
          borderColor: `${color}ee`,
          color: contrastTextColor(color),
        }}
        onClick={(event) => {
          event.stopPropagation();
          closeHoverCard();
          onClick(appointment, resourceActorReference(resource));
        }}
        onMouseEnter={scheduleHoverCard}
        onMouseLeave={closeHoverCard}
        onFocus={openHoverCard}
        onBlur={closeHoverCard}
      >
        <div className="truncate text-[13px] font-bold leading-tight">{content.patientDisplay}</div>
        <div className="truncate text-[11px] font-semibold leading-tight opacity-90">{content.visitTypeDisplay}</div>
        {watcherAlert && (
          <div className="mt-0.5 truncate text-[10px] font-extrabold leading-tight" aria-label="Balance alert">
            {watcherMoney(watcherAlert.balanceCents)} balance
          </div>
        )}
        {compact ? (
          <div className="mt-0.5 flex items-center gap-1.5">
            {buildCompactCues(content).map((cue) => (
              <span
                key={cue.key}
                title={cue.label}
                className="text-[10px] font-bold leading-none"
                style={{ color: cue.color, textShadow: "0 0 2px rgba(0,0,0,0.8)" }}
              >
                {cue.glyph}
              </span>
            ))}
            {content.note && <AppointmentNoteIndicator />}
          </div>
        ) : (
          <>
            <div className="truncate text-[10px] leading-tight opacity-85">
              {content.statusDisplay} · {content.confirmationDisplay}
            </div>
            <div className="truncate text-[10px] leading-tight opacity-80">{content.insuranceLine}</div>
            {(content.badges.length > 0 || content.note) && (
              <div className="mt-1 flex flex-wrap gap-1">
                {content.badges.map((badge) => (
                  <span
                    key={badge.code}
                    className="rounded-sm bg-black/25 px-1 py-0.5 text-[9px] font-bold uppercase"
                  >
                    {badge.display}
                  </span>
                ))}
                {content.note && <AppointmentNoteIndicator />}
              </div>
            )}
          </>
        )}
      </button>
      {hoverAnchor && <AppointmentHoverCard content={content} anchor={hoverAnchor} />}
    </>
  );
}

function AppointmentNoteIndicator() {
  return (
    <span
      aria-label="Appointment note"
      title="Appointment note"
      className="rounded-sm bg-[color-mix(in_srgb,currentColor_25%,transparent)] px-1 py-0.5 text-[9px] font-bold leading-none"
    >
      ●
    </span>
  );
}

export function ResourceDayColumn({
  resource,
  config,
  date,
  rows,
  axisStartMinutes,
  axisEndMinutes,
  slotMinutes,
  appointments,
  columnKey,
  rowHeight = ROW_HEIGHT,
  onAppointmentClick,
  onBlockedRegionClick,
  onCellClick,
  watcherAlertsByAppointment = {},
}: {
  resource: Schedule;
  config: SchedulingPracticeConfig;
  date: string;
  rows: Array<{ startMinutes: number }>;
  axisStartMinutes: number;
  axisEndMinutes: number;
  slotMinutes: number;
  appointments: PositionedAppointment[];
  columnKey: string;
  rowHeight?: number;
  onAppointmentClick: (appointment: Appointment, sourceResourceActor?: string) => void;
  onBlockedRegionClick: (blockIndex: number | undefined) => void;
  onCellClick: (resource: Schedule, startMinutes: number) => void;
  watcherAlertsByAppointment?: Readonly<Record<string, WatcherAlert>>;
}) {
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
    <div className="relative border-r border-white/10" style={{ minHeight: rows.length * rowHeight }}>
      {regions
        .filter((region) => region.kind !== "blocked")
        .map((region) => (
          <div
            key={`${columnKey}-${region.kind}-${region.startMinutes}`}
            className={clsx(
              "absolute inset-x-0",
              region.kind === "in-hours" ? "bg-white/[0.075]" : "bg-white/[0.025]",
            )}
            style={{ top: region.rowStart * rowHeight, height: region.rowSpan * rowHeight }}
          />
        ))}
      {rows.map((row) => (
        <div
          key={row.startMinutes}
          className="relative border-b border-white/10"
          style={{ height: rowHeight }}
          onClick={() => onCellClick(resource, row.startMinutes)}
        />
      ))}
      {regions
        .filter((region) => region.kind === "blocked")
        .map((region) => {
          const editable = region.blockedKind === "custom" && region.blockIndex !== undefined;
          return (
            <button
              key={`${columnKey}-blocked-${region.startMinutes}-${region.endMinutes}`}
              className={clsx(
                "absolute inset-x-1 z-10 overflow-hidden border border-white/10 bg-zinc-500/45 px-2 py-1 text-left text-[11px] font-semibold text-white/80",
                editable && "hover:bg-zinc-400/55",
              )}
              type="button"
              disabled={!editable}
              style={{
                top: region.rowStart * rowHeight + 2,
                height: Math.max(region.rowSpan * rowHeight - 4, 24),
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
          key={`${columnKey}-${block.appointment.id ?? `${block.geometry.rowStart}-${block.content.patientDisplay}`}`}
          block={block}
          resource={resource}
          rowHeight={rowHeight}
          onClick={onAppointmentClick}
          watcherAlert={block.appointment.id ? watcherAlertsByAppointment[block.appointment.id] : undefined}
        />
      ))}
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
