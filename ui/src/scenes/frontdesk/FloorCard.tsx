// ui/src/scenes/frontdesk/FloorCard.tsx
import clsx from "clsx";
import type { FloorCard as FloorCardModel } from "../../lib/floor-board";

const TIMER_COLOR = { ok: "text-white/55", amber: "text-amber-300", red: "text-red-300" } as const;
const TIMER_BORDER = { ok: "border-white/10", amber: "border-white/10", red: "border-red-400/50" } as const;
const PAYER_CUE_STYLE = { vision: "bg-amber-950/60 text-amber-300", house: "bg-emerald-950/60 text-emerald-300" } as const;

// The two-line floor card (design doc §3 card atom, whisper tier): name + visit type +
// time-in-lane chip on line 1; payer cue + insurance context on line 2. Click opens the
// existing PatientQuickCard (rendered by CockpitFloorBoard). Timer chip colors by level;
// a red timer also tints the left border.
export function FloorCard({ card, onClick }: { card: FloorCardModel; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "w-full rounded-md border-l-4 bg-white/5 px-3 py-1.5 text-left text-xs hover:bg-white/10",
        TIMER_BORDER[card.timer.level],
      )}
      style={{ borderLeftColor: card.content.color }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-semibold text-white">{card.content.patientDisplay}</span>
        <span className="shrink-0 text-white/45">{card.content.visitTypeDisplay}</span>
        <span className={clsx("shrink-0 rounded-full bg-black/30 px-2 py-0.5 font-bold", TIMER_COLOR[card.timer.level])}>
          {card.timer.minutes}m
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-white/40">
        {card.payerCue && (
          <span className={clsx("rounded px-1.5 py-0.5 font-bold", PAYER_CUE_STYLE[card.payerCue.kind])}>
            {card.payerCue.kind === "house" ? "HOUSE PLAN" : card.payerCue.label}
          </span>
        )}
        <span className="truncate">{card.content.insuranceLine}</span>
      </div>
    </button>
  );
}
