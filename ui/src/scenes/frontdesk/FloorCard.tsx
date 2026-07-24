// ui/src/scenes/frontdesk/FloorCard.tsx
import clsx from "clsx";
import { useState } from "react";
import type { FloorCard as FloorCardModel } from "../../lib/floor-board";
import { AppointmentChartButton } from "../../components/AppointmentChartButton";

const TIMER_COLOR = { ok: "text-white/55", amber: "text-amber-300", red: "text-red-300" } as const;
const TIMER_BORDER = { ok: "border-white/10", amber: "border-white/10", red: "border-red-400/50" } as const;
const PAYER_CUE_STYLE = { vision: "bg-amber-950/60 text-amber-300", house: "bg-emerald-950/60 text-emerald-300" } as const;

// The card body stays two lines: name + visit type + timer, then badges + payer context.
// Its body opens PatientQuickCard; authorized checked-in sessions get a separate chart action.
export function FloorCard({
  card,
  canStartChart = false,
  onClick,
}: {
  card: FloorCardModel;
  canStartChart?: boolean;
  onClick: () => void;
}) {
  const [chartError, setChartError] = useState<string | null>(null);
  const checkedInDate = new Date(card.checkedInAt);
  const checkedInLabel = Number.isNaN(checkedInDate.getTime())
    ? undefined
    : checkedInDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <div
      className={clsx(
        "w-full rounded-md border-l-4 bg-white/5 px-3 py-1.5 text-xs",
        TIMER_BORDER[card.timer.level],
      )}
      style={{ borderLeftColor: card.content.color }}
    >
      <button type="button" onClick={onClick} className="w-full text-left hover:bg-white/5">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-semibold text-white">{card.content.patientDisplay}</span>
          <span className="shrink-0 text-white/45">{card.content.visitTypeDisplay}</span>
          <span className={clsx("shrink-0 rounded-full bg-black/30 px-2 py-0.5 font-bold", TIMER_COLOR[card.timer.level])}>
            {card.timer.minutes}m
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-white/40">
          {card.content.badges.map((badge) => (
            <span
              key={badge.code}
              className="shrink-0 rounded-sm bg-white/10 px-1 py-0.5 text-[9px] font-bold uppercase text-white/80"
            >
              {badge.display}
            </span>
          ))}
          {card.payerCue && (
            <span className={clsx("shrink-0 rounded px-1.5 py-0.5 font-bold uppercase", PAYER_CUE_STYLE[card.payerCue.kind])}>
              {card.payerCue.label}
            </span>
          )}
          <span className="truncate">{card.content.insuranceLine}</span>
          {checkedInLabel && <span className="ml-auto shrink-0 text-white/35">in @ {checkedInLabel}</span>}
        </div>
      </button>
      {canStartChart && (
        <div className="mt-1 flex justify-end">
          <AppointmentChartButton
            appointment={card.appointment}
            className="scheduler-button px-2 py-1 text-[10px]"
            onError={setChartError}
          />
        </div>
      )}
      {chartError && <div className="mt-1 text-[10px] text-red-200">{chartError}</div>}
    </div>
  );
}
